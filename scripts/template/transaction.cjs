// @ts-check
"use strict";
const { randomUUID } = require("node:crypto");
const nodePath = require("node:path");
const { assetOf } = require("./smoke.cjs");
const { blobId, indexKey } = require("./git.cjs");
const { PRISTINE_MESSAGE, STATE_FILE, buildState, serializeState } = require("./state.cjs");

const WORKFLOWS = ".github/workflows/";
const ENROLL_MESSAGE = "chore(template): enroll project in template updates";
/** The commands the staged application must pass, in order, before anything is installed. */
const VALIDATION_STEPS = Object.freeze([
  { name: "setup", command: process.execPath, args: ["scripts/bootstrap.cjs", "setup"] },
  { name: "check", command: "pnpm", args: ["run", "check"] },
  { name: "docs:build", command: "pnpm", args: ["run", "docs:build"] },
  { name: "build", command: "pnpm", args: ["run", "build"] },
]);

/**
 * @typedef {import("./render.cjs").RenderedFile} RenderedFile
 * @typedef {import("./git.cjs").IndexEntry} IndexEntry
 * @typedef {{ stdout: (text: string) => unknown, stderr: (text: string) => unknown }} Io
 * @typedef {{ isSymbolicLink: () => boolean, isDirectory: () => boolean, mode: number, dev?: number | bigint, ino?: number | bigint }} Stat
 * @typedef {{
 *   lstatSync: (path: string) => Stat,
 *   readFileSync: (path: string) => Buffer,
 *   readdirSync: (path: string) => string[],
 *   writeFileSync: (path: string, content: Buffer, options: { mode: number }) => void,
 *   chmodSync: (path: string, mode: number) => void,
 *   unlinkSync: (path: string) => void,
 *   mkdirSync: (path: string) => void,
 *   rmdirSync: (path: string) => void,
 * }} Disk
 * @typedef {ReturnType<typeof import("./git.cjs").createGit>} Git
 * @typedef {{
 *   git: Git,
 *   disk: Disk,
 *   scratch: (prefix: string) => string,
 *   remove: (dir: string) => void,
 *   write: (files: readonly RenderedFile[], dir: string) => { undo: () => void },
 *   read: (path: string) => { content: Buffer, mode: number } | null,
 *   run: (command: string, args: readonly string[], options: { cwd: string, env: NodeJS.ProcessEnv }) => Promise<number | null>,
 *   smoke: (options: { cwd: string, env: NodeJS.ProcessEnv, nonce: string }) => Promise<string | null>,
 *   env: NodeJS.ProcessEnv,
 * }} Host what creation needs from the machine: Git, the filesystem, scratch space and the tools it validates with
 */

/** @param {number} mode @returns {string} */
const gitMode = (mode) => (mode & 0o111 ? "100755" : "100644");

/**
 * The workflows a copy carries stay as they are, so the files the render would put there must be
 * the very ones already tracked: GitHub does not let the initialization push a changed workflow.
 * @param {readonly IndexEntry[]} tracked
 * @param {readonly RenderedFile[]} files
 * @returns {string[]}
 */
function workflowParity(tracked, files) {
  const held = new Map(tracked.filter((entry) => entry.path.startsWith(WORKFLOWS)).map((entry) => [entry.path, entry]));
  const rendered = new Map(files.filter((file) => file.path.startsWith(WORKFLOWS)).map((file) => [file.path, file]));
  const problems = [];
  for (const [path, file] of rendered) {
    const entry = held.get(path);
    if (entry === undefined) problems.push(`${path} would be added; the copy does not have it`);
    else if (entry.mode !== gitMode(file.mode)) problems.push(`${path} differs in mode (${entry.mode} in the copy, ${gitMode(file.mode)} rendered)`);
    else if (entry.sha !== blobId(file.content)) problems.push(`${path} differs in bytes from the copy`);
  }
  for (const path of held.keys()) if (!rendered.has(path)) problems.push(`${path} would be removed; the render does not have it`);
  return problems;
}

/**
 * Ignored files may stay where they are, unless the render would write onto them or through them.
 * @param {readonly string[]} ignored paths as `git ls-files --ignored --directory` lists them, directories with a trailing slash
 * @param {readonly string[]} destinations
 * @returns {string[]}
 */
