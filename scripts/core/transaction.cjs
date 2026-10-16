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
const { redact, run } = require("./process.cjs");

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
 * @typedef {{
 *   lstatSync: (path: string) => { isSymbolicLink: () => boolean, isDirectory: () => boolean, mode: number },
 *   readlinkSync: (path: string) => string,
 *   readdirSync: (path: string) => string[],
 *   readFileSync: (path: string) => Buffer,
 *   mkdirSync: (path: string, options?: { recursive: boolean }) => unknown,
 *   rmdirSync: (path: string) => void,
 *   unlinkSync: (path: string) => void,
 *   symlinkSync: (target: string, path: string) => void,
 *   writeFileSync: (path: string, content: Buffer, options: { mode: number }) => void,
 *   chmodSync: (path: string, mode: number) => void,
 * }} Disk the part of `node:fs` a snapshot and a rollback use; a missing path throws an error whose code is ENOENT or ENOTDIR
 */

/**
 * Where Git keeps the state that decides which hooks and settings it runs.
 * @param {string} root
 * @param {{ status: number | null, stdout: string }} revParse the answer of `git rev-parse --path-format=absolute --git-dir --git-common-dir`
 * @returns {Location} the root, and no Git state when the root is not a repository
 */
function locationFrom(root, revParse) {
  const [dir, common] = revParse.status === 0 ? revParse.stdout.trim().split("\n") : [];
  return { root, git: dir && common ? { dir, common } : null };
}

