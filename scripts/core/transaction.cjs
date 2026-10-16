// @ts-check
"use strict";
// Dependency transactions. A pnpm invocation is trusted for nothing: protected bytes are snapshotted
// first, and the result is judged from the files afterwards. Anything outside the one allowed
// manifest mutation (plus the lock) is rolled back to the preimage and the environment is marked dirty.
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const nodePath = require("node:path");
const { clearDirty, markDirty } = require("./install-state.cjs");
const { manifestViolations } = require("./dependency-policy.cjs");
const { isProtectedFile, isShadowOverride, isSkippedDir, DIRS } = require("./protected.cjs");
const { parseObject } = require("./json.cjs");
const { run } = require("./process.cjs");

const MUTABLE = new Set(["package.json", "pnpm-lock.yaml"]);
const LOCK_INPUTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".node-version"];
// Git state outside the working tree that decides which hooks and settings Git runs. In a linked
// worktree these live under the main repository, not under a ".git" directory of the root.
const GIT_PREFIX = "@git:";

/**
 * @typedef {{ type: "file", mode: number, content: Buffer } | { type: "symlink", target: string } | { type: "dir" }} Entry
 * @typedef {Map<string, Entry> & { dirs?: Set<string> }} Snapshot recorded entries; `dirs` lists every directory that existed, recorded or not, to tell who owns a directory
 * @typedef {(args: readonly string[]) => { status: number | null, stdout: string, stderr: string }} Runner
 * @typedef {{ root: string, git: { common: string, dir: string } | null }} Location
 */

/** @param {string} root @returns {Location} */
function locate(root) {
  const result = run("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: root });
  const [dir, common] = result.status === 0 ? result.stdout.trim().split("\n") : [];
  return { root, git: dir && common ? { dir, common } : null };
}

/** @param {Location} where @param {string} key @returns {string} */
function pathOf(where, key) {
  if (!key.startsWith(GIT_PREFIX) || !where.git) return nodePath.join(where.root, key);
  const [kind, ...rest] = key.slice(GIT_PREFIX.length).split("/");
  return nodePath.join(kind === "common" ? where.git.common : where.git.dir, ...rest);
}

/** @param {unknown} error */
const isAbsent = (error) => ["ENOENT", "ENOTDIR"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "");

/**
 * Records one path (and, for a directory, the protected content below it).
 * `select` decides which paths inside an unprotected directory are recorded; a directory is kept
 * only when something below it is recorded, so a created directory can be removed again.
 * @param {string} path @param {string} key @param {Snapshot} into @param {(key: string) => boolean} select
 * @param {Set<string>} dirs collects the key of every directory met
 * @returns {boolean} whether anything was recorded
 */
function walk(path, key, into, select, dirs) {
  let stat;
  try {
    stat = fs.lstatSync(path);
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    if (!select(key)) return false;
    into.set(key, { type: "symlink", target: fs.readlinkSync(path) });
    return true;
  }
  if (stat.isDirectory()) {
    dirs.add(key);
    /** @type {Map<string, Entry>} */
    const here = new Map();
    let any = false;
    for (const child of fs.readdirSync(path).sort()) {
      if (isSkippedDir(child)) continue;
      any = walk(nodePath.join(path, child), `${key}/${child}`, here, select, dirs) || any;
    }
    if (!any && !select(key)) return false;
    into.set(key, { type: "dir" });
    for (const [childKey, entry] of here) into.set(childKey, entry);
    return true;
  }
  if (!select(key)) return false;
  into.set(key, { type: "file", mode: stat.mode & 0o777, content: fs.readFileSync(path) });
  return true;
}

/** @param {Location | string} location a project root, or an already resolved location @returns {Snapshot} */
function snapshot(location) {
  const where = typeof location === "string" ? locate(location) : location;
  /** @type {Snapshot} */
  const into = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  into.dirs = dirs;
  const protectedDir = (/** @type {string} */ key) => DIRS.includes(key.split("/")[0] ?? "");
  for (const name of fs.readdirSync(where.root).sort()) {
    if (isSkippedDir(name)) continue;
    walk(nodePath.join(where.root, name), name, into, (key) => protectedDir(key) || isProtectedFile(key) || isShadowOverride(key), dirs);
  }
  if (where.git) {
    const all = () => true;
    walk(nodePath.join(where.git.common, "config"), `${GIT_PREFIX}common/config`, into, all, dirs);
    walk(nodePath.join(where.git.common, "hooks"), `${GIT_PREFIX}common/hooks`, into, all, dirs);
    if (where.git.dir !== where.git.common) {
      walk(nodePath.join(where.git.dir, "config.worktree"), `${GIT_PREFIX}dir/config.worktree`, into, all, dirs);
      walk(nodePath.join(where.git.dir, "hooks"), `${GIT_PREFIX}dir/hooks`, into, all, dirs);
    }
  }
  return into;
}

/** @param {Entry | undefined} a @param {Entry | undefined} b */
function sameEntry(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === "file" && b.type === "file") return a.mode === b.mode && a.content.equals(b.content);
  if (a.type === "symlink" && b.type === "symlink") return a.target === b.target;
  return true;
}

