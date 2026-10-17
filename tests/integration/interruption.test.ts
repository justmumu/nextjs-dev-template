import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { alive, reclaim, recordedPids, until } from "../support/owned-processes.ts";
import { scratchArea } from "../support/project.ts";

// The real harness as a program, interrupted while it owns a tool, a starting server or a serving
// server, each of which left a SIGTERM-resistant descendant behind.
const scratch = scratchArea("interruption-");
const harness = resolve(import.meta.dirname, "../../scripts/testing/harness.cjs");
const owned = resolve(import.meta.dirname, "../../scripts/testing/owned.cjs");
const { freePort } = createRequire(import.meta.url)(owned) as typeof import("../../scripts/testing/owned.cjs");

// A tool or server that leaves a descendant ignoring SIGTERM; with RESISTANT_LEADER it ignores SIGTERM itself as well.
const PROGRAM = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
/* interruption-fixture */
if (process.env.RESISTANT_LEADER) process.on("SIGTERM", () => {});
writeFileSync(process.env.LEADER_FILE, String(process.pid));
const descendant = spawn(process.execPath, ["-e", "/* interruption-fixture */ process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.env.DESCENDANT_FILE, String(descendant.pid));
if (process.env.SERVER_PORT) require("node:http").createServer((_request, response) => response.end("ready")).listen(Number(process.env.SERVER_PORT), "127.0.0.1");
else setInterval(() => {}, 1000);
`;

const RUNNER = `
const { main } = require(${JSON.stringify(harness)});
const { startOwned } = require(${JSON.stringify(owned)});
const env = process.env;
const program = ["-e", env.PROGRAM];
void main(async ({ host, cancel }) => {
  const cwd = process.cwd();
  if (env.MODE === "ready") {
    // Never answers the nonce: the run is interrupted while the server is starting.
    await startOwned({ command: process.execPath, args: program, cwd, env, url: "http://127.0.0.1:1/", expect: "x", timeoutMs: 60000, cancel });
  } else if (env.MODE === "serving") {
    const server = await startOwned({ command: process.execPath, args: program, cwd, env, url: "http://127.0.0.1:" + env.SERVER_PORT + "/", expect: "ready", timeoutMs: 60000, cancel });
    // The server answered its nonce: the next phase, a tool of its own with a descendant of its own, follows.
    require("node:fs").writeFileSync(env.READY_FILE, "ready");
    try {
      const { SERVER_PORT, ...toolEnv } = { ...env, LEADER_FILE: env.TOOL_LEADER_FILE, DESCENDANT_FILE: env.TOOL_DESCENDANT_FILE };
      await host.run(process.execPath, program, { cwd, env: toolEnv });
    } finally {
      await server.stop();
    }
  } else {
    await host.run(process.execPath, program, { cwd, env });
  }
  // Whatever comes next must not start once the run was interrupted.
  await host.run(process.execPath, ["-e", "require('node:fs').writeFileSync(process.env.LATER_FILE, 'ran')"], { cwd, env });
  return 0;
});
`;

async function interrupt(mode: "run" | "ready" | "serving", signal: "SIGINT" | "SIGTERM", extra: Record<string, string> = {}) {
  const dir = scratch.project({ "runner.cjs": RUNNER });
  const descendantFile = join(dir, "descendant.pid");
  const laterFile = join(dir, "later");
  const files = {
    leader: join(dir, "leader.pid"),
    server: join(dir, "server-ready"),
    toolLeader: join(dir, "tool-leader.pid"),
    toolDescendant: join(dir, "tool-descendant.pid"),
  };
  const pidFiles = [files.leader, descendantFile, files.toolLeader, files.toolDescendant];
  const env = {
    ...process.env,
    MODE: mode,
    PROGRAM,
    DESCENDANT_FILE: descendantFile,
    LEADER_FILE: files.leader,
    READY_FILE: files.server,
    TOOL_LEADER_FILE: files.toolLeader,
    TOOL_DESCENDANT_FILE: files.toolDescendant,
    LATER_FILE: laterFile,
    ...(mode === "serving" ? { SERVER_PORT: String(await freePort()) } : {}),
    ...extra,
  };
  const runner = spawn(process.execPath, [join(dir, "runner.cjs")], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
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
    expect(await until(() => existsSync(descendantFile) && readFileSync(descendantFile, "utf8") !== "", 20_000), "the tool started").toBe(true);
    // A serving run is interrupted only once its server acknowledged readiness and the next phase's tool is running.
    if (mode === "serving") {
      expect(await until(() => existsSync(files.server), 20_000), "the server completed readiness").toBe(true);
      expect(await until(() => recordedPids([files.toolLeader, files.toolDescendant]).length === 2, 20_000), "the next tool started").toBe(true);
    }
    const watched = recordedPids(pidFiles);
    expect(watched.every(alive)).toBe(true);
    runner.kill(signal);
    const result = await Promise.race([
      exit,
      new Promise<"timeout">((done) => {
        timer = setTimeout(() => {
          done("timeout");
        }, 30_000);
      }),
    ]);
    expect(result, log).not.toBe("timeout");
    return {
      result: result as { code: number | null; signal: string | null },
      descendantGone: await until(() => watched.every((pid) => !alive(pid)), 15_000),
      later: existsSync(laterFile),
      log,
    };
  } finally {
    clearTimeout(timer);
    // A failing test must not leak what it was testing: the runner and every leader and descendant the fixture recorded are this test's own.
    const runnerPid = runner.pid;
    const owned = [...(runner.exitCode === null && runner.signalCode === null && runnerPid !== undefined ? [runnerPid] : []), ...recordedPids(pidFiles)];
    await reclaim(owned);
    await exit;
  }
}

describe("an interrupted harness", () => {
  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s stops a tool with its SIGTERM-resistant descendant, starts nothing later and fails",
    async (signal) => {
      const outcome = await interrupt("run", signal);
      expect(outcome.result.code ?? 128).toBeGreaterThan(0);
      expect(outcome.descendantGone, outcome.log).toBe(true);
      expect(outcome.later).toBe(false);
    },
    60_000,
  );

  test("a tool that resists SIGTERM itself is killed after the grace period", async () => {
    const outcome = await interrupt("run", "SIGINT", { RESISTANT_LEADER: "1" });
    expect(outcome.result.code ?? 128).toBeGreaterThan(0);
    expect(outcome.descendantGone, outcome.log).toBe(true);
    expect(outcome.later).toBe(false);
  }, 60_000);

  test("an interrupt while a server is starting stops it with its descendant at once, not at the readiness timeout", async () => {
    const outcome = await interrupt("ready", "SIGINT");
    expect(outcome.result.code ?? 128).toBeGreaterThan(0);
    expect(outcome.descendantGone, outcome.log).toBe(true);
    expect(outcome.later).toBe(false);
  }, 60_000);

  test("an interrupt while a server is serving stops it and its descendant too", async () => {
    const outcome = await interrupt("serving", "SIGTERM");
    expect(outcome.result.code ?? 128).toBeGreaterThan(0);
    expect(outcome.descendantGone, outcome.log).toBe(true);
    expect(outcome.later).toBe(false);
  }, 60_000);
});
