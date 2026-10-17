// @ts-check
"use strict";
const nodePath = require("node:path");
const { readFileSync, existsSync, writeFileSync } = require("node:fs");
const { redact, runStoppable } = require("./process.cjs");
const { resolveOnPath } = require("./toolchain.cjs");
const { isObject, parseObject } = require("./json.cjs");

/**
 * @typedef {{ stdout: (text: string) => unknown, stderr: (text: string) => unknown }} Io
 * @typedef {{ status: number | null, stdout: string, stderr: string }} Result
 * @typedef {{
 *   find: (name: string) => boolean,
 *   run: (command: string, args: string[], options: { cwd: string, signal?: AbortSignal }) => Result | Promise<Result>,
 *   read: (path: string) => Buffer | null,
 *   write: (path: string, content: Buffer) => void,
 * }} Host the agent CLIs and the two tracked files the Claude CLI rewrites
 */

/**
 * The agent CLIs on the PATH and the two tracked files, as this machine has them.
 * @param {{ path?: string, start?: Host["run"], disk?: { existsSync: (path: string) => boolean, readFileSync: (path: string) => Buffer, writeFileSync: (path: string, content: Buffer) => void } }} [machine]
 * @returns {Host}
 */
function realHost({ path = process.env.PATH ?? "", start = runStoppable, disk = { existsSync, readFileSync, writeFileSync } } = {}) {
  return {
    find: (name) => resolveOnPath(name, path) !== null,
    run: start,
    read: (file) => (disk.existsSync(file) ? disk.readFileSync(file) : null),
    write: (file, content) => {
      disk.writeFileSync(file, content);
    },
  };
}

/** @param {Buffer | null} content @returns {{ marketplaces: string[], plugins: string[] }} what the Claude settings declare */
function claudeDeclaration(content) {
  if (content === null) return { marketplaces: [], plugins: [] };
  const settings = parseObject(content.toString("utf8"));
  const known = isObject(settings.extraKnownMarketplaces) ? Object.values(settings.extraKnownMarketplaces) : [];
  const enabled = isObject(settings.enabledPlugins) ? Object.entries(settings.enabledPlugins) : [];
  return {
    marketplaces: known.flatMap((entry) =>
      isObject(entry) && isObject(entry.source) && entry.source.source === "github" && typeof entry.source.repo === "string" ? [entry.source.repo] : [],
    ),
    plugins: enabled.flatMap(([name, on]) => (on === true ? [name] : [])),
  };
}

/** @param {Buffer | null} content @returns {string[]} the marketplaces the Codex configuration declares */
function codexMarketplaces(content) {
  return content === null ? [] : [...content.toString("utf8").matchAll(/^\[marketplaces\.([A-Za-z0-9_-]+)\]\s*$/gm)].flatMap((match) => match[1] ?? []);
}

/** The signals that end the setup; each is answered after the cleanup and then taken by the process again. */
const INTERRUPTS = /** @type {const} */ (["SIGINT", "SIGTERM"]);

/**
 * @param {Host} host @param {string} root @param {Io} io
 * @param {string} cli @param {string[][]} commands run in order, stopping at the first failure or interruption
 * @param {string} failure what to tell the user when one fails
 * @param {{ signal: AbortSignal }} abort
 */
async function runAll(host, root, io, cli, commands, failure, abort) {
  const stopped = () => abort.signal.aborted;
  for (const args of commands) {
    if (stopped()) return;
    const result = await host.run(cli, args, { cwd: root, signal: abort.signal });
    if (stopped()) return;
    if (result.status !== 0) {
      io.stderr(`warning: ${failure}\n${redact((result.stderr || result.stdout).trim().split("\n").slice(0, 3).join("\n"))}\n`);
      return;
    }
  }
}

/**
 * Installs the declared Claude Code plugins in project scope and refreshes the declared Codex
 * marketplaces, each only when its CLI exists. The Claude CLI rewrites the tracked settings file, so
 * its exact bytes are restored afterwards, whatever happens: success, failure, a thrown error, or
 * SIGINT/SIGTERM. An interruption stops the running CLI, restores, and then ends this process by the
 * same signal; it is never swallowed and never reported as success.
 * @param {string} root @param {Io} io @param {Host} host @returns {Promise<void>}
 */
async function installPlugins(root, io, host) {
  const controller = new AbortController();
  const state = { interrupted: /** @type {NodeJS.Signals | null} */ (null) };
  const listeners = INTERRUPTS.map((name) => {
    const listener = () => {
      state.interrupted ??= name;
      controller.abort();
    };
    process.on(name, listener);
    return /** @type {const} */ ([name, listener]);
  });
  try {
    await installAll(root, io, host, controller);
    // A signal that arrived while a command blocked this process is delivered on the next turn.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    for (const [name, listener] of listeners) process.removeListener(name, listener);
  }
  if (state.interrupted !== null) {
    process.kill(process.pid, state.interrupted);
    throw new Error(`interrupted by ${state.interrupted}`);
  }
}

/** @param {string} root @param {Io} io @param {Host} host @param {AbortController} abort @returns {Promise<void>} */
async function installAll(root, io, host, abort) {
  const settings = nodePath.join(root, ".claude", "settings.json");
  if (host.find("claude")) {
    const original = host.read(settings);
    try {
      const { marketplaces, plugins } = claudeDeclaration(original);
      await runAll(
        host,
        root,
        io,
        "claude",
        [
          ...marketplaces.map((repo) => ["plugin", "marketplace", "add", repo, "--scope", "project"]),
          ...plugins.map((plugin) => ["plugin", "install", plugin, "--scope", "project"]),
        ],
        "Claude Code plugin install failed; install the project plugins from /plugin.",
        abort,
      );
    } finally {
      // The signal handler waits for the CLI to end first, so nothing rewrites the file after this.
      const current = host.read(settings);
      if (original !== null && (current === null || !current.equals(original))) host.write(settings, original);
    }
  }
  if (host.find("codex") && !abort.signal.aborted) {
    // Codex reads project tables only for a trusted project, so trust is granted for this one command only.
    const trust = `projects={${JSON.stringify(root)}={trust_level="trusted"}}`;
    for (const name of codexMarketplaces(host.read(nodePath.join(root, ".codex", "config.toml"))))
      await runAll(
        host,
        root,
        io,
        "codex",
        [["plugin", "marketplace", "upgrade", name, "-c", trust]],
        `Codex plugin download failed; trust this project in Codex, then run: codex plugin marketplace upgrade ${name}`,
        abort,
      );
  }
}

module.exports = { claudeDeclaration, codexMarketplaces, installPlugins, realHost };
