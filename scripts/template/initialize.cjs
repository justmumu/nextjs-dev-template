// @ts-check
"use strict";
// GitHub creation (F2): the repository GitHub copied from the template carries one real commit O.
// The copy is converted in place: the rendered application is validated in staging first, then
// installed over the generator's files from a backup, recorded as the pristine commit B0 (a child
// of O, so O stays in the history) and enrolled by E0. O is the copy's own commit, not a revision
// of the template, and nothing here looks it up anywhere.
const nodePath = require("node:path");
const render = require("./render.cjs");
const { indexKey } = require("./git.cjs");
const { isRecord } = require("./manifest.cjs");
const { validateAnswers } = require("./inputs.cjs");
const { STATE_FILE } = require("./state.cjs");
const {
  PRISTINE_MESSAGE,
  enroll,
  ignoredCollisions,
  installTree,
  linkProblems,
  planInstall,
  sourceDrift,
  sourceProblems,
  stageAndValidate,
  workflowParity,
} = require("./transaction.cjs");

/** Present in a copy of the template that has not been initialized; the pristine tree does not have it. */
const SENTINEL = "tooling/template-sentinel.json";
/** The public repository of this template; a checkout of it is never converted, whatever the answers name. */
const SOURCE_REPOSITORY = "justmumu/nextjs-dev-template";
const GITHUB_REMOTE = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;

/**
 * The repository converted must be the one the answers name: a checkout of the template itself
 * (whose origin is the template's) is never turned into an application.
 * @param {string | null} origin
 * @param {{ name: string, owner: string | null }} answers
 * @returns {string | null} why the origin is not the new repository, or null
 */
function originProblem(origin, answers) {
  if (origin === null) return null;
  const match = GITHUB_REMOTE.exec(origin);
  if (match === null) return "origin does not name a GitHub repository";
  if (`${match[1] ?? ""}/${match[2] ?? ""}`.toLowerCase() === SOURCE_REPOSITORY) {
    return `origin is ${SOURCE_REPOSITORY}, the template itself; its own checkout is not converted`;
  }
  const expected = `${answers.owner ?? ""}/${answers.name.split("/").pop() ?? ""}`.toLowerCase();
  const actual = `${match[1] ?? ""}/${match[2] ?? ""}`.toLowerCase();
  return actual === expected
    ? null
    : `origin is ${actual}, not the repository ${expected} this initialization is for; the template's own checkout is not converted`;
}

/** @param {import("./transaction.cjs").Host} host @param {string} path @returns {Buffer | null} */
function readIfPresent(host, path) {
  try {
    return host.disk.readFileSync(path);
  } catch {
    return null;
  }
}

/** @param {import("./transaction.cjs").Host} host @param {string} root @returns {import("./transaction.cjs").Snapshot} */
function snapshotOf(host, root) {
  return { head: host.git.head(root), hidden: host.git.hiddenFlags(root), changes: host.git.changes(root), inventory: host.git.inventory(root) };
}

/** @param {import("./transaction.cjs").Host} host @param {string} root @param {import("./transaction.cjs").Snapshot} first @returns {boolean} whether HEAD and the index are as the first look left them */
function stillAsFirst(host, root, first) {
  try {
    return host.git.head(root) === first.head && indexKey(host.git.inventory(root)) === indexKey(first.inventory);
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   host: import("./transaction.cjs").Host,
 *   io: import("./transaction.cjs").Io,
 *   isCancelled: () => boolean,
 *   root: string,
 *   inputs: { manifest: unknown, bases: import("./render.cjs").Bases },
 *   answers: unknown,
 * }} input
 * @returns {Promise<number>}
 */
