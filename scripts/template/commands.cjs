// @ts-check
"use strict";
const nodePath = require("node:path");
const { parseArgs } = require("../core/args.cjs");
const { cleanEnv } = require("../testing/environment.cjs");
const harness = require("../testing/harness.cjs");
const { createCancellation } = require("../testing/owned.cjs");

/** @typedef {import("../development.cjs").Handler} Handler */

/** @type {Handler} */
function templateCreate(args, { cwd, io }) {
  const flags = parseArgs(args, { name: { required: true }, owner: { required: true }, dest: { required: true } });
  const render = require("./render.cjs");
  const { manifest, bases } = render.defaultInputs();
  const { files, digest } = render.renderTree({ manifest, bases, answers: { name: flags.name, owner: flags.owner } });
  render.writeTree(files, nodePath.resolve(cwd, flags.dest));
  io.stdout(`${JSON.stringify({ files: files.length, digest })}\n`);
  return 0;
}

/** @type {Handler} */
function seedRefresh(args, { root, io }) {
  parseArgs(args, {});
  return require("./seed.cjs").refreshSeed({ root, io });
}

/**
 * @typedef {{
 *   scratch: () => string,
 *   remove: (dir: string) => void,
 *   render: (dest: string) => void,
 *   install: (dir: string) => number | null | Promise<number | null>,
 *   command: (dir: string, command: string) => number | null | Promise<number | null>,
 * }} RenderedHost the generator has no Next.js application of its own: its production proofs render one, install it from its frozen lock and run the application's own command there
 */

/**
 * Both tools run as groups of their own that this process stops when it is interrupted. The
 * application's command is given longer than the groups it must itself stop first, so it finishes
 * its own cleanup before it is forced.
 * @param {import("../testing/owned.cjs").Cancellation} cancel
 * @returns {RenderedHost & { terminate: () => Promise<string[]> }}
 */
function realRenderedHost(cancel) {
  const tools = harness.realHost(cancel);
  return {
    ...tools,
    scratch: () => tools.scratch("rendered-app-"),
    render: (dest) => {
      const render = require("./render.cjs");
      const { manifest, bases } = render.defaultInputs();
      render.writeTree(render.renderTree({ manifest, bases, answers: { name: "rendered-app", owner: "template-check" } }).files, dest);
    },
    install: (dir) => tools.run("pnpm", ["install", "--frozen-lockfile"], { cwd: dir, env: cleanEnv(process.env) }),
    command: (dir, command) =>
      tools.run(process.execPath, [nodePath.join("scripts", "development.cjs"), command], { cwd: dir, env: cleanEnv(process.env), graceMs: NESTED_GRACE_MS }),
  };
}

const NESTED_GRACE_MS = 30_000;

/**
 * @param {string} command an application command
 * @param {{ stderr: (text: string) => unknown }} io
 * @param {RenderedHost} host
 * @param {import("../testing/owned.cjs").Cancellation} [cancel] an interrupted run renders, installs and starts nothing further, and removes its scratch
 * @returns {Promise<number>}
 */
async function inRenderedApp(command, io, host, cancel = createCancellation()) {
  const scratch = host.scratch();
  try {
    const dest = nodePath.join(scratch, "app");
    if (cancel.isCancelled()) return 1;
    host.render(dest);
    const installed = await host.install(dest);
    if (cancel.isCancelled()) return 1;
    if (installed !== 0) {
      io.stderr("the rendered application could not be installed from its frozen lock\n");
      return 1;
    }
    return (await host.command(dest, command)) ?? 1;
  } finally {
    host.remove(scratch);
  }
}

/**
 * This process owns the interrupts of the whole chain: it stops the install or the application's
 * command, which in turn stops its own servers and browsers, and returns only when its scratch is gone.
 * @param {string} command
 * @returns {Promise<number>}
 */
function proofInRenderedApp(command) {
  const cancel = createCancellation();
  const host = realRenderedHost(cancel);
  return harness.execute(({ io }) => inRenderedApp(command, io, host, cancel), process, cancel, host);
}

/** @type {Handler} */
function testE2e(args) {
  parseArgs(args, {});
  return proofInRenderedApp("test:e2e");
}

/** @type {Handler} */
function testArtifact(args) {
  parseArgs(args, {});
  return proofInRenderedApp("test:artifact");
}

module.exports = { inRenderedApp, realRenderedHost, seedRefresh, templateCreate, testArtifact, testE2e };
