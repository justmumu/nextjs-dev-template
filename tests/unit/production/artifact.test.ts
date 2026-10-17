import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { fakeHost } from "../../support/production-host.ts";
import { capture, scratchArea } from "../../support/project.ts";

type Artifact = typeof import("../../../scripts/testing/artifact.cjs");
const artifact = createRequire(import.meta.url)("../../../scripts/testing/artifact.cjs") as Artifact;

const scratch = scratchArea("production-artifact-");

type Response = { status: number; type: string; bytes: number; text: string };
const ok = (text: string): Response => ({ status: 200, type: "text/plain", bytes: Buffer.byteLength(text), text });
const PAGE = '<link rel="stylesheet" href="/_next/static/chunks/app.css"/><script src="/_next/static/chunks/main.js" async></script>';

function server(overrides: Record<string, Response> = {}) {
  const routes: Record<string, Response> = {
    "/": ok(PAGE),
    "/_next/static/chunks/app.css": ok("body{}"),
    "/_next/static/chunks/main.js": ok("main()"),
    "/favicon.svg": ok("<svg/>"),
    ...overrides,
  };
  return (path: string) => Promise.resolve(routes[path] ?? { status: 404, type: "text/html", bytes: 9, text: "not found" });
}

describe("the assets a standalone artifact must serve", () => {
  test("finds the fingerprinted assets a page references, once each, then the favicon", () => {
    expect(artifact.assetPaths(`${PAGE}<script src="/_next/static/chunks/main.js?v=1"></script><a href="/about">x</a>`)).toEqual([
      "/_next/static/chunks/app.css",
      "/_next/static/chunks/main.js",
      "/favicon.svg",
    ]);
  });

  test("a complete artifact misses nothing", async () => {
    expect(await artifact.missingAssets(server())).toEqual([]);
  });

  test("names every asset that does not arrive", async () => {
    const missing = await artifact.missingAssets(
      server({ "/_next/static/chunks/main.js": { status: 404, type: "", bytes: 9, text: "x" }, "/favicon.svg": { status: 200, type: "", bytes: 0, text: "" } }),
    );
    expect(missing).toEqual(["/_next/static/chunks/main.js answered 404 with 9 bytes", "/favicon.svg answered 200 with 0 bytes"]);
  });

  test("a page that references no script or stylesheet is incomplete, not vacuously fine", async () => {
    expect(await artifact.missingAssets(server({ "/": ok("<p>hello</p>") }))).toEqual(["the page references no script", "the page references no stylesheet"]);
  });

  test("a page that does not answer is the only thing reported", async () => {
    expect(await artifact.missingAssets(server({ "/": { status: 500, type: "", bytes: 0, text: "" } }))).toEqual(["/ answered 500"]);
  });
});

describe("fetching from the served artifact", () => {
  test("reads status, type, size and text, and asks for the path under the base address with a time limit", async () => {
    const asked: string[] = [];
    const get = artifact.httpGet("http://127.0.0.1:9", (url, init) => {
      asked.push(typeof url === "string" ? url : "not a string");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(new Response("héllo", { status: 200, headers: { "content-type": "text/css" } }));
    });
    expect(await get("/a.css")).toEqual({ status: 200, type: "text/css", bytes: 6, text: "héllo" });
    expect(asked).toEqual(["http://127.0.0.1:9/a.css"]);
  });

  test("a response without a content type has an empty one", async () => {
    const get = artifact.httpGet("http://x", () => Promise.resolve(new Response(null, { status: 404 })));
    expect(await get("/")).toMatchObject({ status: 404, type: "", bytes: 0 });
  });
});

