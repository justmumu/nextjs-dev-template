// @ts-check
"use strict";
// Decides when a reserved call has really finished. A reservation is closed only by evidence that
// carries the call's own identity: a terminal item of the call's own leaf transcript (session, turn and
// call id), an intercepted patch, or a tool result that names the call. Yielded output, the passing of
// time and a repeated record close nothing, so an unknown stays pending. The module loads only `node:`
// modules, so the guard can run it without resolving the project's package.json.
const fs = require("node:fs");
const nodePath = require("node:path");

/** Bytes of one transcript record, of the header, and of one scan; larger evidence is not evidence. */
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const STORES = ["sessions", "archived_sessions"];
const RESULT_KINDS = new Set(["tool_result", "function_call_output", "custom_tool_call_output"]);
const PATCH_STATUSES = new Set(["completed", "failed", "declined"]);

/**
 * @typedef {import("./state.cjs").State} State
 * @typedef {import("./state.cjs").Reservation} Reservation
 * @typedef {"success" | "failure" | "not-executed"} Outcome how a call ended
 * @typedef {Outcome | "pending" | null} Verdict `null` means the transcript cannot govern this call (a result settles it)
 * @typedef {Pick<typeof fs, "openSync" | "closeSync" | "readSync" | "fstatSync" | "lstatSync" | "statSync" | "realpathSync" | "readdirSync">} Files
 * @typedef {{ codexHome: string, files?: Files }} Environment where the host keeps its transcripts
 * @typedef {{ identity: [string, string] | null, offset: number, discarding: boolean }} Reader
 * @typedef {{ parent: (thread: string) => string | null }} Ancestry
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads one line of at most `limit` bytes, newline included.
 * @param {Files} files @param {number} fd @param {number} position @param {number} limit
 * @returns {Buffer}
 */
function readLine(files, fd, position, limit) {
  /** @type {Buffer[]} */
  const parts = [];
  let size = 0;
  while (size < limit) {
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, limit - size));
    const read = files.readSync(fd, buffer, 0, buffer.length, position + size);
    if (read === 0) break;
    const newline = buffer.subarray(0, read).indexOf(10);
    const used = newline === -1 ? read : newline + 1;
    parts.push(buffer.subarray(0, used));
    size += used;
    if (newline !== -1) break;
  }
  return Buffer.concat(parts);
}

/** @param {Buffer} line @returns {boolean} */
const complete = (line) => line.length > 0 && line[line.length - 1] === 10;

/**
 * Opens a transcript for reading without ever waiting on it: a FIFO or a device is refused.
 * @param {Files} files @param {string} path
 * @returns {number}
 */
function openRegular(files, path) {
  const fd = files.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  if (!files.fstatSync(fd).isFile()) {
    files.closeSync(fd);
    throw new Error("a transcript must be a regular file");
  }
  return fd;
}

/**
 * Finds the parent header of a transcript by id, under the host's two stores and without following a
 * link out of them. Every transcript of the same id must agree on the parent; a missing, partial,
 * malformed, impostor or conflicting header proves nothing and throws.
 * @param {Environment} environment
 * @returns {Ancestry}
 */
function createAncestry(environment) {
  const files = environment.files ?? fs;
  /** @type {{ root: string, path: string, name: string }[] | null} */
  let found = null;
  /** @type {Map<string, string | null>} */
  const parents = new Map();

  function discover() {
    /** @type {{ root: string, path: string, name: string }[]} */
    const paths = [];
    for (const store of STORES) {
      const base = nodePath.join(environment.codexHome, store);
      const stat = files.lstatSync(base, { throwIfNoEntry: false });
      if (stat === undefined) continue;
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Invalid rollout store");
      const root = files.realpathSync(base);
      const pending = [root];
      for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
        for (const entry of files.readdirSync(directory, { withFileTypes: true })) {
          const path = nodePath.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(path);
          else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) paths.push({ root, path, name: entry.name });
        }
      }
    }
    return paths;
  }

  return {
    parent(thread) {
      if (parents.has(thread)) return parents.get(thread) ?? null;
      found ??= discover();
      /** @type {string | null} */
      let parent = null;
      for (const candidate of found) {
        if (!candidate.name.endsWith(`-${thread}.jsonl`)) continue;
        const real = files.realpathSync(candidate.path);
        if (!real.startsWith(candidate.root + nodePath.sep) || !files.statSync(real).isFile()) throw new Error("Invalid parent transcript path");
        const fd = openRegular(files, real);
        let header;
        try {
          header = readLine(files, fd, 0, TRANSCRIPT_TAIL_BYTES + 1);
        } finally {
          files.closeSync(fd);
        }
        if (header.length > TRANSCRIPT_TAIL_BYTES || !complete(header)) throw new Error("Incomplete parent transcript header");
        /** @type {unknown} */
        const record = JSON.parse(header.toString("utf8"));
        if (!isRecord(record) || record.type !== "session_meta") throw new Error("Invalid parent transcript header");
        const metadata = record.payload;
        if (!isRecord(metadata) || metadata.id !== thread) throw new Error("Parent transcript identity mismatch");
        const named = metadata.parent_thread_id;
        if (typeof named !== "string" || named === "" || (parent !== null && parent !== named)) throw new Error("Invalid or conflicting transcript ancestry");
        parent = named;
      }
      parents.set(thread, parent);
      return parent;
    },
  };
}

