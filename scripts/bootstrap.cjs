// @ts-check
"use strict";
// Dependency-free setup, repair and lock reconciliation. Works without node_modules and never
// downloads a tool: exact Node and pnpm are verified, not fetched.
const { existsSync, readFileSync } = require("node:fs");
const nodePath = require("node:path");
const { UsageError, parseArgs } = require("./core/args.cjs");
const { buildPermissions, manifestViolations, npmrcViolations, workspaceViolations } = require("./core/dependency-policy.cjs");
const { capabilities, clearDirty, dirtyKind, dirtyReason, guardCheck, recoveryCommand, removeInstallState } = require("./core/install-state.cjs");
const { parseObject } = require("./core/json.cjs");
const { redact, run, runLogged } = require("./core/process.cjs");
const { installPlugins, realHost: realPluginHost } = require("./core/plugins.cjs");
const { preflightErrors } = require("./core/toolchain.cjs");
const { isProtectedFile, isShadowOverride } = require("./core/protected.cjs");
const { checkLock, runTransaction } = require("./core/transaction.cjs");

/**
 * @typedef {{ stdout: (text: string) => unknown, stderr: (text: string) => unknown }} Io
 * @typedef {{
 *   preflightErrors: (root: string) => string[],
 *   dirtyReason: (root: string) => string | null,
 *   dirtyKind: (root: string) => string | null,
 *   recoveryCommand: (root: string) => string,
 *   guardCheck: typeof guardCheck,
 *   hooksRegistered: (root: string) => boolean,
 *   installHooks: (root: string, io: Io) => void,
 *   installPlugins: (root: string, io: Io) => void | Promise<void>,
 *   guardActive: (root: string) => boolean,
 *   bindNode: (root: string) => void,
 *   guardDrift: (root: string) => string[],
 *   acceptGuard: (root: string, io: Io) => number,
 *   checkLock: (root: string) => { ok: boolean, output: string },
 *   removeInstallState: (root: string) => void,
 *   clearDirty: (root: string) => void,
 *   transact: (options: { root: string, steps: string[][], plan: import("./core/transaction.cjs").Plan, kind?: string | undefined }) => import("./core/transaction.cjs").TransactionResult,
 *   run: (command: string, args: readonly string[], options: { cwd: string }) => { status: number | null, stdout: string },
 *   readFile: (path: string, encoding: "utf8") => string,
 *   exists: (path: string) => boolean,
 * }} Host what the commands need from the machine: the installed tools, the project files, Git and the package manager
 */

/** @type {Host} */
const HOST = {
  preflightErrors,
  dirtyReason,
  dirtyKind,
  recoveryCommand,
  guardCheck,
  hooksRegistered: (root) => capabilities(root).hooks,
  installHooks: (root, io) => {
    /** @type {unknown} */
    const loaded = require(nodePath.join(root, "scripts", "hooks", "install.cjs"));
    const { notice } = /** @type {{ install: (options: { root: string }) => { notice: string[] } }} */ (loaded).install({ root });
    for (const line of notice) io.stderr(`warning: ${line}\n`);
  },
  installPlugins: (root, io) => installPlugins(root, io, realPluginHost()),
  guardActive: (root) => capabilities(root).guard,
  bindNode: (root) => {
    /** @type {unknown} */
    const loaded = require(nodePath.join(root, "scripts", "hooks", "state.cjs"));
    /** @type {{ bindNode: (root: string, candidate: string) => string }} */ (loaded).bindNode(root, process.execPath);
  },
  guardDrift: (root) => {
    /** @type {unknown} */
    const loaded = require(nodePath.join(root, "scripts", "hooks", "guard.cjs"));
    return /** @type {{ approvedDrift: (root: string) => string[] }} */ (loaded).approvedDrift(root);
  },
  // The launcher clears the NODE_* environment and starts the machine-bound Node, so acceptance
  // never runs in this process or under a project-resolved interpreter.
  acceptGuard: (root, io) =>
    runLogged("sh", [nodePath.join(root, "scripts", "hooks", "launch.sh"), "--client", "claude", "--event", "accept"], { cwd: root, ...io }).status ?? 1,
  checkLock,
  removeInstallState,
  clearDirty,
  transact: runTransaction,
  run,
  readFile: readFileSync,
  exists: existsSync,
};

