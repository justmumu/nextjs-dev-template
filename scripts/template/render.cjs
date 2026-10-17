// @ts-check
"use strict";
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const nodePath = require("node:path");
const { validateAnswers } = require("./inputs.cjs");
const { PROTOCOL, RenderError, SCHEMA, checkCollisions, isRecord, parseManifest, safeSegments } = require("./manifest.cjs");

const repoRoot = nodePath.resolve(__dirname, "..", "..");
const MODES = new Set([0o644, 0o755]);

/**
 * @typedef {{ path: string, mode: number, content: Buffer }} RenderedFile
 * @typedef {{ template: string, root: string }} Bases
 * @typedef {{ dev: bigint, ino: bigint }} DirIdentity
 * @typedef {{ path: string } & DirIdentity} OwnedDir
 * @typedef {{ dev: bigint, ino: bigint, ctimeNs: bigint, mtimeNs: bigint, size: bigint }} Fingerprint
 * @typedef {{ path: string, content: Buffer } & Fingerprint} OwnedFile
 */

/** @param {string} path @param {string} label */
function assertNoSymlinkAncestors(path, label) {
  const [head = "", ...rest] = nodePath.resolve(path).split(nodePath.sep);
  const parts = head === "" ? rest : [head, ...rest];
  let current = head === "" ? nodePath.sep : head;
  for (let i = 0; ; i++) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new RenderError(`${label} has a symlink in its path: ${current}`);
    const next = parts[i];
    if (next === undefined) return;
    current = nodePath.join(current, next);
  }
}

/** @param {string | undefined} base @param {string} relative @param {string} label @returns {{ content: Buffer, mode: number }} */
function readSource(base, relative, label) {
  if (typeof base !== "string" || !nodePath.isAbsolute(base)) throw new RenderError(`base for ${label} must be an absolute path`);
  const baseStat = fs.lstatSync(base, { throwIfNoEntry: false });
  if (!baseStat) throw new RenderError(`base directory does not exist: ${label}`);
  assertNoSymlinkAncestors(base, `base directory for ${label}`);
  let current = base;
  const segments = safeSegments(relative, label);
  let stat = baseStat;
  for (const segment of segments) {
    current = nodePath.join(current, segment);
    const next = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!next) throw new RenderError(`source does not exist: ${relative}`);
    stat = next;
    if (stat.isSymbolicLink()) throw new RenderError(`source path contains a symlink: ${relative}`);
  }
  if (!stat.isFile()) throw new RenderError(`source must be a regular file (no directory or submodule): ${relative}`);
  return { content: fs.readFileSync(current), mode: stat.mode & 0o111 ? 0o755 : 0o644 };
}

const PROJECTION_KEYS = ["name", "version", "description", "author"];

/** @type {Record<string, (template: Buffer, answers: ReturnType<typeof validateAnswers>, source: string) => Buffer>} */
const projections = {
  "package-json"(template, answers, source) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(template.toString("utf8"));
    } catch (error) {
      throw new RenderError(`${source} is not valid JSON: ${/** @type {Error} */ (error).message}`);
    }
    if (!isRecord(parsed)) throw new RenderError(`${source} must be a JSON object`);
    for (const key of PROJECTION_KEYS) {
      if (Object.hasOwn(parsed, key)) throw new RenderError(`${source} must not define ${key}; it is projected from the answers`);
    }
    /** @type {Record<string, string>} */
    const head = { name: answers.name, version: answers.version };
    if (answers.description !== "") head.description = answers.description;
    if (answers.owner !== null) head.author = answers.owner;
    return Buffer.from(`${JSON.stringify({ ...head, ...parsed }, null, 2)}\n`, "utf8");
  },
};

/** @param {readonly RenderedFile[]} files @returns {string} */
function treeDigest(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`${file.mode.toString(8)} ${file.path} ${createHash("sha256").update(file.content).digest("hex")}\n`);
  }
  return hash.digest("hex");
}

/**
 * Pure: reads sources, returns the file list. Writes nothing.
 * @param {{ manifest: unknown, bases: Bases, answers: unknown }} input
 * @returns {{ files: RenderedFile[], digest: string }}
 */
function renderTree({ manifest, bases, answers }) {
  const parsed = parseManifest(manifest);
  const values = validateAnswers(answers);
  const files = parsed.entries.map((entry) => {
    const source = readSource(bases[entry.base], entry.source, `${entry.base}:${entry.source}`);
    const project = entry.type === "copy" ? null : projections[entry.projection];
    if (entry.type !== "copy" && !project) throw new RenderError(`unsupported projection: ${entry.projection}`);
    const content = project ? project(source.content, values, entry.source) : source.content;
    return { path: entry.destination, mode: source.mode, content };
  });
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, digest: treeDigest(files) };
}

/** @param {string} path @returns {Fingerprint} */
function fingerprint(path) {
  const stat = fs.lstatSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs, size: stat.size };
}

