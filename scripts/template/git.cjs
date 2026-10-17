// @ts-check
"use strict";
// The Git operations creation and enrollment need, behind one runner so decisions about their output
// are judged without a repository. Arguments are literal argv, never a shell line.
const { createHash, randomUUID } = require("node:crypto");
const { rmSync } = require("node:fs");
const nodePath = require("node:path");
const { run } = require("../core/process.cjs");

/** The identity of objects the generator itself makes (the pristine commits); it is never a person's. */
const PROVENANCE = { name: "nextjs-dev-template", email: "nextjs-dev-template@users.noreply.github.com" };
const REDIRECTS = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|NAMESPACE|PREFIX|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES)$/;
const CHUNK = 100;
const MODES = new Map([
  [0o644, "100644"],
  [0o755, "100755"],
]);

class GitError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * @typedef {{ path: string, mode: string, sha: string, stage: string }} IndexEntry
 * @typedef {{ status: number | null, stdout: string, stderr: string }} Result
 * @typedef {(command: string, args: readonly string[], options: { cwd: string, env?: NodeJS.ProcessEnv }) => Result} Start
 */

/** @param {Buffer} content @returns {string} the id Git gives a blob of these bytes */
function blobId(content) {
  return createHash("sha1")
    .update(`blob ${String(content.length)}\0`)
    .update(content)
    .digest("hex");
}

/** @param {readonly IndexEntry[]} entries @returns {string} what two readings of an index must share for nothing to have changed in it */
const indexKey = (entries) => entries.map((entry) => `${entry.mode} ${entry.sha} ${entry.stage} ${entry.path}`).join("\n");

/** @param {string} text @returns {string[]} the entries of NUL-separated output */
const nulList = (text) => text.split("\0").filter((entry) => entry !== "");

/**
 * What the index must hold for the rendered files to be the pristine tree: exactly these paths,
 * unmerged by nothing, with the bytes and modes that were rendered.
 * @param {readonly IndexEntry[]} entries
 * @param {readonly { path: string, mode: number, content: Buffer }[]} files
 * @returns {string[]}
 */
function treeProblems(entries, files) {
  const problems = [];
  const held = new Map(entries.map((entry) => [entry.path, entry]));
  for (const file of files) {
    const entry = held.get(file.path);
    if (entry === undefined) problems.push(`${file.path} is not in the pristine tree`);
    else if (entry.stage !== "0") problems.push(`${file.path} is unmerged`);
    else if (entry.mode !== MODES.get(file.mode)) problems.push(`${file.path} has mode ${entry.mode}`);
    else if (entry.sha !== blobId(file.content)) problems.push(`${file.path} differs from the rendered bytes in Git (a filter or attribute changed it)`);
  }
  const expected = new Set(files.map((file) => file.path));
  for (const entry of entries) if (!expected.has(entry.path)) problems.push(`${entry.path} is in the index but was not rendered`);
  return problems;
}

/** @param {NodeJS.ProcessEnv} base @returns {NodeJS.ProcessEnv} the environment with nothing that points Git at another repository */
function userEnv(base) {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !REDIRECTS.test(name)));
}

/**
 * Objects the generator makes itself read no configuration of the machine and carry its own identity.
 * @param {NodeJS.ProcessEnv} base @returns {NodeJS.ProcessEnv}
 */
function internalEnv(base) {
  const env = Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith("GIT_")));
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: PROVENANCE.name,
    GIT_AUTHOR_EMAIL: PROVENANCE.email,
    GIT_COMMITTER_NAME: PROVENANCE.name,
    GIT_COMMITTER_EMAIL: PROVENANCE.email,
  };
}

/**
 * @param {{ start?: Start, env?: NodeJS.ProcessEnv }} [options] `env` is the caller's environment: its Git configuration decides who enrolls
 */