/** @param {Snapshot} before @param {Snapshot} after @returns {string[]} */
function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => !sameEntry(before.get(path), after.get(path))).sort();
}

/**
 * Puts every protected path back to the snapshot. Only paths the snapshot machinery recorded are
 * touched: an added, retyped or retargeted entry is removed deepest first (a symlink is unlinked,
 * never followed), and a directory is removed only when the transaction demonstrably created it
 * (it was not in the preimage) and it is empty by then. Content that was never recorded, such as
 * ordinary source in a shared directory, is never deleted. The preimage is then written parents
 * first. Every step is attempted; if any fails, an error lists them all and the drift stays.
 * @param {Location} where @param {Snapshot} before
 */
function restore(where, before) {
  /** @type {string[]} */
  const failures = [];
  const attempt = (/** @type {string} */ path, /** @type {() => void} */ step) => {
    try {
      step();
    } catch (error) {
      failures.push(`${path}: ${/** @type {Error} */ (error).message}`);
    }
  };
  const now = snapshot(where);
  for (const path of changedPaths(before, now).reverse()) {
    const current = now.get(path);
    if (!current || sameEntry(before.get(path), current)) continue;
    const target = pathOf(where, path);
    if (current.type === "dir") {
      // A container the transaction created that now holds unrecorded content is kept; a directory
      // standing where the preimage had another kind of entry must go, or the restore is incomplete.
      if (!before.dirs?.has(path))
        attempt(path, () => {
          try {
            fs.rmdirSync(target);
          } catch (error) {
            if (!before.has(path) && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOTEMPTY") return;
            throw error;
          }
        });
    } else if (current.type === "symlink" || before.get(path)?.type !== current.type)
      attempt(path, () => {
        fs.unlinkSync(target);
      });
  }
  const current = snapshot(where);
  for (const [path, entry] of [...before].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (sameEntry(entry, current.get(path))) continue;
    const target = pathOf(where, path);
    attempt(path, () => {
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      if (entry.type === "dir") fs.mkdirSync(target, { recursive: true });
      else if (entry.type === "symlink") fs.symlinkSync(entry.target, target);
      else {
        fs.writeFileSync(target, entry.content, { mode: entry.mode });
        fs.chmodSync(target, entry.mode);
      }
    });
  }
  if (failures.length > 0) throw new Error(`rollback incomplete; these protected paths could not be restored: ${failures.join("; ")}`);
}

/** @param {string} root @returns {Runner} */
function pnpmRunner(root) {
  return (args) => run("pnpm", args, { cwd: root, env: process.env });
}

/** Restores the preimage and marks the environment dirty; a rollback that cannot finish says so in the marker and throws. */
function rollBack(
  /** @type {string} */ root,
  /** @type {Location} */ where,
  /** @type {Snapshot} */ before,
  /** @type {string} */ reason,
  /** @type {string | undefined} */ kind,
) {
  try {
    restore(where, before);
  } catch (error) {
    markDirty(root, `${reason}; ${/** @type {Error} */ (error).message}`, kind);
    throw error;
  }
  markDirty(root, reason, kind);
}

/**
 * @typedef {import("./dependency-policy.cjs").DependencyPlan & { valueOk?: (value: string) => boolean, pinned?: Record<string, string> }} Plan
 * @typedef {{ ok: boolean, status: number | null, violations: string[], output: string, restored: boolean }} TransactionResult
 */

/**
 * Runs pnpm steps, then accepts the result only if the manifest delta equals `plan` and no other
 * protected path changed. Otherwise protected files go back to the preimage and the environment is
 * marked dirty: node_modules may hold partial or hostile state that bytes cannot undo.
 * An accepted result is also checked against the frozen lock: a successful pnpm exit does not make a
 * manifest that was edited after pnpm's own write consistent. `kind` is stored with the incomplete-
 * install marker so recovery knows which command can progress; `lockCopy` lists extra relative paths
 * the disposable lock check needs (file: fixtures in tests; real dependencies are registry-only).
 * @param {{ root: string, steps: readonly (readonly string[])[], plan: Plan, runner?: Runner | undefined, kind?: string | undefined, lockCopy?: readonly string[] }} options
 * @returns {TransactionResult}
 */
function runTransaction({ root, steps, plan, runner = pnpmRunner(root), kind, lockCopy = [] }) {
  const where = locate(root);
  const before = snapshot(where);
  const preimage = before.get("package.json");
  if (preimage?.type !== "file") throw new Error("package.json is missing");
  const manifestBefore = parseObject(preimage.content.toString("utf8"));
  markDirty(root, "a dependency transaction did not finish", kind);
  let status = 0;
  let output = "";
  try {
    for (const step of steps) {
      const result = runner(step);
      output += result.stdout + result.stderr;
      if (result.status !== 0) {
        status = result.status ?? 1;
        break;
      }
    }
  } catch (error) {
    rollBack(root, where, before, "a dependency transaction was interrupted", kind);
    throw error;
  }
  const after = snapshot(where);
  const violations = changedPaths(before, after)
    .filter((path) => !MUTABLE.has(path))
    .map((path) => `protected path changed: ${path}`);
  const manifest = after.get("package.json");
  try {
    if (manifest?.type !== "file") throw new Error("package.json is missing");
    violations.push(...manifestViolations(manifestBefore, parseObject(manifest.content.toString("utf8")), plan));
  } catch (error) {
    violations.push(`package.json is unreadable after the transaction: ${/** @type {Error} */ (error).message}`);
  }
  if (!after.has("pnpm-lock.yaml")) violations.push("pnpm-lock.yaml is missing after the transaction");
  else if (status === 0 && violations.length === 0 && !checkLock(root, lockCopy).ok)
    violations.push("the lock does not match package.json after the transaction");
  const ok = status === 0 && violations.length === 0;
  if (ok) clearDirty(root);
  else {
    rollBack(root, where, before, violations.length > 0 ? "a dependency transaction was rejected" : "a dependency transaction failed", kind);
  }
  return { ok, status, violations, output, restored: !ok };
}

/**
 * Lock consistency without touching the active tree: pnpm sees only a disposable copy of the
 * metadata inputs, with the frozen, lock-only and offline modes combined (verified against pnpm 12.14).
 * @param {string} root
 * @param {readonly string[]} [extra] further relative paths copied into the disposable copy
 * @returns {{ ok: boolean, output: string }}
 */
function checkLock(root, extra = []) {
  const copy = fs.realpathSync(fs.mkdtempSync(nodePath.join(tmpdir(), "lock-check-")));
  try {
    for (const name of LOCK_INPUTS) {
      const source = nodePath.join(root, name);
      if (fs.existsSync(source)) fs.writeFileSync(nodePath.join(copy, name), fs.readFileSync(source), { mode: 0o600 });
    }
    for (const name of extra) fs.cpSync(nodePath.join(root, name), nodePath.join(copy, name), { recursive: true });
    const result = pnpmRunner(copy)(["install", "--frozen-lockfile", "--lockfile-only", "--offline"]);
    return { ok: result.status === 0, output: result.stdout + result.stderr };
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

module.exports = { changedPaths, checkLock, locate, restore, runTransaction, snapshot };