/** @param {string} root @returns {Location} */
function locate(root) {
  return locationFrom(root, run("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: root }));
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
 * @param {Disk} disk
 * @returns {boolean} whether anything was recorded
 */
function walk(path, key, into, select, dirs, disk) {
  let stat;
  try {
    stat = disk.lstatSync(path);
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    if (!select(key)) return false;
    into.set(key, { type: "symlink", target: disk.readlinkSync(path) });
    return true;
  }
  if (stat.isDirectory()) {
    dirs.add(key);
    /** @type {Map<string, Entry>} */
    const here = new Map();
    let any = false;
    for (const child of disk.readdirSync(path).sort()) {
      if (isSkippedDir(child, key)) continue;
      any = walk(nodePath.join(path, child), `${key}/${child}`, here, select, dirs, disk) || any;
    }
    if (!any && !select(key)) return false;
    into.set(key, { type: "dir" });
    for (const [childKey, entry] of here) into.set(childKey, entry);
    return true;
  }
  if (!select(key)) return false;
  into.set(key, { type: "file", mode: stat.mode & 0o777, content: disk.readFileSync(path) });
  return true;
}

/** @param {Location | string} location a project root, or an already resolved location @param {Disk} [disk] @returns {Snapshot} */
function snapshot(location, disk = fs) {
  const where = typeof location === "string" ? locate(location) : location;
  /** @type {Snapshot} */
  const into = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  into.dirs = dirs;
  const protectedDir = (/** @type {string} */ key) => DIRS.includes(key.split("/")[0] ?? "");
  for (const name of disk.readdirSync(where.root).sort()) {
    if (isSkippedDir(name)) continue;
    walk(nodePath.join(where.root, name), name, into, (key) => protectedDir(key) || isProtectedFile(key) || isShadowOverride(key), dirs, disk);
  }
  if (where.git) {
    const all = () => true;
    walk(nodePath.join(where.git.common, "config"), `${GIT_PREFIX}common/config`, into, all, dirs, disk);
    walk(nodePath.join(where.git.common, "hooks"), `${GIT_PREFIX}common/hooks`, into, all, dirs, disk);
    if (where.git.dir !== where.git.common) {
      walk(nodePath.join(where.git.dir, "config.worktree"), `${GIT_PREFIX}dir/config.worktree`, into, all, dirs, disk);
      walk(nodePath.join(where.git.dir, "hooks"), `${GIT_PREFIX}dir/hooks`, into, all, dirs, disk);
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
 * What it takes to remove what the transaction added, retyped or retargeted. Only paths the snapshot
 * machinery recorded are touched: an added, retyped or retargeted entry is removed deepest first (a
 * symlink is unlinked, never followed), and a directory is removed only when the transaction
 * demonstrably created it (it was not in the preimage) and it is empty by then. Content that was
 * never recorded, such as ordinary source in a shared directory, is never deleted.
 * @param {Snapshot} before @param {Snapshot} now
 * @returns {{ path: string, op: "rmdir" | "unlink", keepNonEmpty: boolean }[]}
 */
function removalsFor(before, now) {
  /** @type {{ path: string, op: "rmdir" | "unlink", keepNonEmpty: boolean }[]} */
  const removals = [];
  for (const path of changedPaths(before, now).reverse()) {
    const current = now.get(path);
    if (!current) continue;
    if (current.type === "dir") {
      // A container the transaction created that now holds unrecorded content is kept; a directory
      // standing where the preimage had another kind of entry must go, or the restore is incomplete.
      if (!before.dirs?.has(path)) removals.push({ path, op: "rmdir", keepNonEmpty: !before.has(path) });
    } else if (current.type === "symlink" || before.get(path)?.type !== current.type) removals.push({ path, op: "unlink", keepNonEmpty: false });
  }
  return removals;
}

/** @param {Snapshot} before @param {Snapshot} current @returns {[string, Entry][]} the preimage entries that are not as they were, parents first */
function writesFor(before, current) {
  return [...before].filter(([path, entry]) => !sameEntry(entry, current.get(path))).sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * Runs every step even when an earlier one failed, so one failure cannot leave the rest of the
 * drift in place.
 * @param {{ path: string, step: () => void }[]} steps
 * @returns {string[]} what failed, one line per failed step
 */
function attemptAll(steps) {
  /** @type {string[]} */
  const failures = [];
  for (const { path, step } of steps) {
    try {
      step();
    } catch (error) {
      failures.push(`${path}: ${/** @type {Error} */ (error).message}`);
    }
  }
  return failures;
}

/** @param {string[]} failures @returns {void} */
function assertRestored(failures) {
  if (failures.length > 0) throw new Error(`rollback incomplete; these protected paths could not be restored: ${failures.join("; ")}`);
}

/**
 * Whether a failed removal is acceptable: a container that was created by the transaction and still
 * holds unrecorded content is kept, not an error.
 * @param {unknown} error @param {boolean} keepNonEmpty
 */
const keptNonEmpty = (error, keepNonEmpty) => keepNonEmpty && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOTEMPTY";

/**
 * Puts every protected path back to the snapshot: first the removals, then the preimage written
 * parents first. Every step is attempted; if any fails, an error lists them all and the drift stays.
 * @param {Location} where @param {Snapshot} before @param {Disk} [disk]
 */
function restore(where, before, disk = fs) {
  const removed = attemptAll(
    removalsFor(before, snapshot(where, disk)).map(({ path, op, keepNonEmpty }) => ({
      path,
      step: () => {
        try {
          if (op === "rmdir") disk.rmdirSync(pathOf(where, path));
          else disk.unlinkSync(pathOf(where, path));
        } catch (error) {
          if (!keptNonEmpty(error, keepNonEmpty)) throw error;
        }
      },
    })),
  );
  const written = attemptAll(
    writesFor(before, snapshot(where, disk)).map(([path, entry]) => ({
      path,
      step: () => {
        const target = pathOf(where, path);
        disk.mkdirSync(nodePath.dirname(target), { recursive: true });
        if (entry.type === "dir") disk.mkdirSync(target, { recursive: true });
        else if (entry.type === "symlink") disk.symlinkSync(entry.target, target);
        else {
          disk.writeFileSync(target, entry.content, { mode: entry.mode });
          disk.chmodSync(target, entry.mode);
        }
      },
    })),
  );
  assertRestored([...removed, ...written]);
}

/** @param {string} root @returns {Runner} */
function pnpmRunner(root) {
  return (args) => run("pnpm", args, { cwd: root, env: process.env });
}

/**
 * The effects a transaction has on the project, so the decisions around them can be judged without
 * a repository, a package manager or a disk.
 * @typedef {{
 *   locate: (root: string) => Location,
 *   snapshot: (where: Location) => Snapshot,
 *   restore: (where: Location, before: Snapshot) => void,
 *   markDirty: (root: string, reason: string, kind?: string) => void,
 *   clearDirty: (root: string) => void,
 *   checkLock: (root: string, extra: readonly string[]) => { ok: boolean, output: string },
 * }} System
 */

/** @type {System} */
const SYSTEM = { locate, snapshot, restore, markDirty, clearDirty, checkLock: (root, extra) => checkLock(root, extra) };

/** Restores the preimage and marks the environment dirty; a rollback that cannot finish says so in the marker and throws. */
function rollBack(
  /** @type {System} */ system,
  /** @type {string} */ root,
  /** @type {Location} */ where,
  /** @type {Snapshot} */ before,
  /** @type {string} */ reason,
  /** @type {string | undefined} */ kind,
) {
  try {
    system.restore(where, before);
  } catch (error) {
    system.markDirty(root, `${reason}; ${/** @type {Error} */ (error).message}`, kind);
    throw error;
  }
  system.markDirty(root, reason, kind);
}

/**
 * @typedef {import("./dependency-policy.cjs").DependencyPlan & { valueOk?: (value: string) => boolean, pinned?: Record<string, string> }} Plan
 * @typedef {{ ok: boolean, status: number | null, violations: string[], output: string, restored: boolean }} TransactionResult
 */

/**
 * What a transaction may not have done, judged from the files alone: a protected path other than the
 * manifest and the lock changed, the manifest changed beyond the plan (or cannot be read), or the
 * lock is gone. Whether the lock still matches the manifest is a separate, costlier question.
 * @param {Snapshot} before @param {Snapshot} after
 * @param {import("./json.cjs").JsonObject} manifestBefore
 * @param {Plan} plan
 * @returns {string[]}
 */
function violationsFor(before, after, manifestBefore, plan) {
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
  return violations;
}

const DETAIL_LINES = 12;

/**
 * The violation for a failed lock check. The check's own output (credentials masked, bounded) rides
 * along, so a stale manifest and unreachable registry metadata can be told apart.
 * @param {string} output
 */
function lockViolation(output) {
  const detail = redact(output).trim().split("\n").slice(0, DETAIL_LINES).join("\n");
  const base = "the lock could not be verified against package.json after the transaction (stale lock, or registry metadata unavailable)";
  return detail ? `${base}:\n${detail}` : base;
}

/**
 * Runs pnpm steps, then accepts the result only if the manifest delta equals `plan` and no other
 * protected path changed. Otherwise protected files go back to the preimage and the environment is
 * marked dirty: node_modules may hold partial or hostile state that bytes cannot undo.
 * An accepted result is also checked against the frozen lock: a successful pnpm exit does not make a
 * manifest that was edited after pnpm's own write consistent. `kind` is stored with the incomplete-
 * install marker so recovery knows which command can progress; `lockCopy` lists extra relative paths
 * the disposable lock check needs (file: fixtures in tests; real dependencies are registry-only).
 * @param {{ root: string, steps: readonly (readonly string[])[], plan: Plan, runner?: Runner | undefined, kind?: string | undefined, lockCopy?: readonly string[], system?: System }} options
 * @returns {TransactionResult}
 */
function runTransaction({ root, steps, plan, runner = pnpmRunner(root), kind, lockCopy = [], system = SYSTEM }) {
  const where = system.locate(root);
  const before = system.snapshot(where);
  const preimage = before.get("package.json");
  if (preimage?.type !== "file") throw new Error("package.json is missing");
  const manifestBefore = parseObject(preimage.content.toString("utf8"));
  system.markDirty(root, "a dependency transaction did not finish", kind);
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
    rollBack(system, root, where, before, "a dependency transaction was interrupted", kind);
    throw error;
  }
  const after = system.snapshot(where);
  const violations = violationsFor(before, after, manifestBefore, plan);
  if (after.has("pnpm-lock.yaml") && status === 0 && violations.length === 0) {
    const lock = system.checkLock(root, lockCopy);
    if (!lock.ok) violations.push(lockViolation(lock.output));
  }
  const ok = status === 0 && violations.length === 0;
  if (ok) system.clearDirty(root);
  else {
    rollBack(system, root, where, before, violations.length > 0 ? "a dependency transaction was rejected" : "a dependency transaction failed", kind);
  }
  return { ok, status, violations, output, restored: !ok };
}

/**
 * Lock consistency without touching the active tree: pnpm sees only a disposable copy of the
 * metadata inputs, with the frozen and lock-only modes combined (verified against pnpm 12.14). Cached
 * metadata is preferred, but a cache miss may fetch it: a new lock hash needs supply-chain policy
 * metadata even when the graph and tarballs are already known. Fetching never accepts a stale lock.
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
    const result = pnpmRunner(copy)(["install", "--frozen-lockfile", "--lockfile-only", "--prefer-offline"]);
    return { ok: result.status === 0, output: result.stdout + result.stderr };
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

module.exports = {
  assertRestored,
  attemptAll,
  changedPaths,
  checkLock,
  keptNonEmpty,
  locate,
  locationFrom,
  pathOf,
  removalsFor,
  restore,
  runTransaction,
  snapshot,
  violationsFor,
  writesFor,
};
