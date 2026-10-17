// @ts-check
"use strict";
// The steps of an update after its journal exists, and the three ways out of one: `resume` goes on
// where an interrupted update stopped (and finishes the bookkeeping of one that was committed),
// `abort` returns the project to where the update found it, `inspect` only says where it stands.
// Every step reads the journal and the repository first, runs at most once, and refuses on any
// doubt instead of overwriting something it did not write. Nothing here is run by an agent.
const nodePath = require("node:path");
const { indexKey } = require("./git.cjs");
const {
  BACKUP_DIR,
  JournalError,
  PENDING_REF,
  fileDigest,
  journalPaths,
  ownedMergeProblem,
  readFacts,
  readJournal,
  serializeJournal,
  sha256,
} = require("./journal.cjs");
const { STATE_FILE, advanceState, parseState, serializeState } = require("./state.cjs");

/**
 * @typedef {import("./journal.cjs").Journal} Journal
 * @typedef {import("./journal.cjs").Facts} Facts
 * @typedef {{
 *   git: Pick<ReturnType<typeof import("./git.cjs").createGit>, "out" | "inventory" | "blob" | "mergeNoCommit">,
 *   fs: typeof import("node:fs"),
 *   root: string,
 *   gitDir: string,
 *   io: { stdout: (text: string) => unknown, stderr: (text: string) => unknown },
 * }} Host
 */

/** @param {Host} host @returns {import("./journal.cjs").GitText} */
const textGit = (host) => (args) => {
  try {
    return { status: 0, stdout: host.git.out(host.root, ["-c", "core.quotepath=false", ...args]) };
  } catch {
    return { status: 1, stdout: "" };
  }
};

/** @param {Host} host @returns {Facts} */
const factsOf = (host) => {
  const journal = readJournal(host.gitDir, host.fs);
  if (journal === null) throw new JournalError("no template update is in progress");
  return readFacts({ root: host.root, gitDir: host.gitDir, disk: host.fs, git: textGit(host), journal });
};

/** @param {Host} host @returns {string[]} tracked paths that differ from HEAD, staged or not */
const trackedChanges = (host) =>
  host.git
    .out(host.root, ["status", "--porcelain=v1", "-z", "--untracked-files=no"])
    .split("\0")
    .filter((entry) => entry !== "");

/** @param {Host} host @param {Journal} journal @param {(journal: Journal) => Journal} change @returns {Journal} the journal as replaced whole, never half-written */
function replaceJournal(host, journal, change) {
  const next = change(journal);
  const { journal: target, dir } = journalPaths(host.gitDir);
  const partial = nodePath.join(dir, `journal.json.${String(process.pid)}.tmp`);
  host.fs.writeFileSync(partial, serializeJournal(next), { mode: 0o600 });
  host.fs.renameSync(partial, target);
  return next;
}

/**
 * Writes the first journal: complete or not at all, and only while there is none.
 * @param {Host} host @param {Journal} journal
 */
