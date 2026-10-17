// @ts-check
"use strict";
// The record of one template update that is in progress: what the project was, what the update
// brings and which files the updater itself writes (with their bytes before and after). It lives in
// the Git directory, never in tracked content, and is the only thing that lets the guard, the
// recovery commands and a later update tell an update this engine started from any other merge.
// It loads nothing but Node's own modules: the guard and the raw recovery entry both read it.
const { createHash } = require("node:crypto");
const nodePath = require("node:path");

const JOURNAL_SCHEMA = "nextjs-dev-template/update-journal";
const JOURNAL_VERSION = 1;
/** Where an update keeps its files inside the Git directory, next to the preview. */
const UPDATE_DIR = "template-update";
const JOURNAL_FILE = "journal.json";
const LOCK_FILE = "update.lock";
const BACKUP_DIR = "backup";
/** Keeps the pristine snapshot of an update alive for as long as the update is not finished; it is never removed by age. */
const PENDING_REF = "refs/template-update/pending";
const PHASES = /** @type {const} */ (["prepared", "merged", "ready"]);
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** Markers of a merge, rebase, cherry-pick or revert that is waiting to be finished, other than the merge of an update. */
const OTHER_OPERATIONS = ["CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply"];

/**
 * @typedef {{ digest: string, blob: string }} Content the sha-256 of a file's bytes and the Git blob id of the same bytes
 * @typedef {{ path: string, before: Content, after: Content }} Owned a file the updater writes itself
 * @typedef {{
 *   schema: typeof JOURNAL_SCHEMA, journalVersion: number, phase: (typeof PHASES)[number],
 *   source: { url: string, ref: string, sha: string },
 *   start: { head: string, baseline: { commit: string, tree: string } },
 *   next: { commit: string, tree: string, renderDigest: string },
 *   outputDigest: string, conflicted: boolean, owned: Owned[], pendingRef: typeof PENDING_REF,
 * }} Journal
 * @typedef {{ status: number | null, stdout: string }} GitResult
 * @typedef {(args: string[]) => GitResult} GitText runs Git in the project's worktree
 * @typedef {Pick<typeof import("node:fs"), "existsSync" | "readFileSync" | "lstatSync">} Reader
 * @typedef {{
 *   head: string | null, mergeHeads: string[], otherOperation: boolean, pending: string | null, unmerged: boolean,
 *   owned: { path: string, worktree: string | null, index: string | null }[],
 * }} Facts what the repository holds now, read without changing anything
 */

class JournalError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "JournalError";
  }
}

/** @param {string | Buffer} data @returns {string} */
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** @param {string} gitDir @returns {{ dir: string, journal: string, lock: string, backup: string }} */
const journalPaths = (gitDir) => {
  const dir = nodePath.join(gitDir, UPDATE_DIR);
  return { dir, journal: nodePath.join(dir, JOURNAL_FILE), lock: nodePath.join(dir, LOCK_FILE), backup: nodePath.join(dir, BACKUP_DIR) };
};

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @param {string[]} keys @param {string} label @returns {Record<string, unknown>} */
function exact(value, keys, label) {
  if (!isRecord(value)) throw new JournalError(`journal ${label} must be an object`);
  if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new JournalError(`journal ${label} has unexpected keys`);
  return value;
}

/** @param {unknown} value @param {RegExp} pattern @param {string} label @returns {string} */
function text(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new JournalError(`journal ${label} is not valid`);
  return value;
}

/** @param {unknown} value @param {string} label @returns {Content} */
function content(value, label) {
  const held = exact(value, ["digest", "blob"], label);
  return { digest: text(held.digest, DIGEST, `${label} digest`), blob: text(held.blob, OBJECT_ID, `${label} blob`) };
}

/**
 * Reads a journal strictly: a changed, foreign or half-written file is refused rather than guessed at.
 * @param {string} source
 * @returns {Journal}
 */
function parseJournal(source) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new JournalError("the update journal is not valid JSON");
  }
  const top = exact(raw, ["schema", "journalVersion", "phase", "source", "start", "next", "outputDigest", "conflicted", "owned", "pendingRef"], "file");
  if (top.schema !== JOURNAL_SCHEMA || top.journalVersion !== JOURNAL_VERSION) throw new JournalError("this is not an update journal this engine understands");
  const phase = PHASES.find((name) => name === top.phase);
  if (phase === undefined) throw new JournalError("journal phase is not valid");
  if (typeof top.conflicted !== "boolean") throw new JournalError("journal conflicted flag is not valid");
  if (top.pendingRef !== PENDING_REF) throw new JournalError("journal pending ref is not valid");
  if (!Array.isArray(top.owned)) throw new JournalError("journal owned files are not valid");
  const origin = exact(top.source, ["url", "ref", "sha"], "source");
  const start = exact(top.start, ["head", "baseline"], "start");
  const baseline = exact(start.baseline, ["commit", "tree"], "baseline");
  const next = exact(top.next, ["commit", "tree", "renderDigest"], "next");
  return {
    schema: JOURNAL_SCHEMA,
    journalVersion: JOURNAL_VERSION,
    phase,
    source: { url: text(origin.url, /^\S+$/, "source url"), ref: text(origin.ref, /^\S+$/, "source ref"), sha: text(origin.sha, OBJECT_ID, "source sha") },
    start: {
      head: text(start.head, OBJECT_ID, "start head"),
      baseline: { commit: text(baseline.commit, OBJECT_ID, "baseline commit"), tree: text(baseline.tree, OBJECT_ID, "baseline tree") },
    },
    next: {
      commit: text(next.commit, OBJECT_ID, "next commit"),
      tree: text(next.tree, OBJECT_ID, "next tree"),
      renderDigest: text(next.renderDigest, DIGEST, "render digest"),
    },
    outputDigest: text(top.outputDigest, DIGEST, "output digest"),
    conflicted: top.conflicted,
    owned: top.owned.map((item) => {
      const file = exact(item, ["path", "before", "after"], "owned file");
      return { path: text(file.path, /^[^\0]+$/, "owned path"), before: content(file.before, "before"), after: content(file.after, "after") };
    }),
    pendingRef: PENDING_REF,
  };
}

