// @ts-check
"use strict";
// The guard's durable state: one baseline per Git worktree, the reservations of calls that may still
// change protected files, and the machine-local Node binding. Reservations are identity-bound and
// never expire by age: a call is settled only by a result that carries its own identity, so a late or
// foreign result cannot approve a change that is waiting. Completion evidence beyond a matching host
// result (transcripts, yielded Codex sessions, offline lock recovery) is added on top of this
// contract by U7; the reservation shape leaves room for it without any broader shortcut.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const nodePath = require("node:path");
const { isObject } = require("../core/json.cjs");
const { STATE_DIR_NAME } = require("./policy.cjs");

const STATE_VERSION = 2;
const BINDING_NAME = "protected-baseline-node";
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_ID_LENGTH = 256;
const LOCK_WAIT_MS = 10_000;
// The dependency commands ask for this status from inside the very call that reserved them.
const SELF_CHECKING_ROUTES = ["deps-add", "deps-remove", "deps-upgrade", "deps-lock"];
const OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply"];

class GuardError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GuardError";
  }
}

/**
 * @typedef {import("./policy.cjs").Allowance} Allowance
 * @typedef {{
 *   client: string, session: string | null, turn: string | null, digest: string, exclusive: boolean, route: string | null,
 *   completion: "result", allowances: { success: Allowance, failure: Allowance },
 * }} Reservation a call that was admitted and has not been settled; `completion` names the evidence that settles it
 * @typedef {{
 *   version: number,
 *   policy: string,
 *   files: Record<string, string | null>,
 *   approved: Record<string, (string | null)[]>,
 *   head: string | null,
 *   hooks: { path: string | null, scripts: Record<string, string> },
 *   environment: string,
 *   environmentBlocked: boolean,
 *   user: Record<string, string | null>,
 *   blocked: string | null,
 *   inflight: Record<string, Reservation>,
 *   window: Allowance[],
 *   needsEvaluation: boolean,
 * }} State
 */

/** @typedef {typeof fs} Disk the part of `node:fs` the guard's state uses; tests answer it from memory */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isMap = (value) => isObject(value);

/**
 * Reads the stored baseline; anything that is not exactly the stored shape is an error, because a
 * baseline that cannot be trusted must not be reinterpreted.
 * @param {string} text
 * @returns {State}
 */
function parseState(text) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GuardError("guard state is not valid JSON");
  }
  if (!isMap(raw) || raw.version !== STATE_VERSION) throw new GuardError("guard state has an unsupported version");
  const hooks = raw.hooks;
  if (
    typeof raw.policy !== "string" ||
    !isMap(raw.files) ||
    !isMap(raw.approved) ||
    !isMap(raw.user) ||
    !isMap(raw.inflight) ||
    !Array.isArray(raw.window) ||
    !isMap(hooks) ||
    !isMap(hooks.scripts) ||
    typeof raw.environment !== "string" ||
    typeof raw.environmentBlocked !== "boolean" ||
    typeof raw.needsEvaluation !== "boolean" ||
    !(raw.blocked === null || typeof raw.blocked === "string") ||
    !(raw.head === null || typeof raw.head === "string")
  )
    throw new GuardError("guard state is malformed");
  return /** @type {State} */ (/** @type {unknown} */ (raw));
}

