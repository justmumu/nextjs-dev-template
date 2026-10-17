// @ts-check
"use strict";
// The startup smoke of the staged application: its production server is started on a loopback port,
// is recognised as the one this run started by a per-run nonce asset in the staged public directory
// (anything else listening there is not it), must then answer the application's HTML page, and is
// always stopped again.
const nodePath = require("node:path");
const owned = require("../testing/owned.cjs");

const NEXT = nodePath.join("node_modules", "next", "dist", "bin", "next");
const START_TIMEOUT_MS = 60_000;

/** @param {string} nonce @returns {string} the file name, below `public/`, that holds exactly the nonce */
const assetOf = (nonce) => `template-smoke-${nonce}.txt`;

/**
 * @typedef {{ port: () => Promise<number>, start: typeof owned.startOwned, fetchPage: (url: string) => Promise<{ ok: boolean, text: string } | null> }} Servers
 */

/** @param {string} url @returns {Promise<{ ok: boolean, text: string } | null>} */
async function fetchPage(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return { ok: response.ok, text: await response.text() };
  } catch {
    return null;
  }
}

/** @returns {Servers} */
function realServers() {
  return { port: owned.freePort, start: owned.startOwned, fetchPage };
}

/**
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, nonce: string, cancel: import("../testing/owned.cjs").Cancellation, servers?: Servers, timeoutMs?: number }} input the staged application (built with the nonce asset in its public directory) and its cleaned environment
 * @returns {Promise<string | null>} why the application did not start and answer a page, or null
 */
async function smoke({ cwd, env, nonce, cancel, servers = realServers(), timeoutMs = START_TIMEOUT_MS }) {
  const port = await servers.port();
  const url = `http://127.0.0.1:${String(port)}/`;
  /** @type {{ stop: () => Promise<void> } | null} */
  let server = null;
  /** @type {string | null} */
  let problem = null;
  try {
    // The server is the one this call started only when it serves this run's nonce; its page is checked after that.
    const probe = async (/** @type {string} */ target) => {
      const asset = await servers.fetchPage(target);
      return asset?.ok === true ? asset.text : null;
    };
    server = await servers.start(
      {
        command: process.execPath,
        args: [nodePath.join(cwd, NEXT), "start", "--hostname", "127.0.0.1", "--port", String(port)],
        cwd,
        env,
        url: `${url}${assetOf(nonce)}`,
        expect: nonce,
        timeoutMs,
        cancel,
      },
      { ...owned.realHost(), probe },
    );
    const page = await servers.fetchPage(url);
    if (page?.ok !== true || !/<html[\s>]/i.test(page.text)) problem = `the application's page ${url} is not a successful HTML document`;
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  try {
    await server?.stop();
  } catch (error) {
    problem ??= `the production server could not be stopped: ${error instanceof Error ? error.message : String(error)}`;
  }
  return problem;
}

module.exports = { NEXT, assetOf, smoke };
