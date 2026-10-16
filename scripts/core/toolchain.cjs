// @ts-check
"use strict";
// Dependency-free toolchain facts and preflight. Must keep working when node_modules is
// missing or broken, so it uses only Node built-ins.
const { accessSync, constants, readFileSync, statSync } = require("node:fs");
const nodePath = require("node:path");
const { dirtyReason, recoveryCommand } = require("./install-state.cjs");
const { readObject } = require("./json.cjs");
const { run } = require("./process.cjs");

/** @typedef {{ forbiddenTools: string[], install: { frozenLockfile: boolean, dependencyBuildScripts: string }, commitIdentity: { emailPattern: string } }} Policy */

/** @param {string} path @returns {import("./json.cjs").JsonObject} */
function readJson(path) {
  return readObject(path);
}

/** @param {string} dir @returns {{ node: string, pnpm: string }} */
function readExpected(dir) {
  const manifest = readJson(nodePath.join(dir, "package.json"));
  const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(typeof manifest.packageManager === "string" ? manifest.packageManager : "");
  if (!match) throw new Error("package.json packageManager must name an exact pnpm version");
  return { node: readFileSync(nodePath.join(dir, ".node-version"), "utf8").trim(), pnpm: match[1] ?? "" };
}

/** @param {string} dir @returns {Policy} */
function readPolicy(dir) {
  return /** @type {Policy} */ (readJson(nodePath.join(dir, "tooling", "policy.json")));
}

/** @param {string} dir @returns {"generator" | "application"} */
function readRole(dir) {
  const role = readJson(nodePath.join(dir, "tooling", "project-role.json")).role;
  if (role !== "generator" && role !== "application") throw new Error(`tooling/project-role.json has an unknown role: ${JSON.stringify(role)}`);
  return role;
}

/**
 * @param {{ node: string, pnpm: string | null }} actual
 * @param {{ node: string, pnpm: string }} expected
 * @param {string} [detail] why pnpm could not be run, when it could not
 * @returns {string[]}
 */
function checkEnvironment(actual, expected, detail = "") {
  const errors = [];
  if (actual.node !== expected.node) {
    errors.push(`Node ${expected.node} is required (found ${actual.node}). Install exactly that version.`);
  }
  if (actual.pnpm === null) {
    errors.push(
      `pnpm ${expected.pnpm} is required but could not be run without downloading or switching package managers (found none${detail ? `: ${detail}` : ""}). Install exactly that version (for example with Corepack); no runtime downloads it for you.`,
    );
  } else if (actual.pnpm !== expected.pnpm) {
    errors.push(`pnpm ${expected.pnpm} is required (found ${actual.pnpm}). Install exactly that version.`);
  }
  return errors;
}

/**
 * @param {{ rev: string, author: string, committer: string }[]} entries
 * @param {string} emailPattern
 * @returns {string[]}
 */
function commitIdentityErrors(entries, emailPattern) {
  const pattern = new RegExp(emailPattern);
  const errors = [];
  for (const entry of entries) {
    for (const role of /** @type {const} */ (["author", "committer"])) {
      if (!pattern.test(entry[role])) errors.push(`${entry.rev}: ${role} e-mail is not a GitHub noreply address`);
    }
  }
  return errors;
}

/** @param {string} name @param {string} pathValue @returns {string | null} */
function resolveOnPath(name, pathValue) {
  for (const dir of pathValue.split(nodePath.delimiter)) {
    if (!dir) continue;
    const candidate = nodePath.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

// The preflight must observe the installed manager, never fetch or switch to another one: Corepack
// is denied network access (it reports the missing download instead) and pnpm's own package-manager
// version switching is off (pmOnFail=ignore, which also keeps the probe from recording the pin in a
// lock). Only the preflight probe gets this; project configuration is not weakened.
const NO_MANAGER_SWITCH = { COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_AUTO_PIN: "0", pnpm_config_pm_on_fail: "ignore" };

/**
 * @param {string} cwd
 * @returns {{ version: string | null, detail: string }} the installed pnpm version, or why none could be run
 */
function probePnpm(cwd) {
  const result = run("pnpm", ["--version"], { cwd, env: { ...process.env, ...NO_MANAGER_SWITCH } });
  const version = result.status === 0 ? result.stdout.trim() : null;
  return { version, detail: version === null ? ((result.stderr || result.stdout).trim().split("\n")[0] ?? "") : "" };
}

/** @param {string} cwd @returns {string | null} */
function pnpmVersion(cwd) {
  return probePnpm(cwd).version;
}

/**
 * Exact Node and pnpm check for the project at `dir`; returns error lines.
 * @param {string} dir
 * @returns {string[]}
 */
function preflightErrors(dir) {
  const pnpm = probePnpm(dir);
  return checkEnvironment({ node: process.versions.node, pnpm: pnpm.version }, readExpected(dir), pnpm.detail);
}

/**
 * Gate for every routine command: exact tools, and no incomplete install left behind.
 * @param {string} dir
 * @returns {string[]}
 */
function gateErrors(dir) {
  const errors = preflightErrors(dir);
  const dirty = dirtyReason(dir);
  if (dirty) errors.push(`The installed dependencies are incomplete (${dirty}). Run: ${recoveryCommand(dir)}`);
  return errors;
}

module.exports = {
  NO_MANAGER_SWITCH,
  checkEnvironment,
  commitIdentityErrors,
  gateErrors,
  pnpmVersion,
  preflightErrors,
  readExpected,
  readJson,
  readPolicy,
  readRole,
  resolveOnPath,
};
