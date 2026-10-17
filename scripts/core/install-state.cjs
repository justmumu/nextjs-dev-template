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

/** @param {string} root @returns {string | null} the text of the marker, or null when there is none */
function readMarker(root) {
  try {
    return fs.readFileSync(markerPath(root), "utf8");
  } catch {
    return null;
  }
}

/**
 * @param {string | null} text the content of the marker file, if any
 * @returns {{ reason: string, kind: string | null } | null} null when the environment is not marked dirty; an empty marker is still dirty
 */
function parseMarker(text) {
  if (text === null) return null;
  return { reason: text.trim() || "unknown", kind: /^kind=(.+)$/m.exec(text)?.[1] ?? null };
}

/** @param {string} reason @param {string} [kind] @returns {string} the content of the marker file */
function markerText(reason, kind) {
  return `${reason}\n${kind ? `kind=${kind}\n` : ""}`;
}

/** @param {string} root @returns {string | null} the reason, or null when the environment is not marked dirty */
function dirtyReason(root) {
  return parseMarker(readMarker(root))?.reason ?? null;
}

/** @param {string} root @returns {string | null} which command's failure left the marker (for example "deps-lock"), if any */
function dirtyKind(root) {
  return parseMarker(readMarker(root))?.kind ?? null;
}

/** @param {string} root @param {string} reason @param {string} [kind] */
function markDirty(root, reason, kind) {
  fs.mkdirSync(nodePath.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(markerPath(root), markerText(reason, kind));
}

/**
 * The one command that can make progress from an incomplete install of this kind. A failed relock
 * leaves the manifest edited and the lock stale, so only the same approved relock can proceed;
 * every other drift is rebuilt from the frozen lock.
 * @param {string | null} kind
 */
function recoveryFor(kind) {
  return kind === "deps-lock" ? "node scripts/bootstrap.cjs deps-lock" : "node scripts/bootstrap.cjs repair";
}

/** @param {string} root */
function recoveryCommand(root) {
  return recoveryFor(dirtyKind(root));
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
  return guardCheck(root).refusal;
}

/** @param {string} root @param {"deps-lock"} [operation] @returns {{ refusal: string | null, approvedManifest: string | null }} */
function guardCheck(root, operation) {
  if (!capabilities(root).guard) return { refusal: null, approvedManifest: null };
  const statePath = nodePath.join(root, "scripts", "hooks", "state.cjs");
  if (!fs.existsSync(statePath))
    return { refusal: "the guard is registered in tooling/capabilities.json but scripts/hooks/state.cjs is missing", approvedManifest: null };
  /** @type {unknown} */
  let state;
  try {
    /** @type {unknown} */
    const loaded = require(statePath);
    state = /** @type {{ status: (root: string, options: { operation: "deps-lock" | undefined }) => unknown }} */ (loaded).status(root, { operation });
  } catch (error) {
    return {
      refusal: `the guard state could not be read (${/** @type {Error} */ (error).message}); resolve it before changing dependencies`,
      approvedManifest: null,
    };
  }
  const refusal = guardVerdict(state);
  return { refusal, approvedManifest: refusal === null && isObject(state) && typeof state.approvedManifest === "string" ? state.approvedManifest : null };
}

/**
 * Only an explicit clean answer lets the operation proceed.
 * @param {unknown} state what `status(root)` answered
 * @returns {string | null} a refusal message, or null
 */
function guardVerdict(state) {
  if (isObject(state) && state.clean === true) return null;
  return `the guard reports an unresolved protected state (${isObject(state) && typeof state.reason === "string" ? state.reason : "unknown"}); resolve it before changing dependencies`;
}

module.exports = {
  MARKER,
  capabilities,
  clearDirty,
  dirtyKind,
  dirtyReason,
  guardCheck,
  guardRefusal,
  guardVerdict,
  markDirty,
  markerText,
  parseMarker,
  recoveryCommand,
  recoveryFor,
  removeInstallState,
};