function ignoredCollisions(ignored, destinations) {
  const problems = [];
  for (const entry of ignored) {
    const directory = entry.endsWith("/");
    const path = directory ? entry.slice(0, -1) : entry;
    for (const destination of destinations) {
      if (destination === path || destination.startsWith(`${path}/`) || path.startsWith(`${destination}/`)) {
        problems.push(`${destination} collides with the ignored ${directory ? "directory" : "file"} ${path}`);
      }
    }
  }
  return problems;
}

/**
 * A tracked symlink or submodule on a path the render writes, or above it, would be followed or replaced.
 * @param {readonly IndexEntry[]} tracked
 * @param {readonly string[]} destinations
 * @returns {string[]}
 */
function linkProblems(tracked, destinations) {
  return tracked
    .filter((entry) => entry.mode === "120000" || entry.mode === "160000")
    .flatMap((entry) =>
      destinations
        .filter((destination) => destination === entry.path || destination.startsWith(`${entry.path}/`))
        .map((destination) => `${destination} is, or is below, the tracked ${entry.mode === "120000" ? "symlink" : "submodule"} ${entry.path}`),
    );
}

/**
 * @typedef {{ head: string | null, hidden: readonly string[], changes: readonly string[], inventory: readonly IndexEntry[] }} Snapshot
 */

/**
 * What makes the source repository unfit to be converted: anything uncommitted, a flag that hides a
 * change from Git, an unmerged entry, or no commit at all.
 * @param {Snapshot} snapshot
 * @returns {string[]}
 */
function sourceProblems({ head, hidden, changes, inventory }) {
  const problems = [];
  if (head === null) problems.push("the repository has no commit");
  if (changes.length > 0) problems.push(`the working tree or index is not clean: ${changes.slice(0, 5).join(", ")}${changes.length > 5 ? ", ..." : ""}`);
  if (hidden.length > 0) problems.push(`tracked files hide their changes from Git (assume-unchanged or skip-worktree): ${hidden.slice(0, 5).join(", ")}`);
  const unmerged = inventory.filter((entry) => entry.stage !== "0");
  if (unmerged.length > 0)
    problems.push(
      `unmerged entries: ${unmerged
        .slice(0, 5)
        .map((entry) => entry.path)
        .join(", ")}`,
    );
  return problems;
}

/**
 * What changed in the source between the first look and the moment before it is written.
 * @param {Snapshot} before @param {Snapshot} after @returns {string[]}
 */
function sourceDrift(before, after) {
  const problems = sourceProblems(after);
  if (before.head !== after.head) problems.push(`HEAD moved from ${before.head ?? "nothing"} to ${after.head ?? "nothing"}`);
  if (indexKey(before.inventory) !== indexKey(after.inventory)) problems.push("the tracked files changed");
  return problems;
}

/**
 * Staging must not change what was rendered: a formatter or a build that rewrites a tracked file
 * would silently make its output the template's.
 * @param {readonly RenderedFile[]} files the rendered output, captured before anything ran
 * @param {(path: string) => { content: Buffer, mode: number } | null} read
 * @param {readonly string[]} changes the staging repository's uncommitted and untracked paths
 * @returns {string[]}
 */
function stagingProblems(files, read, changes) {
  const problems = [];
  for (const file of files) {
    const found = read(file.path);
    if (found === null) problems.push(`${file.path} is gone`);
    else if (!found.content.equals(file.content)) problems.push(`${file.path} was changed by validation`);
    else if ((found.mode & 0o777) !== file.mode)
      problems.push(`${file.path} changed its mode during validation (${(found.mode & 0o777).toString(8)}, rendered ${file.mode.toString(8)})`);
  }
  for (const change of changes) problems.push(`validation left ${change.slice(3)} uncommitted or untracked`);
  return problems;
}

/**
 * @param {readonly IndexEntry[]} tracked what the source tracks
 * @param {readonly RenderedFile[]} files what the render puts there
 * @returns {{ add: RenderedFile[], change: RenderedFile[], remove: string[] }}
 */
function planInstall(tracked, files) {
  const held = new Map(tracked.map((entry) => [entry.path, entry]));
  const rendered = new Set(files.map((file) => file.path));
  const add = [];
  const change = [];
  for (const file of files) {
    const entry = held.get(file.path);
    if (entry === undefined) add.push(file);
    else if (entry.mode !== gitMode(file.mode) || entry.sha !== blobId(file.content)) change.push(file);
  }
  return { add, change, remove: tracked.map((entry) => entry.path).filter((path) => !rendered.has(path)) };
}

class InstallError extends Error {
  /** @param {string} message @param {string[]} failures paths the rollback could not restore */
  constructor(message, failures) {
    super(message);
    this.name = "InstallError";
    this.failures = failures;
  }
}

