// @ts-check
"use strict";
// Servers and tools started by the production harnesses. Every process is started as the leader of
// its own process group and is signalled only through that group: while its leader is still alive
// and once more when the leader's exit is observed, to sweep orphans it left in the group. This
// bounds the signalling to groups this run started; it does not claim an operating-system identity
// guarantee, so a group that outlives its leader and whose id is reused before the sweep is not
// distinguished. A run that is interrupted cancels through one shared state: nothing is started
// after it, and what runs is stopped.
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { setTimeout: sleep } = require("node:timers/promises");

const GRACE_MS = 5_000;
const POLL_MS = 100;
const LOG_LIMIT = 8_192;

class OwnedProcessError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "OwnedProcessError";
  }
}

/**
 * @typedef {{
 *   pid: number | undefined,
 *   onExit: (listener: (code: number | null, signal: string | null) => void) => void,
 *   onOutput: (listener: (text: string) => void) => void,
 * }} Child
 * @typedef {{
 *   start: (command: string, args: readonly string[], options: { cwd: string, env: NodeJS.ProcessEnv, inherit?: boolean }) => Child,
 *   signalGroup: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void,
 *   probe: (url: string) => Promise<string | null>,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 * }} Host how processes are started and signalled, and how readiness is observed
 */

/** @param {unknown} pgid @returns {pgid is number} a group identifier that may be signalled: a positive process id other than init's */
function signallable(pgid) {
  return typeof pgid === "number" && Number.isInteger(pgid) && pgid > 1;
}

/** @returns {Host} */
function realHost() {
  return {
    start: (command, args, options) => {
      // A tool that talks to the terminal inherits its output; it is still the leader of a group of its own.
      /** @type {import("node:child_process").StdioOptions} */
      const stdio = options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"];
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio });
      return {
        pid: child.pid,
        onExit: (listener) => {
          child.on("exit", listener);
          // A command that could not be started never emits `exit`.
          child.on("error", () => {
            if (child.pid === undefined) listener(null, null);
          });
        },
        onOutput: (listener) => {
          for (const stream of [child.stdout, child.stderr]) stream?.setEncoding("utf8").on("data", listener);
          child.on("error", (error) => {
            listener(error.message);
          });
        },
      };
    },
    signalGroup: (pgid, signal) => {
      if (!signallable(pgid)) throw new OwnedProcessError(`refusing to signal process group ${String(pgid)}`);
      try {
        process.kill(-pgid, signal);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") throw error;
      }
    },
    probe: async (url) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        return response.ok ? await response.text() : null;
      } catch {
        return null;
      }
    },
    sleep: (ms) => sleep(ms),
    now: Date.now,
  };
}

/** @returns {Promise<number>} a TCP port on the loopback interface that was free a moment ago */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null) resolve(address.port);
        else reject(new Error("no port was assigned"));
      });
    });
  });
}

/** @param {number | null} code @param {string | null} signal @returns {string} */
function describeExit(code, signal) {
  return signal === null ? `status ${String(code)}` : `signal ${signal}`;
}

/**
 * What an interrupted run shares with everything it owns: the first interrupt is remembered, every
 * party that registered is told once, and a party that asks later is told at once. It makes no
 * decision about processes; whoever listens stops its own.
 * @typedef {{
 *   isCancelled: () => boolean,
 *   readonly signal: string | null,
 *   cancel: (signal: string) => void,
 *   onCancel: (listener: () => void) => () => void,
 * }} Cancellation
 * @returns {Cancellation}
 */
