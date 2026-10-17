// @ts-check
"use strict";
// Local creation (F1): validate the answers, render deterministically, validate the rendered
// application in a staging copy, and only then create the project with its own Git history: the
// pristine render B0 and, on top of it, the enrollment commit E0.
const nodePath = require("node:path");
const render = require("./render.cjs");
const { RenderError, parseManifest } = require("./manifest.cjs");
const { validateAnswers } = require("./inputs.cjs");
const { PRISTINE_MESSAGE, enroll, stageAndValidate } = require("./transaction.cjs");

/**
 * The paths whose content decides what a render contains: the declared sources, the manifest and the renderer.
 * @param {{ entries: readonly { base: string, source: string }[] }} manifest
 * @returns {string[]}
 */
function sourcePaths(manifest) {
  const declared = manifest.entries.map((entry) => (entry.base === "template" ? `template/app/${entry.source}` : entry.source));
  return [...new Set([...declared, "tooling/template-manifest.json", "scripts/template"])].sort();
}

/**
 * The revision of the generator a render came from. It is claimed only when it is true: every file
 * the render reads is exactly as that commit has it.
 * @param {{ git: import("./transaction.cjs").Git, root: string, manifest: unknown }} input the manifest as it was read, before it is parsed
 * @returns {import("./state.cjs").Source}
 */
function generatorSource({ git, root, manifest }) {
  const revision = git.head(root);
  if (revision === null) throw new RenderError("the generator checkout has no commit, so the revision of the render cannot be recorded");
  const paths = sourcePaths(parseManifest(manifest));
  const read = (/** @type {string} */ entry) => paths.some((path) => entry === path || entry.startsWith(`${path}/`));
  const hidden = git.hiddenFlags(root).filter(read);
  if (hidden.length > 0) {
    throw new RenderError(
      `files the render reads hide their changes from Git (assume-unchanged or skip-worktree): ${hidden.slice(0, 3).join(", ")}; clear the flags so the recorded revision is true`,
    );
  }
  const changed = git.changes(root).filter((entry) => read(entry.slice(3)));
  if (changed.length > 0) {
    throw new RenderError(
      `the generator has uncommitted changes in what the render reads (${changed.slice(0, 3).join(", ")}); commit them so the recorded revision is true`,
    );
  }
  return { kind: "local-generator", revision };
}

/** @param {import("./transaction.cjs").Host} host @param {string} path @returns {string} the nearest directory that exists at or above `path` */
function nearestExisting(host, path) {
  for (let current = path; ; current = nodePath.dirname(current)) {
    try {
      host.disk.lstatSync(current);
      return current;
    } catch {
      if (nodePath.dirname(current) === current) return current;
    }
  }
}

/**
 * @param {{
 *   host: import("./transaction.cjs").Host,
 *   io: import("./transaction.cjs").Io,
 *   isCancelled: () => boolean,
 *   inputs: { manifest: unknown, bases: import("./render.cjs").Bases },
 *   answers: unknown,
 *   dest: string,
 *   source: () => import("./state.cjs").Source,
 * }} input
 * @returns {Promise<number>} 0 only for a project that is committed, clean and enrolled
 */
async function createLocal({ host, io, isCancelled, inputs, answers, dest, source }) {
  const values = validateAnswers(answers);
  const { files, digest } = render.renderTree({ ...inputs, answers });
  const target = render.checkDestination(dest).root;
  if (!host.git.hasIdentity(nearestExisting(host, target))) {
    io.stderr("Git has no author or committer identity here. Set user.name and user.email (the enrollment commit is yours); nothing was created.\n");
    return 1;
  }
  const provenance = source();
  if (!(await stageAndValidate({ host, io, files, isCancelled })) || isCancelled()) return 1;
  io.stdout("The new project has no Git hooks yet, so it was validated in a staging copy with its own committed baseline.\n");

  render.checkDestination(target);
  const written = host.write(files, target);
  /** @type {{ commit: string, tree: string }} */
  let baseline;
  try {
    host.git.init(target);
    baseline = host.git.commitPristine(target, files, { parent: null, message: PRISTINE_MESSAGE, index: [] });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    // The directory was missing or empty, so the repository and the files are this call's only while the
    // repository is still the empty one it made. A commit, a ref or a staged entry that appeared since is
    // somebody's, and so are the files it committed.
    if (!host.git.untouched(target)) {
      io.stderr(
        `the project could not be recorded in Git (${cause}), and the repository in ${target} is no longer empty: it was changed meanwhile, so nothing was removed. ` +
          "Inspect it with git status and git log before deleting or reusing it.\n",
      );
      return 1;
    }
    host.remove(nodePath.join(target, ".git"));
    written.undo();
    io.stderr(`the project could not be recorded in Git and was taken back: ${cause}\n`);
    return 1;
  }
  const enrolled = enroll({ host, io, root: target, state: { baseline, source: provenance, answers: values, renderDigest: digest } });
  if (!enrolled.ok) return 1;
  io.stdout(`${JSON.stringify({ files: files.length, digest, baseline: baseline.commit, enrollment: enrolled.commit })}\n`);
  return 0;
}

module.exports = { createLocal, generatorSource, nearestExisting, sourcePaths };
