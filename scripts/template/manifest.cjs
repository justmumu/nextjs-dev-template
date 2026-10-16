// @ts-check
"use strict";
const SCHEMA = "nextjs-dev-template/manifest";
const PROTOCOL = 1;
const ROLE = "application";
const PROJECTIONS = new Set(["package-json"]);
const TOP_KEYS = new Set(["schema", "protocol", "role", "entries"]);
/** @type {Record<string, Set<string>>} */
const ENTRY_KEYS = {
  copy: new Set(["type", "base", "source", "destination"]),
  "json-metadata": new Set(["type", "base", "source", "destination", "projection"]),
};

/**
 * @typedef {{ base: "template" | "root", source: string, destination: string }} EntryPaths
 * @typedef {({ type: "copy" } | { type: "json-metadata", projection: string }) & EntryPaths} ManifestEntry
 */

class RenderError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RenderError";
  }
}

/**
 * Validates a relative POSIX path: no absolute, traversal, dot, empty, backslash,
 * control-character or `.git` segments.
 * @param {unknown} value
 * @param {string} label
 * @returns {string[]} segments
 */
function safeSegments(value, label) {
  if (typeof value !== "string" || value === "") throw new RenderError(`${label} must be a non-empty string`);
  // eslint-disable-next-line no-control-regex -- rejecting control characters in untrusted input is the purpose of this pattern
  if (/[\u0000-\u001f\u007f\\]/.test(value)) throw new RenderError(`${label} contains a control character or backslash: ${JSON.stringify(value)}`);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new RenderError(`${label} must be relative: ${value}`);
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") throw new RenderError(`${label} has an unsafe segment: ${value}`);
    if (segment.toLowerCase() === ".git") throw new RenderError(`${label} must not touch .git: ${value}`);
  }
  return segments;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} label @returns {string} a validated relative path */
function safePath(value, label) {
  safeSegments(value, label);
  return /** @type {string} */ (value);
}

/** @param {readonly string[]} destinations */
function checkCollisions(destinations) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const destination of destinations) {
    const key = destination.toLowerCase();
    if (seen.has(key)) throw new RenderError(`destination collides: ${destination} and ${seen.get(key) ?? ""}`);
    seen.set(key, destination);
    const segments = key.split("/");
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
  }
  for (const dir of dirs) {
    if (seen.has(dir)) throw new RenderError(`destination is both a file and a directory: ${seen.get(dir) ?? ""}`);
  }
}

/**
 * @param {unknown} raw
 * @returns {{ entries: ManifestEntry[] }}
 */
function parseManifest(raw) {
  if (!isRecord(raw)) throw new RenderError("manifest must be an object");
  if (raw.schema !== SCHEMA) throw new RenderError(`unsupported manifest schema: ${JSON.stringify(raw.schema)}`);
  if (raw.protocol !== PROTOCOL) throw new RenderError(`unsupported manifest protocol: ${JSON.stringify(raw.protocol)}`);
  if (raw.role !== ROLE) throw new RenderError(`manifest role must be "${ROLE}"`);
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) throw new RenderError(`unknown manifest key: ${key}`);
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) throw new RenderError("manifest entries must be a non-empty array");
  /** @type {ManifestEntry[]} */
  const entries = /** @type {unknown[]} */ (raw.entries).map((entry, index) => {
    const label = `entries[${String(index)}]`;
    if (!isRecord(entry)) throw new RenderError(`${label} must be an object`);
    const type = entry.type;
    if (type !== "copy" && type !== "json-metadata") throw new RenderError(`${label} has unknown type: ${JSON.stringify(type)}`);
    const allowed = ENTRY_KEYS[type];
    for (const key of Object.keys(entry)) {
      if (!allowed?.has(key)) throw new RenderError(`${label} has unknown key: ${key}`);
    }
    const base = entry.base;
    if (base !== "template" && base !== "root") throw new RenderError(`${label} has unknown base: ${JSON.stringify(base)}`);
    /** @type {EntryPaths} */
    const paths = { base, source: safePath(entry.source, `${label}.source`), destination: safePath(entry.destination, `${label}.destination`) };
    if (type === "copy") return { type, ...paths };
    const projection = entry.projection;
    if (typeof projection !== "string" || !PROJECTIONS.has(projection)) {
      throw new RenderError(`${label} has unknown projection: ${JSON.stringify(projection)}`);
    }
    return { type, ...paths, projection };
  });
  checkCollisions(entries.map((entry) => entry.destination));
  return { entries };
}

module.exports = { SCHEMA, PROTOCOL, RenderError, isRecord, parseManifest, safeSegments, checkCollisions };
