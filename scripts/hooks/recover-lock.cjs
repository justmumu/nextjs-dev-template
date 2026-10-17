// @ts-check
"use strict";
// Offline recovery of the guard's state mutex, run by a person in a terminal while every session of
// this worktree is stopped. The mutex is never reclaimed by age and an agent cannot run this file. What
// it removes is the lock and the half-written state files an interrupted run left; the approved
// baseline, its blobs and the reservations of calls that have not finished are never edited, accepted
// or deleted. Everything it moves is kept in the journal for the person to read.
const fs = require("node:fs");
const nodePath = require("node:path");
const nodeVm = require("node:vm");

/**
 * Started directly, Node's resolver would read the nearest package.json for every local require and a
 * malformed manifest would stop recovery before its refusal. A direct start therefore loads the
 * guard's own .cjs files through the launcher's loader, which reads them itself.
 * @returns {(request: string) => unknown}
 */
function localLoader() {
  if (require.main !== module) return require;
  /** @param {string} file */
  const read = (file) => fs.readFileSync(file, "utf8");
  /** @param {string} name @returns {unknown} */
  const only = (name) => {
    if (!name.startsWith("node:")) throw new Error(`recovery starts with node: modules only, not ${name}`);
    return require(name);
  };
  const file = nodePath.join(__dirname, "entry.cjs");
  const entry = { exports: /** @type {typeof import("./entry.cjs")} */ ({ createLoader: () => () => undefined }) };
  const run = /** @type {(...args: unknown[]) => unknown} */ (
    nodeVm.compileFunction(read(file), ["exports", "require", "module", "__filename", "__dirname"], { filename: file })
  );
  run(entry.exports, only, entry, file, __dirname);
  const load = entry.exports.createLoader({ scripts: nodePath.resolve(__dirname, ".."), readFile: read, builtin: only });
  return (request) => load(nodePath.resolve(__dirname, request));
}
const local = localLoader();
const { JOURNAL_NAME, LOCK_NAME, STATE_NAME, journal, readJournal, readLock } = /** @type {typeof import("./mutex.cjs")} */ (local("./mutex.cjs"));
const { STATE_DIR_NAME, locateGit, readState } = /** @type {typeof import("./state.cjs")} */ (local("./state.cjs"));

const TEMPORARY = new RegExp(`^${STATE_NAME.replace(".", "\\.")}\\..+\\.tmp$`);
const CONFIRMATION = "recover";

/**
 * @typedef {{
 *   lock: { text: string, token: string | null, pid: number | null, at: string | null } | null,
 *   temporaries: string[],
 *   baseline: { status: "missing" } | { status: "readable", pending: number } | { status: "unreadable", reason: string },
 *   journalEntries: number,
 * }} Report what an interrupted run left in the state directory
 */

/**
 * Reads what is in the state directory without changing it.
 * @param {string} dir @param {typeof fs} [disk]
 * @returns {Report}
 */
