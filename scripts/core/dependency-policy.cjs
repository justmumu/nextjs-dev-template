// @ts-check
"use strict";
// Semantic dependency policy: what a dependency change may touch, and which workspace/.npmrc
// fields are never part of one. Dependency-free and pure so the guard can reuse it later.
const { isObject } = require("./json.cjs");

const MAPS = /** @type {const} */ (["dependencies", "devDependencies"]);
const GROUP_MAP = /** @type {const} */ ({ prod: "dependencies", dev: "devDependencies" });
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Higher-priority build permissions, shells, hooks and graph-rewriting fields. None of these is a
// dependency change; each needs its own protected review.
const FORBIDDEN_WORKSPACE_KEYS = [
  "permissions",
  "scriptShell",
  "shellEmulator",
  "pnpmfile",
  "globalPnpmfile",
  "hooks",
  "packages",
  "packageExtensions",
  "patchedDependencies",
  "dangerouslyAllowAllBuilds",
  "onlyBuiltDependencies",
  "neverBuiltDependencies",
  "ignoredBuiltDependencies",
];
// The reviewed graph rewrites. VitePress 1.6.4 pins DocSearch 3.8.2, whose peers stop at React 18;
// DocSearch 3.9.0 adds React 19 support (https://github.com/algolia/docsearch/releases/tag/v3.9.0).
// This is a compatible package replacement scoped to that parent, not a peer-dependency suppression.
// The last two lift the old form-data (2.1.x/2.3.x, GHSA-fjxv-7rqg-78g4, GHSA-hmw2-7cc7-3qxx) and qs (6.5.x,
// GHSA-6rw7-vpxm-498p, GHSA-4mjr-xmp4-gh2g) that hyperlink's request/teepee chains request to the patched
// versions of the same major lines; the selectors match only those old requested ranges. Roots and
// generated projects share this declaration; a workspace file may carry exactly this block or none,
// and dependency commands never add, remove or change it.
const REVIEWED_OVERRIDES = Object.freeze({
  "vitepress@1.6.4>@docsearch/js": "3.9.0",
  "vitepress@1.6.4>@docsearch/css": "3.9.0",
  "form-data@<2.5.0": "2.5.6",
  "qs@<6.6.0": "6.16.1",
});
const REQUIRED_SCALARS = /** @type {const} */ ({ strictDepBuilds: "true", verifyDepsBeforeRun: "error", enablePrePostScripts: "false" });
const FORBIDDEN_NPMRC = /^\s*(script-shell|shell-emulator|pnpmfile|global-pnpmfile)\s*=/im;
const NPMRC_CREDENTIAL = /^\s*(?:\/\/[^\s=]*:)?(_authToken|_auth|_password)\s*=\s*(\S*)/gim;

const TOP_KEY = /^([A-Za-z][A-Za-z0-9]*):(?: (.+))?$/;
const CHILD = /^ {2}(?:([A-Za-z0-9][A-Za-z0-9._/-]*)|"([^"\\\n]+)"|'([^'\n]+)'): (\S.*)$/;
const SCALAR = /^(?:[A-Za-z0-9][A-Za-z0-9._/-]*|\[\]|\{\})$/;
const ALLOWED_TOP = new Set([...Object.keys(REQUIRED_SCALARS), "skills", "allowBuilds", "overrides"]);

/**
 * Parses the deliberately narrow canonical subset of pnpm-workspace.yaml that the policy files use:
 * full-line comments, `key: scalar` at the top, and one level of two-space-indented `key: scalar`
 * children. The check has to run without node_modules, so it cannot use a YAML library; instead
 * everything outside the subset (quoted top-level keys, flow maps, lists, anchors, aliases, tags,
 * block scalars, inline comments, tabs, duplicate keys, extra indentation, extra documents) is
 * reported as unsupported structure and fails the policy.
 * @param {string} text
 * @returns {{ keys: Map<string, { inline: string | null, children: Map<string, string> }>, problems: string[] }}
 */
