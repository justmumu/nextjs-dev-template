import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { fakeHost as makeHost } from "../support/production-host.ts";
import { capture, put, scratchArea } from "../support/project.ts";

// The artifact run with its tools scripted but its staging, composing, inspecting and removing real.
type Artifact = typeof import("../../scripts/testing/artifact.cjs");
const artifact = createRequire(import.meta.url)("../../scripts/testing/artifact.cjs") as Artifact;
const stageModule = createRequire(import.meta.url)("../../scripts/testing/stage.cjs") as typeof import("../../scripts/testing/stage.cjs");
const { createCancellation } = createRequire(import.meta.url)("../../scripts/testing/owned.cjs") as typeof import("../../scripts/testing/owned.cjs");
const scratch = scratchArea("production-artifact-run-");
const fakeHost = (options: Parameters<typeof makeHost>[0] = {}) => {
  const fake = makeHost({ ...options, scratch: (prefix) => scratch.project({ [`${prefix}marker`]: "" }) });
  fake.host.stage = stageModule.stage;
  return fake;
};

describe("the standalone run", () => {
  const role = JSON.stringify({ role: "application", dependencyGraph: "root", seedWorkspaceMember: false });
  const application = () =>
    scratch.project({
      "tooling/project-role.json": role,
      "package.json": JSON.stringify({ devDependencies: { typescript: "6.0.3", vitest: "5.0.5" } }),
      "next.config.ts": "typedRoutes: true,",
    });

  /** A build step that writes the output a real standalone build would leave. */
  function buildingHost(options: { leak?: string; statuses?: (number | null)[] } = {}) {
    const fake = fakeHost(options.statuses ? { statuses: options.statuses } : {});
    const run = fake.host.run;
    fake.host.run = async (command, args, runOptions) => {
      if (command === "isolate") {
        put(runOptions.cwd, ".next/standalone/server.js", "server");
        put(runOptions.cwd, ".next/standalone/node_modules/next/package.json", "{}");
        if (options.leak) put(runOptions.cwd, `.next/standalone/node_modules/${options.leak}/package.json`, "{}");
        put(runOptions.cwd, ".next/static/chunks/main.js", "main");
        put(runOptions.cwd, "public/favicon.svg", "<svg/>");
      }
      return run(command, args, runOptions);
    };
    return fake;
  }

  test("serves the complete artifact, then proves the check can fail by serving one without assets", async () => {
    const { host, removed } = buildingHost();
    const served: { artifact: string; hasAssets: boolean }[] = [];
    const out = capture();
    const status = await artifact.runArtifact({
      root: application(),
      io: out.io,
      host,
      base: {},
      serve: ({ artifact: directory }) => {
        const hasAssets = readdirHas(directory);
        served.push({ artifact: directory, hasAssets });
        return Promise.resolve(hasAssets ? [] : ["/favicon.svg answered 404 with 9 bytes"]);
      },
    });
    expect(status).toBe(0);
    expect(served.map((entry) => entry.hasAssets)).toEqual([true, false]);
    expect(out.out()).toMatch(/negative control detected 1 missing asset/);
    expect(removed).toHaveLength(4);
  });

  test("an interrupt while the artifact is served fails the run without serving the negative control, and everything is removed", async () => {
    const { host, removed } = buildingHost();
    const cancel = createCancellation();
    const served: string[] = [];
    const out = capture();
    const status = await artifact.runArtifact({
      root: application(),
      io: out.io,
      host,
      base: {},
      cancel,
      serve: ({ artifact: directory }) => {
        served.push(directory);
        cancel.cancel("SIGINT");
        return Promise.resolve([]);
      },
    });
    expect(status).toBe(1);
    expect(served).toHaveLength(1);
    expect(out.out()).not.toMatch(/negative control/);
    expect(out.err()).not.toMatch(/negative control failed/);
    expect(removed).toHaveLength(4);
  });

  test("an incomplete artifact fails the run", async () => {
    const { host } = buildingHost();
    const out = capture();
    const status = await artifact.runArtifact({
      root: application(),
      io: out.io,
      host,
      base: {},
      serve: () => Promise.resolve(["/favicon.svg answered 404 with 9 bytes"]),
    });
    expect(status).toBe(1);
    expect(out.err()).toMatch(/artifact is incomplete: \/favicon\.svg answered 404/);
  });

  test("a check that cannot fail is itself a failure", async () => {
    const { host } = buildingHost();
    const out = capture();
    expect(await artifact.runArtifact({ root: application(), io: out.io, host, base: {}, serve: () => Promise.resolve([]) })).toBe(1);
    expect(out.err()).toMatch(/negative control failed/);
  });

  test("a development dependency in the artifact fails the run before anything is served", async () => {
    const { host } = buildingHost({ leak: "typescript" });
    const out = capture();
    let served = false;
    const status = await artifact.runArtifact({
      root: application(),
      io: out.io,
      host,
      base: {},
      serve: () => {
        served = true;
        return Promise.resolve([]);
      },
    });
    expect(status).toBe(1);
    expect(served).toBe(false);
    expect(out.err()).toMatch(/not self-contained: development dependencies typescript/);
  });

  test("a failed build is reported and everything created is removed", async () => {
    const { host, removed } = buildingHost({ statuses: [0, 1] });
    expect(await artifact.runArtifact({ root: application(), io: capture().io, host, base: {} })).toBe(1);
    expect(removed).toHaveLength(3);
  });

  test("a server that fails to start is reported", async () => {
    const { host } = buildingHost();
    const out = capture();
    const status = await artifact.runArtifact({
      root: application(),
      io: out.io,
      host,
      base: {},
      serve: () => Promise.reject(new Error("server.js exited (status 1) before it answered")),
    });
    expect(status).toBe(1);
    expect(out.err()).toMatch(/server\.js exited/);
  });
});

function readdirHas(directory: string): boolean {
  try {
    readFileSync(join(directory, "public/favicon.svg"));
    return true;
  } catch {
    return false;
  }
}