function createGit({ start = run, env = process.env } = {}) {
  const user = userEnv(env);
  const internal = internalEnv(env);
  const plain = ["--literal-pathspecs", "-c", "core.quotepath=false"];
  const raw = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];

  /** @param {string} cwd @param {readonly string[]} args @param {boolean} [own] @param {NodeJS.ProcessEnv} [extra] @returns {Result} */
  const call = (cwd, args, own = false, extra = {}) =>
    start("git", [...plain, ...(own ? raw : []), ...args], { cwd, env: own ? { ...internal, ...extra } : user });

  /** @param {string} cwd @param {readonly string[]} args @param {boolean} [own] @param {NodeJS.ProcessEnv} [extra] @returns {string} */
  const out = (cwd, args, own = false, extra = {}) => {
    const result = call(cwd, args, own, extra);
    if (result.status !== 0) throw new GitError(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`);
    return result.stdout;
  };

  /** @param {string} cwd @param {boolean} [own] @param {NodeJS.ProcessEnv} [extra] @returns {IndexEntry[]} */
  const inventory = (cwd, own = false, extra = {}) =>
    nulList(out(cwd, ["ls-files", "-s", "-z"], own, extra)).map((line) => {
      const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(line);
      if (!match) throw new GitError(`unreadable index entry: ${JSON.stringify(line)}`);
      return { mode: String(match[1]), sha: String(match[2]), stage: String(match[3]), path: String(match[4]) };
    });

  /** @param {string} cwd @returns {string | null} the full id HEAD names, or null before the first commit */
  const headOf = (cwd) => {
    const result = call(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return result.status === 0 ? result.stdout.trim() : null;
  };

  return {
    out,
    inventory,
    head: headOf,
    /** @param {string} cwd @returns {string} */
    toplevel: (cwd) => out(cwd, ["rev-parse", "--show-toplevel"]).trim(),
    /** @param {string} cwd @param {string} path @returns {boolean} whether the commit HEAD names has this file */
    committed: (cwd, path) => call(cwd, ["cat-file", "-e", `HEAD:${path}`]).status === 0,
    /** @param {string} cwd @returns {string | null} */
    origin: (cwd) => {
      const result = call(cwd, ["config", "--get", "remote.origin.url"]);
      return result.status === 0 ? result.stdout.trim() : null;
    },
    /** @param {string} cwd @returns {boolean} whether Git can name both an author and a committer here */
    hasIdentity: (cwd) => call(cwd, ["var", "GIT_AUTHOR_IDENT"]).status === 0 && call(cwd, ["var", "GIT_COMMITTER_IDENT"]).status === 0,
    /** @param {string} cwd @returns {string[]} tracked paths whose index flags make Git ignore a change to them */
    hiddenFlags: (cwd) =>
      nulList(out(cwd, ["ls-files", "-v", "-z"]))
        .filter((line) => /^[a-zS] /.test(line))
        .map((line) => line.slice(2)),
    /** @param {string} cwd @returns {string[]} every path that differs from HEAD, staged, unstaged or untracked (ignored paths are not listed) */
    changes: (cwd) => nulList(out(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])),
    /** @param {string} cwd @returns {string[]} the ignored files and directories (with a trailing slash) */
    ignored: (cwd) => nulList(out(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])),
    /** @param {string} cwd @param {string} revision @returns {string} */
    treeOf: (cwd, revision) => out(cwd, ["rev-parse", "--verify", `${revision}^{tree}`]).trim(),
    /**
     * @param {string} cwd
     * @returns {boolean} whether a repository this process created still has no commit, no ref and nothing in its index; anything unprovable is false
     */
    untouched: (cwd) => {
      try {
        return headOf(cwd) === null && out(cwd, ["for-each-ref", "--format=%(refname)"]).trim() === "" && inventory(cwd).length === 0;
      } catch {
        return false;
      }
    },
    /**
     * Records the rendered files as a commit without running any hook. The tree is built in an index
     * of its own, so a change someone makes to the real index meanwhile is never overwritten; HEAD
     * moves only from `parent`, and only while the real index still holds `index`. Afterwards the
     * real index is made to match the new commit, again only if nobody changed it meanwhile.
     * Anything else that changed stays exactly as it is, and the error says so.
     * @param {string} cwd
     * @param {readonly { path: string, mode: number, content: Buffer }[]} files already written below `cwd`
     * @param {{ parent: string | null, message: string, index: readonly IndexEntry[] }} commit `index`: the entries the real index holds now
     * @returns {{ commit: string, tree: string }}
     */
    commitPristine: (cwd, files, { parent, message, index }) => {
      const gitDir = nodePath.resolve(cwd, out(cwd, ["rev-parse", "--absolute-git-dir"], true).trim());
      const own = { GIT_INDEX_FILE: nodePath.join(gitDir, `template-pristine-${randomUUID()}.index`) };
      const held = (/** @type {string} */ when) => {
        if (indexKey(inventory(cwd)) !== indexKey(index)) throw new GitError(`the index changed ${when}; it was left as it is`);
      };
      try {
        out(cwd, ["read-tree", "--empty"], true, own);
        for (let i = 0; i < files.length; i += CHUNK) {
          out(cwd, ["add", "-f", "--", ...files.slice(i, i + CHUNK).map((file) => file.path)], true, own);
        }
        const problems = treeProblems(inventory(cwd, true, own), files);
        if (problems.length > 0) throw new GitError(`the pristine tree is not the rendered tree: ${problems.join("; ")}`);
        const tree = out(cwd, ["write-tree"], true, own).trim();
        const commit = out(cwd, ["commit-tree", tree, ...(parent === null ? [] : ["-p", parent]), "-m", message], true).trim();
        held("before HEAD was moved");
        const moved = call(cwd, ["update-ref", "-m", message, "HEAD", commit, parent ?? "0".repeat(commit.length)], true);
        if (moved.status !== 0) {
          throw new GitError(`HEAD is no longer ${parent ?? "unborn"}, so it was not moved: ${moved.stderr.trim() || `exit ${String(moved.status)}`}`);
        }
        held(`after HEAD moved to the pristine commit ${commit}`);
        // Git's two-tree merge keeps concurrent staged entries or refuses a conflict while holding
        // its index lock. A plain read-tree would overwrite entries added after the last inspection.
        const previous = parent ?? out(cwd, ["mktree"], true).trim();
        out(cwd, ["read-tree", "-m", "-i", previous, commit], true);
        call(cwd, ["update-index", "-q", "--refresh"], true);
        return { commit, tree };
      } finally {
        rmSync(own.GIT_INDEX_FILE, { force: true });
      }
    },
    /** @param {string} cwd @returns {void} a repository without templates, hooks or configuration of the machine */
    init: (cwd) => {
      out(cwd, ["init", "--quiet", "--initial-branch=main", "--template=", "."], true);
    },
    /**
     * The enrollment commit is an ordinary commit of the caller: their identity, their hooks. It
     * commits only `paths`: HEAD must still be `head`, and nothing else may be staged, or it refuses.
     * @param {string} cwd @param {readonly string[]} paths @param {string} message @param {{ head?: string }} [expect]
     */
    commitAsCaller: (cwd, paths, message, expect = {}) => {
      if (expect.head !== undefined && headOf(cwd) !== expect.head) throw new GitError(`HEAD is no longer ${expect.head}; nothing was committed`);
      out(cwd, ["add", "-f", "--", ...paths]);
      const staged = nulList(out(cwd, ["diff", "--cached", "--name-only", "-z"]));
      const others = staged.filter((path) => !paths.includes(path));
      if (others.length > 0) {
        call(cwd, ["reset", "-q", "--", ...paths]);
        throw new GitError(`other changes are staged (${others.slice(0, 5).join(", ")}); nothing was committed and they stay staged`);
      }
      // Limit the normal, hook-running commit too: another process can stage a file after our check.
      out(cwd, ["commit", "--quiet", "-m", message, "--only", "--", ...paths]);
    },
  };
}

module.exports = { GitError, PROVENANCE, blobId, createGit, indexKey, internalEnv, treeProblems, userEnv };
