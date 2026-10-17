// @ts-check
"use strict";
const { randomUUID } = require("node:crypto");
const nodePath = require("node:path");
const { cleanEnv } = require("./environment.cjs");
const { NEXT, main, prepareFixture, preconditions } = require("./harness.cjs");
const { attemptAll, createCancellation, freePort, startOwned } = require("./owned.cjs");

const BUILD = { FIXTURE_SERVER_ONLY: "build-time-server-only-value", NEXT_PUBLIC_FIXTURE_PUBLIC: "build-time-public-value" };
const RUNTIME = { FIXTURE_SERVER_ONLY: "runtime-server-only-value", NEXT_PUBLIC_FIXTURE_PUBLIC: "runtime-public-value" };

const PLAYWRIGHT = nodePath.join("node_modules", "@playwright", "test", "cli.js");
const START_TIMEOUT_MS = 60_000;

/**
 * @typedef {import("./harness.cjs").Io} Io
 * @typedef {import("./harness.cjs").Host} Host
 * @typedef {import("./owned.cjs").Cancellation} Cancellation
 * @typedef {{ port: () => Promise<number>, start: typeof startOwned, nonce: () => string }} Servers how the production server is given its port and name, and started
 */

/**
 * The environment of the Playwright process: where the server is, where its fixture was built, and
 * the build-time and run-time values the environment specification compares.
 * @param {{ baseUrl: string, fixture: string, base: NodeJS.ProcessEnv }} options
 * @returns {NodeJS.ProcessEnv}
 */
function suiteEnv({ baseUrl, fixture, base }) {
  return cleanEnv(base, {
    E2E_BASE_URL: baseUrl,
    E2E_FIXTURE_DIR: fixture,
    E2E_BUILD_PUBLIC: BUILD.NEXT_PUBLIC_FIXTURE_PUBLIC,
    E2E_BUILD_SERVER: BUILD.FIXTURE_SERVER_ONLY,
    E2E_RUNTIME_PUBLIC: RUNTIME.NEXT_PUBLIC_FIXTURE_PUBLIC,
    E2E_RUNTIME_SERVER: RUNTIME.FIXTURE_SERVER_ONLY,
  });
}

/**
 * @param {{ root: string, io: Io, host: Host, servers: Servers, base: NodeJS.ProcessEnv, cancel?: Cancellation }} options
 * @returns {Promise<number>} 0 only when the build, the server and every browser lane passed
 */
async function runProduction({ root, io, host, servers, base, cancel = createCancellation() }) {
  const blocked = preconditions(root);
  if (blocked.length > 0) {
    io.stderr(`${blocked.join("\n")}\n`);
    return 1;
  }
  const dir = host.scratch("production-fixture-");
  /** @type {{ stop: () => Promise<void> } | null} */
  let server = null;
  /** @returns {Promise<number>} */
  const execute = async () => {
    if (!(await prepareFixture({ root, dir, io, host, kind: "production", buildEnv: BUILD, cancel }))) return 1;
    const port = await servers.port();
    const nonce = servers.nonce();
    if (cancel.isCancelled()) return 1;
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    server = await servers.start({
      command: process.execPath,
      args: [nodePath.join(dir, NEXT), "start", "--hostname", "127.0.0.1", "--port", String(port)],
      cwd: dir,
      env: cleanEnv(base, { ...RUNTIME, E2E_NONCE: nonce }),
      url: `${baseUrl}/e2e-ready`,
      expect: nonce,
      timeoutMs: START_TIMEOUT_MS,
      cancel,
    });
    io.stdout(`server: next start owned by this run on ${baseUrl}\n`);
    const status = await host.run(process.execPath, [nodePath.join(root, PLAYWRIGHT), "test"], { cwd: root, env: suiteEnv({ baseUrl, fixture: dir, base }) });
    if (cancel.isCancelled()) io.stderr("browser suite interrupted\n");
    else if (status !== 0) io.stderr("browser suite failed; a browser that cannot launch lacks its prerequisites, see docs/contributing/production-tests.md\n");
    return status === 0 && !cancel.isCancelled() ? 0 : 1;
  };
  let status = 1;
  try {
    status = await execute();
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  const failures = await attemptAll([
    () => server?.stop(),
    () => {
      host.remove(dir);
    },
  ]);
  for (const failure of failures) io.stderr(`cleanup failed: ${failure}\n`);
  return failures.length > 0 ? 1 : status;
}

/**
 * The run of an application's production proof, for whoever owns the process's interrupts.
 * @param {string} root
 * @returns {Parameters<typeof main>[0]}
 */
function programOf(root) {
  return ({ io, host, cancel }) =>
    runProduction({ root, io, host, servers: { port: freePort, start: startOwned, nonce: randomUUID }, base: process.env, cancel });
}

module.exports = { BUILD, RUNTIME, programOf, runProduction, suiteEnv };

if (require.main === module) void main(programOf(nodePath.resolve(__dirname, "..", "..")));
