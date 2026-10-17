// @ts-check
"use strict";
const { spawn, spawnSync } = require("node:child_process");

/**
 * Registry credentials never reach a log: auth keys, passwords and URL userinfo are masked.
 * @param {string} text
 * @returns {string}
 */
function redact(text) {
  return text
    .replace(/((?:_authToken|_auth|_password|:_authToken|:_auth|:_password)\s*=\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/(\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@");
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} options
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function run(command, args, options) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
  // A process that could not be spawned has null output streams although the types promise strings.
  const { error, status, stdout, stderr } = /** @type {import("node:child_process").SpawnSyncReturns<string | null>} */ (result);
  return { status, stdout: stdout ?? "", stderr: stderr ?? error?.message ?? "" };
}

/**
 * A command attached to the terminal: its output is not captured, so a server or a long run is seen
 * as it happens.
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} options
 * @returns {{ status: number | null }}
 */
function runInherited(command, args, options) {
  const { status } = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: "inherit" });
  return { status };
}

/**
 * Same as run, but asynchronous, so the process can receive signals while the command runs, and
 * stoppable: aborting the signal terminates the command, and the answer is its final result.
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal }} options
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
function runStoppable(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    child.stdout.setEncoding("utf8").on("data", (/** @type {string} */ text) => out.push(text));
    child.stderr.setEncoding("utf8").on("data", (/** @type {string} */ text) => err.push(text));
    // A command that could not be started answers at once; an aborted one answers when it has really ended.
    child.on("error", (error) => {
      err.push(error.message);
      if (child.pid === undefined) resolve({ status: null, stdout: "", stderr: error.message });
    });
    child.on("close", (status) => {
      resolve({ status, stdout: out.join(""), stderr: err.join("") });
    });
  });
}

/**
 * Same as run, but output is passed through redaction to the given writers.
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, stdout: (text: string) => unknown, stderr: (text: string) => unknown }} options
 * @param {typeof run} [start] how the command is started
 */
function runLogged(command, args, options, start = run) {
  const result = start(command, args, options);
  if (result.stdout) options.stdout(redact(result.stdout));
  if (result.stderr) options.stderr(redact(result.stderr));
  return result;
}

/** The process's own output streams, for commands that run as a program. */
const stdio = { stdout: (/** @type {string} */ text) => process.stdout.write(text), stderr: (/** @type {string} */ text) => process.stderr.write(text) };

module.exports = { redact, run, runInherited, runLogged, runStoppable, stdio };