/** @param {Host} host @param {string} root @param {string[][]} steps @param {import("./core/transaction.cjs").Plan} plan @param {Io} io @param {string} [kind] */
function transact(host, root, steps, plan, io, kind) {
  const result = host.transact({ root, steps, plan, kind });
  io.stdout(redact(result.output));
  if (!result.ok) {
    io.stderr(
      `install failed or was rejected; protected files were restored and the install is marked incomplete (recover with: ${host.recoveryCommand(root)}).\n${result.violations.map((line) => `- ${line}\n`).join("")}`,
    );
  }
  return result.ok;
}

/** @param {string} root @param {Io} io @param {Host} host @returns {number | Promise<number>} */
function setup(root, io, host) {
  const errors = host.preflightErrors(root);
  if (errors.length > 0) return fail(io, errors);
  const dirty = host.dirtyReason(root);
  if (dirty) return fail(io, [`An incomplete install was left behind (${dirty}). Run: ${host.recoveryCommand(root)}`]);
  if (!transact(host, root, [["install", "--frozen-lockfile"]], { action: "none" }, io)) return 1;
  if (host.guardActive(root)) {
    try {
      host.bindNode(root);
    } catch (error) {
      return fail(io, [`The guard could not bind the Node binary: ${/** @type {Error} */ (error).message}`]);
    }
    io.stdout("Node binary bound for the protected-files guard.\n");
  }
  if (host.hooksRegistered(root)) {
    try {
      host.installHooks(root, io);
    } catch (error) {
      return fail(io, [`Git hooks were not installed: ${/** @type {Error} */ (error).message}`]);
    }
    io.stdout("Git hooks installed.\n");
    // The plugin step is asynchronous so that an interrupting signal is handled while it runs.
    return Promise.resolve()
      .then(() => host.installPlugins(root, io))
      .catch((/** @type {unknown} */ error) => {
        io.stderr(`warning: the agent plugins were not installed: ${error instanceof Error ? error.message : String(error)}\n`);
      })
      .then(() => 0);
  } else {
    io.stdout(
      "Dependencies installed from the frozen lock. Git hooks are not installed: hook registration is not activated for this project in tooling/capabilities.json.\n",
    );
  }
  return 0;
}

/** @param {string} root @param {Io} io @param {Host} host @returns {number} */
function repair(root, io, host) {
  const errors = host.preflightErrors(root);
  if (errors.length > 0) return fail(io, errors);
  const lock = host.checkLock(root);
  if (!lock.ok) {
    const retry =
      host.dirtyKind(root) === "deps-lock" ? " A relock was interrupted: run node scripts/bootstrap.cjs deps-lock again once the failure is fixed." : "";
    return fail(io, [
      `pnpm-lock.yaml does not match package.json; repair only reinstalls from the lock and never regenerates manifests or locks. Nothing was removed.${retry}`,
      redact(lock.output),
    ]);
  }
  host.removeInstallState(root);
  if (!transact(host, root, [["install", "--frozen-lockfile"]], { action: "none" }, io)) return 1;
  host.clearDirty(root);
  io.stdout("Project-local install state rebuilt from the frozen lock. The global store was not touched.\n");
  return 0;
}

/**
 * The protected paths a `git status --porcelain=v1 -z` listing reports as differing from the
 * committed baseline. package.json and the lock are the two files a relock may change.
 * @param {string} porcelain
 * @returns {string[]}
 */
function differingProtected(porcelain) {
  return porcelain
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
    .filter((path) => path !== "package.json" && path !== "pnpm-lock.yaml" && (isProtectedFile(path) || isShadowOverride(path)));
}

/**
 * The protected paths that differ from the guard's approved baseline. The lock is the relock's own
 * output, so it is not judged; everything else, the manifest included, must already be approved.
 * @param {string[]} drift what the guard reports as differing from its baseline
 * @returns {string[]}
 */
function differingApproved(drift) {
  return drift.filter((entry) => entry !== "pnpm-lock.yaml" && entry !== "pnpm-lock.yaml (staged)");
}

/**
 * What puts the manifest or the workspace outside the dependency-only boundary of an approved relock.
 * @param {{ head: string, manifest: string, workspace: string, npmrc: string | null }} files the committed manifest and the working copies
 * @returns {string[]}
 */
function boundaryProblems({ head, manifest, workspace, npmrc }) {
  const problems = [...workspaceViolations(workspace, { reviewedBuilds: buildPermissions(workspace) })];
  if (npmrc !== null) problems.push(...npmrcViolations(npmrc));
  try {
    problems.push(...manifestViolations(parseObject(head), parseObject(manifest), { action: "approved-edit" }));
  } catch (error) {
    problems.push(`package.json is not valid JSON: ${/** @type {Error} */ (error).message}`);
  }
  return problems;
}

