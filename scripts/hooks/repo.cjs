// @ts-check
"use strict";
const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { homedir } = require("node:os");
const nodePath = require("node:path");
const { GuardError, STATE_DIR_NAME, locateGit, operationInProgress, pruneBlobs, readBlob, readState, storeBlob, withLock, writeState } = require("./state.cjs");

const SYMLINK_PREFIX = "symlink:";
const EXECUTABLE_SUFFIX = ":x";
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

/**
 * @typedef {Pick<ReturnType<typeof import("../core/protected.cjs").createInventory>, "isProtectedFile" | "isShadowOverride" | "isSkippedDir">} Inventory
 * @typedef {{
 *   root: string,
 *   gitDir: string,
 *   stateDir: string,
 *   candidates: (extra: Iterable<string>) => string[],
 *   worktreeIds: (paths: string[]) => Record<string, string | null>,
 *   indexIds: (paths: string[]) => Record<string, string | null>,
 *   treeIds: (paths: string[], revision?: string) => Record<string, string | null>,
 *   treePaths: (revision: string) => Set<string>,
 *   unmerged: (paths: string[]) => Set<string>,
 *   head: () => string | null,
 *   operationInProgress: () => boolean,
 *   stagedNames: (filter?: string) => string[],
 *   resetIndex: (paths: string[]) => void,
 *   blobId: (content: Buffer) => string,
 *   readWorktree: (path: string) => Buffer | null,
 *   readBlob: (id: string | null) => Buffer | null,
 *   readObject: (blob: string) => Buffer | null,
 *   capture: (path: string) => string | null,
 *   storeContent: (content: Buffer) => string,
 *   restore: (path: string, id: string | null) => void,
 *   prune: (keep: Iterable<string | null>) => void,
 *   hooks: (keep: boolean) => { path: string | null, scripts: Record<string, string> },
 *   restoreHooks: (baseline: { path: string | null, scripts: Record<string, string> }) => void,
 *   environment: () => string,
 *   userFile: (name: string) => { path: string, content: Buffer | null },
 *   writeUserFile: (name: string, content: Buffer) => void,
 *   realpath: (absolute: string) => string,
 *   userHome: string,
 *   codexHome: string,
 *   files: import("./completion.cjs").Files,
 *   readText: (absolute: string) => string | null,
 *   writeText: (absolute: string, text: string) => void,
 *   readState: () => import("./state.cjs").State | null,
 *   writeState: (baseline: import("./state.cjs").State) => void,
 *   locked: <T>(action: () => T) => T,
 * }} Repo
 */

/** @param {string} id the stored id of a file @returns {string} the id of its content alone */
const contentOf = (id) => (id.endsWith(EXECUTABLE_SUFFIX) ? id.slice(0, -EXECUTABLE_SUFFIX.length) : id);

/**
 * @param {string} listing the output of `git ls-files -s -z`
 * @returns {{ mode: string, blob: string, stage: number, path: string }[]}
 */
function parseIndexListing(listing) {
  return listing
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(entry);
      return match ? [{ mode: match[1] ?? "", blob: match[2] ?? "", stage: Number(match[3]), path: match[4] ?? "" }] : [];
    });
}

/**
 * @param {string} listing the output of `git ls-tree -r -z`
 * @returns {{ mode: string, blob: string, path: string }[]}
 */
function parseTreeListing(listing) {
  return listing
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const match = /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
      return match ? [{ mode: match[1] ?? "", blob: match[2] ?? "", path: match[3] ?? "" }] : [];
    });
}

/**
 * What the repository needs from the machine: the worktree's places, a Git runner and a disk.
 * @typedef {{
 *   root: string, gitDir: string, commonDir: string, codexHome: string, userHome: string,
 *   git: (args: string[], input?: string) => { status: number | null, stdout: Buffer, stderr: Buffer | string, error?: Error | undefined },
 *   disk: import("./state.cjs").Disk,
 * }} Host
 */

/**
 * The questions the guard asks about one worktree, answered through a host.
 * @param {Host} host
 * @param {Inventory} inventory what is protected
 * @returns {Repo}
 */
