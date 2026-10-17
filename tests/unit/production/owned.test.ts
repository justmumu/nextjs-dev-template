import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

type Owned = typeof import("../../../scripts/testing/owned.cjs");
const owned = createRequire(import.meta.url)("../../../scripts/testing/owned.cjs") as Owned;
type Host = NonNullable<Parameters<Owned["startOwned"]>[1]>;

/** A scripted process table: time only moves when the code sleeps, and every signal is recorded. */
function world(options: { pid?: number | undefined; answers?: (string | null)[]; exitsOn?: "SIGTERM" | "SIGKILL" | "never"; exitAt?: number }) {
  const signals: string[] = [];
  let time = 0;
  let exited = false;
  let exitListener: (code: number | null, signal: string | null) => void = () => undefined;
  let outputListener: (text: string) => void = () => undefined;
  const probes: string[] = [];
  const answers = [...(options.answers ?? [])];
  const host: Host = {
    start: () => ({
      pid: "pid" in options ? options.pid : 4242,
      onExit: (listener) => {
        exitListener = listener;
      },
      onOutput: (listener) => {
        outputListener = listener;
      },
    }),
    signalGroup: (pgid, signal) => {
      signals.push(`${signal}:${String(pgid)}`);
      if (signal === options.exitsOn && !exited) {
        exited = true;
        exitListener(null, signal);
      }
    },
    probe: (url) => {
      probes.push(url);
      if (options.exitAt !== undefined && time >= options.exitAt && !exited) {
        exited = true;
        exitListener(1, null);
      }
      return Promise.resolve(answers.shift() ?? null);
    },
    sleep: (ms) => {
      time += ms;
      return Promise.resolve();
    },
    now: () => time,
  };
  return {
    host,
    signals,
    probes,
    output: (text: string) => {
      outputListener(text);
    },
    exit: (code: number) => {
      exited = true;
      exitListener(code, null);
    },
  };
}

const spec = { command: "node", args: ["server.js"], cwd: "/app", env: {}, url: "http://127.0.0.1:1/ready", expect: "nonce", timeoutMs: 1_000 };

describe("signallable group identifiers", () => {
  test.each([[undefined], [0], [1], [-5], [1.5], [Number.NaN], ["42"]])("%j is never signalled", (pgid) => {
    expect(owned.signallable(pgid)).toBe(false);
  });

  test("a positive process id other than init's is", () => {
    expect(owned.signallable(2)).toBe(true);
    expect(owned.signallable(31337)).toBe(true);
  });

  test("the real host refuses to signal an invalid group before it signals anything", () => {
    for (const pgid of [0, 1, -1, Number.NaN]) {
      expect(() => {
        owned.realHost().signalGroup(pgid, "SIGTERM");
      }).toThrow(/refusing to signal/);
    }
  });
});

describe("cancellation", () => {
  test("remembers the first interrupt only and tells each party once", () => {
    const cancel = owned.createCancellation();
    const told: string[] = [];
    const release = cancel.onCancel(() => told.push("a"));
    cancel.onCancel(() => told.push("b"));
    expect([cancel.isCancelled(), cancel.signal]).toEqual([false, null]);
    cancel.cancel("SIGTERM");
    cancel.cancel("SIGINT");
    release();
    expect([cancel.isCancelled(), cancel.signal, told]).toEqual([true, "SIGTERM", ["a", "b"]]);
  });

  test("a party that asks after the interrupt is told at once, and one that let go is not told", () => {
    const cancel = owned.createCancellation();
    const told: string[] = [];
    const released = cancel.onCancel(() => told.push("released"));
    released();
    cancel.cancel("SIGINT");
    cancel.onCancel(() => told.push("late"))();
    expect(told).toEqual(["late"]);
  });

  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    [null, 1],
    ["SIGHUP", 1],
  ])("an interrupt by %s ends a run with status %j, never zero", (signal, status) => {
    expect(owned.interruptedStatus(signal)).toBe(status);
  });

  test("every operation is attempted even when one fails, and each failure is named", async () => {
    const ran: string[] = [];
    const failures = await owned.attemptAll([
      () => {
        ran.push("a");
        throw new Error("first failed");
      },
      () => {
        ran.push("b");
      },
      () => {
        ran.push("c");
        return Promise.reject(new Error("third failed"));
      },
      () => {
        ran.push("d");
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error rejection is reported by its text
        throw "plain text";
      },
    ]);
    expect(ran).toEqual(["a", "b", "c", "d"]);
    expect(failures).toEqual(["first failed", "third failed", "plain text"]);
  });
});

