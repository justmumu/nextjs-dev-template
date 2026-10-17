import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { memoryFs } from "../../support/memory-fs.ts";
import { memoryRepo, policyText, shell } from "../../support/guard-repo.ts";
import { Rollout, storedRollout, type Medium } from "../../support/rollout.ts";

// The engine settles a Codex shell call only on its own terminal record. The host's transcripts are
// synthetic files and the repository are held in memory; the same hooks over real files and a real
// launcher are in tests/integration/guard-completion.test.ts.

const guard = createRequire(import.meta.url)("../../../scripts/hooks/guard.cjs") as typeof import("../../../scripts/hooks/guard.cjs");
let counter = 0;

const PACKAGE = JSON.stringify(
  { name: "app", version: "1.0.0", scripts: { check: "node scripts/development.cjs check" }, dependencies: {}, devDependencies: {} },
  null,
  2,
);
const WITH_DEP = JSON.stringify(
  { name: "app", version: "1.0.0", scripts: { check: "node scripts/development.cjs check" }, dependencies: { "left-pad": "1.3.0" }, devDependencies: {} },
  null,
  2,
);
const DEPENDENCY = "pnpm run deps:add --package=left-pad@1.3.0 --group=prod";

function project(codexHome?: string, files: Medium = memoryFs()) {
  const machine = memoryRepo(
    {
      "package.json": PACKAGE,
      "pnpm-lock.yaml": "lock: 1\n",
      "pnpm-workspace.yaml": "strictDepBuilds: true\n",
      "AGENTS.md": "# Rules\n",
      "tsconfig.json": '{"compilerOptions":{"strict":true}}',
      "tooling/policy.json": policyText.toString(),
      "scripts/hooks/guard.cjs": "module.exports = 1;\n",
      "src/app.ts": "export const a = 1;\n",
    },
    { files, ...(codexHome && { codexHome }) },
  );
  expect(guard.accept(machine.context(), () => undefined)).toBe(0);
  const run = new Rollout(join(`/area/p${++counter}`, "rollout.jsonl"), { files });
  const codex = machine.context("codex");
  const payload = (command: string, id = "call") => shell(command, id, { session_id: "thread", turn_id: "turn", transcript_path: run.path });
  return { machine, run, codex, payload, files };
}

