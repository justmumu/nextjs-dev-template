// @ts-check
"use strict";
// Project-local install state: the "dirty" marker for incomplete environments, safe removal of
// node_modules for repair, and the explicit capability boundary to units that are not built yet.
const fs = require("node:fs");
const nodePath = require("node:path");
const { isObject, readObject } = require("./json.cjs");

const MARKER = ".template-environment-dirty";

/** @param {string} root */
const markerPath = (root) => nodePath.join(root, "node_modules", MARKER);

/** @param {string} root @returns {string | null} the reason, or null when the environment is not marked dirty */
function dirtyReason(root) {
  try {
    return fs.readFileSync(markerPath(root), "utf8").trim() || "unknown";
  } catch {
    return null;
  }
}

/** @param {string} root @returns {string | null} which command's failure left the marker (for example "deps-lock"), if any */
function dirtyKind(root) {
  try {
    return /^kind=(.+)$/m.exec(fs.readFileSync(markerPath(root), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** @param {string} root @param {string} reason @param {string} [kind] */
function markDirty(root, reason, kind) {
  fs.mkdirSync(nodePath.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(markerPath(root), `${reason}\n${kind ? `kind=${kind}\n` : ""}`);
}

/**
 * The one command that can make progress from the current incomplete install. A failed relock
 * leaves the manifest edited and the lock stale, so only the same approved relock can proceed;
 * every other drift is rebuilt from the frozen lock.
 * @param {string} root
 */
function recoveryCommand(root) {
  return dirtyKind(root) === "deps-lock" ? "node scripts/bootstrap.cjs deps-lock" : "node scripts/bootstrap.cjs repair";
}

/** @param {string} root */
function clearDirty(root) {
  fs.rmSync(markerPath(root), { force: true });
}

/**
 * Removes the project-local node_modules only. A symlink is unlinked, never followed; the global
 * store and every file outside node_modules are left alone.
 * @param {string} root
 */
function removeInstallState(root) {
  const target = nodePath.join(root, "node_modules");
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fs.unlinkSync(target);
  else fs.rmSync(target, { recursive: true, force: true });
}

/**
 * @param {string} root
 * @returns {{ guard: boolean, hooks: boolean }}
 */
function capabilities(root) {
  const parsed = readObject(nodePath.join(root, "tooling", "capabilities.json"));
  return { guard: parsed.guard === true, hooks: parsed.hooks === true };
}

/**
 * Integration boundary for the protected-files guard (U6). While the guard capability is not
 * registered nothing is claimed. Once registered, `scripts/hooks/state.cjs` must export
 * `status(root)` returning `{ clean: true }` for a coherent protected baseline with no pending
 * reservation or conflict. Everything else fails closed: a missing module, a module that throws,
 * and any answer other than an explicit `clean: true` refuse the operation.
 * @param {string} root
 * @returns {string | null} a refusal message, or null when the operation may proceed
 */
function guardRefusal(root) {
  if (!capabilities(root).guard) return null;
  const statePath = nodePath.join(root, "scripts", "hooks", "state.cjs");
  if (!fs.existsSync(statePath)) return "the guard is registered in tooling/capabilities.json but scripts/hooks/state.cjs is missing";
  /** @type {unknown} */
  let state;
  try {
    /** @type {unknown} */
    const loaded = require(statePath);
    state = /** @type {{ status: (root: string) => unknown }} */ (loaded).status(root);
  } catch (error) {
    return `the guard state could not be read (${/** @type {Error} */ (error).message}); resolve it before changing dependencies`;
  }
  if (!isObject(state) || state.clean !== true)
    return `the guard reports an unresolved protected state (${isObject(state) && typeof state.reason === "string" ? state.reason : "unknown"}); resolve it before changing dependencies`;
  return null;
}

module.exports = { MARKER, capabilities, clearDirty, dirtyKind, dirtyReason, guardRefusal, markDirty, recoveryCommand, removeInstallState };