/**
 * Relocks after an independently approved manifest edit. The approved baseline is the committed
 * HEAD: protected files may not differ from it, and package.json may differ only in its
 * dependency maps. A resolved, guard-accepted template merge uses its accepted manifest instead;
 * approval itself is never granted here.
 * @param {string} root @param {Io} io @param {Host} host @returns {number}
 */
function depsLock(root, io, host) {
  const errors = host.preflightErrors(root);
  if (errors.length > 0) return fail(io, errors);
  const guard = host.guardCheck(root, "deps-lock");
  if (guard.refusal) return fail(io, [guard.refusal]);
  const dirty = host.dirtyReason(root);
  if (dirty && host.dirtyKind(root) !== "deps-lock") return fail(io, [`An incomplete install was left behind (${dirty}). Run: ${host.recoveryCommand(root)}`]);
  const head = git(host, root, ["show", "HEAD:package.json"]);
  if (head.status !== 0) return fail(io, ["deps-lock needs a committed baseline (HEAD:package.json); commit the approved state first."]);
  if (host.guardActive(root)) {
    /** @type {string[]} */
    let differing;
    try {
      differing = differingApproved(host.guardDrift(root));
    } catch (error) {
      return fail(io, [`The guard baseline could not be compared (${/** @type {Error} */ (error).message}); deps-lock approves nothing.`]);
    }
    if (differing.length > 0) return fail(io, ["Protected files differ from the guard's approved baseline; deps-lock does not approve them:", ...differing]);
  } else {
    const status = git(host, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const differing = differingProtected(status.stdout);
    if (status.status !== 0 || differing.length > 0) {
      return fail(io, [
        "Protected files differ from the committed baseline; deps-lock does not approve them:",
        ...(status.status === 0 ? differing : ["git status failed"]),
      ]);
    }
  }
  const npmrc = nodePath.join(root, ".npmrc");
  const problems = boundaryProblems({
    head: guard.approvedManifest ?? head.stdout,
    manifest: host.readFile(nodePath.join(root, "package.json"), "utf8"),
    workspace: host.readFile(nodePath.join(root, "pnpm-workspace.yaml"), "utf8"),
    npmrc: host.exists(npmrc) ? host.readFile(npmrc, "utf8") : null,
  });
  if (problems.length > 0) return fail(io, ["The manifest or workspace is outside the dependency-only boundary:", ...problems.map((line) => `- ${line}`)]);
  const steps = [
    ["install", "--lockfile-only", "--no-frozen-lockfile"],
    ["install", "--frozen-lockfile"],
  ];
  if (!transact(host, root, steps, { action: "none" }, io, "deps-lock")) return 1;
  io.stdout("Lock regenerated from the approved manifest and installed frozen.\n");
  return 0;
}

/** @param {Host} host @param {string} root @param {string[]} args @returns {{ status: number | null, stdout: string }} the answer of git in the project */
function git(host, root, args) {
  return host.run("git", args, { cwd: root });
}

/** @param {Io} io @param {string[]} lines */
function fail(io, lines) {
  io.stderr(`${lines.join("\n")}\n`);
  return 1;
}

/**
 * @param {readonly string[]} argv
 * @param {{ root?: string, io?: Io, host?: Host }} [options]
 * @returns {number | Promise<number>} the exit status; a promise only while the optional plugin step runs
 */
function main(argv, options = {}) {
  const root = options.root ?? nodePath.resolve(__dirname, "..");
  const io = options.io ?? { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
  const host = options.host ?? HOST;
  const [command, ...args] = argv;
  try {
    parseArgs(args, {});
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${command ?? "bootstrap"} takes no arguments\n`);
    return 2;
  }
  if (command === "setup") return setup(root, io, host);
  if (command === "repair") return repair(root, io, host);
  if (command === "deps-lock") return depsLock(root, io, host);
  if (command === "guard-accept") {
    if (!host.guardActive(root)) return fail(io, ["The protected-files guard is not active in this project. Nothing was accepted."]);
    return host.acceptGuard(root, io);
  }
  io.stderr("usage: node scripts/bootstrap.cjs setup | repair | guard-accept | deps-lock\n");
  return 2;
}

module.exports = { boundaryProblems, differingApproved, differingProtected, main };

if (require.main === module) {
  void Promise.resolve(main(process.argv.slice(2))).then((status) => {
    process.exitCode = status;
  });
}