/**
 * Binds the first record of a transcript to the hook's session through verified parent headers.
 * @param {unknown} record @param {{ session: string | null }} entry @param {Ancestry} ancestry
 * @returns {string | null} the leaf thread of a paginated transcript, "" for a legacy one, null when unproven
 */
function rolloutThread(record, entry, ancestry) {
  if (!isRecord(record)) return null;
  const metadata = record.payload;
  if (record.type !== "session_meta" || !isRecord(metadata)) return null;
  const thread = metadata.id;
  if (typeof thread !== "string" || thread === "") return null;
  let ancestor = thread;
  let parent = metadata.parent_thread_id;
  const visited = new Set([thread]);
  while (ancestor !== entry.session) {
    if (typeof parent !== "string" || parent === "" || visited.has(parent)) return null;
    if (parent === entry.session) break;
    visited.add(parent);
    ancestor = parent;
    parent = ancestry.parent(ancestor);
  }
  const mode = "history_mode" in metadata ? metadata.history_mode : "legacy";
  if (mode === "legacy") return "";
  return mode === "paginated" ? thread : null;
}

/**
 * Reads a terminal item of this very call, not the first response of a yielded command.
 * @param {unknown} record @param {{ turn: string | null }} entry @param {string} callId @param {string} thread
 * @returns {Outcome | null}
 */
function commandOutcome(record, entry, callId, thread) {
  if (!isRecord(record) || record.type !== "event_msg") return null;
  const payload = record.payload;
  if (!isRecord(payload) || payload.type !== "item_completed" || payload.thread_id !== thread || payload.turn_id !== entry.turn || !isRecord(payload.item))
    return null;
  const item = payload.item;
  if (item.id !== callId) return null;
  // exec_command can intercept apply_patch without ever spawning a process, and that is no shell success.
  if (item.type === "FileChange" && typeof item.status === "string" && PATCH_STATUSES.has(item.status)) return "not-executed";
  if (item.type !== "CommandExecution" || item.source !== "unified_exec_startup") return null;
  const code = item.exit_code;
  if (typeof code !== "number" || !Number.isInteger(code) || item.status !== (code === 0 ? "completed" : "failed")) return null;
  const process = item.process_id;
  if (typeof process === "string" && process !== "") return code === 0 ? "success" : "failure";
  return (process === null || process === undefined) && code === -1 ? "not-executed" : null;
}

/**
 * The reader that remembers how far a transcript was read. What is stored is not trusted: anything
 * that is not exactly the stored shape starts over.
 * @param {Reservation} entry @returns {Reader}
 */
function readerOf(entry) {
  /** @type {unknown} */
  const stored = entry.rolloutReader;
  const valid =
    isRecord(stored) &&
    Number.isSafeInteger(stored.offset) &&
    /** @type {number} */ (stored.offset) >= 0 &&
    typeof stored.discarding === "boolean" &&
    Array.isArray(stored.identity) &&
    stored.identity.length === 2 &&
    stored.identity.every((part) => typeof part === "string");
  entry.rolloutReader = valid ? /** @type {Reader} */ (stored) : { identity: null, offset: 0, discarding: false };
  return /** @type {Reader} */ (entry.rolloutReader);
}

/**
 * Advances over complete records within a byte budget; incomplete or oversized evidence stays pending.
 * @param {Files} files @param {number} fd @param {number} headerEnd @param {Reservation} entry @param {string} callId @param {string} thread @param {number} budget
 * @returns {Outcome | "pending"}
 */
function scan(files, fd, headerEnd, entry, callId, thread, budget) {
  const progress = readerOf(entry);
  const stat = files.fstatSync(fd, { bigint: true });
  const identity = /** @type {[string, string]} */ ([String(stat.dev), String(stat.ino)]);
  if (progress.identity?.[0] !== identity[0] || progress.identity[1] !== identity[1] || stat.size < BigInt(progress.offset)) {
    progress.identity = identity;
    progress.offset = 0;
    progress.discarding = false;
  }
  let position = Math.max(headerEnd, progress.offset);
  const full = budget;
  while (budget > 0) {
    const line = readLine(files, fd, position, budget + 1);
    if (line.length === 0) return "pending";
    position += line.length;
    if (progress.discarding || (line.length > budget && budget === full)) {
      // An oversized record cannot supply evidence; skip to its next newline.
      progress.offset = position;
      progress.discarding = !complete(line);
      budget -= line.length;
      continue;
    }
    budget -= line.length;
    if (budget < 0 || !complete(line)) return "pending";
    /** @type {unknown} */
    let record;
    try {
      record = JSON.parse(line.toString("utf8"));
    } catch {
      return "pending";
    }
    const outcome = commandOutcome(record, entry, callId, thread);
    if (outcome !== null) return outcome;
    progress.offset = position;
  }
  return "pending";
}