function inspect(dir, disk = fs) {
  /** @type {string[]} */
  let names = [];
  try {
    names = disk.readdirSync(dir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
  /** @type {Report["baseline"]} */
  let baseline = { status: "missing" };
  try {
    const state = readState(dir, disk);
    if (state !== null) baseline = { status: "readable", pending: Object.keys(state.inflight).length };
  } catch (error) {
    baseline = { status: "unreadable", reason: /** @type {Error} */ (error).message };
  }
  return {
    lock: readLock(dir, disk),
    temporaries: names.filter((name) => TEMPORARY.test(name)).sort(),
    baseline,
    journalEntries: readJournal(dir, disk).length,
  };
}

/** @param {Report} report @returns {string} what the person is asked to confirm */
function describe(report) {
  const lines = [];
  if (report.lock) {
    const owner = [report.lock.pid === null ? null : `pid ${report.lock.pid}`, report.lock.at].filter(Boolean).join(", ");
    lines.push(`The state lock is held${owner ? ` (${owner})` : ""}.`);
  } else {
    lines.push("The state lock is not held.");
  }
  if (report.temporaries.length > 0) lines.push(`Half-written state files: ${report.temporaries.join(", ")}.`);
  if (report.baseline.status === "readable")
    lines.push(`The approved baseline is readable; ${report.baseline.pending} call(s) are still reserved and stay reserved.`);
  else if (report.baseline.status === "missing") lines.push("There is no approved baseline yet.");
  else lines.push(`The approved baseline cannot be read (${report.baseline.reason}); it is left as it is for you to inspect.`);
  return lines.join("\n");
}

/**
 * Moves the abandoned lock and the half-written state files into the journal, if nothing changed since
 * they were inspected. Nothing is deleted and the baseline is not touched.
 * @param {string} dir @param {Report} inspected @param {typeof fs} [disk]
 * @returns {{ recovered: boolean, message: string }}
 */
function recover(dir, inspected, disk = fs) {
  const now = inspect(dir, disk);
  if (now.lock?.text !== inspected.lock?.text || now.temporaries.join("\n") !== inspected.temporaries.join("\n"))
    return { recovered: false, message: "The state directory changed while it was being inspected, so a session may be running. Nothing was changed." };
  if (now.lock === null && now.temporaries.length === 0)
    return { recovered: true, message: "Nothing to recover: no lock is held and no state file is half written." };
  const keep = nodePath.join(dir, JOURNAL_NAME, `recovered-${Date.now()}-${process.pid}`);
  disk.mkdirSync(keep, { recursive: true, mode: 0o700 });
  if (now.lock) disk.renameSync(nodePath.join(dir, LOCK_NAME), nodePath.join(keep, LOCK_NAME));
  for (const name of now.temporaries) disk.renameSync(nodePath.join(dir, name), nodePath.join(keep, name));
  journal(
    dir,
    "offline-recovery",
    {
      lock: now.lock ? now.lock.text.slice(0, 300) : null,
      temporaries: now.temporaries.join(","),
      baseline: now.baseline.status,
      pending: now.baseline.status === "readable" ? now.baseline.pending : null,
      kept: nodePath.basename(keep),
    },
    disk,
  );
  return { recovered: true, message: `Recovered. What was removed is kept in ${keep}.\n${describe(inspect(dir, disk))}` };
}

/**
 * @typedef {{
 *   cwd?: string, interactive?: boolean, stdout?: (text: string) => unknown, stderr?: (text: string) => unknown,
 *   readLine?: () => string, disk?: typeof fs, stateDir?: string,
 * }} Io `readLine`, `disk` and `stateDir` let a test answer from memory
 */

/** @returns {string} one line typed at the terminal */
function readTerminalLine() {
  const buffer = Buffer.alloc(1);
  let line = "";
  while (line.length < 256 && fs.readSync(0, buffer, 0, 1, null) === 1 && buffer[0] !== 10) line += String.fromCharCode(buffer[0] ?? 0);
  return line.trim();
}

/** @param {string[]} argv @param {Io} [io] @returns {number} the exit code */
function main(argv, io = {}) {
  const stdout = io.stdout ?? ((/** @type {string} */ text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((/** @type {string} */ text) => process.stderr.write(text));
  if (argv.length > 0) {
    stderr("usage: node scripts/hooks/recover-lock.cjs (no arguments; run it yourself in a terminal while every session is stopped)\n");
    return 2;
  }
  if (!(io.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) {
    stderr("Lock recovery is a human operation and needs an interactive terminal.\n");
    return 2;
  }
  try {
    const disk = io.disk ?? fs;
    const dir = io.stateDir ?? nodePath.join(locateGit(io.cwd ?? process.cwd()).gitDir, STATE_DIR_NAME);
    const inspected = inspect(dir, disk);
    stdout(`${describe(inspected)}\n`);
    if (inspected.lock === null && inspected.temporaries.length === 0) {
      stdout("Nothing to recover.\n");
      return 0;
    }
    stdout(`Stop every session that uses this worktree first. Type "${CONFIRMATION}" to continue: `);
    if ((io.readLine ?? readTerminalLine)() !== CONFIRMATION) {
      stdout("\nNothing was changed.\n");
      return 1;
    }
    const result = recover(dir, inspected, disk);
    stdout(`\n${result.message}\n`);
    return result.recovered ? 0 : 1;
  } catch (error) {
    stderr(`Lock recovery failed: ${/** @type {Error} */ (error).message}\n`);
    return 1;
  }
}

module.exports = { describe, inspect, main, recover };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