function createCancellation() {
  /** @type {string | null} */
  let signal = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  return {
    isCancelled: () => signal !== null,
    get signal() {
      return signal;
    },
    cancel: (name) => {
      if (signal !== null) return;
      signal = name;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
    onCancel: (listener) => {
      if (signal !== null) {
        listener();
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** @param {string | null} signal @returns {number} the conventional exit status of a run ended by that signal: never zero */
function interruptedStatus(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

/**
 * Runs every operation even when an earlier one failed.
 * @param {readonly (() => unknown)[]} operations
 * @returns {Promise<string[]>} what each failed operation said
 */
async function attemptAll(operations) {
  /** @type {string[]} */
  const failures = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}

/**
 * Takes ownership of a started process: its output, how it ended, and a stop that ends its group.
 * The stop is asked politely first and forced after the grace period; asking again returns the
 * same stop. The leader's exit sweeps what it left in its group. A tool that owns groups of its own
 * (a nested harness) is given a longer grace than the groups it must itself stop first.
 * @param {Child} child
 * @param {Host} host
 * @param {number} [graceMs]
 */
function supervise(child, host, graceMs = GRACE_MS) {
  const pgid = child.pid;
  /** @type {{ exit: { code: number | null, signal: string | null } | null }} */
  const state = { exit: null };
  let log = "";
  /** @type {(exit: { code: number | null, signal: string | null }) => void} */
  let settle = () => undefined;
  /** @type {Promise<{ code: number | null, signal: string | null }>} */
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  child.onOutput((text) => {
    log = (log + text).slice(-LOG_LIMIT);
  });
  child.onExit((code, signal) => {
    state.exit = { code, signal };
    // The leader is gone: whatever it left behind in its group is an orphan of this run.
    try {
      if (signallable(pgid)) host.signalGroup(pgid, "SIGKILL");
    } finally {
      settle(state.exit);
    }
  });

  /** @param {number} ms @returns {Promise<boolean>} whether the leader exited within the time */
  const exited = async (ms) => {
    const deadline = host.now() + ms;
    while (state.exit === null && host.now() < deadline) await host.sleep(POLL_MS);
    return state.exit !== null;
  };
  /** @type {Promise<void> | null} */
  let stopping = null;
  const stopGroup = async () => {
    if (state.exit !== null || !signallable(pgid)) return;
    host.signalGroup(pgid, "SIGTERM");
    if (await exited(graceMs)) return;
    host.signalGroup(pgid, "SIGKILL");
    await exited(GRACE_MS);
  };
  return {
    pgid,
    state,
    done,
    log: () => log,
    exited,
    stop: () => (stopping ??= stopGroup()),
  };
}

/**
 * Starts a server and returns only when it answers `url` with exactly `expect`. The expected body is
 * a per-run nonce, so an unrelated server that already holds the port can never be taken for the
 * one that was started. On a failed start, a timeout, an interrupt or an early exit the whole
 * process group is stopped before the error is thrown; an interrupt after the start stops it too.
 * @param {{ command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, url: string, expect: string, timeoutMs: number, cancel?: Cancellation }} spec
 * @param {Host} [host]
 * @returns {Promise<{ pid: number, stop: () => Promise<void>, log: () => string }>}
 */
async function startOwned(spec, host = realHost()) {
  const { cancel } = spec;
  if (cancel?.isCancelled()) throw new OwnedProcessError(`${spec.command} was not started: the run was interrupted`);
  const server = supervise(host.start(spec.command, spec.args, { cwd: spec.cwd, env: spec.env }), host);
  const { pgid, state, stop } = server;
  // An interrupt ends the server wherever the run is; a failure to stop resurfaces from the owner's own stop.
  const release =
    cancel?.onCancel(() => {
      stop().catch(() => undefined);
    }) ?? (() => undefined);

  const deadline = host.now() + spec.timeoutMs;
  try {
    for (;;) {
      if (cancel?.isCancelled()) {
        await stop();
        throw new OwnedProcessError(`${spec.command} was stopped before it answered ${spec.url}: the run was interrupted`);
      }
      if (state.exit !== null) {
        const { code, signal } = state.exit;
        throw new OwnedProcessError(`${spec.command} exited (${describeExit(code, signal)}) before it answered ${spec.url}\n${server.log()}`);
      }
      if ((await host.probe(spec.url)) === spec.expect) {
        if (!signallable(pgid)) throw new OwnedProcessError(`${spec.command} has no process group`);
        return {
          pid: pgid,
          stop: async () => {
            release();
            await stop();
          },
          log: server.log,
        };
      }
      if (host.now() >= deadline) {
        await stop();
        throw new OwnedProcessError(`${spec.command} did not answer ${spec.url} within ${String(spec.timeoutMs)} ms\n${server.log()}`);
      }
      await host.sleep(POLL_MS);
    }
  } catch (error) {
    release();
    throw error;
  }
}

module.exports = { GRACE_MS, OwnedProcessError, attemptAll, createCancellation, freePort, interruptedStatus, realHost, signallable, startOwned, supervise };