function createJournal(host, journal) {
  const { dir, journal: target } = journalPaths(host.gitDir);
  host.fs.mkdirSync(dir, { recursive: true });
  const partial = nodePath.join(dir, `journal.json.${String(process.pid)}.new`);
  host.fs.writeFileSync(partial, serializeJournal(journal), { mode: 0o600 });
  try {
    host.fs.linkSync(partial, target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST")
      throw new JournalError("a template update is already in progress; inspect, resume or abort it first");
    throw error;
  } finally {
    host.fs.rmSync(partial, { force: true });
  }
}

/**
 * One mutating command at a time. The lock is a file created exclusively; a command that was killed
 * leaves it, and it is removed by the person who has checked that no update command is running.
 * @template T
 * @param {Host} host @param {() => T} action @returns {T}
 */
function exclusively(host, action) {
  const { dir, lock } = journalPaths(host.gitDir);
  host.fs.mkdirSync(dir, { recursive: true });
  try {
    host.fs.writeFileSync(lock, `${String(process.pid)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST")
      throw new JournalError(`another update command holds ${lock}; if none is running, remove that file and try again`);
    throw error;
  }
  try {
    return action();
  } finally {
    host.fs.rmSync(lock, { force: true });
  }
}

/** @param {Host} host @param {Journal} journal @returns {string} the state file the update commits, derived again from the journal's own facts */
function nextStateText(host, journal) {
  const previous = parseState(host.git.blob(host.root, `${journal.start.head}:${STATE_FILE}`).toString("utf8"));
  return serializeState(
    advanceState(previous, {
      next: { commit: journal.next.commit, tree: journal.next.tree, renderDigest: journal.next.renderDigest },
      upstream: { url: journal.source.url, sha: journal.source.sha },
    }),
  );
}

/** @param {Host} host @param {string} path @param {Buffer | string} bytes writes a worktree file whole, keeping its mode */
function writeWhole(host, path, bytes) {
  const target = nodePath.join(host.root, path);
  const mode = host.fs.lstatSync(target).mode & 0o777;
  const partial = `${target}.${String(process.pid)}.tmp`;
  host.fs.writeFileSync(partial, bytes, { mode });
  host.fs.chmodSync(partial, mode);
  host.fs.renameSync(partial, target);
}

/** @param {Host} host @param {Journal} journal @param {Facts} facts @returns {string[]} what is wrong with a file the updater owns; empty when each is as the journal says, before or after */
function foreignEdits(host, journal, facts) {
  return journal.owned.flatMap((file, i) => {
    const held = facts.owned[i];
    const worktree = held?.worktree === file.before.digest || held?.worktree === file.after.digest;
    const index = held?.index === file.before.blob || held?.index === file.after.blob;
    return worktree && index ? [] : [file.path];
  });
}

/** @param {Journal} journal @param {string | null} pending */
function checkPending(journal, pending) {
  if (pending !== null && pending !== journal.next.commit) throw new JournalError("the pending snapshot points elsewhere; it was not removed");
}

/** @param {Host} host @param {Journal} journal the end of an update: its pending snapshot reference, journal and backups go; the preview stays */
function removeEnd(host, journal) {
  const paths = journalPaths(host.gitDir);
  const pending = textGit(host)(["rev-parse", "--verify", "--quiet", `${PENDING_REF}^{commit}`]);
  checkPending(journal, pending.status === 0 ? pending.stdout.trim() : null);
  if (pending.status === 0) host.git.out(host.root, ["update-ref", "-d", PENDING_REF, journal.next.commit]);
  host.fs.rmSync(paths.journal, { force: true });
  host.fs.rmSync(paths.backup, { recursive: true, force: true });
}

/** @param {Host} host @param {Journal} journal @param {Facts} facts @returns {boolean} whether the user's own commit completed this update */
function committed(host, journal, facts) {
  if (facts.head === null || facts.head === journal.start.head || facts.mergeHeads.length > 0 || facts.otherOperation) return false;
  // Ordinary application commits may follow the reviewed merge before the next update settles it.
  const history = textGit(host)(["rev-list", "--parents", "--merges", "--ancestry-path", `${journal.start.head}..HEAD`]);
  if (history.status !== 0) return false;
  return history.stdout
    .trim()
    .split("\n")
    .some((line) => {
      const [commit, ...parents] = line.split(" ");
      if (parents.length !== 2 || parents[0] !== journal.start.head || parents[1] !== journal.next.commit) return false;
      try {
        return journal.owned.every((file) => sha256(host.git.blob(host.root, `${commit}:${file.path}`)) === file.after.digest);
      } catch {
        return false;
      }
    });
}

/**
 * Takes the update from "prepared" to "ready": the native merge, then the state it commits. Each
 * step is skipped once the repository shows it is done, so a second call changes nothing.
 * @param {Host} host @param {Journal} journal
 * @returns {Journal}
 */
function conduct(host, journal) {
  let current = journal;
  const pending = factsOf(host).pending;
  checkPending(journal, pending);
  if (pending === null) throw new JournalError("the template update's pending snapshot is missing; inspect it before resuming");
  if (current.phase === "prepared") {
    const facts = factsOf(host);
    if (facts.head !== current.start.head) throw new JournalError("HEAD is not where the update began; abort it and preview again");
    if (facts.otherOperation) throw new JournalError("another merge, rebase, cherry-pick or revert is in progress");
    if (facts.mergeHeads.length === 0) {
      if (trackedChanges(host).length > 0)
        throw new JournalError("tracked files changed since the update began, so no merge was started; inspect them, then abort the update");
      const merged = host.git.mergeNoCommit(host.root, current.next.commit, `chore(template): update to ${current.source.sha.slice(0, 12)}`);
      if (merged.status !== 0 && merged.status !== 1) {
        removeEnd(host, current);
        throw new JournalError(`the merge could not start and the project is unchanged: ${merged.stderr.trim() || `exit ${String(merged.status)}`}`);
      }
    } else if (facts.mergeHeads.length !== 1 || facts.mergeHeads[0] !== current.next.commit) {
      throw new JournalError("a merge other than this update's is waiting");
    }
    if (sha256(indexKey(host.git.inventory(host.root, true))) !== current.outputDigest) {
      throw new JournalError("the merge in the project is not the one the preview described; abort the update and preview again");
    }
    current = replaceJournal(host, current, (held) => ({ ...held, phase: "merged" }));
  }
  if (current.phase === "merged") {
    const facts = factsOf(host);
    if (facts.mergeHeads.length !== 1 || facts.mergeHeads[0] !== current.next.commit) throw new JournalError("the merge of this update is no longer waiting");
    const foreign = foreignEdits(host, current, facts);
    if (foreign.length > 0) throw new JournalError(`${foreign.join(", ")} was changed by someone else; it was not overwritten`);
    for (const file of current.owned) {
      const wanted = nextStateText(host, current);
      if (sha256(wanted) !== file.after.digest) throw new JournalError(`${file.path} would not be what the preview bound`);
      if (fileDigest(nodePath.join(host.root, file.path), host.fs) !== file.after.digest) writeWhole(host, file.path, wanted);
      host.git.out(host.root, ["add", "--", file.path]);
    }
    const after = factsOf(host);
    if (after.owned.some((held, i) => held.index !== current.owned[i]?.after.blob)) throw new JournalError("the new state could not be staged");
    current = replaceJournal(host, current, (held) => ({ ...held, phase: "ready" }));
  }
  return current;
}

/** @param {Host} host @param {Journal} journal @param {Facts} facts @returns {string} where the update stands, in words */
function describe(host, journal, facts) {
  const conflicts = host.git
    .out(host.root, ["ls-files", "-u", "-z"])
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const lines = [
    `phase: ${journal.phase}`,
    `source: ${journal.source.sha}`,
    `started at HEAD: ${journal.start.head}`,
    `HEAD now: ${facts.head ?? "none"}`,
    `merge waiting: ${facts.mergeHeads.length > 0 ? facts.mergeHeads.join(" ") : "none"}`,
    `pending snapshot: ${facts.pending ?? "missing"}`,
    ...journal.owned.map((file, i) => {
      const held = facts.owned[i];
      const where = held?.worktree === file.after.digest ? "new" : held?.worktree === file.before.digest ? "original" : "changed by someone else";
      return `${file.path}: ${where}`;
    }),
    ...[...new Set(conflicts)].sort().map((path) => `unmerged: ${path}`),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Says where the update stands and what comes next. Changes nothing.
 * @param {Host} host @returns {number}
 */
function inspect(host) {
  const journal = readJournal(host.gitDir, host.fs);
  if (journal === null) {
    const orphan = textGit(host)(["rev-parse", "--verify", "--quiet", `${PENDING_REF}^{commit}`]);
    if (orphan.status === 0) {
      host.io.stderr(`no update journal, but ${PENDING_REF} points to ${orphan.stdout.trim()}; it is kept, and nothing here may delete it by guess\n`);
      return 1;
    }
    host.io.stdout("no template update is in progress\n");
    return 0;
  }
  const facts = readFacts({ root: host.root, gitDir: host.gitDir, disk: host.fs, git: textGit(host), journal });
  host.io.stdout(describe(host, journal, facts));
  const foreign = foreignEdits(host, journal, facts);
  if (foreign.length > 0) {
    host.io.stderr(`${foreign.join(", ")} was changed by someone else: manual recovery is needed, nothing will be overwritten\n`);
    return 1;
  }
  if (committed(host, journal, facts)) {
    host.io.stdout("the update was committed: run node scripts/template/update.cjs resume to finish its bookkeeping\n");
    return 0;
  }
  const problem = ownedMergeProblem(journal, facts);
  if (journal.phase === "ready" && problem === null) {
    host.io.stdout(
      "ready: finish it with guard-accept, deps-lock if the resolved lock is stale, repair and a normal commit, or run node scripts/template/update.cjs abort\n",
    );
  } else if (journal.phase === "ready" && facts.unmerged) {
    host.io.stdout("conflicted: resolve the unmerged paths and git add them, or run node scripts/template/update.cjs abort\n");
  } else {
    host.io.stdout(`${problem ?? "continue"}: run node scripts/template/update.cjs resume or abort\n`);
  }
  return 0;
}

/**
 * Finishes the bookkeeping of an update the user committed, so that the next one can start.
 * @param {Host} host @returns {boolean} whether no update is in progress any longer
 */
function settle(host) {
  return exclusively(host, () => {
    const journal = readJournal(host.gitDir, host.fs);
    if (journal === null) return true;
    if (!committed(host, journal, factsOf(host))) return false;
    removeEnd(host, journal);
    return true;
  });
}

/**
 * Goes on with the update where it stopped, or finishes the bookkeeping of one the user committed.
 * Never starts a second merge.
 * @param {Host} host @returns {number}
 */
function resume(host) {
  return exclusively(host, () => {
    const journal = readJournal(host.gitDir, host.fs);
    if (journal === null) {
      host.io.stdout("no template update is in progress\n");
      return 0;
    }
    const facts = factsOf(host);
    if (committed(host, journal, facts)) {
      removeEnd(host, journal);
      host.io.stdout("the update is committed; its journal and pending snapshot were removed\n");
      return 0;
    }
    if (facts.head !== journal.start.head)
      throw new JournalError("HEAD moved without completing the update; inspect it, and abort if the update is no longer wanted");
    const foreign = foreignEdits(host, journal, facts);
    if (foreign.length > 0) throw new JournalError(`${foreign.join(", ")} was changed by someone else; it was not overwritten`);
    if (journal.phase === "ready") {
      // Conflicts are left to the person, but the merge and updater-owned state must still be ours.
      const problem = ownedMergeProblem(journal, { ...facts, unmerged: false });
      if (problem !== null) throw new JournalError(problem);
      host.io.stdout("the update is already applied; nothing was merged again\n");
      return 0;
    }
    const done = conduct(host, journal);
    host.io.stdout(`the update continued to phase ${done.phase}\n`);
    return 0;
  });
}

/**
 * Returns the project to where the update found it, and keeps a backup of what it replaced until
 * it has. A file the updater owns that someone else changed is never overwritten.
 * @param {Host} host @returns {number}
 */
function abort(host) {
  return exclusively(host, () => {
    const journal = readJournal(host.gitDir, host.fs);
    if (journal === null) {
      host.io.stdout("no template update is in progress\n");
      return 0;
    }
    const facts = factsOf(host);
    checkPending(journal, facts.pending);
    if (committed(host, journal, facts)) throw new JournalError("the update is already committed; run resume to finish its bookkeeping");
    if (facts.head !== journal.start.head) throw new JournalError("HEAD moved without completing the update, so it was not rewound; inspect the history");
    if (facts.otherOperation) throw new JournalError("another merge, rebase, cherry-pick or revert is in progress");
    if (facts.mergeHeads.length > 1 || (facts.mergeHeads.length === 1 && facts.mergeHeads[0] !== journal.next.commit))
      throw new JournalError("the merge waiting is not this update's, so it was not aborted");
    const foreign = foreignEdits(host, journal, facts);
    if (foreign.length > 0) throw new JournalError(`${foreign.join(", ")} was changed by someone else; it was not overwritten and the update stays recorded`);

    const paths = journalPaths(host.gitDir);
    const backup = nodePath.join(paths.dir, BACKUP_DIR, `${String(Date.now())}-${String(process.pid)}`);
    host.fs.mkdirSync(backup, { recursive: true });
    host.fs.copyFileSync(paths.journal, nodePath.join(backup, "journal.json"));
    journal.owned.forEach((file, i) => {
      if (facts.owned[i]?.worktree !== null) host.fs.copyFileSync(nodePath.join(host.root, file.path), nodePath.join(backup, `owned-${String(i)}`));
    });
    try {
      for (const [i, file] of journal.owned.entries()) {
        if (facts.owned[i]?.worktree !== file.before.digest) {
          const original = host.git.blob(host.root, `${journal.start.head}:${file.path}`);
          if (sha256(original) !== file.before.digest) throw new JournalError(`${file.path} at the start of the update no longer matches the journal`);
          writeWhole(host, file.path, original);
        }
        if (facts.owned[i]?.index !== file.before.blob) host.git.out(host.root, ["reset", "-q", "HEAD", "--", file.path]);
      }
      if (facts.mergeHeads.length === 1) host.git.out(host.root, ["merge", "--abort"]);
      else if (trackedChanges(host).length > 0) throw new JournalError("no merge is waiting but tracked files differ from HEAD; inspect them");
      if (textGit(host)(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).status === 0 || trackedChanges(host).length > 0)
        throw new JournalError("the project is not clean after the abort; inspect it");
    } catch (error) {
      throw new JournalError(
        `${error instanceof Error ? error.message : String(error)}\nthe update stays recorded; a backup of what was replaced is in ${backup}`,
      );
    }
    removeEnd(host, journal);
    host.io.stdout("the update was aborted; HEAD, the index and the tracked files are as they were\n");
    return 0;
  });
}

module.exports = { abort, conduct, createJournal, exclusively, inspect, nextStateText, resume, settle, trackedChanges };
