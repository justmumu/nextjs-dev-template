// @ts-check
"use strict";
// Facts the static-quality commands share. Dependency-free so the commands work before and without
// a healthy node_modules.
const { readFileSync } = require("node:fs");
const nodePath = require("node:path");

// Formatting covers code, data, styles and the public documents and workflows. The pnpm lock files
// are written by pnpm, which owns their format, and are excluded in .prettierignore; so are the
// private working directories, which are not part of the project's tracked content.
const FORMAT_EXTENSIONS = ["js", "cjs", "mjs", "ts", "tsx", "json", "css", "md", "yml", "yaml", "html"];
const FORMAT_GLOBS = [`**/*.{${FORMAT_EXTENSIONS.join(",")}}`];
const LINT_FIX_EXTENSIONS = ["js", "cjs", "mjs", "ts", "tsx"];

// Blocks that `next dev` manages inside agent instruction files. With agentRules disabled it removes
// them silently, which would change a protected baseline file without review.
const MANAGED_BLOCKS = [
  { start: "<!-- BEGIN:nextjs-agent-rules -->", name: "Next.js agent rules block" },
  { start: "<!-- BEGIN:nextjs-agent-feedback -->", name: "Next.js agent feedback block" },
  { start: "<!-- NEXT-AGENTS-MD-START -->", name: "legacy Next.js agent rules block" },
];
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/**
 * @param {string} root
 * @returns {string[]} one error per managed block found; nothing is modified
 */
function managedAgentBlockErrors(root) {
  const errors = [];
  for (const file of INSTRUCTION_FILES) {
    let content;
    try {
      content = readFileSync(nodePath.join(root, file), "utf8");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") continue;
      throw error;
    }
    for (const { start, name } of MANAGED_BLOCKS) {
      if (content.includes(start)) {
        errors.push(
          `${file} contains the ${name}. Next.js would rewrite or remove it on \`next dev\`. Migrate it explicitly: move the guidance you want into the canonical AGENTS.md text outside any managed marker, delete the block in a reviewed change, and keep agentRules: false.`,
        );
      }
    }
  }
  return errors;
}

module.exports = { FORMAT_EXTENSIONS, FORMAT_GLOBS, LINT_FIX_EXTENSIONS, managedAgentBlockErrors };
