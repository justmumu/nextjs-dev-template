// @ts-check
"use strict";
const nodePath = require("node:path");
const { capabilities } = require("../core/install-state.cjs");
const { run, runLogged, stdio } = require("../core/process.cjs");
const { checkLock } = require("../core/transaction.cjs");
const development = require("../development.cjs");

const LOCK_FILES = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"]);
const TYPED = /\.[cm]?[jt]sx?$|(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/;

/**
 * @typedef {{ stdout: (text: string) => unknown, stderr: (text: string) => unknown }} Io
 * @typedef {{
 *   guardActive: () => boolean,
 *   guard: () => number,
 *   staged: () => string[] | null,
 *   lintStaged: () => number,
 *   lock: () => { ok: boolean, output: string },
 *   typecheck: () => number,
 * }} Host what the hook needs from the machine, one answer per step
 * @typedef {{
 *   capabilities: typeof capabilities,
 *   run: typeof run,
 *   runLogged: typeof runLogged,
 *   launch: (pkg: string, bin: string, args: string[]) => number,
 *   checkLock: typeof checkLock,
 *   dispatch: (argv: string[], options: { root: string, io: Io }) => number,
 * }} Machine the processes and project facts behind the host
 */

/** @param {string} root @param {Io} io @returns {Machine} the real processes and project facts */
const realMachine = (root, io) => ({
  capabilities,
  run,
  runLogged,
  launch: development.installedTools({ root, cwd: root, io }).launch,
  checkLock,
  dispatch: development.mainSync,
});

/** @param {string} root @param {Io} io @param {Machine} [machine] @returns {Host} */
function realHost(root, io, machine = realMachine(root, io)) {
  return {
    guardActive: () => machine.capabilities(root).guard,
    // The launcher starts the machine-bound Node; the hook never starts the guard through a Node it resolved itself.
    guard: () =>
      machine.runLogged("sh", [nodePath.join(root, "scripts", "hooks", "launch.sh"), "--client", "claude", "--event", "pre-commit"], { cwd: root, ...io })
        .status ?? 1,
    staged: () => {
      const result = machine.run("git", ["diff", "--cached", "--name-only", "-z"], { cwd: root });
      return result.status === 0 ? result.stdout.split("\0").filter((name) => name !== "") : null;
    },
    lintStaged: () => machine.launch("lint-staged", "lint-staged", ["--config", "tooling/hooks/staged.mjs", "--concurrent", "false"]),
    lock: () => machine.checkLock(root),
    typecheck: () => machine.dispatch(["typecheck"], { root, io }),
  };
}

/**
 * The guard's staged check, then the changed-file format and lint of lint-staged (which hides
 * unstaged hunks of partially staged files, restages what it fixes, and restores Git on failure),
 * then the whole-project checks the staged paths make relevant. Those run after lint-staged on the
 * working tree, so an unstaged edit elsewhere can affect them.
 * @param {Host} host @param {Io} io
 * @returns {number}
 */
function preCommit(host, io) {
  if (host.guardActive() && host.guard() !== 0) return 1;
  const staged = host.staged();
  if (staged === null) {
    io.stderr("pre-commit: the staged files could not be listed\n");
    return 1;
  }
  if (staged.length === 0) return 0;
  if (host.lintStaged() !== 0) return 1;
  if (staged.some((name) => LOCK_FILES.has(name))) {
    const lock = host.lock();
    if (!lock.ok) {
      io.stderr(`pre-commit: pnpm-lock.yaml does not match package.json\n${lock.output}`);
      return 1;
    }
  }
  if (staged.some((name) => TYPED.test(name)) && host.typecheck() !== 0) return 1;
  return 0;
}

/**
 * @param {readonly string[]} _argv
 * @param {{ root?: string, io?: Io, host?: Host }} [options]
 * @returns {number}
 */
function main(_argv, options = {}) {
  const root = options.root ?? nodePath.resolve(__dirname, "..", "..");
  const io = options.io ?? stdio;
  return preCommit(options.host ?? realHost(root, io), io);
}

module.exports = { main, preCommit, realHost, realMachine };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