/** @param {string} dir the state directory @param {Disk} [disk] @returns {State | null} null before the first baseline */
function readState(dir, disk = fs) {
  const path = nodePath.join(dir, "state.json");
  let stat;
  try {
    stat = disk.statSync(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
  if (stat.size > MAX_STATE_BYTES) throw new GuardError("guard state is unreasonably large");
  return parseState(disk.readFileSync(path, "utf8"));
}

/** Writes the baseline atomically: a reader sees the old state or the new one, never a torn file. @param {string} dir @param {State} state @param {Disk} [disk] */
function writeState(dir, state, disk = fs) {
  disk.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = nodePath.join(dir, "state.json");
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = disk.openSync(temporary, "w", 0o600);
  try {
    disk.writeFileSync(handle, JSON.stringify(state, null, 1));
    disk.fsyncSync(handle);
  } finally {
    disk.closeSync(handle);
  }
  disk.renameSync(temporary, path);
}

/** @param {number} ms */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serializes hook runs for one worktree. The lock is never reclaimed by age; one that cannot be
 * taken in time is reported as busy, and an abandoned one is removed only by offline recovery.
 * @template T
 * @param {string} dir @param {() => T} action @param {number} [waitMs] @param {Disk} [disk]
 * @returns {T}
 */
function withLock(dir, action, waitMs = LOCK_WAIT_MS, disk = fs) {
  disk.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = nodePath.join(dir, "lock");
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      disk.writeFileSync(path, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      if (Date.now() >= until) throw new GuardError("another guard run holds the state lock; retry after it finishes");
      pause(25);
    }
  }
  try {
    return action();
  } finally {
    try {
      if (disk.readFileSync(path, "utf8") === token) disk.unlinkSync(path);
    } catch {
      // the lock was removed by offline recovery; there is nothing left to release
    }
  }
}

/** @param {string} dir @param {string} id @param {Buffer} content @param {Disk} [disk] keeps a copy of approved content so it can be restored */
function storeBlob(dir, id, content, disk = fs) {
  const blobs = nodePath.join(dir, "blobs");
  disk.mkdirSync(blobs, { recursive: true, mode: 0o700 });
  try {
    disk.writeFileSync(nodePath.join(blobs, id), content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
  }
}

/** @param {string} dir @param {string} id @param {Disk} [disk] @returns {Buffer | null} */
function readBlob(dir, id, disk = fs) {
  if (!/^[0-9a-f]{40,64}$/.test(id)) return null;
  try {
    return disk.readFileSync(nodePath.join(dir, "blobs", id));
  } catch {
    return null;
  }
}

/** Drops stored copies the baseline no longer needs; the approval history keeps ids only. @param {string} dir @param {Iterable<string | null>} keep @param {Disk} [disk] */
function pruneBlobs(dir, keep, disk = fs) {
  const wanted = new Set([...keep].filter(Boolean));
  const blobs = nodePath.join(dir, "blobs");
  if (!disk.existsSync(blobs)) return;
  for (const name of disk.readdirSync(blobs)) if (!wanted.has(name)) disk.rmSync(nodePath.join(blobs, name), { force: true });
}

/**
 * The identity a host result must carry to settle a reservation.
 * @param {Record<string, unknown>} payload @param {string} client
 * @returns {{ id: string, client: string, session: string | null, turn: string | null }}
 */
function identityOf(payload, client) {
  const id = payload.tool_use_id;
  if (typeof id !== "string" || id === "" || id.length > MAX_ID_LENGTH)
    throw new GuardError("the call carries no usable tool_use_id, so it cannot be identified");
  /** @param {unknown} value */
  const optional = (value) => (typeof value === "string" && value !== "" && value.length <= MAX_ID_LENGTH ? value : null);
  return { id, client, session: optional(payload.session_id), turn: optional(payload.turn_id) };
}

/**
 * Admits a call. A call whose id is already reserved is refused rather than shared.
 * @param {State} state @param {string} id @param {Reservation} reservation
 * @returns {boolean} whether it was admitted
 */
function reserve(state, id, reservation) {
  if (Object.hasOwn(state.inflight, id)) return false;
  state.inflight[id] = reservation;
  return true;
}

/**
 * Settles a reservation from a host result. Only the result of the very call that was admitted
 * settles it: another client, session, turn or command leaves the reservation and approves nothing.
 * @param {State} state
 * @param {ReturnType<typeof identityOf>} identity
 * @param {string} digest identifies the command or edit the result belongs to
 * @param {"success" | "failure"} outcome
 * @returns {{ settled: true } | { settled: false, reason: string }}
 */
function settle(state, identity, digest, outcome) {
  const entry = Object.hasOwn(state.inflight, identity.id) ? state.inflight[identity.id] : undefined;
  if (!entry) return { settled: false, reason: "no reservation for this call" };
  if (entry.client !== identity.client || entry.session !== identity.session || entry.turn !== identity.turn || entry.digest !== digest)
    return { settled: false, reason: "the result does not belong to the reserved call" };
  Reflect.deleteProperty(state.inflight, identity.id);
  state.window.push(entry.allowances[outcome]);
  state.needsEvaluation = true;
  return { settled: true };
}

/** @param {State} state @returns {Record<string, Reservation>} the calls that may still change protected files */
function liveCalls(state) {
  return state.inflight;
}

/** @param {string} gitDir @param {Disk} [disk] @returns {boolean} whether a merge, rebase, cherry-pick or revert is waiting to be finished */
function operationInProgress(gitDir, disk = fs) {
  return OPERATION_MARKERS.some((marker) => disk.existsSync(nodePath.join(gitDir, marker)));
}

/**
 * @param {string} cwd
 * @returns {{ root: string, gitDir: string, commonDir: string }}
 */
function locateGit(cwd) {
  const out = execFileSync("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const [root, gitDir, commonDir] = out.split("\n");
  if (!root || !gitDir || !commonDir) throw new GuardError("not inside a Git worktree");
  return { root: fs.realpathSync(root), gitDir, commonDir };
}

/**
 * The answer the dependency transaction asks for before it changes anything: only an explicit
 * `clean: true` lets it proceed. A missing baseline, a pending reservation, a held conflict or
 * environment drift are not clean, and neither is anything that cannot be read.
 * @param {string} root
 * @param {{ gitDir?: string, disk?: Disk }} [options]
 * @returns {{ clean: boolean, reason?: string }}
 */
function status(root, options = {}) {
  try {
    const gitDir = options.gitDir ?? locateGit(root).gitDir;
    const disk = options.disk ?? fs;
    const state = readState(nodePath.join(gitDir, STATE_DIR_NAME), disk);
    if (state === null)
      return { clean: false, reason: "the guard has no approved baseline yet; commit the project, then run node scripts/bootstrap.cjs guard-accept" };
    const reserved = Object.values(state.inflight);
    const own = reserved.length === 1 && SELF_CHECKING_ROUTES.includes(reserved[0]?.route ?? "");
    const pending = own ? [] : Object.keys(state.inflight);
    if (pending.length > 0) return { clean: false, reason: `${pending.length} call(s) that may change protected files have not finished` };
    if (state.blocked) return { clean: false, reason: state.blocked };
    if (state.needsEvaluation || state.window.length > 0) return { clean: false, reason: "finished calls have not been checked yet" };
    if (state.environmentBlocked)
      return { clean: false, reason: "the dependency environment changed outside an approved route; run node scripts/bootstrap.cjs repair" };
    if (operationInProgress(gitDir, disk)) return { clean: false, reason: "a merge, rebase, cherry-pick or revert is waiting to be finished" };
    return { clean: true };
  } catch (error) {
    return { clean: false, reason: `the guard state could not be read (${/** @type {Error} */ (error).message})` };
  }
}

/**
 * Binds the Node the launcher runs. The binding is machine-local Git state, never repository
 * content, and it must be an absolute, executable file outside the project and its dependencies.
 * @param {string} root @param {string} candidate
 * @returns {string} the bound path
 */
function bindNode(root, candidate) {
  if (!nodePath.isAbsolute(candidate)) throw new GuardError("the Node binary must be an absolute path");
  const real = fs.realpathSync(candidate);
  const project = fs.realpathSync(root);
  if (real === project || real.startsWith(project + nodePath.sep)) throw new GuardError("the Node binary must be outside the project and its dependencies");
  fs.accessSync(real, fs.constants.X_OK);
  if (!fs.statSync(real).isFile()) throw new GuardError("the Node binary must be a file");
  const { commonDir } = locateGit(root);
  const target = nodePath.join(commonDir, BINDING_NAME);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${real}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return real;
}

module.exports = {
  GuardError,
  MAX_STATE_BYTES,
  STATE_DIR_NAME,
  STATE_VERSION,
  bindNode,
  identityOf,
  liveCalls,
  locateGit,
  operationInProgress,
  parseState,
  pruneBlobs,
  readBlob,
  readState,
  reserve,
  settle,
  status,
  storeBlob,
  withLock,
  writeState,
};