/** @param {Disk} disk @param {string} path @returns {Stat | null} */
function lstat(disk, path) {
  try {
    return disk.lstatSync(path);
  } catch {
    return null;
  }
}

/** @param {Stat | null} stat @returns {string | null} what tells this file or directory from another one at the same path */
const identity = (stat) => (stat === null ? null : `${String(stat.dev)}:${String(stat.ino)}`);

/**
 * @param {Disk} disk @param {string} base @param {string} dir creates `dir` and what is missing between `base` and it
 * @param {(path: string) => void} [onMade] told of each directory right after it is made, so a later failure still knows it
 */
function mkdirs(disk, base, dir, onMade = () => undefined) {
  let current = base;
  for (const segment of nodePath.relative(base, dir).split(nodePath.sep).filter(Boolean)) {
    current = nodePath.join(current, segment);
    const stat = lstat(disk, current);
    if (stat === null) {
      disk.mkdirSync(current);
      onMade(current);
    } else if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe directory: ${current}`);
  }
}

/** @param {string} root @param {string} path @returns {string[]} `root` and every directory between it and `path` */
function ancestorsOf(root, path) {
  const dirs = [root];
  let current = root;
  for (const segment of nodePath.relative(root, nodePath.dirname(path)).split(nodePath.sep).filter(Boolean)) {
    current = nodePath.join(current, segment);
    dirs.push(current);
  }
  return dirs;
}

/**
 * @typedef {{
 *   op: "write", path: string, content: Buffer, backup: string | null, mode: number, partial: boolean,
 *   before: string | null, after: string | null,
 * } | { op: "remove", path: string, backup: string, mode: number }
 *   | { op: "mkdir", path: string, made: string | null }
 *   | { op: "rmdir", path: string }} Step what each step knows of the file it took over: `before` is the identity of what the target was, `after` of what this call wrote
 */

/** @param {Stat | null} stat @returns {boolean} whether this is a regular file: not a link, not a directory */
const isRegular = (stat) => stat !== null && !stat.isSymbolicLink() && !stat.isDirectory();

/** @param {Disk} disk @param {string} path @param {Buffer} content @param {number} mode writes the file with exactly this permission, whatever the umask */
function restoreFile(disk, path, content, mode) {
  disk.writeFileSync(path, content, { mode });
  disk.chmodSync(path, mode);
}

/**
 * Takes one step back only when the path is still the one this installation walked and what is
 * there is provably what it left. Anything else belongs to someone else now.
 * @param {Disk} disk @param {Step} step @param {(path: string) => boolean} intact whether every directory above a path is the one that was walked
 * @returns {string | null} the path that could not be restored, or null
 */
function undoStep(disk, step, intact) {
  try {
    if (!intact(step.path)) return step.path;
    if (step.op === "mkdir") {
      if (identity(lstat(disk, step.path)) !== step.made) return step.path;
      disk.rmdirSync(step.path);
    } else if (step.op === "rmdir") disk.mkdirSync(step.path);
    else if (step.op === "remove") {
      if (lstat(disk, step.path) !== null) return step.path;
      restoreFile(disk, step.path, disk.readFileSync(step.backup), step.mode);
    } else {
      const stat = lstat(disk, step.path);
      if (stat === null) {
        // Gone: only a new file whose write never completed leaves nothing that could have been lost.
        return step.partial && step.backup === null ? null : step.path;
      }
      // Only the regular file this call wrote is ours to take back: never one that was replaced by a link
      // or a directory, and never one that holds something else than what was written.
      if (!isRegular(stat)) return step.path;
      const current = disk.readFileSync(step.path);
      if (step.partial) {
        // A failed first write never captured the new inode. Equal bytes cannot prove ownership.
        if (step.before === null) return step.path;
        // A write that failed has left the same file with a part of the new bytes (or none), or the old ones;
        // a different file, or other bytes, is somebody's.
        const mine = step.backup !== null && current.equals(disk.readFileSync(step.backup));
        if (identity(stat) !== step.before) return step.path;
        if (!mine && !step.content.subarray(0, current.length).equals(current)) return step.path;
      } else if (identity(stat) !== step.after || !current.equals(step.content)) return step.path;
      if (step.backup === null) disk.unlinkSync(step.path);
      else restoreFile(disk, step.path, disk.readFileSync(step.backup), step.mode);
    }
    return null;
  } catch {
    return step.path;
  }
}

/**
 * Puts the rendered files into the source in place of its own, after copying every file it will
 * replace or remove into `backup`. Any failure takes back what this call did; what cannot be taken
 * back (a path someone changed meanwhile, a restore that failed) is named in the error, and the
 * backup is then the only copy to keep. The result takes the installation back the same way for a
 * caller whose next step failed.
 * @param {{ disk: Disk, root: string, plan: ReturnType<typeof planInstall>, backup: string }} input
 * @returns {{ undo: () => string[] }}
 */
function installTree({ disk, root, plan, backup }) {
  /** @type {Step[]} */
  const journal = [];
  /** @type {Map<string, string | null>} the directories walked, by what they were */
  const walked = new Map();
  /** Remembers every existing directory above `path`, and refuses one that is a link. @param {string} path */
  const observe = (path) => {
    for (const dir of ancestorsOf(root, path)) {
      const stat = lstat(disk, dir);
      if (stat === null) continue;
      if (dir !== root && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`unsafe directory: ${dir}`);
      if (!walked.has(dir)) walked.set(dir, identity(stat));
    }
  };
  /** @param {string} path @returns {boolean} whether the directories above `path` are still the ones that were walked */
  const intact = (path) =>
    ancestorsOf(root, path).every((dir) => {
      const stat = lstat(disk, dir);
      if (stat === null || (dir !== root && (stat.isSymbolicLink() || !stat.isDirectory()))) return false;
      return !walked.has(dir) || walked.get(dir) === identity(stat);
    });
  /** @returns {string[]} the paths that could not be put back */
  const undo = () =>
    journal
      .splice(0)
      .reverse()
      .flatMap((step) => {
        const failed = undoStep(disk, step, intact);
        if (failed === null && step.op === "rmdir") walked.set(step.path, identity(lstat(disk, step.path)));
        return failed === null ? [] : [failed];
      });
  try {
    /** @type {Map<string, { path: string, mode: number }>} */
    const saved = new Map();
    for (const path of [...plan.change.map((file) => file.path), ...plan.remove]) {
      const source = nodePath.join(root, path);
      observe(source);
      const stat = lstat(disk, source);
      if (stat === null || !isRegular(stat)) throw new Error(`${path} is not the regular file Git tracks`);
      const target = nodePath.join(backup, path);
      const mode = stat.mode & 0o777;
      mkdirs(disk, backup, nodePath.dirname(target));
      restoreFile(disk, target, disk.readFileSync(source), mode);
      saved.set(path, { path: target, mode });
    }
    for (const path of plan.remove) {
      disk.unlinkSync(nodePath.join(root, path));
      const before = saved.get(path);
      journal.push({ op: "remove", path: nodePath.join(root, path), backup: before?.path ?? "", mode: before?.mode ?? 0o644 });
    }
    const emptied = new Set(plan.remove.map((path) => nodePath.dirname(path)).filter((dir) => dir !== "."));
    const dropped = /** @type {Set<string>} */ (new Set());
    for (const dir of [...emptied].sort((a, b) => b.length - a.length)) {
      for (let current = dir; current !== "." && !dropped.has(current); current = nodePath.dirname(current)) {
        const absolute = nodePath.join(root, current);
        if (disk.readdirSync(absolute).length > 0) break;
        disk.rmdirSync(absolute);
        dropped.add(current);
        journal.push({ op: "rmdir", path: absolute });
      }
    }
    for (const file of [...plan.add, ...plan.change]) {
      const target = nodePath.join(root, file.path);
      observe(target);
      mkdirs(disk, root, nodePath.dirname(target), (path) => {
        const made = identity(lstat(disk, path));
        journal.push({ op: "mkdir", path, made });
        walked.set(path, made);
      });
      const before = saved.get(file.path);
      const existing = lstat(disk, target);
      if (before === undefined && existing !== null) throw new Error(`${file.path} appeared since the source was checked`);
      // Journaled before the write: a write that fails part-way has already changed the file.
      const step = /** @type {Extract<Step, { op: "write" }>} */ ({
        op: "write",
        path: target,
        content: file.content,
        backup: before?.path ?? null,
        mode: before?.mode ?? 0o644,
        partial: true,
        before: identity(existing),
        after: null,
      });
      journal.push(step);
      disk.writeFileSync(target, file.content, { mode: file.mode });
      step.after = identity(lstat(disk, target));
      step.partial = false;
      disk.chmodSync(target, file.mode);
    }
    return { undo };
  } catch (error) {
    const failures = undo();
    const cause = error instanceof Error ? error.message : String(error);
    throw new InstallError(
      failures.length === 0 ? `installation failed and was taken back: ${cause}` : `installation failed (${cause}) and could not be taken back completely`,
      failures,
    );
  }
}

/**
 * Renders the files into a disposable application with a committed baseline of its own, so the
 * guard and the hooks of the emitted profile run as they will in the project, and runs every
 * validation step there. Nothing of the target is touched, and the staging copy is always removed.
 * @param {{ host: Host, io: Io, files: readonly RenderedFile[], isCancelled: () => boolean }} input
 * @returns {Promise<boolean>} whether the rendered application passed unchanged
 */
async function stageAndValidate({ host, io, files, isCancelled }) {
  const scratch = host.scratch("template-staging-");
  const root = nodePath.join(scratch, "app");
  // Validation data of this run only: lets the smoke tell its own server from any other listener. It
  // is in the staged public directory before the build, never in the rendered files, and gone before
  // the check that nothing else was left.
  const nonce = randomUUID();
  const asset = nodePath.join(root, "public", assetOf(nonce));
  let planted = false;
  const plant = () => {
    host.disk.writeFileSync(asset, Buffer.from(nonce), { mode: 0o644 });
    planted = true;
  };
  const unplant = () => {
    if (!planted) return;
    planted = false;
    host.disk.unlinkSync(asset);
  };
  try {
    host.write(files, root);
    host.git.init(root);
    host.git.commitPristine(root, files, { parent: null, message: PRISTINE_MESSAGE, index: [] });
    for (const step of VALIDATION_STEPS) {
      if (isCancelled()) return false;
      if (step.name === "build") plant();
      io.stdout(`staging: ${step.name}\n`);
      const status = await host.run(step.command, step.args, { cwd: root, env: host.env });
      if (isCancelled()) return false;
      if (status !== 0) {
        io.stderr(`staging validation failed at ${step.name}; nothing was written to the target\n`);
        return false;
      }
    }
    if (isCancelled()) return false;
    io.stdout("staging: smoke\n");
    const unhealthy = await host.smoke({ cwd: root, env: host.env, nonce });
    unplant();
    if (isCancelled()) return false;
    if (unhealthy !== null) {
      io.stderr(`staging validation failed at smoke: ${unhealthy}; nothing was written to the target\n`);
      return false;
    }
    const problems = stagingProblems(files, (path) => host.read(nodePath.join(root, path)), host.git.changes(root));
    if (problems.length > 0) {
      io.stderr(`staging validation changed the rendered application; nothing was written to the target:\n${problems.map((line) => `- ${line}\n`).join("")}`);
      return false;
    }
    return true;
  } finally {
    try {
      unplant();
    } finally {
      host.remove(scratch);
    }
  }
}

/**
 * Records the enrollment as an ordinary commit of the caller: their identity and their hooks, no
 * bypass. A failure leaves the state file and the pristine commit where they are, so the commit can
 * be made again.
 * @param {{ host: Host, io: Io, root: string, state: Parameters<typeof buildState>[0] }} input
 * @returns {{ ok: true, commit: string } | { ok: false }}
 */
function enroll({ host, io, root, state }) {
  try {
    host.disk.writeFileSync(nodePath.join(root, STATE_FILE), Buffer.from(serializeState(buildState(state))), { mode: 0o644 });
    host.git.commitAsCaller(root, [STATE_FILE], ENROLL_MESSAGE, { head: state.baseline.commit });
    const left = host.git.changes(root);
    if (left.length > 0) throw new Error(`the enrollment commit left changes behind: ${left.join(", ")}`);
    return { ok: true, commit: host.git.head(root) ?? "" };
  } catch (error) {
    io.stderr(
      `enrollment did not complete: ${error instanceof Error ? error.message : String(error)}\n` +
        `The pristine commit ${state.baseline.commit} and ${STATE_FILE} are in ${root}; no file of yours was removed. ` +
        `Fix the cause (for example the Git identity or a hook), then commit ${STATE_FILE}.\n`,
    );
    return { ok: false };
  }
}

module.exports = {
  ENROLL_MESSAGE,
  InstallError,
  PRISTINE_MESSAGE,
  VALIDATION_STEPS,
  enroll,
  ignoredCollisions,
  installTree,
  linkProblems,
  planInstall,
  sourceDrift,
  sourceProblems,
  stageAndValidate,
  stagingProblems,
  workflowParity,
};
