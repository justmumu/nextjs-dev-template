import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { fakeHost } from "../../support/production-host.ts";
import { capture, scratchArea } from "../../support/project.ts";

const require = createRequire(import.meta.url);
type Harness = typeof import("../../../scripts/testing/harness.cjs");
type Owned = typeof import("../../../scripts/testing/owned.cjs");
const harness = require("../../../scripts/testing/harness.cjs") as Harness;
const owned = require("../../../scripts/testing/owned.cjs") as Owned;

const scratch = scratchArea("production-harness-");
const roleFile = (role: string) => JSON.stringify({ role, dependencyGraph: "root", seedWorkspaceMember: false });

describe("preconditions", () => {
  test("a generator is told to render an application first", () => {
    expect(harness.preconditions(scratch.project({ "tooling/project-role.json": roleFile("generator") }))).toEqual([
      expect.stringMatching(/runs in an application/),
    ]);
  });

  test("an application whose instructions carry a managed Next.js block is refused before anything is built", () => {
    const root = scratch.project({ "tooling/project-role.json": roleFile("application"), "AGENTS.md": "<!-- BEGIN:nextjs-agent-rules -->\n" });
    expect(harness.preconditions(root)).toEqual([expect.stringMatching(/AGENTS\.md contains the Next\.js agent rules block/)]);
  });

  test("a clean application passes", () => {
    expect(harness.preconditions(scratch.project({ "tooling/project-role.json": roleFile("application"), "AGENTS.md": "# Rules\n" }))).toEqual([]);
  });
});

describe("prepareFixture", () => {
  const prepare = (host: ReturnType<typeof fakeHost>["host"], extra: Partial<Parameters<Harness["prepareFixture"]>[0]> = {}) => {
    const out = capture();
    const result = harness.prepareFixture({ root: "/application", dir: "/fixture", io: out.io, host, kind: "production", buildEnv: {}, ...extra });
    return { result, out };
  };

  test("stages, installs from the frozen lock offline, then builds once without network, in a production environment", async () => {
    const { host, calls, staged } = fakeHost();
    const { result, out } = prepare(host, { buildEnv: { FIXTURE_SERVER_ONLY: "build-value" } });
    expect(await result).toBe(true);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ source: "/application", dest: "/fixture" });
    expect(Object.keys(staged[0]?.files ?? {})).toContain("src/app/e2e-ready/route.ts");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ command: "pnpm", args: ["install", "--frozen-lockfile", "--offline"], cwd: "/fixture" });
    expect(calls[1]).toMatchObject({ command: "isolate", cwd: "/fixture" });
    expect(calls[1]?.args).toEqual([process.execPath, "/fixture/node_modules/next/dist/bin/next", "build"]);
    expect(calls[1]?.env).toMatchObject({ FIXTURE_SERVER_ONLY: "build-value", NEXT_TELEMETRY_DISABLED: "1" });
    for (const call of calls) {
      expect(call.env).not.toHaveProperty("NODE_ENV");
      expect(Object.keys(call.env).filter((name) => /^npm_config_|^pnpm_config_verify/.test(name))).toEqual([]);
    }
    expect(out.out()).toMatch(/no outbound network/);
  });

  test("passes a transform on to staging", async () => {
    const { host, staged } = fakeHost();
    const transform = { "next.config.ts": (text: string) => text };
    await prepare(host, { kind: "artifact", transform }).result;
    expect(staged[0]?.transform).toBe(transform);
  });

  test("without proved offline isolation nothing is staged, installed or built, and the platform limit is explained", async () => {
    const { host, calls, staged } = fakeHost({ isolated: false });
    const { result, out } = prepare(host);
    expect(await result).toBe(false);
    expect(calls).toEqual([]);
    expect(staged).toEqual([]);
    expect(out.err()).toMatch(/offline build proof unavailable: no namespaces here/);
    expect(out.err()).toMatch(/Linux with unprivileged user and network namespaces: unshare \(util-linux\) and ip \(iproute2\)/);
    expect(out.err()).toMatch(/do not pass without that proof/);
    expect(out.err()).toMatch(/`pnpm run build` is not affected/);
    expect(out.out()).not.toMatch(/staged|build:/);
  });

  test("a failed install stops before any build and tells how to warm the store", async () => {
    const { host, calls } = fakeHost({ statuses: [1] });
    const { result, out } = prepare(host);
    expect(await result).toBe(false);
    expect(calls).toHaveLength(1);
    expect(out.err()).toMatch(/run `pnpm install` in the project once/);
  });

  test("a failed build is reported", async () => {
    const { host } = fakeHost({ statuses: [0, 1] });
    const { result, out } = prepare(host);
    expect(await result).toBe(false);
    expect(out.err()).toMatch(/production build failed/);
  });

  test("a cancelled run stages nothing more and is not reported as a failed install or build", async () => {
    const before = owned.createCancellation();
    before.cancel("SIGINT");
    const idle = fakeHost();
    const early = prepare(idle.host, { cancel: before });
    expect(await early.result).toBe(false);
    expect([idle.calls, idle.staged]).toEqual([[], []]);

    const cancel = owned.createCancellation();
    const duringInstall = fakeHost();
    const run = duringInstall.host.run;
    duringInstall.host.run = (...args) => {
      cancel.cancel("SIGTERM");
      return run(...args);
    };
    const interrupted = prepare(duringInstall.host, { cancel });
    expect(await interrupted.result).toBe(false);
    expect(duringInstall.calls).toHaveLength(1);
    expect(interrupted.out.err()).toBe("");
  });
});