function createRepo(host, inventory) {
  const { root, gitDir, commonDir, disk } = host;
  const stateDir = nodePath.join(gitDir, STATE_DIR_NAME);
  /** @param {string[]} args @param {{ check?: boolean, input?: string }} [run] @returns {string} */
  const git = (args, run = {}) => {
    const result = host.git(args, run.input);
    if (result.error) throw new GuardError(`git ${args[0] ?? ""} could not run: ${result.error.message}`);
    if ((run.check ?? true) && result.status !== 0)
      throw new GuardError(`git ${args.join(" ").slice(0, 200)} failed: ${result.stderr.toString().trim().slice(0, 500)}`);
    return result.stdout.toString("utf8");
  };
  const hashName = git(["rev-parse", "--show-object-format"], { check: false }).trim() || "sha1";
  /** @type {Map<string, Map<string, string | null>>} */
  const trees = new Map();
  /** @type {Map<string, string>} */
  const symlinkTargets = new Map();

  /** @param {Buffer} content */
  const blobId = (content) => createHash(hashName).update(`blob ${content.length}\0`).update(content).digest("hex");
  const head = () => git(["rev-parse", "--verify", "--quiet", "HEAD"], { check: false }).trim() || null;

  /** @param {string} mode @param {string} blob @returns {string} the id an index or tree entry has when it is on disk */
  function entryId(mode, blob) {
    if (mode === "120000") {
      let target = symlinkTargets.get(blob);
      if (target === undefined) {
        target = git(["cat-file", "blob", blob]);
        symlinkTargets.set(blob, target);
      }
      return SYMLINK_PREFIX + target;
    }
    return mode === "100755" ? blob + EXECUTABLE_SUFFIX : blob;
  }

  /** @param {string} path @returns {string | null} */
  function worktreeId(path) {
    const full = nodePath.join(root, path);
    let stat;
    try {
      stat = disk.lstatSync(full);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return SYMLINK_PREFIX + disk.readlinkSync(full);
    if (!stat.isFile()) return null;
    return blobId(disk.readFileSync(full)) + (stat.mode & 0o111 ? EXECUTABLE_SUFFIX : "");
  }

  /** @param {string} relative @returns {boolean} */
  const isCandidate = (relative) => inventory.isProtectedFile(relative) || inventory.isShadowOverride(relative);

  /** @param {string} directory @param {string} relative @param {string[]} found */
  function walk(directory, relative, found) {
    for (const entry of disk.readdirSync(directory, { withFileTypes: true })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        const full = nodePath.join(directory, entry.name);
        if (inventory.isSkippedDir(entry.name, relative) || disk.existsSync(nodePath.join(full, ".git"))) continue;
        walk(full, child, found);
      } else if (isCandidate(child)) {
        found.push(child);
      }
      if (found.length > MAX_ENTRIES) throw new GuardError("too many protected candidates to check safely");
    }
  }

  /** @param {string} revision @returns {Map<string, string | null>} */
  function tree(revision) {
    let known = trees.get(revision);
    if (known === undefined) {
      known = new Map();
      if (git(["rev-parse", "--verify", "--quiet", revision], { check: false }).trim() !== "")
        for (const { mode, blob, path } of parseTreeListing(git(["ls-tree", "-r", "-z", revision]))) known.set(path, entryId(mode, blob));
      trees.set(revision, known);
    }
    return known;
  }

  /** @type {ReturnType<typeof parseIndexListing> | null} */
  let indexListing = null;
  const index = () => (indexListing ??= parseIndexListing(git(["ls-files", "-s", "-z"])));

  /** @param {string} absolute @returns {string} the path with symlinks in its deepest existing part resolved */
  function realpath(absolute) {
    let existing = absolute;
    const rest = [];
    for (;;) {
      try {
        return nodePath.join(disk.realpathSync.native(existing), ...rest);
      } catch (error) {
        const parent = nodePath.dirname(existing);
        if (parent === existing || !["ENOENT", "ENOTDIR"].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? "")) return absolute;
        rest.unshift(nodePath.basename(existing));
        existing = parent;
      }
    }
  }

  /**
   * Every directory between the worktree and the target must be a real directory of this worktree:
   * a symbolic link on the way would send a delete or a write to a place the worktree does not own.
   * @param {string} target the path a protected file is changed at
   */
  function ownedAncestors(target) {
    const parts = nodePath.relative(root, nodePath.dirname(target)).split(nodePath.sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = nodePath.join(current, part);
      const stat = disk.lstatSync(current, { throwIfNoEntry: false });
      if (stat === undefined) return;
      if (stat.isSymbolicLink()) throw new GuardError(`refusing to change ${target}: ${current} is a symbolic link`);
      if (!stat.isDirectory()) throw new GuardError(`refusing to change ${target}: ${current} is not a directory`);
    }
  }

  /** @param {string} id @returns {Buffer | null} */
  const blob = (id) => readBlob(stateDir, contentOf(id), disk);

  /** @returns {{ path: string | null, scripts: Record<string, string> }} */
  function hooks(/** @type {boolean} */ keep) {
    const path = git(["config", "--get", "core.hooksPath"], { check: false }).trim() || null;
    /** @type {Record<string, string>} */
    const scripts = {};
    const directory = nodePath.join(commonDir, "hooks");
    if (disk.existsSync(directory)) {
      for (const name of disk.readdirSync(directory).sort()) {
        const full = nodePath.join(directory, name);
        const stat = disk.statSync(full);
        if (!stat.isFile() || name.endsWith(".sample")) continue;
        const content = disk.readFileSync(full);
        const id = blobId(content);
        if (keep) storeBlob(stateDir, id, content, disk);
        scripts[name] = `${id}:${(stat.mode & 0o777).toString(8)}`;
      }
    }
    return { path, scripts };
  }

  /** @param {string} dir @param {string} relative @param {string[]} lines @param {{ budget: number }} limit */
  function listEntries(dir, relative, lines, limit) {
    let entries;
    try {
      entries = disk.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (limit.budget-- <= 0) return;
      const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const full = nodePath.join(dir, entry.name);
      if (entry.isSymbolicLink()) lines.push(`${name}>${disk.readlinkSync(full)}`);
      else if (entry.isDirectory()) lines.push(`${name}/`);
      else if (entry.isFile()) {
        const stat = disk.lstatSync(full);
        lines.push(`${name}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  }

  const home = host.codexHome;
  /** @param {string} name */
  const userPath = (name) => {
    if (name !== "config.toml" && name !== "hooks.json") throw new GuardError(`unknown user file ${name}`);
    return nodePath.join(home, name);
  };

  return {
    root,
    gitDir,
    stateDir,
    candidates(extra) {
      /** @type {string[]} */
      const found = [];
      walk(root, "", found);
      const all = new Set([...found, ...index().map((entry) => entry.path), ...tree("HEAD").keys(), ...extra].filter((path) => isCandidate(path)));
      return [...all].sort();
    },
    worktreeIds: (paths) => Object.fromEntries(paths.map((path) => [path, worktreeId(path)])),
    indexIds(paths) {
      const staged = new Map(
        index()
          .filter((entry) => entry.stage === 0)
          .map((entry) => [entry.path, entryId(entry.mode, entry.blob)]),
      );
      return Object.fromEntries(paths.map((path) => [path, staged.get(path) ?? null]));
    },
    treeIds(paths, revision = "HEAD") {
      const listed = tree(revision);
      return Object.fromEntries(paths.map((path) => [path, listed.get(path) ?? null]));
    },
    treePaths: (revision) => new Set([...tree(revision).keys()].filter((path) => isCandidate(path))),
    unmerged(paths) {
      const wanted = new Set(paths);
      return new Set(
        index()
          .filter((entry) => entry.stage > 0 && wanted.has(entry.path))
          .map((entry) => entry.path),
      );
    },
    head,
    operationInProgress: () => operationInProgress(gitDir, disk),
    stagedNames: (filter) =>
      git(["diff", "--cached", "--name-only", "-z", ...(filter ? [`--diff-filter=${filter}`] : [])])
        .split("\0")
        .filter(Boolean),
    resetIndex(paths) {
      if (paths.length > 0) git(["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: paths.join("\0") });
      indexListing = null;
    },
    blobId,
    readWorktree(path) {
      try {
        const full = nodePath.join(root, path);
        return disk.lstatSync(full).isFile() ? disk.readFileSync(full) : null;
      } catch {
        return null;
      }
    },
    readObject(blob) {
      const result = host.git(["cat-file", "blob", blob]);
      return result.status === 0 ? result.stdout : null;
    },
    readBlob: (id) => (id === null || id.startsWith(SYMLINK_PREFIX) ? null : blob(id)),
    capture(path) {
      const id = worktreeId(path);
      if (id === null || id.startsWith(SYMLINK_PREFIX)) return id;
      const content = disk.readFileSync(nodePath.join(root, path));
      storeBlob(stateDir, blobId(content), content, disk);
      return id;
    },
    storeContent(content) {
      const id = blobId(content);
      storeBlob(stateDir, id, content, disk);
      return id;
    },
    restore(path, id) {
      const target = nodePath.join(root, path);
      ownedAncestors(target);
      // What the file is to become is read before anything is removed, so a restore that cannot finish keeps what is there.
      const content = id === null || id.startsWith(SYMLINK_PREFIX) ? null : blob(id);
      if (id !== null && !id.startsWith(SYMLINK_PREFIX) && content === null) throw new GuardError(`no stored copy of ${path}`);
      const stat = disk.lstatSync(target, { throwIfNoEntry: false });
      if (stat?.isDirectory()) disk.rmdirSync(target);
      else if (stat && (id === null || id.startsWith(SYMLINK_PREFIX))) disk.unlinkSync(target);
      if (id === null) return;
      disk.mkdirSync(nodePath.dirname(target), { recursive: true });
      if (content === null) {
        disk.symlinkSync(id.slice(SYMLINK_PREFIX.length), target);
        return;
      }
      const mode = id.endsWith(EXECUTABLE_SUFFIX) ? 0o755 : 0o644;
      const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      disk.writeFileSync(temporary, content, { mode, flag: "wx" });
      disk.chmodSync(temporary, mode);
      disk.renameSync(temporary, target);
    },
    prune(keep) {
      pruneBlobs(
        stateDir,
        [...keep].map((id) => (id === null || id.startsWith(SYMLINK_PREFIX) ? null : contentOf(id))),
        disk,
      );
    },
    hooks,
    restoreHooks(baseline) {
      const directory = nodePath.join(commonDir, "hooks");
      const current = hooks(false);
      for (const name of Object.keys(current.scripts)) if (!(name in baseline.scripts)) disk.unlinkSync(nodePath.join(directory, name));
      for (const [name, entry] of Object.entries(baseline.scripts)) {
        const [id = "", mode = "755"] = entry.split(":");
        const content = readBlob(stateDir, id, disk);
        if (content === null) throw new GuardError(`no stored copy of the ${name} Git hook`);
        const target = nodePath.join(directory, name);
        disk.rmSync(target, { force: true });
        disk.writeFileSync(target, content, { mode: Number.parseInt(mode, 8) });
        disk.chmodSync(target, Number.parseInt(mode, 8));
      }
    },
    environment() {
      const modules = nodePath.join(root, "node_modules");
      if (!disk.existsSync(modules)) return "absent";
      /** @type {string[]} */
      const lines = [];
      const limit = { budget: MAX_ENTRIES };
      listEntries(modules, "", lines, limit);
      // Only names, links and file metadata decide which code runs; caches under dot directories do not.
      const kept = lines.filter((line) => !line.startsWith(".") || /^\.(?:bin|pnpm|modules\.yaml)\b/.test(line));
      listEntries(nodePath.join(modules, ".bin"), ".bin", kept, limit);
      listEntries(nodePath.join(modules, ".pnpm"), ".pnpm", kept, limit);
      for (const entry of disk.readdirSync(modules, { withFileTypes: true })) {
        if (entry.name.startsWith("@") && entry.isDirectory()) listEntries(nodePath.join(modules, entry.name), entry.name, kept, limit);
      }
      return createHash("sha256")
        .update([...new Set(kept)].sort().join("\n"))
        .digest("hex");
    },
    userFile(name) {
      const path = userPath(name);
      try {
        return { path, content: disk.readFileSync(path) };
      } catch {
        return { path, content: null };
      }
    },
    writeUserFile(name, content) {
      disk.writeFileSync(userPath(name), content);
    },
    realpath,
    userHome: host.userHome,
    codexHome: home,
    files: disk,
    readText(absolute) {
      try {
        return disk.readFileSync(absolute, "utf8");
      } catch {
        return null;
      }
    },
    writeText(absolute, text) {
      disk.writeFileSync(absolute, text);
    },
    readState: () => readState(stateDir, disk),
    writeState: (baseline) => {
      writeState(stateDir, baseline, disk);
    },
    locked: (action) => withLock(stateDir, action, undefined, disk),
  };
}

/**
 * Opens the worktree a hook event belongs to, on this machine.
 * @param {string} start a directory inside the worktree
 * @param {Inventory} inventory what is protected
 * @param {{ codexHome?: string }} [options]
 * @returns {Repo}
 */
function openRepo(start, inventory, options = {}) {
  const located = locateGit(start);
  /** @type {Host["git"]} */
  const git = (args, input) =>
    spawnSync("git", ["-C", located.root, ...args], {
      maxBuffer: MAX_GIT_OUTPUT,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      ...(input === undefined ? {} : { input }),
    });
  return createRepo(
    { ...located, userHome: homedir(), codexHome: options.codexHome ?? (process.env.CODEX_HOME || nodePath.join(homedir(), ".codex")), git, disk: fs },
    inventory,
  );
}

module.exports = { SYMLINK_PREFIX, contentOf, createRepo, openRepo, parseIndexListing, parseTreeListing };
