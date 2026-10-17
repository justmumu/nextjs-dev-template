import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { scratchArea } from "../support/project.ts";

const processes = createRequire(import.meta.url)("../../scripts/core/process.cjs") as typeof import("../../scripts/core/process.cjs");
const scratch = scratchArea("process-");

describe("subprocess wrapper", () => {
  test("captures status and both streams of a command run without a shell", () => {
    const cwd = scratch.project();
    const result = processes.run(process.execPath, ["-e", 'process.stdout.write("out " + process.cwd()); process.stderr.write("err"); process.exitCode = 3'], {
      cwd,
    });
    expect(result).toEqual({ status: 3, stdout: `out ${cwd}`, stderr: "err" });
  });

  test("passes a literal argument through untouched", () => {
    const result = processes.run(process.execPath, ["-p", "process.argv[1]", "$(id); `x`"], { cwd: scratch.project() });
    expect(result.stdout.trim()).toBe("$(id); `x`");
  });

  test("uses the given environment and nothing else", () => {
    const result = processes.run(process.execPath, ["-p", "process.env.U5_PROBE ?? 'unset'"], {
      cwd: scratch.project(),
      env: { U5_PROBE: "set", PATH: process.env.PATH },
    });
    expect(result.stdout.trim()).toBe("set");
  });

  test("a command that cannot start has no status and says why", () => {
    const result = processes.run("definitely-not-a-command-u5", [], { cwd: scratch.project() });
    expect(result.status).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/ENOENT/);
  });

  test("logged output is redacted on its way to the writers", () => {
    const out: string[] = [];
    const err: string[] = [];
    const script = 'process.stdout.write("//r.example/:_authToken=top-secret\\n"); process.stderr.write("https://user:pw" + "@" + "r.example/x\\n")';
    const result = processes.runLogged(process.execPath, ["-e", script], {
      cwd: scratch.project(),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });
    expect(result.status).toBe(0);
    expect(out.join("") + err.join("")).not.toMatch(/top-secret|user:pw/);
    expect(out.join("")).toContain("[redacted]");
    expect(err.join("")).toContain("[redacted]@r.example");
  });

  test("silent commands write nothing", () => {
    const written: string[] = [];
    processes.runLogged(process.execPath, ["-e", ""], { cwd: scratch.project(), stdout: (text) => written.push(text), stderr: (text) => written.push(text) });
    expect(written).toEqual([]);
  });
});
