// @ts-check
"use strict";
// Shell-disabled subprocesses with literal argv arrays, and output redaction.
const { spawnSync } = require("node:child_process");

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

module.exports = { redact, run, runLogged };
