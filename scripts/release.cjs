// @ts-check
"use strict";
// The release state machine of a project, generator or application. `release:bump` prepares a version
// and its changelog on a feature branch and commits them through the project's hooks; it never tags.
// `release:tag` annotates the reviewed merge commit of the current main; `release:validate` judges a
// tag. None of them pushes, publishes or deploys: those are separate approvals.
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const { UsageError, parseArgs } = require("./core/args.cjs");
const { readObject } = require("./core/json.cjs");
const { readPolicy, readRole } = require("./core/toolchain.cjs");
const { checkLock } = require("./core/transaction.cjs");
const { createGit } = require("./template/git.cjs");
const changelog = require("./release/changelog.cjs");
const metadata = require("./release/metadata.cjs");
const validate = require("./release/validate.cjs");

const { ReleaseError, SEGMENTS } = metadata;
const REFUSALS = new Set(["ReleaseError", "GitError"]);

/**
 * @typedef {{ read: (path: string) => string | null, write: (path: string, text: string) => unknown }} Disk project-relative paths; an absolute path is used as it is
 * @typedef {{
 *   root: string,
 *   role: "generator" | "application",
 *   git: validate.Git,
 *   disk: Disk,
 *   io: { stdout: (text: string) => unknown, stderr: (text: string) => unknown },
 *   now: () => Date,
 *   emailPattern: string,
 *   generate: (input: { version: string, date: string }) => Promise<string>,
 *   format: (file: string) => unknown,
 *   checkLock: () => { ok: boolean, output: string },
 * }} Host everything a release command touches outside its own decisions
 */

/** @param {Host} host @param {string} file @returns {string} */
function mustRead(host, file) {
  const text = host.disk.read(file);
  if (text === null) throw new ReleaseError(`${file} is missing.`);
  return text;
}

/**
 * Prepares a release for review: the next version in the manifest and its changelog section, committed
 * with the project's own hooks on a feature branch. The tree and the history are checked, and the
 * section is generated, before any file is written. Failed checks leave the prepared files visible:
 * restoring old bytes could erase edits made by a hook or another process.
 * @param {Host} host
 * @param {string} segment patch, minor or major
 * @returns {Promise<void>}
 */
async function bump(host, segment) {
  if (!SEGMENTS.some((name) => name === segment)) throw new ReleaseError("Choose a patch, minor or major version bump.");
  const { root, git, io } = host;
  validate.requireRepository(git, root);
  validate.requireFeatureBranch(git, root);
  validate.requireCleanTree(git, root);
  const head = git.out(root, ["rev-parse", "--verify", "HEAD"]).trim();
  const { file } = metadata.adapterFor(host.role);
  const manifest = mustRead(host, file);
  const next = metadata.nextVersion(metadata.readVersion(manifest), segment);
  const tag = metadata.tagOf(next);
  if (validate.tagsOf(git, root).includes(tag)) throw new ReleaseError(`Tag ${tag} already exists; no files changed.`);

  const previous = host.disk.read(changelog.CHANGELOG_FILE);
  const date = host.now().toISOString().slice(0, 10);
  const composed = changelog.compose(previous, await host.generate({ version: next, date }));
  validate.requireFeatureBranch(git, root);
  validate.requireCleanTree(git, root);
  if (git.out(root, ["rev-parse", "--verify", "HEAD"]).trim() !== head) throw new ReleaseError("HEAD changed while preparing the release; no files changed.");
  validate.requireFreeTag(git, root, tag);
  const files = [file, changelog.CHANGELOG_FILE];
  host.disk.write(file, metadata.withVersion(manifest, next));
  host.disk.write(changelog.CHANGELOG_FILE, composed);
  host.format(changelog.CHANGELOG_FILE);
  changelog.extractSection(mustRead(host, changelog.CHANGELOG_FILE), tag);
  const lock = host.checkLock();
  if (!lock.ok) throw new ReleaseError(`pnpm-lock.yaml no longer matches package.json after the bump:\n${lock.output}`);
  git.out(root, ["add", "--", ...files]);
  git.out(root, ["commit", "--quiet", "--only", "-m", `chore: bump version to ${tag}`, "--", ...files]);
  validate.requireCleanTree(git, root);
  io.stdout(
    `Release ${tag} prepared on ${git.out(root, ["branch", "--show-current"]).trim()}. Pushing the branch and opening a PR each need your approval.\n` +
      "Run node scripts/bootstrap.cjs setup to refresh pnpm's project-version metadata before more pnpm commands or a push.\n" +
      "After its regular merge, update main, run setup again, then pnpm run release:tag (a separate approval).\n",
  );
}

/**
 * Annotates the reviewed merge commit that is the head of the current main with the tag of the
 * version in its manifest. The tag is local; pushing it is a separate approval.
 * @param {Host} host
 * @returns {Promise<void>}
 */
