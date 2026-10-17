// @ts-check
"use strict";
const nodePath = require("node:path");
const { stdio } = require("../core/process.cjs");
const development = require("../development.cjs");

/**
 * Checks the message file Git hands the hook against the one reviewed commitlint configuration.
 * @param {readonly string[]} argv the message file
 * @param {{ root?: string, io?: { stdout: (text: string) => unknown, stderr: (text: string) => unknown }, launch?: (pkg: string, bin: string, args: string[]) => number }} [options]
 * @returns {number}
 */
function main(argv, options = {}) {
  const root = options.root ?? nodePath.resolve(__dirname, "..", "..");
  const io = options.io ?? stdio;
  const [file, ...extra] = argv;
  if (file === undefined || extra.length > 0) {
    io.stderr("commit-msg: expected exactly the commit message file\n");
    return 2;
  }
  const launch = options.launch ?? development.installedTools({ root, cwd: root, io }).launch;
  return launch("@commitlint/cli", "commitlint", ["--config", "tooling/hooks/commit-message.mjs", "--edit", file]);
}

module.exports = { main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
