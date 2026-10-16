// @ts-check
"use strict";
// Runs exactly one test file of a suite. Vitest's command line treats a file argument as a substring
// of the path, so a lookalike (a.test.ts beside a.test.tsx, or the same segments under another
// directory) would be run with it; this selects the file by its absolute module id through Vitest's
// own Node API instead, in the suite's protected configuration, and runs only that specification.
const nodePath = require("node:path");
const { pathToFileURL } = require("node:url");

/**
 * @typedef {{ moduleId: string }} Specification
 * @typedef {{ state: () => string, children: { allTests: () => Iterable<{ result: () => { state: string } }> } }} TestModule
 */

/** @param {string} text @returns {string} the text as a regular expression that matches it literally */
function literalPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\\-/]/g, "\\$&");
}

/**
 * @template {Specification} S
 * @param {readonly S[]} specifications every specification of the suite
 * @param {string} moduleId the absolute path of the one file
 * @returns {S[]} the specifications of that file and no other
 */
function exactSpecifications(specifications, moduleId) {
  return specifications.filter((specification) => specification.moduleId === moduleId);
}

/**
 * Judges a finished run. A literal name that selected no test leaves every test skipped, which
 * Vitest reports as a pass; it is a refusal here.
 * @param {readonly TestModule[]} modules @param {readonly unknown[]} unhandledErrors @param {string | null} name
 * @returns {{ status: number, message: string | null }}
 */
function judge(modules, unhandledErrors, name) {
  const states = modules.flatMap((module) => [...module.children.allTests()].map((test) => test.result().state));
  if (unhandledErrors.length > 0 || modules.some((module) => module.state() === "failed") || states.includes("failed")) {
    return { status: 1, message: null };
  }
  if (name !== null && !states.some((state) => state === "passed")) return { status: 2, message: `no test has the name ${JSON.stringify(name)}` };
  return { status: 0, message: null };
}

/**
 * @param {{ root: string, suite: string, file: string, name: string | null }} focus a project-relative file
 * @returns {Promise<number>} the exit status
 */
async function focusedRun({ root, suite, file, name }) {
  // Vitest's command line leaves the colours out of output that is not a terminal; the API does not.
  if (!process.stdout.isTTY && process.env.FORCE_COLOR === undefined) process.env.NO_COLOR = "1";
  /** @type {unknown} */
  const loaded = await import(pathToFileURL(nodePath.join(root, "node_modules", "vitest", "dist", "node.js")).href);
  const vitest = /** @type {typeof import("vitest/node")} */ (loaded);
  const ctx = await vitest.createVitest({
    watch: false,
    run: true,
    root,
    project: [suite],
    ...(name === null ? {} : { testNamePattern: new RegExp(literalPattern(name)) }),
  });
  try {
    await ctx.standalone();
    const moduleId = nodePath.resolve(root, file);
    const specifications = exactSpecifications(await ctx.globTestSpecifications(), moduleId);
    if (specifications.length === 0) {
      process.stderr.write(`test:one: the ${suite} suite does not select ${file}\n`);
      return 2;
    }
    const { testModules, unhandledErrors } = await ctx.runTestSpecifications(specifications);
    const { status, message } = judge(testModules, unhandledErrors, name);
    if (message !== null) process.stderr.write(`test:one: ${message} in ${file}\n`);
    return status;
  } finally {
    await ctx.close();
  }
}

module.exports = { exactSpecifications, focusedRun, judge, literalPattern };

if (require.main === module) {
  const [suite, file, name] = process.argv.slice(2);
  if (suite === undefined || file === undefined) {
    process.stderr.write("usage: focused-run.cjs <suite> <file> [name]\n");
    process.exitCode = 2;
  } else {
    focusedRun({ root: process.cwd(), suite, file, name: name ?? null }).then(
      (status) => {
        process.exitCode = status;
      },
      (/** @type {unknown} */ error) => {
        process.stderr.write(`test:one: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
  }
}
