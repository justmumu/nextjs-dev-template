import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { scratchArea } from "../support/project.ts";

// The plugin step runs in a real child process with the real process runner, the real disk and a
// fixture `claude` executable on the PATH that rewrites the tracked settings the way the real CLI
// does. Interruptions are real signals: the settings must come back byte for byte and the process
// must still end by the signal, never by a success.

const { area } = scratchArea("plugin-interruption-");
const plugins = join(import.meta.dirname, "../../scripts/core/plugins.cjs");
const ORIGINAL = JSON.stringify({ enabledPlugins: { "compound-engineering@compound-engineering-plugin": true } }, null, 2) + "\n";
let counter = 0;

// Every setup process is the leader of its own process group, so the fixture CLI and anything it
// started share that group. Whatever way a test ends, the group is killed by its own id: nothing
// else is signalled, and descendants go even when the parent is already gone.
const groups = new Set<number>();

// A failed spawn reports pid 0 (or none): that is not a group this test owns, and -0, -1 or -undefined
// would address the caller's own group or every process.
function ownGroup(pid: number | undefined): void {
  if (Number.isInteger(pid) && pid !== undefined && pid > 1) groups.add(pid);
}

afterEach(() => {
  const failures: unknown[] = [];
  for (const group of groups) {
    try {
      process.kill(-group, "SIGKILL");
    } catch (error) {
      // ESRCH: the group has no members left. Anything else is a real cleanup failure, reported after
      // the remaining groups were killed too.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(error);
    }
  }
  groups.clear();
  if (failures.length > 0) throw new AggregateError(failures, "owned process group cleanup failed");
});

function runSetup(script: string, root: string) {
  // Node honours `detached` for the synchronous spawn too, but its typings omit the option.
  const options: SpawnSyncOptionsWithStringEncoding & { detached: boolean } = { env: env(root), encoding: "utf8", timeout: 30_000, detached: true };
  const result = spawnSync(process.execPath, ["-e", script], options);
  ownGroup(result.pid);
  return result;
}

type Behavior = "succeed" | "fail" | "kill-parent-INT" | "kill-parent-TERM" | "hang";

function project(behavior: Behavior) {
  const root = join(area, `p${++counter}`);
  mkdirSync(join(root, ".claude"), { recursive: true });
  mkdirSync(join(root, "bin"));
  const settings = join(root, ".claude/settings.json");
  writeFileSync(settings, ORIGINAL);
  const ready = join(root, "ready");
  const cli = [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(settings)}, 'changed by the fixture CLI');`,
    `const behavior = ${JSON.stringify(behavior)};`,
    "if (behavior === 'fail') { process.stderr.write('network down\\n'); process.exit(1); }",
    "if (behavior.startsWith('kill-parent-')) process.kill(process.ppid, 'SIG' + behavior.slice('kill-parent-'.length));",
    `if (behavior === 'hang') { fs.writeFileSync(${JSON.stringify(ready)}, 'x'); setInterval(() => {}, 1000); } else process.exit(0);`,
    "",
  ].join("\n");
  const bin = join(root, "bin/claude");
  writeFileSync(bin, cli);
  chmodSync(bin, 0o755);
  const script = [
    `const plugins = require(${JSON.stringify(plugins)});`,
    `const host = plugins.realHost({ path: ${JSON.stringify(join(root, "bin"))} });`,
    "const io = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) };",
    `Promise.resolve(plugins.installPlugins(${JSON.stringify(root)}, io, host)).then(() => process.stdout.write('finished\\n'));`,
  ].join("\n");
  return { root, ready, script, settings };
}

const env = (root: string) => ({ ...process.env, PATH: join(root, "bin") });

describe("the Claude settings come back byte for byte", () => {
  test("after a successful install and after an ordinary CLI failure, which only warns", () => {
    for (const behavior of ["succeed", "fail"] as const) {
      const { root, script, settings } = project(behavior);
      const result = runSetup(script, root);
      expect(result.status, behavior).toBe(0);
      expect(result.stdout, behavior).toContain("finished");
      expect(readFileSync(settings, "utf8"), behavior).toBe(ORIGINAL);
      if (behavior === "fail") expect(result.stderr).toMatch(/warning: Claude Code plugin install failed/);
    }
  });

  test.each(["INT", "TERM"] as const)("when the CLI interrupts the setup process with SIG%s: restored, and the process still ends by that signal", (name) => {
    const { root, script, settings } = project(`kill-parent-${name}`);
    const result = runSetup(script, root);
    expect(result.signal).toBe(`SIG${name}`);
    expect(result.stdout).not.toContain("finished");
    expect(readFileSync(settings, "utf8")).toBe(ORIGINAL);
  });

  test.each(["SIGINT", "SIGTERM"] as const)(
    "when %s arrives while the CLI is running: the CLI is stopped, the bytes are restored, the process ends by the signal",
    async (name) => {
      const { root, ready, script, settings } = project("hang");
      const child = spawn(process.execPath, ["-e", script], { env: env(root), stdio: ["ignore", "pipe", "pipe"], detached: true });
      ownGroup(child.pid);
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("close", (code, signal) => {
          resolve({ code, signal });
        });
      });
      const deadline = Date.now() + 20_000;
      while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(ready)).toBe(true);
      expect(readFileSync(settings, "utf8")).not.toBe(ORIGINAL);
      child.kill(name);
      const outcome = await ended;
      expect(outcome.signal).toBe(name);
      expect(readFileSync(settings, "utf8")).toBe(ORIGINAL);
    },
  );
});
