import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { fakeHost } from "../../support/production-host.ts";
import { capture, scratchArea } from "../../support/project.ts";

type Production = typeof import("../../../scripts/testing/production.cjs");
const owned = createRequire(import.meta.url)("../../../scripts/testing/owned.cjs") as typeof import("../../../scripts/testing/owned.cjs");
const production = createRequire(import.meta.url)("../../../scripts/testing/production.cjs") as Production;
type Servers = Parameters<Production["runProduction"]>[0]["servers"];

const scratch = scratchArea("production-run-");
const role = JSON.stringify({ role: "application", dependencyGraph: "root", seedWorkspaceMember: false });
const application = () => scratch.project({ "tooling/project-role.json": role, "package.json": "{}", "next.config.ts": "typedRoutes: true," });

function fakeServers(options: { startFails?: boolean; stopFails?: boolean; onStart?: () => void } = {}) {
  const started: Parameters<Servers["start"]>[0][] = [];
  const stopped: string[] = [];
  const servers: Servers = {
    port: () => Promise.resolve(45678),
    nonce: () => "run-nonce",
    start: (spec) => {
      started.push(spec);
      options.onStart?.();
      if (options.startFails) return Promise.reject(new Error("next start exited (status 1) before it answered"));
      return Promise.resolve({
        pid: 99,
        stop: () => {
          stopped.push("stopped");
          return options.stopFails ? Promise.reject(new Error("could not stop the server")) : Promise.resolve();
        },
        log: () => "",
      });
    },
  };
  return { servers, started, stopped };
}

