// @ts-check
"use strict";
// Dependency-free setup, repair and lock reconciliation. Works without node_modules and never
// downloads a tool: exact Node and pnpm are verified, not fetched.
const { existsSync, readFileSync } = require("node:fs");
const nodePath = require("node:path");
const { UsageError, parseArgs } = require("./core/args.cjs");
const { buildPermissions, manifestViolations, npmrcViolations, workspaceViolations } = require("./core/dependency-policy.cjs");
const { capabilities, clearDirty, dirtyKind, dirtyReason, guardRefusal, recoveryCommand, removeInstallState } = require("./core/install-state.cjs");
const { parseObject } = require("./core/json.cjs");
const { redact, run } = require("./core/process.cjs");
const { preflightErrors } = require("./core/toolchain.cjs");
const { isProtectedFile, isShadowOverride } = require("./core/protected.cjs");
const { checkLock, runTransaction } = require("./core/transaction.cjs");

/** @typedef {{ stdout: (text: string) => unknown, stderr: (text: string) => unknown }} Io */

/** @param {string} root @param {string[][]} steps @param {import("./core/transaction.cjs").Plan} plan @param {Io} io @param {string} [kind] */
function transact(root, steps, plan, io, kind) {
  const result = runTransaction({ root, steps, plan, kind });
  io.stdout(redact(result.output));
  if (!result.ok) {
    io.stderr(
      `install failed or was rejected; protected files were restored and the install is marked incomplete (recover with: ${recoveryCommand(root)}).\n${result.violations.map((line) => `- ${line}\n`).join("")}`,
    );
  }
  return result.ok;
}

/** @param {string} root @param {Io} io @returns {number} */
function setup(root, io) {
  const errors = preflightErrors(root);
  if (errors.length > 0) return fail(io, errors);
  const dirty = dirtyReason(root);
  if (dirty) return fail(io, [`An incomplete install was left behind (${dirty}). Run: ${recoveryCommand(root)}`]);
  if (!transact(root, [["install", "--frozen-lockfile"]], { action: "none" }, io)) return 1;
  if (capabilities(root).hooks) {
    /** @type {unknown} */
    const loaded = require(nodePath.join(root, "scripts", "hooks", "install.cjs"));
    /** @type {{ install: (options: { root: string }) => void }} */ (loaded).install({ root });
    io.stdout("Git hooks installed.\n");
  } else {
    io.stdout("Dependencies installed from the frozen lock. Git hooks are not installed: the hook installer is not available yet.\n");
  }
  return 0;
}

/** @param {string} root @param {Io} io @returns {number} */
function repair(root, io) {
  const errors = preflightErrors(root);
  if (errors.length > 0) return fail(io, errors);
  const lock = checkLock(root);
  if (!lock.ok) {
    const retry = dirtyKind(root) === "deps-lock" ? " A relock was interrupted: run node scripts/bootstrap.cjs deps-lock again once the failure is fixed." : "";
    return fail(io, [
      `pnpm-lock.yaml does not match package.json; repair only reinstalls from the lock and never regenerates manifests or locks. Nothing was removed.${retry}`,
      redact(lock.output),
    ]);
  }
  removeInstallState(root);
  if (!transact(root, [["install", "--frozen-lockfile"]], { action: "none" }, io)) return 1;
  clearDirty(root);
  io.stdout("Project-local install state rebuilt from the frozen lock. The global store was not touched.\n");
  return 0;
}

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {{ status: number | null, stdout: string }}
 */
function git(root, args) {
  return run("git", args, { cwd: root });
}

/**
 * Relocks after an independently approved manifest edit. The approved baseline is the committed
 * HEAD: protected files may not differ from it, and package.json may differ only in its
 * dependency maps. Approval itself is never granted here.
 * @param {string} root @param {Io} io @returns {number}
 */
function depsLock(root, io) {
  const errors = preflightErrors(root);
  if (errors.length > 0) return fail(io, errors);
  const refusal = guardRefusal(root);
  if (refusal) return fail(io, [refusal]);
  // Only a relock that was itself interrupted may be retried; any other incomplete install is repaired first.
  const dirty = dirtyReason(root);
  if (dirty && dirtyKind(root) !== "deps-lock") return fail(io, [`An incomplete install was left behind (${dirty}). Run: ${recoveryCommand(root)}`]);
  const head = git(root, ["show", "HEAD:package.json"]);
  if (head.status !== 0) return fail(io, ["deps-lock needs a committed baseline (HEAD:package.json); commit the approved state first."]);
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const differing = status.stdout
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
    .filter((path) => path !== "package.json" && path !== "pnpm-lock.yaml" && (isProtectedFile(path) || isShadowOverride(path)));
  if (status.status !== 0 || differing.length > 0) {
    return fail(io, [
      "Protected files differ from the committed baseline; deps-lock does not approve them:",
      ...(status.status === 0 ? differing : ["git status failed"]),
    ]);
  }
  const problems = [];
  const workspace = readFileSync(nodePath.join(root, "pnpm-workspace.yaml"), "utf8");
  problems.push(...workspaceViolations(workspace, { reviewedBuilds: buildPermissions(workspace) }));
  if (existsSync(nodePath.join(root, ".npmrc"))) problems.push(...npmrcViolations(readFileSync(nodePath.join(root, ".npmrc"), "utf8")));
  try {
    problems.push(
      ...manifestViolations(parseObject(head.stdout), parseObject(readFileSync(nodePath.join(root, "package.json"), "utf8")), { action: "approved-edit" }),
    );
  } catch (error) {
    problems.push(`package.json is not valid JSON: ${/** @type {Error} */ (error).message}`);
  }
  if (problems.length > 0) return fail(io, ["The manifest or workspace is outside the dependency-only boundary:", ...problems.map((line) => `- ${line}`)]);
  if (
    !transact(
      root,
      [
        ["install", "--lockfile-only", "--no-frozen-lockfile"],
        ["install", "--frozen-lockfile"],
      ],
      { action: "none" },
      io,
      "deps-lock",
    )
  )
    return 1;
  io.stdout("Lock regenerated from the approved manifest and installed frozen.\n");
  return 0;
}

/** @param {Io} io @param {string[]} lines */
function fail(io, lines) {
  io.stderr(`${lines.join("\n")}\n`);
  return 1;
}

/**
 * @param {readonly string[]} argv
 * @param {{ root?: string, io?: Io }} [options]
 * @returns {number}
 */
function main(argv, options = {}) {
  const root = options.root ?? nodePath.resolve(__dirname, "..");
  const io = options.io ?? { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
  const [command, ...args] = argv;
  try {
    parseArgs(args, {});
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${command ?? "bootstrap"} takes no arguments\n`);
    return 2;
  }
  if (command === "setup") return setup(root, io);
  if (command === "repair") return repair(root, io);
  if (command === "deps-lock") return depsLock(root, io);
  if (command === "guard-accept") return fail(io, ["guard-accept is not available yet: U6 implements the protected-files guard. Nothing was accepted."]);
  io.stderr("usage: node scripts/bootstrap.cjs setup | repair | guard-accept | deps-lock\n");
  return 2;
}

module.exports = { main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