function tag(host) {
  return Promise.resolve().then(() => {
    const { root, git, io } = host;
    validate.requireRepository(git, root);
    validate.requireCleanTree(git, root);
    const head = validate.requireReviewedMain(git, root);
    const name = metadata.tagOf(metadata.readVersion(mustRead(host, metadata.adapterFor(host.role).file)));
    changelog.extractSection(mustRead(host, changelog.CHANGELOG_FILE), name);
    validate.requireFreeTag(git, root, name);
    const { baselines } = changelog.snapshotLineage(git, root);
    const problems = validate.identityErrors(git, root, host.emailPattern, ["HEAD", ...(baselines.length > 0 ? ["--not", ...baselines] : [])]);
    if (problems.length > 0) throw new ReleaseError(`Every author and committer must use a GitHub noreply address before a release:\n${problems.join("\n")}`);
    git.out(root, ["tag", "-a", name, "HEAD", "-m", name]);
    io.stdout(`Reviewed release tag ${name} created at ${head}. Pushing it needs its own approval: git push origin ${name}\n`);
  });
}

/**
 * Judges a release tag, by default the tag of the version in the manifest, and optionally writes
 * its changelog section to a file for the publishing step to read as data.
 * @param {Host} host
 * @param {{ tag?: string | undefined, notes?: string | undefined }} flags
 */
function validateRelease(host, flags) {
  const { root, git, io } = host;
  validate.requireRepository(git, root);
  const name = flags.tag ?? metadata.tagOf(metadata.readVersion(mustRead(host, metadata.adapterFor(host.role).file)));
  const { commit, notes } = validate.validateTag(git, root, host.role, name);
  if (flags.notes !== undefined) host.disk.write(flags.notes, notes);
  io.stdout(`release ${name} is valid at ${commit}\n`);
}

/**
 * Runs a release command and reports a refusal as a message and a status of 1; anything else is a crash.
 * @param {Host["io"]} io @param {() => unknown} command
 * @returns {Promise<number>}
 */
async function report(io, command) {
  try {
    await command();
    return 0;
  } catch (error) {
    if (error instanceof Error && REFUSALS.has(error.name)) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/**
 * @typedef {{
 *   root: string, io: Host["io"],
 *   tools?: { launch: (pkg: string, bin: string, args: string[]) => number },
 *   env?: NodeJS.ProcessEnv,
 * }} Context the project and its output; `tools` starts the installed formatter, `env` is the environment Git is run in (a fixture boundary of tests)
 */

/** @param {Context} context @returns {Host} the release commands' view of the real project */
function realHost(context) {
  const { root, io } = context;
  const resolve = (/** @type {string} */ path) => nodePath.resolve(root, path);
  const role = readRole(root);
  const git = createGit(context.env === undefined ? {} : { env: context.env });
  return {
    root,
    role,
    git,
    io,
    disk: {
      read: (path) => (nodeFs.existsSync(resolve(path)) ? nodeFs.readFileSync(resolve(path), "utf8") : null),
      write: (path, text) => {
        nodeFs.writeFileSync(resolve(path), text);
      },
    },
    now: () => new Date(),
    emailPattern: readPolicy(root).commitIdentity.emailPattern,
    generate: ({ version, date }) => {
      const lineage = changelog.snapshotLineage(git, root);
      const { name } = readObject(resolve(metadata.adapterFor(role).file));
      return changelog.generateSection({
        cwd: root,
        name: typeof name === "string" ? name : "",
        version,
        date,
        from: changelog.boundary(git, root, lineage),
        excluded: lineage.excluded,
      });
    },
    format: (file) => {
      if (context.tools === undefined) throw new ReleaseError("the formatter is not available");
      if (context.tools.launch("prettier", "prettier", ["--write", "--log-level=warn", file]) !== 0) throw new ReleaseError(`the formatter failed on ${file}`);
    },
    checkLock: () => checkLock(root),
  };
}

/** @param {readonly string[]} args @param {Context} context @returns {Promise<number>} */
function bumpCommand(args, context) {
  const [segment, ...rest] = args;
  if (segment === undefined || rest.length > 0 || !SEGMENTS.some((name) => name === segment)) {
    throw new UsageError("release:bump takes exactly one argument: patch, minor or major");
  }
  return report(context.io, () => bump(realHost(context), segment));
}

/** @param {readonly string[]} args @param {Context} context @returns {Promise<number>} */
function tagCommand(args, context) {
  parseArgs(args, {});
  return report(context.io, () => tag(realHost(context)));
}

/** @param {readonly string[]} args @param {Context} context @returns {Promise<number>} */
function validateCommand(args, context) {
  const flags = parseArgs(args, { tag: { pattern: /^v\d+\.\d+\.\d+$/ }, notes: {} });
  return report(context.io, () => {
    validateRelease(realHost(context), { tag: flags.tag, notes: flags.notes });
  });
}

module.exports = { bump, bumpCommand, realHost, report, tag, tagCommand, validate: validateRelease, validateCommand };
