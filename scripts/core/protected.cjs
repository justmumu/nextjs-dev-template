// @ts-check
"use strict";
// The one inventory of files that define a project's rules and tooling, for both roles. The
// dependency transaction snapshots exactly this surface; the protected-files guard (U6) extends
// this module instead of keeping a second list. Dependency-free and pure so hooks can load it.
const nodePath = require("node:path");

// Exact root-level names.
const FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".node-version",
  ".nvmrc",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".prettierignore",
  ".eslintignore",
  ".npmignore",
  "AGENTS.md",
  "CLAUDE.md",
];

// Root-level static configuration and package-manager hooks, whatever the extension variant.
const CONFIG_NAMES = [
  /^\.pnpmfile\..+$/,
  /^tsconfig(?:\..+)?\.json$/,
  /^next\.config\.[cm]?[jt]s$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^\.eslintrc(?:\..+)?$/,
  /^\.prettierrc(?:\..+)?$/,
  /^prettier\.config\.[cm]?[jt]s$/,
  /^vitest\.(?:[a-z]+\.)?(?:config|workspace)\.[cm]?[jt]s$/,
  /^playwright\.config\.[cm]?[jt]s$/,
  /^postcss\.config\.[cm]?[jt]s$/,
];

// Site generators keep their configuration directly under docs/, and VitePress keeps config.* plus
// its config/ helper directory under docs/.vitepress/ (theme and content stay ordinary source).
const DOCS_CONFIG = /^[^/]+\.config\.(?:[cm]?[jt]s|json)$/;
const VITEPRESS_CONFIG = /^\.vitepress\/(?:config\.[cm]?[jt]s|config\/.+)$/;

// The generator's application seed carries the same policy surface under this prefix; the rest of
// the seed (src, app, public, ...) is ordinary template source and is not protected.
const SEED_PREFIX = "template/app/";

// Directories whose whole content is protected.
const DIRS = ["scripts", "tooling", ".claude", ".codex", ".githooks", ".husky"];

// Configuration that wins over the root one when it sits closer to the file it configures: a copy
// anywhere below the root is a shadow override and is never allowed to appear.
const SHADOW_NAMES = [
  /^\.npmrc$/,
  /^pnpm-workspace\.yaml$/,
  /^\.pnpmfile\..+$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^\.eslintrc(?:\..+)?$/,
  /^\.prettierrc(?:\..+)?$/,
  /^prettier\.config\.[cm]?[jt]s$/,
  /^vitest\.(?:[a-z]+\.)?(?:config|workspace)\.[cm]?[jt]s$/,
  /^playwright\.config\.[cm]?[jt]s$/,
];

// Never scanned: dependency trees, build output and other generated state.
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "out",
  "dist",
  "build",
  "coverage",
  "site",
  "test-results",
  "playwright-report",
  ".turbo",
  ".cache",
  ".pnpm-store",
]);
// Not scanned for shadow overrides: the generator's application seed and test fixtures legitimately carry their own configuration.
const SHADOW_EXEMPT_PREFIXES = ["template/", "tests/fixtures/"];

/** @param {string} rel posix path relative to the project root @returns {boolean} */
function isProtectedFile(rel) {
  if (rel.startsWith(SEED_PREFIX)) return isProtectedFile(rel.slice(SEED_PREFIX.length));
  const parts = rel.split("/");
  if (parts.length === 1) return FILES.includes(rel) || CONFIG_NAMES.some((pattern) => pattern.test(rel));
  const [first = "", second = ""] = parts;
  if (DIRS.includes(first)) return true;
  if (first !== "docs") return false;
  return (parts.length === 2 && DOCS_CONFIG.test(second)) || VITEPRESS_CONFIG.test(parts.slice(1).join("/"));
}

/** @param {string} rel @returns {boolean} true for a shadow-capable config name below the root */
function isShadowOverride(rel) {
  if (!rel.includes("/")) return false;
  if (SHADOW_EXEMPT_PREFIXES.some((prefix) => rel.startsWith(prefix))) return false;
  return SHADOW_NAMES.some((pattern) => pattern.test(nodePath.basename(rel)));
}

/** @param {string} name a directory name @returns {boolean} */
function isSkippedDir(name) {
  return SKIPPED_DIRS.has(name);
}

module.exports = { DIRS, FILES, isProtectedFile, isShadowOverride, isSkippedDir };