/**
 * What the host's own transcript says about a Codex shell call.
 * @param {Reservation} entry @param {string} callId
 * @param {{ environment: Environment, ancestry: Ancestry, starting?: boolean }} context `starting` is the admission: history before it is skipped
 * @returns {Verdict}
 */
function commandCompletion(entry, callId, { environment, ancestry, starting = false }) {
  if (entry.client !== "codex" || !entry.shell || !entry.session || !entry.turn || !entry.transcript) return null;
  const files = environment.files ?? fs;
  try {
    const fd = openRegular(files, entry.transcript);
    try {
      const header = readLine(files, fd, 0, TRANSCRIPT_TAIL_BYTES + 1);
      if (header.length > TRANSCRIPT_TAIL_BYTES || !complete(header)) return "pending";
      const thread = rolloutThread(JSON.parse(header.toString("utf8")), entry, ancestry);
      if (thread === null) return "pending";
      if (thread === "") return entry.rolloutRequired ? "pending" : null;
      entry.rolloutRequired = true;
      if (starting) {
        const stat = files.fstatSync(fd, { bigint: true });
        const last = Buffer.alloc(1);
        if (files.readSync(fd, last, 0, 1, Number(stat.size) - 1) === 1 && last[0] === 10) {
          entry.rolloutReader = { identity: [String(stat.dev), String(stat.ino)], offset: Number(stat.size), discarding: false };
          return "pending";
        }
      }
      return scan(files, fd, header.length, entry, callId, thread, TRANSCRIPT_TAIL_BYTES - header.length);
    } finally {
      files.closeSync(fd);
    }
  } catch {
    // A transcript that cannot be read or trusted proves nothing; the call stays pending.
    return "pending";
  }
}

/** @param {unknown} node @param {string} callId @returns {boolean} whether a transcript record holds a tool result that answers the call */
function hasResult(node, callId) {
  if (Array.isArray(node)) return node.some((value) => hasResult(value, callId));
  if (!isRecord(node)) return false;
  if (typeof node.type === "string" && RESULT_KINDS.has(node.type) && (node.tool_use_id === callId || node.call_id === callId)) return true;
  return Object.values(node).some((value) => hasResult(value, callId));
}

/**
 * Recognizes a call whose result already reached a legacy transcript, e.g. a denied one.
 * @param {Reservation} entry @param {string} callId @param {Environment} environment
 * @returns {boolean}
 */
function transcriptFinished(entry, callId, environment) {
  if (!entry.transcript) return false;
  const files = environment.files ?? fs;
  let data;
  try {
    const fd = openRegular(files, entry.transcript);
    try {
      const size = Number(files.fstatSync(fd, { bigint: true }).size);
      const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      const read = files.readSync(fd, buffer, 0, buffer.length, start);
      data = buffer.subarray(0, read);
    } finally {
      files.closeSync(fd);
    }
  } catch {
    return false;
  }
  const needle = Buffer.from(callId);
  if (data.indexOf(needle) === -1) return false;
  return data
    .toString("utf8")
    .split("\n")
    .some((line) => {
      if (!line.includes(callId)) return false;
      try {
        return hasResult(JSON.parse(line), callId);
      } catch {
        return false;
      }
    });
}

/**
 * Closes a reservation once and schedules the protected-state check. Only a process that really ran
 * grants the allowance recorded for its outcome; a call that never executed grants nothing.
 * @param {State} state @param {string} callId @param {Outcome | null} outcome
 */
function finishCall(state, callId, outcome) {
  const entry = Object.hasOwn(state.inflight, callId) ? state.inflight[callId] : undefined;
  if (entry === undefined) return;
  Reflect.deleteProperty(state.inflight, callId);
  const granted = outcome === "success" || outcome === "failure" ? entry.allowances[outcome] : undefined;
  if (granted) state.window.push(granted);
  state.needsEvaluation = true;
}

/**
 * Closes every reservation that positive, identity-bound evidence finished, and returns the rest.
 * @param {State} state @param {Environment} environment @param {Ancestry} [ancestry] shared by the calls of one reconciliation
 * @returns {Record<string, Reservation>} the calls that may still change protected files
 */
function liveCalls(state, environment, ancestry = createAncestry(environment)) {
  for (const [callId, entry] of Object.entries(state.inflight)) {
    const verdict = commandCompletion(entry, callId, { environment, ancestry });
    if (verdict === "success" || verdict === "failure" || verdict === "not-executed") finishCall(state, callId, verdict);
    else if (verdict === null && transcriptFinished(entry, callId, environment)) finishCall(state, callId, null);
  }
  return state.inflight;
}

/** @param {Record<string, Reservation>} calls @returns {Reservation[]} the live calls that keep protected state from being judged */
const exclusiveCalls = (calls) => Object.values(calls).filter((entry) => entry.exclusive);

module.exports = {
  TRANSCRIPT_TAIL_BYTES,
  commandCompletion,
  commandOutcome,
  createAncestry,
  exclusiveCalls,
  finishCall,
  hasResult,
  liveCalls,
  rolloutThread,
  transcriptFinished,
};
