import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { alive, reclaim, recordedPids, until } from "../support/owned-processes.ts";
import { scratchArea } from "../support/project.ts";

// The public command boundary: the project's own dispatcher (and, for one case, the real pnpm
// wrapper in a foreground process group) is interrupted while it owns a resistant tool, and must
// stop everything, remove its scratch, start nothing later and fail. The tool is a `pnpm` earlier
// on PATH that records itself, ignores SIGTERM, and leaves a SIGTERM-resistant descendant.
const scratch = scratchArea("public-cancellation-");
const root = resolve(import.meta.dirname, "../..");
const render = createRequire(import.meta.url)("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");
const realPnpm = execFileSync("sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).trim();

function shim(dir: string) {
  const files = { log: join(dir, "pnpm.log"), leader: join(dir, "leader.pid"), descendant: join(dir, "descendant.pid") };
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    `#!${process.execPath}
const { spawn } = require("node:child_process");
const fs = require("node:fs");
// The dispatcher's own preflight asks the real pnpm for its version; only the install is the fixture.
if (process.argv[2] === "--version") {
  process.stdout.write(require("node:child_process").execFileSync(${JSON.stringify(realPnpm)}, ["--version"]));
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(files.log)}, process.argv.slice(2).join(" ") + "\\n");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(files.leader)}, String(process.pid));
const descendant = spawn(process.execPath, ["-e", "/* public-cancellation-fixture */ process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(files.descendant)}, String(descendant.pid));
setInterval(() => {}, 1000);
`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  return { ...files, bin };
}

function renderedApplication(dir: string) {
  const { manifest, bases } = render.defaultInputs();
  const app = join(dir, "app");
  render.writeTree(render.renderTree({ manifest, bases, answers: { name: "cancel-app", owner: "template-check" } }).files, app);
  return app;
}

/** Kills the process group this test created for its runner (the runner is its leader); a group that is already gone is fine. */
function killOwnGroup(leader: number | undefined) {
  if (leader === undefined || !Number.isSafeInteger(leader) || leader <= 1) return;
  try {
    process.kill(-leader, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

interface Case {
  project: "generator" | "application";
  command: "test:e2e" | "test:artifact";
  /** a signal to the dispatcher process alone, or to the foreground process group it runs in, optionally through the real pnpm wrapper */
  delivery: { to: "dispatcher" } | { to: "group"; through: "node" | "pnpm" };
  signal: "SIGINT" | "SIGTERM";
}

async function cancel({ project, command, delivery, signal }: Case) {
  const dir = scratch.project();
  const tools = shim(dir);
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  const cwd = project === "generator" ? root : renderedApplication(dir);
  const env = { ...process.env, PATH: `${tools.bin}:${process.env.PATH ?? ""}`, TMPDIR: tmp, CI: "1", NODE_DISABLE_COMPILE_CACHE: "1" };
  const grouped = delivery.to === "group";
  const [program, args] =
    grouped && delivery.through === "pnpm" ? [realPnpm, ["run", command]] : [process.execPath, [join(cwd, "scripts", "development.cjs"), command]];
  const runner = spawn(program, args, { cwd, env, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  for (const stream of [runner.stdout, runner.stderr])
    stream.setEncoding("utf8").on("data", (text: string) => {
      log += text;
    });
  const exit = new Promise<{ code: number | null; signal: string | null }>((done) => {
    runner.on("exit", (code, by) => {
      done({ code, signal: by });
    });
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    expect(await until(() => recordedPids([tools.leader, tools.descendant]).length === 2, 60_000), `the tool started\n${log}`).toBe(true);
    const owned = recordedPids([tools.leader, tools.descendant]);
    expect(owned.every(alive)).toBe(true);
    expect(readdirSync(tmp).length, "the run owns a scratch directory").toBeGreaterThan(0);
    if (delivery.to === "group") {
      // What a terminal does: every process of the foreground group gets the signal.
      if (runner.pid === undefined || runner.pid <= 1) throw new Error("no process group to signal");
      process.kill(-runner.pid, signal);
    } else runner.kill(signal);
    const result = await Promise.race([
      exit,
      new Promise<"timeout">((done) => {
        timer = setTimeout(() => {
          done("timeout");
        }, 60_000);
      }),
    ]);
    expect(result, log).not.toBe("timeout");
    return {
      result: result as { code: number | null; signal: string | null },
      gone: await until(() => owned.every((pid) => !alive(pid)), 15_000),
      scratchLeft: existsSync(tmp) ? readdirSync(tmp) : [],
      invocations: readFileSync(tools.log, "utf8").trim().split("\n"),
      log,
    };
  } finally {
    clearTimeout(timer);
    // A failing test must not leak what it was testing; the group is the one this test created.
    if (grouped) killOwnGroup(runner.pid);
    const runnerPid = runner.pid;
    await reclaim([
      ...(runner.exitCode === null && runner.signalCode === null && runnerPid !== undefined ? [runnerPid] : []),
      ...recordedPids([tools.leader, tools.descendant]),
    ]);
    await exit;
  }
}

const status = { SIGINT: 130, SIGTERM: 143 };

describe("a cancelled public command", () => {
  test.each([
    { project: "generator", command: "test:e2e", signal: "SIGTERM", delivery: { to: "dispatcher" } },
    { project: "generator", command: "test:artifact", signal: "SIGINT", delivery: { to: "dispatcher" } },
    { project: "application", command: "test:e2e", signal: "SIGTERM", delivery: { to: "dispatcher" } },
    { project: "application", command: "test:artifact", signal: "SIGTERM", delivery: { to: "dispatcher" } },
    { project: "application", command: "test:e2e", signal: "SIGINT", delivery: { to: "group", through: "node" } },
    { project: "generator", command: "test:e2e", signal: "SIGINT", delivery: { to: "group", through: "pnpm" } },
  ] satisfies Case[])(
    "$project $command: $signal to the $delivery.to stops the resistant tool and its descendant, removes the scratch, starts nothing later and fails",
    async (options) => {
      const outcome = await cancel(options);
      if (options.delivery.to === "group" && options.delivery.through === "pnpm" && outcome.result.code === null) {
        // Native pnpm re-raises the signal; a Corepack wrapper reports its conventional numeric status.
        expect(outcome.result.signal, outcome.log).toBe(options.signal);
      } else expect(outcome.result.code, outcome.log).toBe(status[options.signal]);
      expect(outcome.gone, outcome.log).toBe(true);
      expect(outcome.scratchLeft, outcome.log).toEqual([]);
      // Only the one install ever ran: no later phase started once the run was interrupted.
      expect(outcome.invocations, outcome.log).toHaveLength(1);
      expect(outcome.invocations[0]).toMatch(/^install --frozen-lockfile/);
    },
    180_000,
  );
});