describe("startOwned", () => {
  test("returns once the server answers with this run's nonce, and stops it through its group", async () => {
    const { host, signals, probes } = world({ answers: [null, "other", "nonce"], exitsOn: "SIGTERM" });
    const server = await owned.startOwned(spec, host);
    expect(probes).toHaveLength(3);
    expect(server.pid).toBe(4242);
    await server.stop();
    expect(signals).toEqual(["SIGTERM:4242", "SIGKILL:4242"]);
  });

  test("a server that ignores the polite signal is killed after the grace period", async () => {
    const { host, signals } = world({ answers: ["nonce"], exitsOn: "SIGKILL" });
    const server = await owned.startOwned(spec, host);
    await server.stop();
    expect(signals).toEqual(["SIGTERM:4242", "SIGKILL:4242", "SIGKILL:4242"]);
  });

  test("a foreign server on the port does not pass for this one: a start that dies is reported with its output and nothing foreign is signalled", async () => {
    const run = world({ answers: ["foreign server body", "foreign server body"], exitAt: 200 });
    const failing = owned.startOwned(spec, run.host);
    run.output("Error: listen EADDRINUSE: address already in use 127.0.0.1:1");
    await expect(failing).rejects.toThrow(/exited \(status 1\) before it answered[\s\S]*EADDRINUSE/);
    // The only signal is the sweep of the group the dead leader itself owned.
    expect(run.signals).toEqual(["SIGKILL:4242"]);
  });

  test("a server that never answers is stopped when the time is up", async () => {
    const { host, signals } = world({ exitsOn: "SIGTERM" });
    await expect(owned.startOwned(spec, host)).rejects.toThrow(/did not answer http:\/\/127\.0\.0\.1:1\/ready within 1000 ms/);
    expect(signals).toEqual(["SIGTERM:4242", "SIGKILL:4242"]);
  });

  test("a command that could not be started has no group to signal", async () => {
    const { host, signals } = world({ pid: undefined, answers: ["nonce"] });
    await expect(owned.startOwned(spec, host)).rejects.toThrow(/has no process group/);
    const stuck = world({ pid: undefined });
    await expect(owned.startOwned(spec, stuck.host)).rejects.toThrow(/did not answer/);
    expect(signals).toEqual([]);
    expect(stuck.signals).toEqual([]);
  });

  test("stopping a server that already exited signals nothing more", async () => {
    const run = world({ answers: ["nonce"] });
    const server = await owned.startOwned(spec, run.host);
    run.exit(0);
    await server.stop();
    expect(run.signals).toEqual(["SIGKILL:4242"]);
  });

  test("a run interrupted before the start starts nothing", async () => {
    const run = world({ answers: ["nonce"] });
    const cancel = owned.createCancellation();
    cancel.cancel("SIGINT");
    await expect(owned.startOwned({ ...spec, cancel }, run.host)).rejects.toThrow(/was not started: the run was interrupted/);
    expect([run.probes, run.signals]).toEqual([[], []]);
  });

  test("an interrupt while the server is starting stops its group at once, without waiting for the readiness timeout", async () => {
    const run = world({ exitsOn: "SIGTERM" });
    const cancel = owned.createCancellation();
    const starting = owned.startOwned({ ...spec, timeoutMs: 600_000, cancel }, run.host);
    const outcome = starting.catch((error: unknown) => (error as Error).message);
    await Promise.resolve();
    cancel.cancel("SIGINT");
    expect(await outcome).toMatch(/was stopped before it answered http:\/\/127\.0\.0\.1:1\/ready: the run was interrupted/);
    expect(run.signals).toEqual(["SIGTERM:4242", "SIGKILL:4242"]);
    expect(run.probes.length).toBeLessThan(5);
  });

  test("an interrupt after the start stops the server once, whoever asks to stop it", async () => {
    const run = world({ answers: ["nonce"], exitsOn: "SIGTERM" });
    const cancel = owned.createCancellation();
    const server = await owned.startOwned({ ...spec, cancel }, run.host);
    cancel.cancel("SIGTERM");
    await server.stop();
    await server.stop();
    expect(run.signals).toEqual(["SIGTERM:4242", "SIGKILL:4242"]);
  });

  test("a server stopped by its owner no longer listens for an interrupt", async () => {
    const run = world({ answers: ["nonce"], exitsOn: "SIGTERM" });
    const cancel = owned.createCancellation();
    const server = await owned.startOwned({ ...spec, cancel }, run.host);
    await server.stop();
    cancel.cancel("SIGINT");
    expect(run.signals).toEqual(["SIGTERM:4242", "SIGKILL:4242"]);
  });

  test("a failure to signal the group when interrupted comes back to whoever stops the server", async () => {
    const run = world({ answers: ["nonce"] });
    run.host.signalGroup = () => {
      throw new Error("not permitted");
    };
    const cancel = owned.createCancellation();
    const server = await owned.startOwned({ ...spec, cancel }, run.host);
    cancel.cancel("SIGINT");
    await expect(server.stop()).rejects.toThrow("not permitted");
  });

  test("keeps only the end of a long log", async () => {
    const run = world({ answers: ["nonce"] });
    const server = await owned.startOwned(spec, run.host);
    run.output("x".repeat(20_000));
    run.output("END");
    expect(server.log().length).toBeLessThanOrEqual(8_192);
    expect(server.log().endsWith("END")).toBe(true);
  });
});
