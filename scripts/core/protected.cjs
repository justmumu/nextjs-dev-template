// @ts-check
"use strict";
// The one inventory of files that define a project's rules and tooling, for both roles. It is
// declared once, in tooling/policy.json: the dependency transaction snapshots exactly this surface
// and the protected-files guard classifies paths with the same declaration. Dependency-free so
// hooks can load it without an install.
const nodePath = require("node:path");
const { isObject, readObject } = require("./json.cjs");

/**
 * @typedef {{
 *   files: string[], dirs: string[], seedPrefix: string, shadowExemptPrefixes: string[],
 *   configNames: RegExp[], shadowNames: RegExp[], docsConfig: RegExp, vitepressConfig: RegExp,
 *   skippedAnywhere: Set<string>, generatedDirs: Set<string>,
 * }} Inventory
 */

/** @param {unknown} value @param {string} name @returns {string[]} */
function strings(value, name) {
  const items = /** @type {unknown[]} */ (Array.isArray(value) ? value : []);
  /** @type {string[]} */
  const list = [];
  for (const item of items) if (typeof item === "string" && item !== "") list.push(item);
  if (list.length === 0 || list.length !== items.length) throw new Error(`tooling/policy.json: protected.${name} must be a non-empty list of strings`);
  return list;
}

/** @param {unknown} value @param {string} name @returns {string} */
function text(value, name) {
  if (typeof value !== "string" || value === "") throw new Error(`tooling/policy.json: protected.${name} must be a non-empty string`);
  return value;
}

/**
 * Reads the declaration; anything that is not exactly the declared shape is an error, because a
 * silently smaller inventory would unprotect files.
 * @param {unknown} declaration the `protected` member of tooling/policy.json
 * @returns {Inventory}
 */
function parseInventory(declaration) {
  if (!isObject(declaration)) throw new Error("tooling/policy.json: protected must be an object");
  return {
    files: strings(declaration.files, "files"),
    dirs: strings(declaration.dirs, "dirs"),
    seedPrefix: text(declaration.seedPrefix, "seedPrefix"),
    shadowExemptPrefixes: strings(declaration.shadowExemptPrefixes, "shadowExemptPrefixes"),
    configNames: strings(declaration.configNames, "configNames").map((pattern) => new RegExp(pattern)),
    shadowNames: strings(declaration.shadowNames, "shadowNames").map((pattern) => new RegExp(pattern)),
    docsConfig: new RegExp(text(declaration.docsConfig, "docsConfig")),
    vitepressConfig: new RegExp(text(declaration.vitepressConfig, "vitepressConfig")),
    skippedAnywhere: new Set(strings(declaration.skippedAnywhere, "skippedAnywhere")),
    generatedDirs: new Set(strings(declaration.generatedDirs, "generatedDirs")),
  };
}

/**
 * The classification functions of one declaration. The guard builds one from the declaration it
 * recorded in its baseline, so an edited working copy cannot shrink what is protected.
 * @param {unknown} declaration
 */
function createInventory(declaration) {
  const inventory = parseInventory(declaration);

  /** @param {string} rel posix path relative to the project root @returns {boolean} */
  function isProtectedFile(rel) {
    if (rel.startsWith(inventory.seedPrefix)) return isProtectedFile(rel.slice(inventory.seedPrefix.length));
    const parts = rel.split("/");
    if (parts.length === 1) return inventory.files.includes(rel) || inventory.configNames.some((pattern) => pattern.test(rel));
    const [first = "", second = ""] = parts;
    if (inventory.dirs.includes(first)) return true;
    if (first !== "docs") return false;
    return (parts.length === 2 && inventory.docsConfig.test(second)) || inventory.vitepressConfig.test(parts.slice(1).join("/"));
  }

  /** @param {string} rel @returns {boolean} true for a shadow-capable config name below the root */
  function isShadowOverride(rel) {
    if (!rel.includes("/")) return false;
    if (inventory.shadowExemptPrefixes.some((prefix) => rel.startsWith(prefix))) return false;
    return inventory.shadowNames.some((pattern) => pattern.test(nodePath.basename(rel)));
  }

  /**
   * Dependency trees and Git data are never scanned. Build output names are generated state at the
   * root and below ordinary source, but not below a protected directory: `scripts/dist/new.cjs` is
   * protected content, not a build product.
   * @param {string} name a directory name
   * @param {string} [parent] the posix path of the directory that holds it; empty for the project root
   * @returns {boolean}
   */
  function isSkippedDir(name, parent = "") {
    if (inventory.skippedAnywhere.has(name)) return true;
    if (!inventory.generatedDirs.has(name)) return false;
    return !inventory.dirs.includes(parent.split("/")[0] ?? "");
  }

  return { DIRS: inventory.dirs, FILES: inventory.files, isProtectedFile, isShadowOverride, isSkippedDir };
}

const DECLARATION = readObject(nodePath.join(__dirname, "..", "..", "tooling", "policy.json")).protected;
const { DIRS, FILES, isProtectedFile, isShadowOverride, isSkippedDir } = createInventory(DECLARATION);

module.exports = { DIRS, FILES, createInventory, isProtectedFile, isShadowOverride, isSkippedDir };