describe("a Codex shell call is finished by its own transcript", () => {
  test("a yielded result settles nothing; the call's terminal record applies the recorded allowance once", () => {
    const { machine, run, codex, payload } = project();
    const call = payload(DEPENDENCY);
    expect(guard.preTool(codex, call)).toEqual({});
    machine.worktree.set("package.json", WITH_DEP);
    run.append({ type: "function_call_output", call_id: "call", output: "yield" });
    expect(guard.postTool(codex, call, false)).toEqual({});
    expect(Object.keys(machine.state()?.inflight ?? {})).toEqual(["call"]);
    expect(machine.state()?.window).toEqual([]);
    run.complete();
    expect(guard.postTool(codex, call, false)).toEqual({});
    expect(machine.state()?.inflight).toEqual({});
    expect(machine.worktree.get("package.json")).toBe(WITH_DEP);
    expect(guard.postTool(codex, call, false)).toEqual({});
    expect(machine.worktree.get("package.json")).toBe(WITH_DEP);
  });

  test("a late record of another call approves nothing", () => {
    const { machine, run, codex, payload } = project();
    const call = payload(DEPENDENCY);
    guard.preTool(codex, call);
    machine.worktree.set("package.json", WITH_DEP);
    run.complete({ call: "another" });
    expect(guard.postTool(codex, call, false)).toEqual({});
    expect(Object.keys(machine.state()?.inflight ?? {})).toEqual(["call"]);
    expect(machine.worktree.get("package.json")).toBe(WITH_DEP);
    expect(Object.keys(machine.state()?.inflight ?? {})).toEqual(["call"]);
  });

  test("a call that never started a process leaves an unrelated write stranded no longer", () => {
    const { machine, run, codex, payload } = project();
    const call = payload(DEPENDENCY);
    guard.preTool(codex, call);
    machine.worktree.set("AGENTS.md", "# Unrelated\n");
    machine.worktree.set("package.json", WITH_DEP);
    run.complete({ process: null, exit_code: -1 });
    expect(JSON.stringify(guard.postTool(codex, call, false))).toMatch(/restored/);
    expect(machine.state()?.inflight).toEqual({});
    expect(machine.worktree.get("AGENTS.md")).toBe("# Rules\n");
    expect(machine.worktree.get("package.json")).toBe(PACKAGE);
  });

  test("a failed reinstall does not accept the environment it left", () => {
    const { machine, run, codex, payload } = project();
    machine.setEnvironment("env-2");
    expect(JSON.stringify(guard.preTool(codex, shell("true", "blocked")))).toMatch(/repair/);
    const call = payload("node scripts/bootstrap.cjs repair");
    expect(guard.preTool(codex, call)).toEqual({});
    machine.setEnvironment("env-3");
    run.complete({ exit_code: 1 });
    guard.postTool(codex, call, false);
    expect(machine.state()?.inflight).toEqual({});
    expect(machine.state()?.environmentBlocked).toBe(true);
    expect(JSON.stringify(guard.preTool(codex, shell("true", "next")))).toMatch(/repair/);
  });

  test("a call without a transcript is settled by the result that names it", () => {
    const { machine, codex } = project();
    const call = shell(DEPENDENCY, "plain", { session_id: "thread", turn_id: "turn" });
    guard.preTool(codex, call);
    machine.worktree.set("package.json", WITH_DEP);
    expect(guard.postTool(codex, call, false)).toEqual({});
    expect(machine.state()?.inflight).toEqual({});
  });

  test("a transcript path that is not absolute or is oversized is not stored", () => {
    const { machine, codex } = project();
    guard.preTool(codex, shell("true", "relative", { transcript_path: "rollout.jsonl" }));
    guard.preTool(codex, shell("true", "huge", { transcript_path: `/${"x".repeat(5000)}` }));
    const inflight = machine.state()?.inflight ?? {};
    expect(inflight["relative"]?.transcript).toBeNull();
    expect(inflight["huge"]?.transcript).toBeNull();
  });

  test("a finished call does not hold back the user's approval, and one that is still running does", () => {
    const { machine, run, codex, payload } = project();
    const call = payload("true");
    guard.preTool(codex, call);
    const out: string[] = [];
    expect(guard.accept(machine.context(), (text) => out.push(text))).toBe(1);
    expect(out.join("")).toMatch(/have not finished/);
    run.complete();
    expect(guard.accept(machine.context(), (text) => out.push(text))).toBe(0);
    expect(machine.state()?.inflight).toEqual({});
  });
});

