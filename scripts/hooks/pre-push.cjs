// @ts-check
"use strict";
const nodePath = require("node:path");
const { stdio } = require("../core/process.cjs");
const development = require("../development.cjs");

const GATES = ["check", "docs:build"];

/**
 * Runs each routine gate once, in order, and stops at the first failure.
 * @param {readonly string[]} _argv
 * @param {{ root?: string, io?: { stdout: (text: string) => unknown, stderr: (text: string) => unknown }, dispatch?: typeof development.main }} [options]
 * @returns {number}
 */
function main(_argv, options = {}) {
  const root = options.root ?? nodePath.resolve(__dirname, "..", "..");
  const io = options.io ?? stdio;
  const dispatch = options.dispatch ?? development.main;
  for (const name of GATES) {
    io.stdout(`pre-push: ${name}\n`);
    const status = dispatch([name], { root, io });
    if (status !== 0) {
      io.stderr(`pre-push: ${name} failed; the push was stopped\n`);
      return status;
    }
  }
  return 0;
}

module.exports = { GATES, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