function parseWorkspace(text) {
  /** @type {Map<string, { inline: string | null, children: Map<string, string> }>} */
  const keys = new Map();
  /** @type {string[]} */
  const problems = [];
  /** @type {{ inline: string | null, children: Map<string, string> } | null} */
  let current = null;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((raw, index) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const where = `pnpm-workspace.yaml line ${String(index + 1)}`;
    if (/^\s*(?:#.*)?$/.test(line)) return;
    if (line.includes("\t")) return void problems.push(`${where}: tabs are not supported`);
    const top = /** @type {(RegExpExecArray & [string, string, string | undefined]) | null} */ (TOP_KEY.exec(line));
    if (top) {
      const inline = top[2] ?? null;
      if (inline !== null && !SCALAR.test(inline))
        return void problems.push(`${where}: unsupported YAML value ${JSON.stringify(inline)} (only bare scalars, [] and {} are supported)`);
      if (keys.has(top[1])) return void problems.push(`${where}: duplicate key ${top[1]}`);
      current = { inline, children: new Map() };
      keys.set(top[1], current);
      return;
    }
    const child = /** @type {(RegExpExecArray & [string, string | undefined, string | undefined, string | undefined, string]) | null} */ (CHILD.exec(line));
    if (child && current && current.inline === null) {
      const name = child[1] ?? child[2] ?? child[3] ?? "";
      if (!SCALAR.test(child[4])) return void problems.push(`${where}: unsupported YAML value for ${name} (${JSON.stringify(child[4])})`);
      if (current.children.has(name)) return void problems.push(`${where}: duplicate key ${name}`);
      current.children.set(name, child[4]);
      return;
    }
    problems.push(`${where}: unsupported YAML structure; only the canonical subset of key: value lines is accepted`);
  });
  return { keys, problems };
}

/** @param {{ inline: string | null, children: Map<string, string> }} block the parsed `overrides` key @returns {boolean} whether it is exactly the reviewed map */
function reviewedOverrides(block) {
  const reviewed = Object.entries(REVIEWED_OVERRIDES);
  return block.inline === null && block.children.size === reviewed.length && reviewed.every(([name, version]) => block.children.get(name) === version);
}

/**
 * @param {string} text pnpm-workspace.yaml
 * @param {{ reviewedBuilds: readonly string[] }} options
 * @returns {string[]}
 */
function workspaceViolations(text, options) {
  const { keys, problems } = parseWorkspace(text);
  const violations = [...problems];
  for (const [key, expected] of Object.entries(REQUIRED_SCALARS)) {
    if (keys.get(key)?.inline !== expected) violations.push(`${key}: ${expected} is required`);
  }
  const skills = keys.get("skills");
  if (skills?.inline !== null || skills.children.size !== 1 || skills.children.get("dirs") !== "[]")
    violations.push("skills.dirs: [] is required (no implicit skill linking)");
  for (const key of keys.keys()) {
    if (FORBIDDEN_WORKSPACE_KEYS.includes(key)) violations.push(`${key} is not a dependency field and needs its own protected review`);
    else if (!ALLOWED_TOP.has(key)) violations.push(`${key} is not part of the reviewed workspace policy and needs its own protected review`);
  }
  const overrides = keys.get("overrides");
  if (overrides && !reviewedOverrides(overrides)) {
    violations.push(
      "overrides: only the reviewed block (" +
        Object.entries(REVIEWED_OVERRIDES)
          .map(([name, version]) => `${name}: ${version}`)
          .join(", ") +
        ") is allowed, and all of it",
    );
  }
  const builds = keys.get("allowBuilds");
  if (builds && builds.inline !== null && builds.inline !== "{}") violations.push("allowBuilds must be a block of name: true|false entries (or {})");
  for (const [name, value] of builds?.children ?? []) {
    if (value === "false") continue;
    if (value !== "true") violations.push(`allowBuilds.${name} has no decision (${JSON.stringify(value)}); a placeholder is not a policy`);
    else if (!options.reviewedBuilds.includes(name)) violations.push(`allowBuilds.${name}: true is not a reviewed build permission`);
  }
  return violations;
}

/**
 * What a workspace file says, independent of key order, quoting, blank lines and comments: every
 * key and scalar of the canonical subset. Layout-only rewrites by the formatter keep it equal.
 * @param {string} text pnpm-workspace.yaml
 * @returns {string | null} null when the file is outside the canonical subset and so cannot be compared
 */
function workspaceMeaning(text) {
  const { keys, problems } = parseWorkspace(text);
  if (problems.length > 0) return null;
  const facts = [...keys].flatMap(([key, block]) => [
    JSON.stringify([key, block.inline]),
    ...[...block.children].map(([name, value]) => JSON.stringify([key, name, value])),
  ]);
  return facts.sort().join("\n");
}

/** @param {string} text .npmrc @returns {string[]} */
function npmrcViolations(text) {
  const violations = [];
  const hook = FORBIDDEN_NPMRC.exec(text);
  if (hook) violations.push(`.npmrc ${hook[1] ?? ""} is not allowed`);
  for (const match of text.matchAll(NPMRC_CREDENTIAL)) {
    if (!/^\$\{[A-Z0-9_]+\}$/.test(match[2] ?? "")) violations.push(`.npmrc holds a literal ${match[1] ?? ""}; credentials stay external`);
  }
  return violations;
}

/** @param {unknown} value @returns {boolean} */
function isExactVersion(value) {
  return typeof value === "string" && EXACT.test(value);
}

/** @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- TypeScript lib limitation: JSON.stringify returns undefined for functions and symbols but is typed string
  return JSON.stringify(value) ?? "undefined";
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => canonical(a) === canonical(b);

/**
 * @param {Record<string, unknown>} manifest
 * @param {string} map
 * @returns {Record<string, unknown>}
 */
function mapOf(manifest, map) {
  const value = manifest[map];
  return isObject(value) ? value : {};
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {Record<string, unknown>}
 */
function withoutMaps(manifest) {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => !(/** @type {readonly string[]} */ (MAPS).includes(key))));
}

