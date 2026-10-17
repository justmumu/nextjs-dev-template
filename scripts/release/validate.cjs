// @ts-check
"use strict";
// What a release must satisfy: who may prepare one, what a reviewed release is, and which commits are
// the project's own to judge. The Git questions are asked through the project's Git runner so a
// decision about the answers is judged without a repository.
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const { commitIdentityErrors } = require("../core/toolchain.cjs");
const { CHANGELOG_FILE, extractSection } = require("./changelog.cjs");
const { ReleaseError, adapterFor, readVersion, versionOfTag } = require("./metadata.cjs");

/** The reviewed line of the project: the remote-tracking main, which only a fetch moves. */
const MAIN_REF = "refs/remotes/origin/main";
const UNFEATURED = new Set(["", "main", "master"]);

/** @typedef {import("./changelog.cjs").LineageGit & Pick<ReturnType<typeof import("../template/git.cjs").createGit>, "toplevel" | "hiddenFlags" | "changes">} Git */

/** @param {string} path @returns {string} */
function canonical(path) {
  try {
    return nodeFs.realpathSync(path);
  } catch {
    return nodePath.resolve(path);
  }
}

/** @param {Git} git @param {string} root */
function requireRepository(git, root) {
  if (canonical(git.toplevel(root)) !== canonical(root)) throw new ReleaseError("Run release commands from the repository root.");
  if (git.isShallow(root)) throw new ReleaseError("Release commands need full Git history; fetch with --unshallow first.");
}

/** @param {Git} git @param {string} root */
function requireFeatureBranch(git, root) {
  if (UNFEATURED.has(git.out(root, ["branch", "--show-current"]).trim())) throw new ReleaseError("Create a feature branch before preparing a release.");
}

/** @param {Git} git @param {string} root */
function requireCleanTree(git, root) {
  if (git.hiddenFlags(root).length > 0) throw new ReleaseError("A clean release cannot use index flags that hide local changes.");
  if (git.changes(root).length > 0) throw new ReleaseError("A release requires a clean working tree and index; commit or stash changes first.");
}

/** @param {Git} git @param {string} root @returns {string[]} */
const tagsOf = (git, root) =>
  git
    .out(root, ["tag", "--list"])
    .split("\n")
    .filter((tag) => tag !== "");

/** @param {Git} git @param {string} root @param {string} tag */
function requireFreeTag(git, root, tag) {
  if (tagsOf(git, root).includes(tag)) throw new ReleaseError(`Tag ${tag} already exists; published tags must not be replaced.`);
}

/**
 * Tagging is for the head of the current main, which must be the merge commit of a reviewed pull request.
 * @param {Git} git @param {string} root
 * @returns {string} the commit to tag
 */
function requireReviewedMain(git, root) {
  if (git.out(root, ["branch", "--show-current"]).trim() !== "main") throw new ReleaseError("Finalize a reviewed release from main.");
  /** @type {string} */
  let main;
  try {
    main = git.out(root, ["rev-parse", "--verify", "--quiet", `${MAIN_REF}^{commit}`]).trim();
  } catch {
    throw new ReleaseError("origin/main is not known here; fetch main before finalizing a release.");
  }
  const head = git.out(root, ["rev-parse", "--verify", "HEAD"]).trim();
  if (head !== main) throw new ReleaseError("Update main from origin/main before finalizing a release.");
  if (git.out(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").length < 3) {
    throw new ReleaseError("Finalize a reviewed release at its regular merge commit.");
  }
  return head;
}

/**
 * A release names the regular merge itself on main's first-parent line. Equal trees do not make
 * a feature commit the reviewed merge, and later main commits do not invalidate an earlier release.
 * @param {Git} git @param {string} root @param {string} commit
 * @returns {string | null} what is wrong, or null
 */
function reviewedTreeProblem(git, root, commit) {
  const lines = (/** @type {string[]} */ args) =>
    git
      .out(root, args)
      .split("\n")
      .filter((line) => line !== "");
  const firstParent = new Set(lines(["rev-list", "--first-parent", MAIN_REF]));
  const parents = git.out(root, ["rev-list", "--parents", "-n", "1", commit]).trim().split(" ");
  return firstParent.has(commit) && parents.length >= 3
    ? null
    : "The tag must name the reviewed regular merge commit on main; finalize the release after PR review.";
}

/**
 * @param {Git} git @param {string} root @param {string} spec @param {string} label
 * @returns {string}
 */
function tagged(git, root, spec, label) {
  try {
    return git.blob(root, spec).toString("utf8");
  } catch {
    throw new ReleaseError(`${label} is missing from the tagged commit.`);
  }
}

/**
 * Judges a release tag by the repository alone: an annotated tag of a commit that main contains,
 * reviewed, whose manifest has the tag's version and whose changelog has exactly one section for it.
 * A later main does not change the answer; only the tag's own history is judged.
 * @param {Git} git @param {string} root @param {string} role @param {string} tag
 * @returns {{ commit: string, version: string, notes: string }}
 */
function validateTag(git, root, role, tag) {
  const version = versionOfTag(tag);
  const reference = `refs/tags/${tag}`;
  /** @type {string} */
  let kind;
  try {
    kind = git.out(root, ["cat-file", "-t", reference]).trim();
  } catch {
    throw new ReleaseError(`Tag ${tag} does not exist.`);
  }
  if (kind !== "tag") throw new ReleaseError("A release requires an annotated tag.");
  const commit = git.out(root, ["rev-parse", "--verify", `${reference}^{commit}`]).trim();
  if (!git.isAncestor(root, commit, MAIN_REF)) throw new ReleaseError("The release tag is not reachable from origin/main.");
  const problem = reviewedTreeProblem(git, root, commit);
  if (problem !== null) throw new ReleaseError(problem);
  const { file } = adapterFor(role);
  if (readVersion(tagged(git, root, `${reference}:${file}`, file)) !== version) throw new ReleaseError(`Tag and tagged ${file} version must match.`);
  const notes = extractSection(tagged(git, root, `${reference}:${CHANGELOG_FILE}`, CHANGELOG_FILE), tag);
  return { commit, version, notes };
}

/**
 * The commits in `revisions` whose author or committer e-mail is not allowed by the policy. Only the
 * commit and the role are reported; an address is never copied into a message.
 * @param {Git} git @param {string} root @param {string} pattern @param {readonly string[]} revisions
 * @returns {string[]}
 */
function identityErrors(git, root, pattern, revisions) {
  const entries = git
    .out(root, ["log", "-z", "--format=%H%x1f%ae%x1f%ce", ...revisions])
    .split("\0")
    .filter((record) => record !== "")
    .map((record) => {
      const [rev = "", author = "", committer = ""] = record.split("\u001f");
      return { rev: rev.slice(0, 12), author, committer };
    });
  return commitIdentityErrors(entries, pattern);
}

module.exports = {
  MAIN_REF,
  identityErrors,
  requireCleanTree,
  requireFeatureBranch,
  requireFreeTag,
  requireRepository,
  requireReviewedMain,
  reviewedTreeProblem,
  tagsOf,
  validateTag,
};
