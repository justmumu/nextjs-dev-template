// @ts-check
"use strict";
// What a release is made of: the version a project keeps in its own package.json, the three bumps,
// and the tag a version is released under. Pure text and number decisions; no repository, no disk.
const semver = require("semver");

class ReleaseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ReleaseError";
  }
}

const SEGMENTS = /** @type {const} */ (["patch", "minor", "major"]);
const PLAIN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_LINE = /^( {2}"version": ")([^"\\]*)(",?)$/gm;

/**
 * The generator and an application keep their live version in the same field of their own manifest;
 * the role and the path are still named, so a role that keeps it elsewhere says so here.
 * @typedef {{ role: "generator" | "application", file: string }} Adapter
 * @type {Readonly<Record<"generator" | "application", Adapter>>}
 */
const ADAPTERS = Object.freeze({
  generator: { role: "generator", file: "package.json" },
  application: { role: "application", file: "package.json" },
});

/** @param {string} role @returns {Adapter} */
function adapterFor(role) {
  if (role !== "generator" && role !== "application") throw new ReleaseError(`unknown role: ${JSON.stringify(role)}`);
  return ADAPTERS[role];
}

/** @param {string} version @returns {boolean} */
const isPlain = (version) => PLAIN.test(version) && semver.valid(version) === version;

/** @param {string} text @returns {string} the version of a manifest, which must be a plain MAJOR.MINOR.PATCH */
function readVersion(text) {
  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new ReleaseError(`package.json is not valid JSON: ${/** @type {Error} */ (error).message}`);
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) throw new ReleaseError("package.json must be a JSON object");
  const version = /** @type {{ version?: unknown }} */ (manifest).version;
  if (typeof version !== "string") throw new ReleaseError("package.json has no version");
  if (!isPlain(version)) throw new ReleaseError(`the version ${JSON.stringify(version)} is not a plain MAJOR.MINOR.PATCH`);
  return version;
}

/** @param {string} version @param {string} segment @returns {string} */
function nextVersion(version, segment) {
  if (!isPlain(version)) throw new ReleaseError(`the version ${JSON.stringify(version)} is not a plain MAJOR.MINOR.PATCH`);
  if (!SEGMENTS.some((name) => name === segment)) throw new ReleaseError("Choose a patch, minor or major version bump.");
  const next = semver.inc(version, /** @type {"patch" | "minor" | "major"} */ (segment));
  if (next === null) throw new ReleaseError(`the version ${version} cannot be bumped`);
  return next;
}

/**
 * The manifest with its version replaced and nothing else changed: one top-level `"version"` line is
 * rewritten in place, so formatting, key order and every other field stay byte for byte.
 * @param {string} text @param {string} version
 * @returns {string}
 */
function withVersion(text, version) {
  const lines = [...text.matchAll(VERSION_LINE)];
  if (lines.length !== 1) throw new ReleaseError("package.json must have exactly one top-level version line");
  const updated = text.replace(VERSION_LINE, (_line, before, _old, after) => `${String(before)}${version}${String(after)}`);
  if (readVersion(updated) !== version) throw new ReleaseError("package.json did not take the new version");
  return updated;
}

/** @param {string} version @returns {string} the tag a version is released under */
const tagOf = (version) => `v${version}`;

/** @param {string} tag @returns {string} the version a release tag names */
function versionOfTag(tag) {
  const match = /^v(\S+)$/.exec(tag);
  if (!match || !isPlain(match[1] ?? "") || tag.length > 64) throw new ReleaseError("Release tags must use vMAJOR.MINOR.PATCH.");
  return match[1] ?? "";
}

/** @param {readonly string[]} tags release tags @returns {string | null} the one with the highest version */
function latestTag(tags) {
  return [...tags].sort((a, b) => semver.rcompare(versionOfTag(a), versionOfTag(b)))[0] ?? null;
}

module.exports = { ADAPTERS, ReleaseError, SEGMENTS, adapterFor, latestTag, nextVersion, readVersion, tagOf, versionOfTag, withVersion };
