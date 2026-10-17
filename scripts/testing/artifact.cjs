// @ts-check
"use strict";
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const nodePath = require("node:path");
const { cleanEnv } = require("./environment.cjs");
const { standaloneConfig } = require("./fixtures.cjs");
const { main, prepareFixture, preconditions } = require("./harness.cjs");
const { attemptAll, createCancellation, freePort, startOwned } = require("./owned.cjs");
const { readObject, isObject } = require("../core/json.cjs");

const START_TIMEOUT_MS = 60_000;

/**
 * @typedef {import("./harness.cjs").Io} Io
 * @typedef {import("./harness.cjs").Host} Host
 * @typedef {import("./owned.cjs").Cancellation} Cancellation
 * @typedef {{ status: number, type: string, bytes: number }} Fetched
 */

/**
 * Copies what a deployment of the standalone output consists of: the traced server, and the
 * `public` directory and `.next/static` that Next.js leaves for the deployer to place. With
 * `assets: false` the last two are left out, which is the failure the harness must detect.
 * @param {{ fixture: string, destination: string, assets: boolean }} options
 */
function composeArtifact({ fixture, destination, assets }) {
  fs.cpSync(nodePath.join(fixture, ".next", "standalone"), destination, { recursive: true, verbatimSymlinks: true });
  if (!assets) return;
  fs.cpSync(nodePath.join(fixture, "public"), nodePath.join(destination, "public"), { recursive: true });
  fs.cpSync(nodePath.join(fixture, ".next", "static"), nodePath.join(destination, ".next", "static"), { recursive: true });
}

/** @param {string} directory @returns {string[]} the names of the packages installed directly below a node_modules directory, scoped ones as @scope/name */
function installedNames(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) =>
      entry.name.startsWith("@") ? fs.readdirSync(nodePath.join(directory, entry.name)).map((name) => `${entry.name}/${name}`) : [entry.name],
    );
}

/** @param {string} entry a pnpm virtual store directory such as `@scope+name@1.0.0(peer@2.0.0)` @returns {string} the package name */
function storeName(entry) {
  const plain = entry.replace("+", "/");
  const at = plain.indexOf("@", 1);
  return at === -1 ? plain : plain.slice(0, at);
}

/**
 * @param {string} artifact
 * @param {readonly string[]} development the project's development dependency names
 * @returns {string[]} development dependencies present in the artifact's runtime tree
 */
function developmentLeaks(artifact, development) {
  const modules = nodePath.join(artifact, "node_modules");
  const present = new Set([
    ...installedNames(modules),
    ...(fs.existsSync(nodePath.join(modules, ".pnpm"))
      ? fs
          .readdirSync(nodePath.join(modules, ".pnpm"))
          .filter((name) => !name.startsWith("."))
          .map(storeName)
      : []),
  ]);
  return development.filter((name) => present.has(name));
}

/** @param {string} directory @returns {string[]} the ancestors of a directory that hold a node_modules directory, through which a dependency could be found */
function resolvingAncestors(directory) {
  const found = [];
  for (let current = nodePath.dirname(directory); ; current = nodePath.dirname(current)) {
    if (fs.existsSync(nodePath.join(current, "node_modules"))) found.push(current);
    if (nodePath.dirname(current) === current) return found;
  }
}

/** @param {string} html @returns {string[]} the fingerprinted assets the page references, then the favicon */
function assetPaths(html) {
  const referenced = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?#]+)/g)].map((match) => match[1] ?? "");
  return [...new Set([...referenced, "/favicon.svg"])];
}

/**
 * What is missing from a served standalone artifact: the page itself, a script and a stylesheet it
 * references, every referenced asset, and the favicon from `public`. An empty list means complete.
 * @param {(path: string) => Promise<Fetched & { text: string }>} get
 * @returns {Promise<string[]>}
 */
async function missingAssets(get) {
  const page = await get("/");
  if (page.status !== 200) return [`/ answered ${String(page.status)}`];
  const paths = assetPaths(page.text);
  const failures = [];
  if (!paths.some((path) => path.endsWith(".js"))) failures.push("the page references no script");
  if (!paths.some((path) => path.endsWith(".css"))) failures.push("the page references no stylesheet");
  for (const path of paths) {
    const asset = await get(path);
    if (asset.status !== 200 || asset.bytes === 0) failures.push(`${path} answered ${String(asset.status)} with ${String(asset.bytes)} bytes`);
  }
  return failures;
}