/**
 * @typedef {{ action: "none" } | { action: "approved-edit" } | { action: "add", group: "prod" | "dev", name: string, version?: string | null } | { action: "remove", group: "prod" | "dev", name: string } | { action: "upgrade", name: string | null }} DependencyPlan
 */

/**
 * Compares two parsed package.json objects against the one mutation a plan allows.
 * Returns an empty list only when nothing outside that mutation changed.
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @param {DependencyPlan & { valueOk?: (value: string) => boolean, pinned?: Record<string, string> }} plan
 * @returns {string[]}
 */
function manifestViolations(before, after, plan) {
  const violations = [];
  for (const [name, version] of Object.entries(plan.pinned ?? {})) {
    for (const map of MAPS) {
      const was = Object.hasOwn(mapOf(before, map), name);
      const now = mapOf(after, map)[name];
      if (was && now !== version)
        violations.push(`${map}.${name} is a reviewed tool pin (${version}); changing it is a reviewed tooling change, not a dependency change`);
      if (!was && now !== undefined && now !== version) violations.push(`${map}.${name} would shadow a reviewed tool pin (${version})`);
    }
  }
  const valueOptions = plan.valueOk;
  /** @param {unknown} value */
  const valueOk = (value) => typeof value === "string" && (valueOptions ? valueOptions(value) : isExactVersion(value));
  if (!same(withoutMaps(before), withoutMaps(after))) {
    violations.push("package.json changed outside the dependency maps (scripts, engines, packageManager, overrides and other fields are protected)");
  }
  for (const map of MAPS) {
    const was = mapOf(before, map);
    const now = mapOf(after, map);
    const wasKeys = Object.keys(was);
    const nowKeys = Object.keys(now);
    const added = nowKeys.filter((key) => !Object.hasOwn(was, key));
    const removed = wasKeys.filter((key) => !Object.hasOwn(now, key));
    const changed = nowKeys.filter((key) => Object.hasOwn(was, key) && was[key] !== now[key]);
    /** @param {string} reason @param {string[]} names */
    const touched = (reason, names) => names.length > 0 && violations.push(`${map}: ${reason} ${names.join(", ")}`);
    if (plan.action === "none") {
      touched("unexpected addition", added);
      touched("unexpected removal", removed);
      touched("unexpected change", changed);
    } else if (plan.action === "approved-edit") {
      for (const key of nowKeys) if (!valueOk(now[key])) violations.push(`${map}.${key} must be an exact registry version (got ${JSON.stringify(now[key])})`);
    } else if (plan.action === "add") {
      const own = map === GROUP_MAP[plan.group];
      touched("unexpected removal", removed);
      touched("unexpected change", own ? changed.filter((key) => key !== plan.name) : changed);
      touched("unexpected addition", own ? added.filter((key) => key !== plan.name) : added);
      if (own && !Object.hasOwn(now, plan.name)) violations.push(`${map}.${plan.name} was not added`);
      if (own && Object.hasOwn(now, plan.name) && !valueOk(now[plan.name]))
        violations.push(`${map}.${plan.name} must be an exact registry version (got ${JSON.stringify(now[plan.name])})`);
      else if (own && plan.version && Object.hasOwn(now, plan.name) && now[plan.name] !== plan.version)
        violations.push(`${map}.${plan.name} must be the requested version ${plan.version} (got ${JSON.stringify(now[plan.name])})`);
    } else if (plan.action === "remove") {
      const own = map === GROUP_MAP[plan.group];
      touched("unexpected addition", added);
      touched("unexpected change", changed);
      touched("unexpected removal", own ? removed.filter((key) => key !== plan.name) : removed);
      if (own && Object.hasOwn(now, plan.name)) violations.push(`${map}.${plan.name} was not removed`);
      if (own && !Object.hasOwn(was, plan.name)) violations.push(`${map}.${plan.name} was not a dependency to remove`);
    } else {
      touched("unexpected addition", added);
      touched("unexpected removal", removed);
      touched("unexpected change", plan.name === null ? [] : changed.filter((key) => key !== plan.name));
      for (const key of changed) if (!valueOk(now[key])) violations.push(`${map}.${key} must be an exact registry version (got ${JSON.stringify(now[key])})`);
    }
  }
  return violations;
}

/** @param {string} text pnpm-workspace.yaml @returns {string[]} names with an allowed build */
function buildPermissions(text) {
  const children = parseWorkspace(text).keys.get("allowBuilds")?.children ?? /** @type {Map<string, string>} */ (new Map());
  return [...children].filter(([, value]) => value === "true").map(([name]) => name);
}

/**
 * Packages whose build scripts pnpm ignored. The result is a review prompt; it is never a policy.
 * @param {string} output
 * @returns {string[]}
 */
function buildReview(output) {
  const match = /Ignored build scripts:\s*([^\n]+)/.exec(output);
  return (
    match?.[1]
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

module.exports = {
  GROUP_MAP,
  buildPermissions,
  buildReview,
  isExactVersion,
  manifestViolations,
  npmrcViolations,
  parseWorkspace,
  same,
  workspaceMeaning,
  workspaceViolations,
};
