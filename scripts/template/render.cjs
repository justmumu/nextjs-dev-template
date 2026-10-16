"use strict";
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { isAbsolute, join, resolve, sep } = require("node:path");
const { validateAnswers } = require("./inputs.cjs");
const { PROTOCOL, RenderError, SCHEMA, checkCollisions, parseManifest, safeSegments } = require("./manifest.cjs");

const repoRoot = resolve(__dirname, "..", "..");
const MODES = new Set([0o644, 0o755]);

function assertNoSymlinkAncestors(path, label) {
  const segments = resolve(path).split(sep);
  let current = segments[0] === "" ? sep : segments[0];
  for (let i = segments[0] === "" ? 1 : 0; i <= segments.length; i++) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new RenderError(`${label} has a symlink in its path: ${current}`);
    if (i === segments.length) return;
    current = join(current, segments[i]);
  }
}

function readSource(base, relative, label) {
  if (typeof base !== "string" || !isAbsolute(base)) throw new RenderError(`base for ${label} must be an absolute path`);
  const baseStat = fs.lstatSync(base, { throwIfNoEntry: false });
  if (!baseStat) throw new RenderError(`base directory does not exist: ${label}`);
  assertNoSymlinkAncestors(base, `base directory for ${label}`);
  let current = base;
  const segments = safeSegments(relative, label);
  let stat = baseStat;
  for (const segment of segments) {
    current = join(current, segment);
    stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new RenderError(`source does not exist: ${relative}`);
    if (stat.isSymbolicLink()) throw new RenderError(`source path contains a symlink: ${relative}`);
  }
  if (!stat.isFile()) throw new RenderError(`source must be a regular file (no directory or submodule): ${relative}`);
  return { content: fs.readFileSync(current), mode: stat.mode & 0o111 ? 0o755 : 0o644 };
}

const PROJECTION_KEYS = ["name", "version", "description", "author"];

const projections = {
  "package-json"(template, answers, source) {
    let parsed;
    try {
      parsed = JSON.parse(template.toString("utf8"));
    } catch (error) {
      throw new RenderError(`${source} is not valid JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new RenderError(`${source} must be a JSON object`);
    for (const key of PROJECTION_KEYS) {
      if (Object.hasOwn(parsed, key)) throw new RenderError(`${source} must not define ${key}; it is projected from the answers`);
    }
    const head = { name: answers.name, version: answers.version };
    if (answers.description !== "") head.description = answers.description;
    if (answers.owner !== null) head.author = answers.owner;
    return Buffer.from(`${JSON.stringify({ ...head, ...parsed }, null, 2)}\n`, "utf8");
  },
};

function treeDigest(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(`${file.mode.toString(8)} ${file.path} ${createHash("sha256").update(file.content).digest("hex")}\n`);
  }
  return hash.digest("hex");
}

/**
 * Pure: reads sources, returns the file list. Writes nothing.
 * @param {{ manifest: unknown, bases: { template: string, root: string }, answers: unknown }} input
 * @returns {{ files: { path: string, mode: number, content: Buffer }[], digest: string }}
 */
function renderTree({ manifest, bases, answers }) {
  const parsed = parseManifest(manifest);
  const values = validateAnswers(answers);
  const files = parsed.entries.map((entry) => {
    const source = readSource(bases[entry.base], entry.source, `${entry.base}:${entry.source}`);
    const content = entry.type === "copy" ? source.content : projections[entry.projection](source.content, values, entry.source);
    return { path: entry.destination, mode: source.mode, content };
  });
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, digest: treeDigest(files) };
}

function fingerprint(path) {
  const stat = fs.lstatSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs, size: stat.size };
}

function sameIdentity(stat, owned) {
  return ["dev", "ino", "ctimeNs", "mtimeNs", "size"].every((key) => !(key in owned) || stat[key] === owned[key]);
}

function ensureDirs(base, segments, createdDirs) {
  let current = base;
  for (const segment of segments) {
    current = join(current, segment);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      try {
        fs.mkdirSync(current);
        const { dev, ino } = fingerprint(current);
        createdDirs.push({ path: current, dev, ino });
        stat = fs.lstatSync(current);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
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
function rollback(createdFiles, createdDirs) {
  for (const owned of createdFiles.reverse()) {
    try {
      const stat = fs.lstatSync(owned.path, { bigint: true });
      if (stat.isFile() && sameIdentity(stat, owned) && fs.readFileSync(owned.path).equals(owned.content)) fs.unlinkSync(owned.path);
    } catch {
    }
  }
  for (const owned of createdDirs.reverse()) {
    try {
      const stat = fs.lstatSync(owned.path, { bigint: true });
      if (stat.isDirectory() && sameIdentity(stat, owned)) fs.rmdirSync(owned.path);
    } catch {
    }
  }
}

/**
 * Writes a rendered tree into a missing or empty directory; never overwrites. No symlink may
 * appear among the destination or its ancestors. If a write fails, only the files and empty
 * directories this call created (and that are still unchanged) are removed.
 */
function writeTree(files, dest) {
  if (typeof dest !== "string" || !isAbsolute(dest)) throw new RenderError("destination root must be an absolute path");
  for (const file of files) {
    safeSegments(file.path, "file path");
    if (!MODES.has(file.mode)) throw new RenderError(`unsupported mode for ${file.path}`);
  }
  checkCollisions(files.map((file) => file.path));
  const root = resolve(dest);
  assertNoSymlinkAncestors(root, "destination");
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isDirectory()) throw new RenderError(`destination exists and is not a directory: ${root}`);
    if (fs.readdirSync(root).length > 0) throw new RenderError(`destination is not empty: ${root}`);
  }
  const createdDirs = [];
  const createdFiles = [];
  try {
    if (!stat) {
      const segments = root.split(sep).filter(Boolean);
      ensureDirs(sep, segments, createdDirs);
    }
    for (const file of files) {
      const segments = file.path.split("/");
      ensureDirs(root, segments.slice(0, -1), createdDirs);
      const target = join(root, ...segments);
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
}

function defaultInputs() {
  return {
    manifest: JSON.parse(fs.readFileSync(join(repoRoot, "tooling", "template-manifest.json"), "utf8")),
    bases: { template: join(repoRoot, "template", "app"), root: repoRoot },
  };
}

module.exports = { PROTOCOL, SCHEMA, RenderError, renderTree, writeTree, treeDigest, defaultInputs };