describe("a call recovered from its transcript is judged like one that reported", () => {
  const nested = (ancestor: string) => {
    const home = `/area/home${++counter}`;
    const files = memoryFs();
    storedRollout(join(home, "sessions/2026/10/13"), { thread: "middle", parent: ancestor, files });
    const leaf = storedRollout(join(home, "sessions/2026/10/14"), { thread: "leaf", parent: "middle", files });
    const harness = project(home, files);
    const payload = (command: string, id = "call") => shell(command, id, { session_id: "root", turn_id: "turn", transcript_path: leaf.path });
    return { ...harness, home, leaf, payload };
  };

  test.each(["root", "unrelated"])("a nested completion controls the admission of the next commit (ancestor %s)", (ancestor) => {
    const { codex, leaf, payload } = nested(ancestor);
    const call = payload("pnpm run format");
    expect(guard.preTool(codex, call)).toEqual({});
    expect(guard.postTool(codex, call, false)).toEqual({});
    const next = shell("git commit -m completed", "next");
    expect(JSON.stringify(guard.preTool(codex, next))).toMatch(/Another call/);
    leaf.complete();
    const result = guard.preTool(codex, next);
    if (ancestor === "root") expect(result).toEqual({});
    else expect(JSON.stringify(result)).toMatch(/Another call/);
  });

  test("a saved nested call recovers when its parent arrives", () => {
    const home = `/area/home${++counter}`;
    const files = memoryFs();
    const leaf = storedRollout(join(home, "sessions/2026/10/14"), { thread: "leaf", parent: "middle", files });
    const { machine, codex } = project(home, files);
    const call = shell("pnpm run format", "call", { session_id: "root", turn_id: "turn", transcript_path: leaf.path });
    expect(guard.preTool(codex, call)).toEqual({});
    expect(machine.state()?.inflight["call"]?.rolloutRequired).toBeUndefined();
    expect(machine.state()?.inflight["call"]).not.toHaveProperty("started");
    leaf.complete();
    const next = shell("git commit -m completed", "next");
    expect(JSON.stringify(guard.preTool(codex, next))).toMatch(/Another call/);
    storedRollout(join(home, "archived_sessions"), { thread: "middle", parent: "root", files });
    expect(guard.preTool(codex, next)).toEqual({});
    expect(Object.keys(machine.state()?.inflight ?? {})).toEqual(["next"]);
  });

  test("a nested recovery restores an unauthorized protected write", () => {
    const { machine, codex, leaf, payload } = nested("root");
    expect(guard.preTool(codex, payload("true"))).toEqual({});
    machine.worktree.set("AGENTS.md", "# Unauthorized\n");
    leaf.complete();
    expect(JSON.stringify(guard.preTool(codex, shell("git commit -m bad", "next")))).toMatch(/restored/);
    expect(machine.worktree.get("AGENTS.md")).toBe("# Rules\n");
    expect(machine.state()?.inflight).toEqual({});
  });

  test("a call that never started is restored at the stop, and the pre-commit check keeps that evaluation for it", () => {
    const { machine, run, codex, payload } = project();
    expect(guard.preTool(codex, payload("true"))).toEqual({});
    machine.worktree.set("AGENTS.md", "# Unauthorized\n");
    run.complete({ process: null, exit_code: -1 });
    expect(guard.preCommit(codex, () => undefined)).toBe(0);
    expect(machine.state()?.needsEvaluation).toBe(true);
    expect(JSON.stringify(guard.stop(codex, {}))).toMatch(/restored/);
    expect(machine.worktree.get("AGENTS.md")).toBe("# Rules\n");
  });

  test.each([true, false])("a failed command's partial output is accepted only if the process ran (executed: %s)", (executed) => {
    const { machine, run, codex, payload } = project();
    expect(guard.preTool(codex, payload(DEPENDENCY))).toEqual({});
    machine.worktree.set("package.json", WITH_DEP);
    run.complete(executed ? { process: "42", exit_code: 1 } : { process: null, exit_code: -1 });
    const result = guard.stop(codex, {});
    if (executed) {
      expect(result).toEqual({});
      expect(machine.worktree.get("package.json")).toBe(WITH_DEP);
    } else {
      expect(JSON.stringify(result)).toMatch(/restored/);
      expect(machine.worktree.get("package.json")).toBe(PACKAGE);
    }
  });

  test.each([0, 1])("the acceptance is recorded only for a successful command (exit %i)", (exitCode) => {
    const { machine, run, codex, payload } = project();
    expect(guard.preTool(codex, payload("node scripts/bootstrap.cjs guard-accept"))).toEqual({});
    machine.worktree.set("AGENTS.md", "# User\n");
    if (exitCode === 0) expect(guard.accept(machine.context(), () => undefined)).toBe(0);
    run.complete({ exit_code: exitCode });
    const result = guard.stop(codex, {});
    expect(machine.worktree.get("AGENTS.md")).toBe(exitCode === 0 ? "# User\n" : "# Rules\n");
    if (exitCode === 0) expect(result).toEqual({});
    else expect(JSON.stringify(result)).toMatch(/restored|outside an agent call/);
  });

  test("a transcript without a history mode keeps the ordinary post hook", () => {
    const { machine, run, codex, payload, files } = project();
    const header = JSON.stringify({ type: "session_meta", payload: { id: "thread", parent_thread_id: null } });
    files.writeFileSync(run.path, `${header}\n`);
    const call = payload("true");
    expect(guard.preTool(codex, call)).toEqual({});
    expect(guard.postTool(codex, call, false)).toEqual({});
    expect(machine.state()?.inflight).toEqual({});
    expect(guard.preTool(codex, shell("pnpm run format", "next"))).toEqual({});
  });
});

