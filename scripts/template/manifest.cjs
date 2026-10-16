"use strict";
const SCHEMA = "nextjs-dev-template/manifest";
const PROTOCOL = 1;
const ROLE = "application";
const BASES = new Set(["template", "root"]);
const PROJECTIONS = new Set(["package-json"]);
const TOP_KEYS = new Set(["schema", "protocol", "role", "entries"]);
const ENTRY_KEYS = {
  copy: new Set(["type", "base", "source", "destination"]),
  "json-metadata": new Set(["type", "base", "source", "destination", "projection"]),
};

class RenderError extends Error {
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
  if (/[\u0000-\u001f\u007f\\]/.test(value)) throw new RenderError(`${label} contains a control character or backslash: ${JSON.stringify(value)}`);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new RenderError(`${label} must be relative: ${value}`);
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") throw new RenderError(`${label} has an unsafe segment: ${value}`);
    if (segment.toLowerCase() === ".git") throw new RenderError(`${label} must not touch .git: ${value}`);
  }
  return segments;
}

function checkCollisions(destinations) {
  const seen = new Map();
  const dirs = new Set();
  for (const destination of destinations) {
    const key = destination.toLowerCase();
    if (seen.has(key)) throw new RenderError(`destination collides: ${destination} and ${seen.get(key)}`);
    seen.set(key, destination);
    const segments = key.split("/");
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
  }
  for (const dir of dirs) {
    if (seen.has(dir)) throw new RenderError(`destination is both a file and a directory: ${seen.get(dir)}`);
  }
}

/**
 * @param {unknown} raw
 * @returns {{ entries: { type: string, base: string, source: string, destination: string, projection?: string }[] }}
 */
function parseManifest(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new RenderError("manifest must be an object");
  if (raw.schema !== SCHEMA) throw new RenderError(`unsupported manifest schema: ${JSON.stringify(raw.schema)}`);
  if (raw.protocol !== PROTOCOL) throw new RenderError(`unsupported manifest protocol: ${JSON.stringify(raw.protocol)}`);
  if (raw.role !== ROLE) throw new RenderError(`manifest role must be "${ROLE}"`);
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) throw new RenderError(`unknown manifest key: ${key}`);
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) throw new RenderError("manifest entries must be a non-empty array");
  const entries = raw.entries.map((entry, index) => {
    const label = `entries[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new RenderError(`${label} must be an object`);
    const allowed = Object.hasOwn(ENTRY_KEYS, entry.type) ? ENTRY_KEYS[entry.type] : null;
    if (!allowed) throw new RenderError(`${label} has unknown type: ${JSON.stringify(entry.type)}`);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) throw new RenderError(`${label} has unknown key: ${key}`);
    }
    if (!BASES.has(entry.base)) throw new RenderError(`${label} has unknown base: ${JSON.stringify(entry.base)}`);
    safeSegments(entry.source, `${label}.source`);
    safeSegments(entry.destination, `${label}.destination`);
    if (entry.type === "json-metadata" && !PROJECTIONS.has(entry.projection)) {
      throw new RenderError(`${label} has unknown projection: ${JSON.stringify(entry.projection)}`);
    }
    return { ...entry };
  });
  checkCollisions(entries.map((entry) => entry.destination));
  return { entries };
}

module.exports = { SCHEMA, PROTOCOL, RenderError, parseManifest, safeSegments, checkCollisions };