describe("running as the main program", () => {
  function fakeProcess() {
    const listeners = new Map<string, () => void>();
    const out: string[] = [];
    const err: string[] = [];
    const proc: Parameters<Harness["main"]>[1] = {
      on: (signal, listener) => listeners.set(signal, listener),
      stdout: { write: (text) => out.push(text) },
      stderr: { write: (text) => err.push(text) },
    };
    return { proc, listeners, out, err };
  }
  function fakeTools(failures: string[] = []) {
    let stops = 0;
    const host = {
      ...fakeHost().host,
      terminate: () => {
        stops++;
        return Promise.resolve(failures);
      },
    };
    return { host, stops: () => stops };
  }

  test("the result is the exit status and the harness writes through the process's streams", async () => {
    const run = fakeProcess();
    const tools = fakeTools();
    await harness.main(
      ({ io }) => {
        io.stdout("hello\n");
        io.stderr("warning\n");
        return Promise.resolve(3);
      },
      run.proc,
      owned.createCancellation(),
      tools.host,
    );
    expect(run.proc.exitCode).toBe(3);
    expect([run.out, run.err]).toEqual([["hello\n"], ["warning\n"]]);
    expect([...run.listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    expect(tools.stops()).toBe(0);
  });

  test("an interrupt cancels the run and stops the tools once; however the run ends the status is never zero", async () => {
    const run = fakeProcess();
    const tools = fakeTools();
    const cancel = owned.createCancellation();
    const seen: boolean[] = [];
    await harness.main(
      ({ cancel: shared }) => {
        run.listeners.get("SIGINT")?.();
        run.listeners.get("SIGINT")?.();
        run.listeners.get("SIGTERM")?.();
        seen.push(shared.isCancelled());
        return Promise.resolve(0);
      },
      run.proc,
      cancel,
      tools.host,
    );
    expect(seen).toEqual([true]);
    expect(cancel.signal).toBe("SIGINT");
    expect(tools.stops()).toBe(1);
    expect(run.proc.exitCode).toBe(130);
  });

  test.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ])("%s ends the process with %i even when the run fails afterwards", async (signal, status) => {
    const run = fakeProcess();
    await harness.main(
      () => {
        run.listeners.get(signal)?.();
        return Promise.reject(new Error("cleanup went wrong"));
      },
      run.proc,
      owned.createCancellation(),
      fakeTools().host,
    );
    expect(run.proc.exitCode).toBe(status);
    expect(run.err).toEqual(["cleanup went wrong\n"]);
  });

  test("a tool that could not be stopped is reported", async () => {
    const run = fakeProcess();
    await harness.main(
      () => {
        run.listeners.get("SIGINT")?.();
        return Promise.resolve(1);
      },
      run.proc,
      owned.createCancellation(),
      fakeTools(["operation not permitted"]).host,
    );
    expect(run.err).toEqual(["could not stop a tool: operation not permitted\n"]);
  });

  test("execute answers with the status, removes its interrupt listeners afterwards and never answers zero for an interrupted run", async () => {
    const run = fakeProcess();
    const removed: string[] = [];
    const proc = { ...run.proc, off: (signal: string) => removed.push(signal) };
    expect(await harness.execute(() => Promise.resolve(4), proc, owned.createCancellation(), fakeTools().host)).toBe(4);
    expect(removed.sort()).toEqual(["SIGINT", "SIGTERM"]);
    const again = fakeProcess();
    const interrupted = await harness.execute(
      () => {
        again.listeners.get("SIGTERM")?.();
        return Promise.resolve(0);
      },
      again.proc,
      owned.createCancellation(),
      fakeTools().host,
    );
    expect(interrupted).toBe(143);
  });

  test("a harness that throws fails the process with its message", async () => {
    const run = fakeProcess();
    await harness.main(() => Promise.reject(new Error("boom")), run.proc, owned.createCancellation(), fakeTools().host);
    expect(run.proc.exitCode).toBe(1);
    expect(run.err).toEqual(["boom\n"]);
  });
});

describe("the real host once the run was cancelled", () => {
  test("starts no tool at all", async () => {
    const cancel = owned.createCancellation();
    cancel.cancel("SIGINT");
    const host = harness.realHost(cancel);
    expect(await host.run("definitely-not-a-command-u10", [], { cwd: "/", env: {} })).toBeNull();
    expect(await host.terminate()).toEqual([]);
  });
});