/** @param {import("node:fs").BigIntStats} stat @param {Partial<Fingerprint>} owned @returns {boolean} */
function sameIdentity(stat, owned) {
  return /** @type {const} */ (["dev", "ino", "ctimeNs", "mtimeNs", "size"]).every((key) => !(key in owned) || stat[key] === owned[key]);
}

/** @param {string} base @param {readonly string[]} segments @param {OwnedDir[]} createdDirs */
function ensureDirs(base, segments, createdDirs) {
  let current = base;
  for (const segment of segments) {
    current = nodePath.join(current, segment);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      try {
        fs.mkdirSync(current);
        const { dev, ino } = fingerprint(current);
        createdDirs.push({ path: current, dev, ino });
        stat = fs.lstatSync(current);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
        stat = fs.lstatSync(current);
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RenderError(`unsafe directory: ${current}`);
  }
}

/**
 * Removes only what this invocation created and can still prove is its own: files whose
 * identity and bytes are unchanged, then directories it made that are still empty.
 * Anything modified, replaced or added by someone else is left in place. A change made
 * between the check and the unlink cannot be excluded without OS support.
 */
/** @param {OwnedFile[]} createdFiles @param {OwnedDir[]} createdDirs */
function rollback(createdFiles, createdDirs) {
  for (const owned of createdFiles.reverse()) {
    try {
      const stat = fs.lstatSync(owned.path, { bigint: true });
      if (stat.isFile() && sameIdentity(stat, owned) && fs.readFileSync(owned.path).equals(owned.content)) fs.unlinkSync(owned.path);
    } catch {
      // best effort: anything that cannot be proven ours is left in place
    }
  }
  for (const owned of createdDirs.reverse()) {
    try {
      const stat = fs.lstatSync(owned.path, { bigint: true });
      if (stat.isDirectory() && sameIdentity(stat, owned)) fs.rmdirSync(owned.path);
    } catch {
      // best effort: anything that cannot be proven ours is left in place
    }
  }
}

/**
 * A destination a tree may be written to: absolute, missing or an empty directory, with no symlink
 * among it or its ancestors.
 * @param {string} dest
 * @returns {{ root: string, exists: boolean }}
 */
function checkDestination(dest) {
  if (typeof dest !== "string" || !nodePath.isAbsolute(dest)) throw new RenderError("destination root must be an absolute path");
  const root = nodePath.resolve(dest);
  assertNoSymlinkAncestors(root, "destination");
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isDirectory()) throw new RenderError(`destination exists and is not a directory: ${root}`);
    if (fs.readdirSync(root).length > 0) throw new RenderError(`destination is not empty: ${root}`);
  }
  return { root, exists: stat !== undefined };
}

/**
 * Writes a rendered tree into a missing or empty directory; never overwrites. No symlink may
 * appear among the destination or its ancestors. If a write fails, only the files and empty
 * directories this call created (and that are still unchanged) are removed. The result removes
 * them the same way later, for a caller whose own next step failed.
 * @param {readonly RenderedFile[]} files @param {string} dest
 * @returns {{ undo: () => void }}
 */
function writeTree(files, dest) {
  for (const file of files) {
    safeSegments(file.path, "file path");
    if (!MODES.has(file.mode)) throw new RenderError(`unsupported mode for ${file.path}`);
  }
  checkCollisions(files.map((file) => file.path));
  const { root, exists } = checkDestination(dest);
  /** @type {OwnedDir[]} */
  const createdDirs = [];
  /** @type {OwnedFile[]} */
  const createdFiles = [];
  try {
    if (!exists) {
      const segments = root.split(nodePath.sep).filter(Boolean);
      ensureDirs(nodePath.sep, segments, createdDirs);
    }
    for (const file of files) {
      const segments = file.path.split("/");
      ensureDirs(root, segments.slice(0, -1), createdDirs);
      const target = nodePath.join(root, ...segments);
      fs.writeFileSync(target, file.content, { flag: "wx", mode: file.mode });
      const owned = { path: target, content: file.content, ...fingerprint(target) };
      createdFiles.push(owned);
      fs.chmodSync(target, file.mode);
      Object.assign(owned, fingerprint(target));
    }
  } catch (error) {
    rollback(createdFiles, createdDirs);
    throw error;
  }
  return {
    undo: () => {
      rollback([...createdFiles], [...createdDirs]);
    },
  };
}

/** @returns {{ manifest: unknown, bases: Bases }} */
function defaultInputs() {
  return {
    manifest: JSON.parse(fs.readFileSync(nodePath.join(repoRoot, "tooling", "template-manifest.json"), "utf8")),
    bases: { template: nodePath.join(repoRoot, "template", "app"), root: repoRoot },
  };
}

module.exports = { PROTOCOL, SCHEMA, RenderError, checkDestination, renderTree, writeTree, treeDigest, defaultInputs };