/** @param {string} baseUrl @param {typeof fetch} [request] @returns {(path: string) => Promise<Fetched & { text: string }>} */
function httpGet(baseUrl, request = fetch) {
  return async (path) => {
    const response = await request(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    return { status: response.status, type: response.headers.get("content-type") ?? "", bytes: Buffer.byteLength(text), text };
  };
}

/** @param {string} root @returns {string[]} the project's development dependency names */
function developmentNames(root) {
  const manifest = readObject(nodePath.join(root, "package.json"));
  return isObject(manifest.devDependencies) ? Object.keys(manifest.devDependencies) : [];
}

/**
 * Serves one relocated artifact and reports what its assets lack.
 * @param {{ artifact: string, base: NodeJS.ProcessEnv, start: typeof startOwned, port: () => Promise<number>, nonce: () => string, cancel?: Cancellation }} options
 * @returns {Promise<string[]>}
 */
async function serveAndCheck({ artifact, base, start, port: choosePort, nonce: chooseNonce, cancel }) {
  const port = await choosePort();
  const nonce = chooseNonce();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const server = await start({
    command: process.execPath,
    args: [nodePath.join(artifact, "server.js")],
    cwd: artifact,
    env: cleanEnv(base, { PORT: String(port), HOSTNAME: "127.0.0.1", E2E_NONCE: nonce }),
    url: `${baseUrl}/e2e-ready`,
    expect: nonce,
    timeoutMs: START_TIMEOUT_MS,
    ...(cancel ? { cancel } : {}),
  });
  try {
    return await missingAssets(httpGet(baseUrl));
  } finally {
    await server.stop();
  }
}

/**
 * @param {{ root: string, io: Io, host: Host, base: NodeJS.ProcessEnv, serve?: typeof serveAndCheck, cancel?: Cancellation }} options
 * @returns {Promise<number>}
 */
async function runArtifact({ root, io, host, base, serve = serveAndCheck, cancel = createCancellation() }) {
  const blocked = preconditions(root);
  if (blocked.length > 0) {
    io.stderr(`${blocked.join("\n")}\n`);
    return 1;
  }
  const fixture = host.scratch("artifact-fixture-");
  const complete = host.scratch("artifact-complete-");
  const incomplete = host.scratch("artifact-incomplete-");
  /** @returns {Promise<number>} */
  const execute = async () => {
    if (!(await prepareFixture({ root, dir: fixture, io, host, kind: "artifact", buildEnv: {}, transform: { "next.config.ts": standaloneConfig }, cancel })))
      return 1;
    const development = developmentNames(root);
    composeArtifact({ fixture, destination: complete, assets: true });
    composeArtifact({ fixture, destination: incomplete, assets: false });
    host.remove(fixture);
    const leaks = developmentLeaks(complete, development);
    const parents = resolvingAncestors(complete);
    if (leaks.length > 0 || parents.length > 0) {
      io.stderr(
        `artifact is not self-contained: development dependencies ${leaks.join(", ") || "none"}; node_modules in ancestors ${parents.join(", ") || "none"}\n`,
      );
      return 1;
    }
    const servers = { artifact: complete, base, start: startOwned, port: freePort, nonce: randomUUID, cancel };
    const missing = await serve(servers);
    if (cancel.isCancelled()) return 1;
    if (missing.length > 0) {
      io.stderr(`artifact is incomplete: ${missing.join("; ")}\n`);
      return 1;
    }
    io.stdout("artifact: relocated outside the project, served with its static and public assets, no development dependency present\n");
    const control = await serve({ ...servers, artifact: incomplete });
    if (cancel.isCancelled()) return 1;
    if (control.length === 0) {
      io.stderr("negative control failed: an artifact without public and .next/static was reported complete\n");
      return 1;
    }
    io.stdout(`artifact: negative control detected ${String(control.length)} missing asset(s)\n`);
    return 0;
  };
  let status = 1;
  try {
    status = await execute();
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  const failures = await attemptAll(
    [fixture, complete, incomplete].map((dir) => () => {
      host.remove(dir);
    }),
  );
  for (const failure of failures) io.stderr(`cleanup failed: ${failure}\n`);
  return failures.length > 0 ? 1 : status;
}

/**
 * The run of an application's standalone proof, for whoever owns the process's interrupts.
 * @param {string} root
 * @returns {Parameters<typeof main>[0]}
 */
function programOf(root) {
  return ({ io, host, cancel }) => runArtifact({ root, io, host, base: process.env, cancel });
}

module.exports = {
  assetPaths,
  composeArtifact,
  developmentLeaks,
  httpGet,
  installedNames,
  missingAssets,
  programOf,
  resolvingAncestors,
  runArtifact,
  serveAndCheck,
  storeName,
};

if (require.main === module) void main(programOf(nodePath.resolve(__dirname, "..", "..")));