describe("a denied call that never reports", () => {
  const denied = () => {
    const harness = project();
    const transcript = `/area/transcript${++counter}.jsonl`;
    harness.files.mkdirSync("/area", { recursive: true });
    harness.files.writeFileSync(transcript, "");
    const result = () => {
      harness.files.writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "denied" }] } })}\n`);
    };
    return { ...harness, transcript, result };
  };

  test("its own result in the transcript stops it keeping others waiting", () => {
    const { machine, transcript, result } = denied();
    const context = machine.context();
    expect(guard.preTool(context, shell("git switch other", "denied", { transcript_path: transcript }))).toEqual({});
    expect(JSON.stringify(guard.preTool(context, shell("true", "other")))).toMatch(/Another call/);
    result();
    expect(guard.preTool(context, shell("ls", "ls"))).toEqual({});
  });

  test("a denied protected edit releases its reservation without granting the edit", () => {
    const { machine, transcript, result } = denied();
    const context = machine.context();
    const edit = { cwd: "/p", tool_name: "Write", tool_input: { file_path: "/p/AGENTS.md" }, tool_use_id: "denied", transcript_path: transcript };
    expect(guard.preTool(context, edit)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    machine.worktree.set("AGENTS.md", "unapproved change\n");
    result();
    expect(JSON.stringify(guard.preTool(context, shell("ls", "next")))).toMatch(/restored/);
    expect(machine.worktree.get("AGENTS.md")).toBe("# Rules\n");
    expect(machine.state()?.inflight["denied"]).toBeUndefined();
  });

  test("it does not strand a parallel write", () => {
    const { machine, transcript, result } = denied();
    const context = machine.context();
    expect(guard.preTool(context, shell("sleep 5", "denied", { transcript_path: transcript }))).toEqual({});
    const writer = shell("echo x >> AGENTS.md", "writer");
    expect(guard.preTool(context, writer)).toEqual({});
    machine.worktree.set("AGENTS.md", "# x\n");
    guard.postTool(context, writer, false);
    result();
    guard.preTool(context, shell("ls", "ls"));
    expect(machine.worktree.get("AGENTS.md")).toBe("# Rules\n");
    expect(Object.keys(machine.state()?.inflight ?? {})).toEqual(["ls"]);
  });
});

describe("a commit that no approved route made, after any kind of completion", () => {
  test.each(["claude", "codex"])("it blocks the next call after an unknown or a duplicate result (%s)", (client) => {
    for (const completion of ["unknown", "duplicate"]) {
      const { machine } = project();
      const context = machine.context(client);
      const tool = client === "claude" ? "Bash" : "exec_command";
      const completed = { ...shell("git commit -q --allow-empty -m baseline", "completed"), tool_name: tool };
      expect(guard.preTool(context, completed)).toEqual({});
      expect(guard.postTool(context, completed, false)).toEqual({});
      machine.object(PACKAGE);
      machine.worktree.set("AGENTS.md", "# Sneaky\n");
      machine.commit("sneak");
      machine.worktree.set("AGENTS.md", "# Rules\n");
      machine.index.set("AGENTS.md", "# Rules\n");
      const late = completion === "duplicate" ? completed : { ...shell("true", "unknown"), tool_name: tool };
      expect(guard.postTool(context, late, false)).toEqual({});
      const refusal = JSON.stringify(guard.preTool(context, { ...shell("git switch main", "next"), tool_name: tool }));
      expect(refusal).toMatch(/A commit recorded unapproved changes to AGENTS\.md/);
      expect(JSON.stringify(guard.preTool(context, { ...shell("true", "following"), tool_name: tool }))).toBe(
        JSON.stringify(guard.preTool(context, { ...shell("true", "following2"), tool_name: tool })),
      );
    }
  });
});

describe("the dependency command's own status", () => {
  const stateModule = createRequire(import.meta.url)("../../../scripts/hooks/state.cjs") as typeof import("../../../scripts/hooks/state.cjs");

  test("a single dependency reservation is taken as the asker unless its transcript shows it finished (documented limitation: no liveness or caller binding)", () => {
    const { machine, run, files } = project();
    const reserved = { ...run.reservation({ exclusive: true, route: "deps-add" }), digest: "d" };
    const stored = { ...(machine.state() as object), inflight: { call: reserved } };
    const disk = files as unknown as ReturnType<typeof memoryFs>;
    disk.mkdirSync("/git/protected-baseline", { recursive: true });
    disk.writeFileSync("/git/protected-baseline/state.json", JSON.stringify(stored));
    const options = { gitDir: "/git", disk, codexHome: "/area/no-home" };
    // A missing transcript keeps the reservation; the lone dependency route is trusted as the asker.
    expect(stateModule.status("/unused", options)).toEqual({ clean: true });
    run.complete();
    expect(stateModule.status("/unused", options).reason).toMatch(/finished calls have not been checked/);
    const other = { ...stored, inflight: { call: { ...reserved, route: null }, second: { ...reserved, route: "deps-add" } } };
    disk.writeFileSync("/git/protected-baseline/state.json", JSON.stringify(other));
    expect(stateModule.status("/unused", options).clean).toBe(false);
  });

  test("a call is owned by its own identity and digest only", () => {
    const { run } = project();
    const current = run.state();
    const identity = { id: "call", client: "codex", session: "thread", turn: "turn" };
    expect(stateModule.owned(current, identity, "digest")).toMatchObject({ client: "codex" });
    expect(stateModule.owned(current, { ...identity, id: "other" }, "digest")).toBe("no reservation for this call");
    expect(stateModule.owned(current, identity, "other")).toBe("the result does not belong to the reserved call");
  });

  test("the host's transcripts are found under CODEX_HOME, or the home directory", () => {
    const saved = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = "/somewhere";
      expect(stateModule.codexHomeOf()).toBe("/somewhere");
      process.env.CODEX_HOME = "";
      expect(stateModule.codexHomeOf()).toMatch(/\.codex$/);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "CODEX_HOME");
      else process.env.CODEX_HOME = saved;
    }
  });
});

describe("a long-running ordinary call (R19)", () => {
  test("it neither blocks the judgement of another call's protected write nor grants an environment or config allowance", () => {
    const { machine, run, codex, payload } = project();
    expect(guard.preTool(codex, payload("pnpm run dev", "server"))).toEqual({});
    run.append({ type: "function_call_output", call_id: "server", output: "yield" });
    const editor = shell("echo x >> package.json", "editor");
    expect(guard.preTool(codex, editor)).toEqual({});
    machine.worktree.set("package.json", WITH_DEP);
    machine.setEnvironment("env-2");
    expect(JSON.stringify(guard.postTool(codex, editor, false))).toMatch(/restored/);
    expect(machine.worktree.get("package.json")).toBe(PACKAGE);
    expect(machine.state()?.environmentBlocked).toBe(true);
    expect(Object.keys(machine.state()?.inflight ?? {})).toEqual(["server"]);
    expect(machine.state()?.window).toEqual([]);
  });
});
