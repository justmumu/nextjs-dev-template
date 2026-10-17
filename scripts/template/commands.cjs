// @ts-check
"use strict";
const fs = require("node:fs");
const nodePath = require("node:path");
const { parseArgs } = require("../core/args.cjs");
const { cleanEnv } = require("../testing/environment.cjs");
const harness = require("../testing/harness.cjs");
const { createCancellation } = require("../testing/owned.cjs");
const { createGit } = require("./git.cjs");

/**
 * @typedef {import("../development.cjs").Handler} Handler
 * @typedef {import("./transaction.cjs").Io} Io
 */

/**
 * What creation does on this machine: real Git, the real filesystem, and tools that run as groups of
 * their own that this process stops when it is interrupted. The tools see the cleaned environment of
 * the production harnesses; Git sees the caller's, because its configuration decides who enrolls.
 * @param {import("../testing/owned.cjs").Cancellation} cancel
 * @param {NodeJS.ProcessEnv} [env] the caller's environment
 * @returns {import("./transaction.cjs").Host & { terminate: () => Promise<string[]> }}
 */
function realCreateHost(cancel, env = process.env) {
  const tools = harness.realHost(cancel);
  const render = require("./render.cjs");
  return {
    git: createGit({ env }),
    disk: fs,
    scratch: tools.scratch,
    remove: tools.remove,
    write: render.writeTree,
    read: (path) => {
      const stat = fs.lstatSync(path, { throwIfNoEntry: false });
      return stat?.isFile() ? { content: fs.readFileSync(path), mode: stat.mode & 0o777 } : null;
    },
    run: (command, args, options) => tools.run(command, args, { ...options, graceMs: NESTED_GRACE_MS }),
    smoke: ({ cwd, env: toolEnv, nonce }) => require("./smoke.cjs").smoke({ cwd, env: toolEnv, nonce, cancel }),
    env: cleanEnv(env),
    terminate: tools.terminate,
  };
}

/**
 * @param {Io} io
 * @param {(host: ReturnType<typeof realCreateHost>, cancel: import("../testing/owned.cjs").Cancellation) => Promise<number>} flow
 * @returns {Promise<number>}
 */
function owningCreation(io, flow) {
  const cancel = createCancellation();
  const host = realCreateHost(cancel);
  return harness.execute(
    async () => {
      try {
        return await flow(host, cancel);
      } catch (error) {
        if (error instanceof Error && error.name === "RenderError") {
          io.stderr(`${error.message}\n`);
          return 2;
        }
        throw error;
      }
    },
    process,
    cancel,
    host,
  );
}

/** @type {Handler} */
function templateCreate(args, { root, cwd, io }) {
  const flags = parseArgs(args, { name: { required: true }, owner: { required: true }, dest: { required: true } });
  return owningCreation(io, (host, cancel) => {
    const inputs = require("./render.cjs").defaultInputs();
    return require("./create.cjs").createLocal({
      host,
      io,
      isCancelled: cancel.isCancelled,
      inputs,
      answers: { name: flags.name, owner: flags.owner },
      dest: nodePath.resolve(cwd, flags.dest),
      source: () => require("./create.cjs").generatorSource({ git: host.git, root, manifest: inputs.manifest }),
    });
  });
}

/**
 * The initialization of a GitHub copy, run by its workflow from the root of the copy.
 * @param {readonly string[]} args
 * @param {{ root: string, io: Io }} context
 * @returns {Promise<number>}
 */
function templateInitialize(args, { root, io }) {
  const flags = parseArgs(args, { name: { required: true }, owner: { required: true }, description: {} });
  return owningCreation(io, (host, cancel) =>
    require("./initialize.cjs").initializeCopy({
      host,
      io,
      isCancelled: cancel.isCancelled,
      root,
      inputs: require("./render.cjs").defaultInputs(),
      answers: { name: flags.name, owner: flags.owner, ...(flags.description === undefined ? {} : { description: flags.description }) },
    }),
  );
}

/**
 * The entry of `node scripts/template/initialize.cjs`.
 * @param {readonly string[]} argv
 * @param {{ stdout: { write: (text: string) => unknown }, stderr: { write: (text: string) => unknown }, exitCode?: number | string | null | undefined }} proc
 * @returns {Promise<void>}
 */
async function initializeMain(argv, proc) {
  const io = { stdout: (/** @type {string} */ text) => proc.stdout.write(text), stderr: (/** @type {string} */ text) => proc.stderr.write(text) };
  try {
    proc.exitCode = await templateInitialize(argv, { root: nodePath.resolve(__dirname, "..", ".."), io });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    proc.exitCode = 2;
  }
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
 *   keepReports?: (dir: string) => void,
 * }} RenderedHost the generator has no Next.js application of its own: its production proofs render one, install it from its frozen lock and run the application's own command there; `keepReports` is asked, before the fixture is removed, to keep what a failed command left as evidence
 */

/**
 * The browser reports of a failed run (traces and screenshots) are written below the application's
 * `test-results`. Only that directory is copied to the generator's ignored `test-results`,
 * replacing what an earlier failure left there; installed dependencies and the fixture are not kept.
 * @param {string} appDir
 * @param {string} root the generator checkout
 * @returns {void}
 */
function keepReports(appDir, root) {
  const from = nodePath.join(appDir, "test-results");
  if (!fs.existsSync(from)) return;
  const to = nodePath.join(root, "test-results");
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

/**
 * Both tools run as groups of their own that this process stops when it is interrupted. The
 * application's command is given longer than the groups it must itself stop first, so it finishes
 * its own cleanup before it is forced.
 * @param {import("../testing/owned.cjs").Cancellation} cancel
 * @param {string} [root] the generator checkout that keeps the reports of a failed run
 * @returns {RenderedHost & { terminate: () => Promise<string[]> }}
 */
function realRenderedHost(cancel, root = process.cwd()) {
  const tools = harness.realHost(cancel);
  return {
    ...tools,
    scratch: () => tools.scratch("rendered-app-"),
    render: (dest) => {
      const render = require("./render.cjs");
      const { manifest, bases } = render.defaultInputs();
      render.writeTree(render.renderTree({ manifest, bases, answers: { name: "rendered-app", owner: "template-check" } }).files, dest);
    },
    keepReports: (dir) => {
      keepReports(dir, root);
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
    const status = (await host.command(dest, command)) ?? 1;
    if (status !== 0 && host.keepReports !== undefined) {
      try {
        host.keepReports(dest);
      } catch (error) {
        io.stderr(`the failure reports could not be kept: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    return status;
  } finally {
    host.remove(scratch);
  }
}

/**
 * This process owns the interrupts of the whole chain: it stops the install or the application's
 * command, which in turn stops its own servers and browsers, and returns only when its scratch is gone.
 * @param {string} command
 * @param {string} root the generator checkout
 * @returns {Promise<number>}
 */
function proofInRenderedApp(command, root) {
  const cancel = createCancellation();
  const host = realRenderedHost(cancel, root);
  return harness.execute(({ io }) => inRenderedApp(command, io, host, cancel), process, cancel, host);
}

/** @type {Handler} */
function testE2e(args, { root }) {
  parseArgs(args, {});
  return proofInRenderedApp("test:e2e", root);
}

/** @type {Handler} */
function testArtifact(args, { root }) {
  parseArgs(args, {});
  return proofInRenderedApp("test:artifact", root);
}

module.exports = {
  inRenderedApp,
  initializeMain,
  keepReports,
  realCreateHost,
  realRenderedHost,
  seedRefresh,
  templateCreate,
  templateInitialize,
  testArtifact,
  testE2e,
};
