// @ts-check
"use strict";
// The short mutex that serializes guard runs for one worktree, and the journal that keeps what an
// interrupted run left behind. The mutex guards a single hook run, never a tool call: the long-lived
// reservation of a running call lives in the state, so a call outlasting the run that admitted it is
// never mistaken for a held lock. A lock is created exclusively, carries an ownership token and is
// released only by its owner. It is never reclaimed by age; one whose owner was killed is removed by
// offline recovery (recover-lock.cjs), which a person runs while every session is stopped.
const fs = require("node:fs");
const nodePath = require("node:path");

const LOCK_NAME = "lock";
const JOURNAL_NAME = "journal";
const STATE_NAME = "state.json";
const LOCK_WAIT_MS = 10_000;
const MAX_JOURNAL_FIELD = 300;

class GuardError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GuardError";
  }
}

/** @typedef {typeof fs} Disk the part of `node:fs` the guard's state uses; tests answer it from memory */

/** @param {unknown} error @returns {string} what went wrong, bounded for the journal */
const reasonOf = (error) => (error instanceof Error ? error.message : "unknown error").slice(0, MAX_JOURNAL_FIELD);

/** @param {number} ms */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @returns {string} a name that is unique to this process and moment */
const uniqueSuffix = () => `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;

/**
 * Keeps a record of something unusual that happened to the state. A journal entry is a new file that
 * is never rewritten, and failing to write one never hides the failure that caused it.
 * @param {string} dir the state directory @param {string} kind @param {Record<string, string | number | null>} details @param {Disk} [disk]
 */
function journal(dir, kind, details, disk = fs) {
  try {
    const directory = nodePath.join(dir, JOURNAL_NAME);
    disk.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = { kind, at: new Date().toISOString(), pid: process.pid, ...details };
    disk.writeFileSync(nodePath.join(directory, `${Date.now()}-${uniqueSuffix()}.json`), `${JSON.stringify(entry)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    // The journal is evidence for a person, not a dependency of the run.
  }
}

/** @param {string} dir @param {Disk} [disk] @returns {{ name: string, text: string }[]} the recorded entries, oldest first */
function readJournal(dir, disk = fs) {
  const directory = nodePath.join(dir, JOURNAL_NAME);
  try {
    return disk
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => ({ name, text: disk.readFileSync(nodePath.join(directory, name), "utf8") }));
  } catch {
    return [];
  }
}

/** @param {string} token @returns {string} the text a lock holds: the owner token and facts for a person to read */
const lockText = (token) => JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() });

/** @param {string} text @returns {{ token: string | null, pid: number | null, at: string | null }} what a lock file says, whatever it holds */
function describeLock(text) {
  try {
    /** @type {unknown} */
    const raw = JSON.parse(text);
    if (typeof raw === "object" && raw !== null) {
      const { token, pid, at } = /** @type {Record<string, unknown>} */ (raw);
      return {
        token: typeof token === "string" ? token : null,
        pid: typeof pid === "number" ? pid : null,
        at: typeof at === "string" ? at : null,
      };
    }
  } catch {
    // A lock this module did not write is described as having no owner.
  }
  return { token: null, pid: null, at: null };
}

/** @param {string} dir @param {Disk} [disk] @returns {{ text: string, token: string | null, pid: number | null, at: string | null } | null} the lock now held, if any */
function readLock(dir, disk = fs) {
  try {
    const text = disk.readFileSync(nodePath.join(dir, LOCK_NAME), "utf8");
    return { text, ...describeLock(text) };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Takes the mutex or reports it busy; it never takes one that exists.
 * @param {string} dir @param {number} waitMs @param {Disk} [disk] @returns {string} the owner token
 */
function acquire(dir, waitMs, disk = fs) {
  disk.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = nodePath.join(dir, LOCK_NAME);
  const token = uniqueSuffix();
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      disk.writeFileSync(path, lockText(token), { flag: "wx", mode: 0o600 });
      return token;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
      if (Date.now() >= until) throw new GuardError("another guard run holds the state lock; retry after it finishes");
      pause(25);
    }
  }
}

/**
 * Releases the mutex only if this owner still holds it. A lock that changed hands, or one that is
 * gone, is recorded and left alone: removing someone else's lock would let two runs write at once.
 * @param {string} dir @param {string} token @param {Disk} [disk]
 */
function release(dir, token, disk = fs) {
  const path = nodePath.join(dir, LOCK_NAME);
  let held;
  try {
    held = readLock(dir, disk);
  } catch (error) {
    journal(dir, "lock-release-unreadable", { error: reasonOf(error) }, disk);
    return;
  }
  if (held === null) {
    journal(dir, "lock-missing-at-release", { token }, disk);
    return;
  }
  if (held.token !== token) {
    journal(dir, "wrong-owner-release", { token, held: held.text.slice(0, MAX_JOURNAL_FIELD) }, disk);
    return;
  }
  try {
    disk.unlinkSync(path);
  } catch (error) {
    journal(dir, "lock-release-failed", { token, error: reasonOf(error) }, disk);
  }
}

/**
 * Serializes hook runs for one worktree.
 * @template T
 * @param {string} dir @param {() => T} action @param {number} [waitMs] @param {Disk} [disk]
 * @returns {T}
 */
function withLock(dir, action, waitMs = LOCK_WAIT_MS, disk = fs) {
  const token = acquire(dir, waitMs, disk);
  try {
    return action();
  } finally {
    release(dir, token, disk);
  }
}

/**
 * Writes a file atomically: a reader sees the old content or the new, never a torn file. The temporary
 * file shares the directory, so the rename cannot cross a filesystem. A write that fails midway leaves
 * the temporary file where it is, and the journal says so, for recovery to quarantine and a person to read.
 * @param {string} dir @param {string} name @param {string} text @param {Disk} [disk]
 */
function writeAtomic(dir, name, text, disk = fs) {
  disk.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = nodePath.join(dir, name);
  const temporary = `${path}.${uniqueSuffix()}.tmp`;
  try {
    const handle = disk.openSync(temporary, "w", 0o600);
    try {
      disk.writeFileSync(handle, text);
      disk.fsyncSync(handle);
    } finally {
      disk.closeSync(handle);
    }
    disk.renameSync(temporary, path);
  } catch (error) {
    journal(dir, "interrupted-write", { name, temporary: nodePath.basename(temporary), error: reasonOf(error) }, disk);
    throw error;
  }
}

module.exports = {
  GuardError,
  JOURNAL_NAME,
  LOCK_NAME,
  LOCK_WAIT_MS,
  STATE_NAME,
  acquire,
  describeLock,
  journal,
  readJournal,
  readLock,
  release,
  withLock,
  writeAtomic,
};