async function initializeCopy({ host, io, isCancelled, root, inputs, answers }) {
  const values = validateAnswers(answers);
  const first = snapshotOf(host, root);
  if (host.git.committed(root, STATE_FILE)) {
    io.stdout("This repository is already initialized; nothing was changed.\n");
    return 0;
  }

  /** @type {unknown} */
  let role;
  try {
    role = JSON.parse((readIfPresent(host, nodePath.join(root, "tooling", "project-role.json")) ?? Buffer.alloc(0)).toString("utf8"));
  } catch {
    role = null;
  }
  const sentinel = first.inventory.some((entry) => entry.path === SENTINEL);
  if (!isRecord(role) || role.role !== "generator" || !sentinel) {
    io.stderr(`this is not an uninitialized copy of the template (a generator checkout with ${SENTINEL}); nothing was changed\n`);
    return 1;
  }
  if (nodePath.resolve(host.git.toplevel(root)) !== nodePath.resolve(root)) {
    io.stderr("the template root is not the top level of its Git repository; nothing was changed\n");
    return 1;
  }

  const { files, digest } = render.renderTree({ ...inputs, answers });
  const destinations = files.map((file) => file.path);
  const origin = originProblem(host.git.origin(root), values);
  const before = [
    ...(origin === null ? [] : [origin]),
    ...sourceProblems(first),
    ...linkProblems(first.inventory, destinations),
    ...ignoredCollisions(host.git.ignored(root), destinations),
    ...workflowParity(first.inventory, files),
  ];
  if (before.length > 0) {
    io.stderr(`the copy cannot be initialized; nothing was changed:\n${before.map((line) => `- ${line}\n`).join("")}`);
    return 1;
  }
  const original = /** @type {string} */ (first.head);

  if (!(await stageAndValidate({ host, io, files, isCancelled })) || isCancelled()) return 1;
  io.stdout("The copy has no Git hooks of the new application yet, so it was validated in a staging copy with its own committed baseline.\n");

  const drift = sourceDrift(first, snapshotOf(host, root));
  if (drift.length > 0) {
    io.stderr(`the repository changed during validation; nothing was changed:\n${drift.map((line) => `- ${line}\n`).join("")}`);
    return 1;
  }
  const backup = host.scratch("template-backup-");
  /** @type {string[]} */
  let failures;
  /** @type {{ commit: string, tree: string } | null} */
  let baseline = null;
  /** @type {{ undo: () => string[] } | null} */
  let installed = null;
  try {
    installed = installTree({ disk: host.disk, root, plan: planInstall(first.inventory, files), backup });
    baseline = host.git.commitPristine(root, files, { parent: original, message: PRISTINE_MESSAGE, index: first.inventory });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    failures = error instanceof Error && "failures" in error ? [.../** @type {string[]} */ (error.failures)] : [];
    if (installed !== null) {
      // The index was never written before HEAD moved, so the installation is undone only while HEAD and
      // the index are still what the first look saw. Otherwise someone else's commit or staged change is
      // in them, and the files may be part of it: nothing is undone, and the backup is kept.
      if (!stillAsFirst(host, root, first)) {
        io.stderr(
          `HEAD or the index of ${root} changed while the pristine commit was made, so nothing was undone: your files, HEAD and index are as they are now. ` +
            `The previous version of every file replaced or removed is in ${backup}; the copy was commit ${original}.\n`,
        );
        return 1;
      }
      failures.push(...installed.undo());
    }
    if (failures.length > 0) {
      io.stderr(
        `these paths could not be restored: ${failures.join(", ")}. Your original files are kept in ${backup}; restore from there, or run: git checkout ${original} -- .\n`,
      );
      return 1;
    }
  }
  if (baseline === null) {
    host.remove(backup);
    return 1;
  }
  host.remove(backup);
  const enrolled = enroll({
    host,
    io,
    root,
    state: { baseline, source: { kind: "github-template-copy", copiedCommit: original }, answers: values, renderDigest: digest },
  });
  if (!enrolled.ok) return 1;
  io.stdout(`${JSON.stringify({ files: files.length, digest, copiedCommit: original, baseline: baseline.commit, enrollment: enrolled.commit })}\n`);
  return 0;
}

module.exports = { SENTINEL, SOURCE_REPOSITORY, initializeCopy, originProblem };

if (require.main === module) {
  void require("./commands.cjs").initializeMain(process.argv.slice(2), process);
}
