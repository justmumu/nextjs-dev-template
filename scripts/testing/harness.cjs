// @ts-check
"use strict";
// What the production browser and standalone harnesses share: a disposable fixture that is staged,
// installed from the frozen lock and built once, tools that stay owned by the run, and cleanup that
// happens whether the run passed, failed or was interrupted.
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const nodePath = require("node:path");
const { stage: realStage } = require("./stage.cjs");
const { cleanEnv } = require("./environment.cjs");
const { isolation: realIsolation } = require("./network.cjs");
const { fixtureFiles } = require("./fixtures.cjs");
const { attemptAll, createCancellation, interruptedStatus, realHost: realProcesses, supervise } = require("./owned.cjs");
const { managedAgentBlockErrors } = require("../core/quality.cjs");
const { readRole } = require("../core/toolchain.cjs");

/**
 * @typedef {{ stdout: (text: string) => unknown, stderr: (text: string) => unknown }} Io
 * @typedef {import("./network.cjs").Isolation} Isolation
 * @typedef {import("./owned.cjs").Cancellation} Cancellation
 * @typedef {{
 *   run: (command: string, args: readonly string[], options: { cwd: string, env: NodeJS.ProcessEnv, graceMs?: number }) => Promise<number | null>,
 *   isolation: () => Isolation,
 *   scratch: (prefix: string) => string,
 *   stage: (options: Parameters<typeof realStage>[0]) => void,
 *   remove: (dir: string) => void,
 * }} Host the tools a run starts, the network isolation it can prove, and its scratch space
 */

/** @param {string} prefix @returns {string} a new scratch directory below the system's temporary directory, with symbolic links resolved */
function scratchDirectory(prefix) {
  return fs.realpathSync(fs.mkdtempSync(nodePath.join(tmpdir(), prefix)));
}

