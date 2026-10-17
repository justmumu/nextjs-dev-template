// @ts-check
"use strict";
const fs = require("node:fs");
const nodePath = require("node:path");

// Configurations may import local code or data from anywhere in the project. Copy those inputs,
// excluding machine state and environment files instead of guessing an import graph.
const LOCAL_STATE = new Set([
  ".git",
  ".private",
  ".claude",
  ".codex",
  ".compound-engineering",
  "node_modules",
  ".pnpm-store",
  ".next",
  "out",
  "coverage",
  "playwright-report",
  "test-results",
  ".cache",
  ".temp",
  "next-env.d.ts",
  ".DS_Store",
]);

/** @param {string} source @param {string} dest */
function copyTree(source, dest) {
  const name = nodePath.basename(source);
  if (LOCAL_STATE.has(name) || name === ".env" || name.startsWith(".env.") || name.endsWith(".tsbuildinfo")) return;
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(source).sort()) copyTree(nodePath.join(source, name), nodePath.join(dest, name));
  } else if (stat.isFile()) {
    fs.writeFileSync(dest, fs.readFileSync(source));
    // Set after the write: a creation mode is reduced by the umask, and a copy keeps the mode of its source.
    fs.chmodSync(dest, stat.mode & 0o777);
  } else {
    throw new Error(`${source} is neither a file nor a directory and is not staged`);
  }
}

/**
 * @param {{ source: string, dest: string, files: Record<string, string>, transform?: Record<string, (text: string) => string> }} options
 * `files` are written after the copy; `transform` rewrites copied text files by project-relative path
 */
function stage({ source, dest, files, transform = {} }) {
  for (const entry of fs.readdirSync(source).sort()) copyTree(nodePath.join(source, entry), nodePath.join(dest, entry));
  for (const [path, rewrite] of Object.entries(transform)) {
    const target = nodePath.join(dest, path);
    fs.writeFileSync(target, rewrite(fs.readFileSync(target, "utf8")));
  }
  for (const [path, content] of Object.entries(files)) {
    const target = nodePath.join(dest, path);
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

module.exports = { stage };