describe("package names in a runtime tree", () => {
  test("runtime reachability follows optional and peer edges, stops cycles and ignores dev-only packages", () => {
    const manifests: Record<string, Record<string, unknown>> = {
      next: { dependencies: { sharp: "1" }, optionalDependencies: { absent: "1" }, peerDependencies: { react: "1" }, devDependencies: { typescript: "1" } },
      sharp: { dependencies: { semver: "1", next: "1" } },
      semver: {},
      react: {},
    };
    expect(
      [
        ...artifact.runtimeNames(["next"], "/project", (name) => (manifests[name] ? { directory: "/packages/" + name, manifest: manifests[name] } : null)),
      ].sort(),
    ).toEqual(["next", "react", "semver", "sharp"]);
  });

  test.each([
    ["next@16.4.1", "next"],
    ["@swc+helpers@0.5.15", "@swc/helpers"],
    ["react-dom@19.3.0(react@19.3.0)", "react-dom"],
    ["@types+node@24.19.2", "@types/node"],
    ["local", "local"],
  ])("%s is %s", (entry, name) => {
    expect(artifact.storeName(entry)).toBe(name);
  });

  test("lists what is installed below a node_modules directory, scoped packages included, hidden entries not", () => {
    const dir = scratch.project({ "node_modules/next/package.json": "{}", "node_modules/@swc/helpers/package.json": "{}", "node_modules/.bin/x": "" });
    expect(artifact.installedNames(join(dir, "node_modules")).sort()).toEqual(["@swc/helpers", "next"]);
    expect(artifact.installedNames(join(dir, "absent"))).toEqual([]);
  });

  test("finds a development dependency both directly and in pnpm's virtual store", () => {
    const dir = scratch.project({
      "node_modules/next/package.json": "{}",
      "node_modules/typescript/package.json": "{}",
      "node_modules/.pnpm/@types+node@24.19.2/node_modules/@types/node/index.d.ts": "",
      "node_modules/.pnpm/next@16.4.1/node_modules/next/package.json": "{}",
    });
    expect(artifact.developmentLeaks(dir, ["typescript", "@types/node", "vitest"])).toEqual(["typescript", "@types/node"]);
    expect(artifact.developmentLeaks(scratch.project({ "server.js": "" }), ["typescript"])).toEqual([]);
  });

  test("finds ancestors through which a dependency could still be resolved", () => {
    const dir = scratch.project({ "node_modules/x/package.json": "{}", "inner/server.js": "" });
    expect(artifact.resolvingAncestors(join(dir, "inner"))).toContain(dir);
    expect(artifact.resolvingAncestors(join(scratch.project({ "server.js": "" }), "inner"))).not.toContain(dir);
  });
});

describe("the standalone run without offline isolation", () => {
  const role = JSON.stringify({ role: "application", dependencyGraph: "root", seedWorkspaceMember: false });

  test("builds nothing, serves nothing, removes what it named and fails with the prerequisite", async () => {
    const { host, calls, removed, staged } = fakeHost({ isolated: false });
    const out = capture();
    const root = scratch.project({ "tooling/project-role.json": role, "package.json": "{}" });
    let served = false;
    const status = await artifact.runArtifact({
      root,
      io: out.io,
      host,
      base: {},
      serve: () => {
        served = true;
        return Promise.resolve([]);
      },
    });
    expect(status).toBe(1);
    expect([calls, staged, served]).toEqual([[], [], false]);
    expect(out.err()).toMatch(/offline build proof unavailable: no namespaces here/);
    expect(removed).toHaveLength(3);
  });

  test("every directory is still removed when removing one fails, and the run does not pass", async () => {
    const { host, removed } = fakeHost({ isolated: false, removeFails: "/scratch/artifact-fixture-1" });
    const out = capture();
    const root = scratch.project({ "tooling/project-role.json": role, "package.json": "{}" });
    expect(await artifact.runArtifact({ root, io: out.io, host, base: {} })).toBe(1);
    expect(removed).toHaveLength(3);
    expect(out.err()).toMatch(/cleanup failed: cannot remove \/scratch\/artifact-fixture-1/);
  });

  test("refuses to run in a generator", async () => {
    const { host, calls } = fakeHost();
    const generator = scratch.project({
      "tooling/project-role.json": JSON.stringify({ role: "generator", dependencyGraph: "root", seedWorkspaceMember: false }),
    });
    expect(await artifact.runArtifact({ root: generator, io: capture().io, host, base: {} })).toBe(1);
    expect(calls).toEqual([]);
  });
});