/** @param {string} dir */
function removeDirectory(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * @param {Cancellation} [cancel] a run that is cancelled starts no further tool
 * @returns {Host & { terminate: () => Promise<string[]> }}
 */
function realHost(cancel = createCancellation()) {
  const processes = realProcesses();
  /** @type {Set<ReturnType<typeof supervise>>} */
  const running = new Set();
  return {
    // Each tool leads a process group of its own, so what it starts can be stopped with it.
    run: async (command, args, options) => {
      if (cancel.isCancelled()) return null;
      const tool = supervise(processes.start(command, args, { cwd: options.cwd, env: options.env, inherit: true }), processes, options.graceMs);
      running.add(tool);
      const { code, signal } = await tool.done;
      running.delete(tool);
      // A command that could not be started never ran and says why through its output.
      if (code === null && signal === null && tool.log() !== "") process.stderr.write(`${command}: ${tool.log()}\n`);
      return code;
    },
    isolation: realIsolation,
    scratch: scratchDirectory,
    stage: realStage,
    remove: removeDirectory,
    // Asks every running tool's group to stop, then forces it after the grace period; reports what could not be stopped.
    terminate: () => attemptAll([...running].map((tool) => () => tool.stop())),
  };
}

/**
 * @typedef {{
 *   on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown,
 *   off?: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown,
 *   stdout: { write: (text: string) => unknown },
 *   stderr: { write: (text: string) => unknown },
 *   exitCode?: number | string | null | undefined,
 * }} Process the process a harness runs as
 */

/**
 * Runs a harness as the owner of this process's interrupts. An interrupt cancels the run: nothing
 * further is started, every tool and server it owns is stopped and the harness unwinds its own
 * cleanup before the status is returned, which is never zero for an interrupted run. A repeated
 * signal changes nothing: the cleanup is already bounded. The interrupt listeners are removed when
 * the run is over.
 * @template {{ terminate: () => Promise<string[]> }} H
 * @param {(context: { io: Io, host: H, cancel: Cancellation }) => Promise<number>} run
 * @param {Process} [proc]
 * @param {Cancellation} [cancel]
 * @param {H} [host]
 * @returns {Promise<number>}
 */
async function execute(run, proc = process, cancel = createCancellation(), host = /** @type {H} */ (/** @type {unknown} */ (realHost(cancel)))) {
  const io = { stdout: (/** @type {string} */ text) => proc.stdout.write(text), stderr: (/** @type {string} */ text) => proc.stderr.write(text) };
  /** @type {Promise<string[]>} */
  let terminated = Promise.resolve([]);
  /** @param {"SIGINT" | "SIGTERM"} signal */
  const interrupt = (signal) => {
    if (cancel.isCancelled()) return;
    cancel.cancel(signal);
    terminated = host.terminate();
  };
  const onInt = () => {
    interrupt("SIGINT");
  };
  const onTerm = () => {
    interrupt("SIGTERM");
  };
  proc.on("SIGINT", onInt);
  proc.on("SIGTERM", onTerm);
  try {
    const status = await run({ io, host, cancel });
    for (const failure of await terminated) io.stderr(`could not stop a tool: ${failure}\n`);
    return cancel.isCancelled() ? interruptedStatus(cancel.signal) : status;
  } catch (/** @type {unknown} */ error) {
    await terminated;
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return cancel.isCancelled() ? interruptedStatus(cancel.signal) : 1;
  } finally {
    proc.off?.("SIGINT", onInt);
    proc.off?.("SIGTERM", onTerm);
  }
}

/**
 * Runs a harness as the process's main program: its status becomes the exit status.
 * @param {(context: { io: Io, host: Host & { terminate: () => Promise<string[]> }, cancel: Cancellation }) => Promise<number>} run
 * @param {Process} [proc]
 * @param {Cancellation} [cancel]
 * @param {Host & { terminate: () => Promise<string[]> }} [host]
 * @returns {Promise<void>}
 */
async function main(run, proc = process, cancel = createCancellation(), host = realHost(cancel)) {
  proc.exitCode = await execute(run, proc, cancel, host);
}

/**
 * The checks every harness makes before it stages anything.
 * @param {string} root @returns {string[]} what keeps the harness from running here
 */
function preconditions(root) {
  if (readRole(root) !== "application") return ["the production harness runs in an application; a generator renders one first"];
  return managedAgentBlockErrors(root);
}

const NEXT = nodePath.join("node_modules", "next", "dist", "bin", "next");

/**
 * What a run without proved offline isolation says: the required proofs do not pass on it, and an
 * ordinary build still works there.
 * @param {string} reason @returns {string}
 */
function offlineUnavailable(reason) {
  return [
    `offline build proof unavailable: ${reason}`,
    "test:e2e and test:artifact require a build without outbound network and do not pass without that proof.",
    "They need Linux with unprivileged user and network namespaces: unshare (util-linux) and ip (iproute2) installed, and namespace creation permitted for the user.",
    "`pnpm run build` is not affected by this limit.",
    "",
  ].join("\n");
}

/**
 * Stages a fixture from the application, installs it from the frozen lock without the network (the
 * store is warm after the application's own install) and builds it once without outbound network.
 * Where that isolation cannot be proved nothing is staged or built: the run fails with what the
 * platform lacks, and is never reported as an offline proof.
 * @param {{ root: string, dir: string, io: Io, host: Host, kind: "production" | "artifact", buildEnv: Record<string, string>, transform?: Record<string, (text: string) => string>, cancel?: Cancellation }} options
 * @returns {Promise<boolean>} whether the fixture was built offline; false when a step failed or the run was interrupted (already reported); `dir` is the caller's to remove
 */
async function prepareFixture({ root, dir, io, host, kind, buildEnv, transform, cancel = createCancellation() }) {
  const isolated = host.isolation();
  if (!isolated.available) {
    io.stderr(offlineUnavailable(isolated.reason));
    return false;
  }
  if (cancel.isCancelled()) return false;
  host.stage({ source: root, dest: dir, files: fixtureFiles(kind), ...(transform ? { transform } : {}) });
  const env = cleanEnv(process.env);
  io.stdout(`fixture: staged ${dir}\n`);
  const install = await host.run("pnpm", ["install", "--frozen-lockfile", "--offline"], { cwd: dir, env });
  if (cancel.isCancelled()) return false;
  if (install !== 0) {
    io.stderr("fixture: the frozen offline install failed; run `pnpm install` in the project once so the package store is warm, then retry\n");
    return false;
  }
  io.stdout("build: no outbound network (loopback only), proved by a probe in the same kind of namespace\n");
  const next = isolated.wrap(process.execPath, [nodePath.join(dir, NEXT), "build"]);
  const build = await host.run(next.command, next.args, { cwd: dir, env: cleanEnv(process.env, buildEnv) });
  if (cancel.isCancelled()) return false;
  if (build !== 0) {
    io.stderr("build: the production build failed\n");
    return false;
  }
  return true;
}

module.exports = { NEXT, execute, main, offlineUnavailable, prepareFixture, preconditions, realHost, removeDirectory, scratchDirectory };
