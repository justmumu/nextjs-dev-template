import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJson } from "../support/json.ts";
import { denial, guardArea, stateModule } from "../support/guard-fixture.ts";
import { Rollout } from "../support/rollout.ts";

// Real processes and real state: two hooks racing for the one exclusive slot, two worktrees of one
// repository, a lock owner that is killed, and a development server that stays reserved.

const { createFixture, area } = guardArea("guard-concurrency-");
const require = createRequire(import.meta.url);
const recovery = require("../../scripts/hooks/recover-lock.cjs") as typeof import("../../scripts/hooks/recover-lock.cjs");
const mutexPath = join(import.meta.dirname, "../../scripts/hooks/mutex.cjs");

const shell = (command: string, id: string, root: string, extra: Record<string, unknown> = {}) => ({
  cwd: root,
  tool_name: "Bash",
  tool_input: { command },
  tool_use_id: id,
  ...extra,
});
type Stored = { inflight: Record<string, { route: string | null }>; window: unknown[] };
const stateOf = (gitDir: string) => parseJson<Stored>(readFileSync(join(gitDir, "protected-baseline", "state.json"), "utf8"));

/** Starts the launcher the way a host does and resolves with what it printed. */
function launchAsync(root: string, env: NodeJS.ProcessEnv, event: string, payload: unknown) {
  return new Promise<{ status: number | null; json: Record<string, unknown> }>((resolve, reject) => {
    const child = spawn("sh", [join(root, "scripts/hooks/launch.sh"), "--client", "claude", "--event", event], { cwd: root, env });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, json: out.trim() ? (JSON.parse(out) as Record<string, unknown>) : {} });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("exclusive operations and worktrees (R19)", () => {
  test("of two exclusive calls started together only one proceeds", async () => {
    const fixture = createFixture();
    const results = await Promise.all(["a", "b"].map((id) => launchAsync(fixture.root, fixture.env, "pre", shell("pnpm run format", id, fixture.root))));
    expect(results.map((result) => result.status)).toEqual([0, 0]);
    const allowed = results.filter((result) => Object.keys(result.json).length === 0);
    const refused = results.filter((result) => Object.keys(result.json).length > 0);
    expect(allowed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(denial(refused[0]?.json ?? {})).toMatch(/Another call/);
    expect(Object.keys(stateOf(join(fixture.root, ".git")).inflight)).toHaveLength(1);
    expect(existsSync(join(fixture.root, ".git", "protected-baseline", "lock"))).toBe(false);
  });

  test("the baselines of two worktrees of one repository do not mix", () => {
    const fixture = createFixture();
    const other = join(area, "second-worktree");
    fixture.git("worktree", "add", "-q", "-b", "second", other);
    const run = (root: string, command: string, id: string) =>
      spawnSync("sh", [join(root, "scripts/hooks/launch.sh"), "--client", "claude", "--event", "pre"], {
        cwd: root,
        env: fixture.env,
        input: JSON.stringify(shell(command, id, root)),
        encoding: "utf8",
      });
    expect(run(fixture.root, "pnpm run format", "first").stdout).toBe("");
    const result = run(other, "pnpm run format", "second");
    expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({ status: 0, stderr: "", stdout: "" });
    const first = stateOf(join(fixture.root, ".git"));
    const second = stateOf(join(fixture.root, ".git", "worktrees", "second-worktree"));
    expect(Object.keys(first.inflight)).toEqual(["first"]);
    expect(Object.keys(second.inflight)).toEqual(["second"]);
  });

  test("the short mutex is free while a call stays reserved", () => {
    const fixture = createFixture();
    expect(fixture.launch("pre", shell("pnpm run format", "long", fixture.root)).json).toEqual({});
    expect(existsSync(join(fixture.root, ".git", "protected-baseline", "lock"))).toBe(false);
    expect(Object.keys(stateOf(join(fixture.root, ".git")).inflight)).toEqual(["long"]);
  });
});

describe("a lock owner that is killed", () => {
  test("its lock is not reclaimed by age; offline recovery removes it and keeps the baseline and the pending call", () => {
    const fixture = createFixture();
    expect(fixture.launch("pre", shell("pnpm run format", "pending", fixture.root)).json).toEqual({});
    const dir = join(fixture.root, ".git", "protected-baseline");
    const before = readFileSync(join(dir, "state.json"), "utf8");

    const owner = spawnSync(
      process.execPath,
      ["-e", `const m = require(${JSON.stringify(mutexPath)}); m.acquire(${JSON.stringify(dir)}, 0); process.kill(process.pid, "SIGKILL");`],
      { encoding: "utf8" },
    );
    expect(owner.signal).toBe("SIGKILL");
    expect(existsSync(join(dir, "lock"))).toBe(true);
    utimesSync(join(dir, "lock"), new Date(2000, 0, 1), new Date(2000, 0, 1));
    expect(() => stateModule.withLock(dir, () => 1, 60)).toThrow(/holds the state lock/);
    expect(existsSync(join(dir, "lock"))).toBe(true);

    const refused = spawnSync("node", [join(fixture.root, "scripts/hooks/recover-lock.cjs")], { cwd: fixture.root, input: "recover\n", encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(existsSync(join(dir, "lock"))).toBe(true);

    const out: string[] = [];
    expect(recovery.main([], { cwd: fixture.root, interactive: true, readLine: () => "recover", stdout: (text) => out.push(text) })).toBe(0);
    expect(out.join("")).toMatch(/Recovered/);
    expect(existsSync(join(dir, "lock"))).toBe(false);
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(before);
    expect(denial(fixture.launch("pre", shell("true", "next", fixture.root)).json)).toMatch(/Another call/);
    expect(fixture.launch("post", shell("pnpm run format", "pending", fixture.root)).json).toEqual({});
    expect(stateOf(join(fixture.root, ".git")).inflight).toEqual({});
  });
});

describe("offline recovery started directly (F7)", () => {
  test("a malformed package.json and missing node_modules do not stop the entry; the refusal and the state bytes are intact", () => {
    const fixture = createFixture();
    expect(fixture.launch("pre", shell("pnpm run format", "pending", fixture.root)).json).toEqual({});
    const dir = join(fixture.root, ".git", "protected-baseline");
    const before = readFileSync(join(dir, "state.json"), "utf8");
    writeFileSync(join(fixture.root, "package.json"), "{ broken");
    expect(existsSync(join(fixture.root, "node_modules"))).toBe(false);

    const refused = spawnSync(process.execPath, [join(fixture.root, "scripts/hooks/recover-lock.cjs")], {
      cwd: fixture.root,
      input: "recover\n",
      encoding: "utf8",
    });
    expect({ status: refused.status, stderr: refused.stderr }).toEqual({
      status: 2,
      stderr: expect.stringMatching(/human operation and needs an interactive terminal/) as string,
    });
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(before);

    const usage = spawnSync(process.execPath, [join(fixture.root, "scripts/hooks/recover-lock.cjs"), "extra"], { cwd: fixture.root, encoding: "utf8" });
    expect({ status: usage.status, stderr: usage.stderr }).toEqual({ status: 2, stderr: expect.stringMatching(/usage:/) as string });
  });
});

describe("a development server that stays reserved (R19)", () => {
  test("it neither defers the judgement of another call's protected write nor lets a protected write through", () => {
    const fixture = createFixture();
    mkdirSync(join(area, "codex-run"), { recursive: true });
    const run = new Rollout(join(area, "codex-run", "rollout.jsonl"), { thread: "thread" });
    run.append({ type: "function_call_output", call_id: "server", output: "Process running" });
    const server = shell("pnpm run dev", "server", fixture.root, { session_id: "thread", turn_id: "turn", transcript_path: run.path });
    expect(fixture.launch("pre", server, { client: "codex" }).json).toEqual({});
    expect(fixture.launch("post", server, { client: "codex" }).json).toEqual({});
    expect(Object.keys(stateOf(join(fixture.root, ".git")).inflight)).toEqual(["server"]);

    const edit = shell("echo evil >> AGENTS.md", "edit", fixture.root);
    expect(fixture.launch("pre", edit).json).toEqual({});
    writeFileSync(join(fixture.root, "AGENTS.md"), "# Rules\nevil\n");
    const post = fixture.launch("post", edit);
    expect(post.json.decision).toBe("block");
    expect(fixture.read("AGENTS.md")).toBe("# Rules\n");
    expect(Object.keys(stateOf(join(fixture.root, ".git")).inflight)).toEqual(["server"]);
    expect(stateOf(join(fixture.root, ".git")).window).toEqual([]);

    expect(denial(fixture.launch("pre", shell("pnpm run format", "fmt", fixture.root)).json)).toMatch(/Another call/);
    run.complete({ call: "server", turn: "turn" });
    expect(fixture.launch("post", server, { client: "codex" }).json).toEqual({});
    expect(stateOf(join(fixture.root, ".git")).inflight).toEqual({});
  });
});