describe("the production browser run", () => {
  test("builds once, serves that build from a process it owns, runs the suite against it and cleans up", async () => {
    const { host, calls, removed } = fakeHost();
    const { servers, started, stopped } = fakeServers();
    const out = capture();
    const root = application();
    const status = await production.runProduction({
      root,
      io: out.io,
      host,
      servers,
      base: { PATH: "/bin", NODE_ENV: "test", FIXTURE_SERVER_ONLY: "inherited" },
    });
    expect(status).toBe(0);
    expect(calls.map((call) => call.command)).toEqual(["pnpm", "isolate", process.execPath]);
    expect(started).toHaveLength(1);
    expect(started[0]?.cancel).toBeDefined();
    const server = started[0];
    expect(server?.args.slice(1)).toEqual(["start", "--hostname", "127.0.0.1", "--port", "45678"]);
    expect(server?.url).toBe("http://127.0.0.1:45678/e2e-ready");
    expect(server?.expect).toBe("run-nonce");
    expect(server?.env).toMatchObject({ E2E_NONCE: "run-nonce", ...production.RUNTIME });
    expect(server?.env).not.toHaveProperty("NODE_ENV");
    const suite = calls[2];
    expect(suite?.args[0]).toBe(`${root}/node_modules/@playwright/test/cli.js`);
    expect(suite?.args.slice(1)).toEqual(["test"]);
    expect(suite?.cwd).toBe(root);
    expect(suite?.env).toMatchObject({ E2E_BASE_URL: "http://127.0.0.1:45678", E2E_BUILD_PUBLIC: production.BUILD.NEXT_PUBLIC_FIXTURE_PUBLIC });
    expect(suite?.env).not.toHaveProperty("E2E_NONCE");
    expect(stopped).toEqual(["stopped"]);
    expect(removed).toHaveLength(1);
    expect(out.err()).toBe("");
  });

  test("without proved offline isolation nothing is built or served and the run fails with the prerequisite", async () => {
    const { host, calls, removed, staged } = fakeHost({ isolated: false });
    const { servers, started } = fakeServers();
    const out = capture();
    expect(await production.runProduction({ root: application(), io: out.io, host, servers, base: {} })).toBe(1);
    expect([calls, staged, started]).toEqual([[], [], []]);
    expect(out.err()).toMatch(/offline build proof unavailable: no namespaces here/);
    expect(removed).toHaveLength(1);
  });

  test("the build and the server are given different values, so build-time and run-time can be told apart", () => {
    expect(production.BUILD.FIXTURE_SERVER_ONLY).not.toBe(production.RUNTIME.FIXTURE_SERVER_ONLY);
    expect(production.BUILD.NEXT_PUBLIC_FIXTURE_PUBLIC).not.toBe(production.RUNTIME.NEXT_PUBLIC_FIXTURE_PUBLIC);
  });

  test("a failing browser suite fails the run, and the server and the fixture are still cleaned up", async () => {
    const { host, removed } = fakeHost({ statuses: [0, 0, 1] });
    const { servers, stopped } = fakeServers();
    const out = capture();
    expect(await production.runProduction({ root: application(), io: out.io, host, servers, base: {} })).toBe(1);
    expect(stopped).toEqual(["stopped"]);
    expect(removed).toHaveLength(1);
    expect(out.err()).toMatch(/browser suite failed; a browser that cannot launch lacks its prerequisites/);
  });

  test("an interrupt during the run starts no suite, still stops the server and removes the fixture, and fails", async () => {
    const cancel = owned.createCancellation();
    const { host, calls, removed } = fakeHost();
    const { servers, stopped } = fakeServers({
      onStart: () => {
        cancel.cancel("SIGINT");
      },
    });
    const out = capture();
    expect(await production.runProduction({ root: application(), io: out.io, host, servers, base: {}, cancel })).toBe(1);
    expect(calls.map((call) => call.command)).toEqual(["pnpm", "isolate", process.execPath]);
    expect(stopped).toEqual(["stopped"]);
    expect(removed).toHaveLength(1);
    expect(out.err()).toMatch(/browser suite interrupted/);
    expect(out.err()).not.toMatch(/browser suite failed/);
  });

  test("an interrupt before the server is chosen starts no server and no suite", async () => {
    const cancel = owned.createCancellation();
    const { host, calls, removed } = fakeHost();
    const { servers, started } = fakeServers();
    servers.port = () => {
      cancel.cancel("SIGTERM");
      return Promise.resolve(45678);
    };
    expect(await production.runProduction({ root: application(), io: capture().io, host, servers, base: {}, cancel })).toBe(1);
    expect(started).toEqual([]);
    expect(calls.map((call) => call.command)).toEqual(["pnpm", "isolate"]);
    expect(removed).toHaveLength(1);
  });

  test("the fixture is removed even when stopping the server fails, and the failure is not a pass", async () => {
    const { host, removed } = fakeHost();
    const { servers } = fakeServers({ stopFails: true });
    const out = capture();
    expect(await production.runProduction({ root: application(), io: out.io, host, servers, base: {} })).toBe(1);
    expect(removed).toHaveLength(1);
    expect(out.err()).toMatch(/cleanup failed: could not stop the server/);
  });

  test("a fixture that cannot be removed is reported and the run does not pass", async () => {
    const { host } = fakeHost({ removeFails: "/scratch/production-fixture-1" });
    const out = capture();
    expect(await production.runProduction({ root: application(), io: out.io, host, servers: fakeServers().servers, base: {} })).toBe(1);
    expect(out.err()).toMatch(/cleanup failed: cannot remove \/scratch\/production-fixture-1/);
  });

  test("a signal-killed or missing suite process is a failure, never a pass", async () => {
    const { host } = fakeHost({ statuses: [0, 0, null] });
    expect(await production.runProduction({ root: application(), io: capture().io, host, servers: fakeServers().servers, base: {} })).toBe(1);
  });

  test("a failed build never starts a server", async () => {
    const { host, removed } = fakeHost({ statuses: [0, 1] });
    const { servers, started } = fakeServers();
    expect(await production.runProduction({ root: application(), io: capture().io, host, servers, base: {} })).toBe(1);
    expect(started).toEqual([]);
    expect(removed).toHaveLength(1);
  });

  test("a server that does not start is reported with its reason, the suite does not run, and the fixture is removed", async () => {
    const { host, calls, removed } = fakeHost();
    const out = capture();
    const status = await production.runProduction({ root: application(), io: out.io, host, servers: fakeServers({ startFails: true }).servers, base: {} });
    expect(status).toBe(1);
    expect(calls.map((call) => call.command)).toEqual(["pnpm", "isolate"]);
    expect(out.err()).toMatch(/next start exited \(status 1\)/);
    expect(removed).toHaveLength(1);
  });

  test("refuses to start in a generator or with a managed agent-rules block, before anything is staged", async () => {
    const { host, calls } = fakeHost();
    const out = capture();
    const generator = scratch.project({
      "tooling/project-role.json": JSON.stringify({ role: "generator", dependencyGraph: "root", seedWorkspaceMember: false }),
    });
    expect(await production.runProduction({ root: generator, io: out.io, host, servers: fakeServers().servers, base: {} })).toBe(1);
    const managed = scratch.project({ "tooling/project-role.json": role, "CLAUDE.md": "<!-- BEGIN:nextjs-agent-feedback -->\n" });
    expect(await production.runProduction({ root: managed, io: out.io, host, servers: fakeServers().servers, base: {} })).toBe(1);
    expect(calls).toEqual([]);
    expect(out.err()).toMatch(/runs in an application[\s\S]*CLAUDE\.md contains the Next\.js agent feedback block/);
  });
});
