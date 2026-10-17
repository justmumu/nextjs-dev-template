// @ts-check
"use strict";
const fs = require("node:fs");
const nodePath = require("node:path");
const { run } = require("../core/process.cjs");

const HOOKS = ["pre-commit", "commit-msg", "pre-push"];
const MARKER = "# managed by nextjs-dev-template";

class HookError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "HookError";
  }
}

/**
 * @typedef {Pick<typeof fs, "chmodSync" | "lstatSync" | "mkdirSync" | "readFileSync" | "renameSync" | "rmSync" | "writeFileSync">} Disk
 * @typedef {{ root: string, disk?: Disk, start?: typeof run }} Options
 */

/** @param {string} name @returns {string} the hook Git runs: it finds the worktree at run time, because linked worktrees share one hooks directory */
function shim(name) {
  return `#!/bin/sh\n${MARKER}: ${name}\nroot=$(git rev-parse --show-toplevel) || exit 1\nexec node "$root/scripts/hooks/${name}.cjs" "$@"\n`;
}

/** @param {typeof run} start @param {string} root @param {string[]} args @returns {string} */
function gitOutput(start, root, args) {
  const result = start("git", args, { cwd: root });
  if (result.status !== 0) throw new HookError(`git ${args.join(" ")} failed; the hooks need a Git worktree`);
  return result.stdout.trim();
}

/**
 * The hooks directory Git itself resolves, so a linked worktree or a configured core.hooksPath is
 * honored and never rewritten.
 * @param {typeof run} start @param {string} root
 * @returns {{ dir: string, usual: string }} the directory Git runs hooks from, and the one it uses without configuration
 */
function hooksDirectories(start, root) {
  const dir = gitOutput(start, root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  const common = gitOutput(start, root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { dir, usual: nodePath.join(common, "hooks") };
}

/** @param {Disk} disk @param {string} path @returns {{ content: Buffer, mode: number } | null} the file there, or null when there is none; a symlink or directory counts as foreign */
function existing(disk, path) {
  const stat = disk.lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) return { content: Buffer.alloc(0), mode: stat.mode };
  return { content: disk.readFileSync(path), mode: stat.mode & 0o777 };
}

/**
 * What the hooks directory holds for each hook this tool manages.
 * @param {Options} options
 * @returns {{ dir: string, usual: string, hooks: Record<string, "missing" | "stale" | "current" | "foreign">, unreachable: string[] }} `unreachable` lists owned hooks in the usual directory that Git no longer runs because core.hooksPath points elsewhere
 */
function inspect({ root, disk = fs, start = run }) {
  const { dir, usual } = hooksDirectories(start, root);
  /** @type {Record<string, "missing" | "stale" | "current" | "foreign">} */
  const hooks = {};
  for (const name of HOOKS) {
    const found = existing(disk, nodePath.join(dir, name));
    if (found === null) hooks[name] = "missing";
    else if (found.content.toString("utf8") === shim(name) && (found.mode & 0o111) !== 0) hooks[name] = "current";
    else hooks[name] = owns(found.content, name) ? "stale" : "foreign";
  }
  const unreachable =
    usual === dir
      ? []
      : HOOKS.filter((name) => {
          const found = existing(disk, nodePath.join(usual, name));
          return found !== null && owns(found.content, name);
        });
  return { dir, usual, hooks, unreachable };
}

/** @param {Buffer} content @param {string} name @returns {boolean} */
function owns(content, name) {
  return content.toString("utf8").split("\n")[1] === `${MARKER}: ${name}`;
}

/**
 * Installs the three hooks, replacing only hooks this tool wrote. Anything else already there stops
 * the installation before a file is touched. A failure part-way restores every hook as it was.
 * @param {Options} options
 * @returns {{ dir: string, written: string[], unchanged: string[], notice: string[] }}
 */
function install(options) {
  const { disk = fs } = options;
  const state = inspect(options);
  const foreign = HOOKS.filter((name) => state.hooks[name] === "foreign");
  if (foreign.length > 0) {
    throw new HookError(
      `${foreign.map((name) => nodePath.join(state.dir, name)).join(", ")} already exist and are not managed by this template; nothing was changed. Move them aside or integrate them by hand, then run setup again.`,
    );
  }
  /** @type {{ path: string, before: { content: Buffer, mode: number } | null }[]} */
  const done = [];
  /** @type {string[]} */
  const temporaries = [];
  const todo = HOOKS.filter((name) => state.hooks[name] !== "current");
  try {
    disk.mkdirSync(state.dir, { recursive: true });
    for (const name of todo) {
      const path = nodePath.join(state.dir, name);
      done.push({ path, before: existing(disk, path) });
      const temporary = `${path}.${String(process.pid)}.tmp`;
      temporaries.push(temporary);
      disk.writeFileSync(temporary, shim(name), { mode: 0o755 });
      disk.chmodSync(temporary, 0o755);
      disk.renameSync(temporary, path);
    }
  } catch (error) {
    for (const { path, before } of done.reverse()) {
      if (before === null) disk.rmSync(path, { force: true });
      else {
        disk.writeFileSync(path, before.content);
        disk.chmodSync(path, before.mode);
      }
    }
    for (const temporary of temporaries) disk.rmSync(temporary, { force: true });
    throw error;
  }
  const notice = state.unreachable.map((name) => `${nodePath.join(state.usual, name)} is managed by this template but Git runs hooks from ${state.dir}`);
  return { dir: state.dir, written: todo, unchanged: HOOKS.filter((name) => !todo.includes(name)), notice };
}

module.exports = { HOOKS, HookError, MARKER, inspect, install, shim };