/** @param {Journal} journal @returns {string} */
const serializeJournal = (journal) => `${JSON.stringify(journal, null, 2)}\n`;

/**
 * The journal as the Git directory holds it, or null when no update is in progress. A file that
 * cannot be read as a journal is an error, never "no update".
 * @param {string} gitDir @param {Reader} disk @returns {Journal | null}
 */
function readJournal(gitDir, disk) {
  const { journal } = journalPaths(gitDir);
  if (!disk.existsSync(journal)) return null;
  return parseJournal(disk.readFileSync(journal, "utf8"));
}

/** @param {string} path @param {Reader} disk @returns {string | null} the sha-256 of a regular file's bytes, null when it is not one */
function fileDigest(path, disk) {
  try {
    return disk.lstatSync(path).isFile() ? sha256(disk.readFileSync(path)) : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ root: string, gitDir: string, disk: Reader, git: GitText, journal: Journal }} input
 * @returns {Facts}
 */
function readFacts({ root, gitDir, disk, git, journal }) {
  /** @param {string[]} args @returns {string | null} */
  const line = (args) => {
    const result = git(args);
    return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null;
  };
  const mergeFile = nodePath.join(gitDir, "MERGE_HEAD");
  const mergeHeads = disk.existsSync(mergeFile)
    ? disk
        .readFileSync(mergeFile, "utf8")
        .split("\n")
        .filter((entry) => entry !== "")
    : [];
  const listed = git(["ls-files", "-u", "-z"]);
  return {
    head: line(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
    mergeHeads,
    otherOperation: OTHER_OPERATIONS.some((marker) => disk.existsSync(nodePath.join(gitDir, marker))),
    pending: line(["rev-parse", "--verify", "--quiet", `${journal.pendingRef}^{commit}`]),
    unmerged: listed.status !== 0 || listed.stdout !== "",
    owned: journal.owned.map((file) => {
      const staged = git(["ls-files", "-s", "-z", "--", file.path]);
      const entry = staged.status === 0 ? /^\d+ ([0-9a-f]+) 0\t/.exec(staged.stdout) : null;
      return { path: file.path, worktree: fileDigest(nodePath.join(root, file.path), disk), index: entry?.[1] ?? null };
    }),
  };
}

/**
 * Whether the merge waiting in the repository is, whole and unchanged, the one this journal began
 * and its owner has finished: the answer the guard needs before it lets a user accept the result
 * of a template update. Anything else about a pending merge stays what it was: unresolved.
 * @param {Journal} journal @param {Facts} facts
 * @returns {string | null} why it is not, or null when it is
 */
function ownedMergeProblem(journal, facts) {
  if (journal.phase !== "ready") return "the template update has not finished its own steps; resume or abort it";
  if (facts.head !== journal.start.head) return "HEAD is not where the template update began";
  if (facts.otherOperation) return "another merge, rebase, cherry-pick or revert is in progress";
  if (facts.mergeHeads.length !== 1 || facts.mergeHeads[0] !== journal.next.commit) return "the merge waiting is not the template update's";
  if (facts.pending !== journal.next.commit) return "the template update's pending snapshot is missing or points elsewhere";
  if (facts.unmerged) return "the template update still has unmerged paths";
  for (const [index, file] of journal.owned.entries()) {
    const held = facts.owned[index];
    if (held?.worktree !== file.after.digest || held.index !== file.after.blob) return `${file.path} is not what the template update wrote`;
  }
  return null;
}

/**
 * The guard's question: is the merge waiting in this repository an update this engine owns and that
 * is ready to be accepted? A missing journal is "no"; an unreadable one is "no" with its reason.
 * @param {{ root: string, gitDir: string, disk: Reader, git: GitText }} input
 * @returns {{ owned: boolean, reason: string | null }}
 */
function ownedMerge({ root, gitDir, disk, git }) {
  try {
    const journal = readJournal(gitDir, disk);
    if (journal === null) return { owned: false, reason: "no template update is in progress" };
    const reason = ownedMergeProblem(journal, readFacts({ root, gitDir, disk, git, journal }));
    return { owned: reason === null, reason };
  } catch (error) {
    return { owned: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = {
  BACKUP_DIR,
  JOURNAL_FILE,
  JOURNAL_SCHEMA,
  JOURNAL_VERSION,
  JournalError,
  LOCK_FILE,
  PENDING_REF,
  UPDATE_DIR,
  fileDigest,
  journalPaths,
  ownedMerge,
  ownedMergeProblem,
  parseJournal,
  readFacts,
  readJournal,
  serializeJournal,
  sha256,
};
