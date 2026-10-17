import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { memoryFs } from "../../support/memory-fs.ts";

const require = createRequire(import.meta.url);
const mutex = require("../../../scripts/hooks/mutex.cjs") as typeof import("../../../scripts/hooks/mutex.cjs");
const recovery = require("../../../scripts/hooks/recover-lock.cjs") as typeof import("../../../scripts/hooks/recover-lock.cjs");
const state = require("../../../scripts/hooks/state.cjs") as typeof import("../../../scripts/hooks/state.cjs");

const DIR = "/git/protected-baseline";
const baseline = (inflight: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: state.STATE_VERSION,
    policy: "p".repeat(40),
    files: {},
    approved: {},
    head: null,
    hooks: { path: null, scripts: {} },
    environment: "absent",
    environmentBlocked: false,
    user: {},
    blocked: null,
    inflight,
    window: [],
    needsEvaluation: false,
  });
const journalKinds = (disk: ReturnType<typeof memoryFs>) => mutex.readJournal(DIR, disk).map(({ text }) => (JSON.parse(text) as { kind: string }).kind);

describe("the short state mutex", () => {
  test("it is created exclusively, carries an owner token and is released by its owner", () => {
    const disk = memoryFs({});
    const held = mutex.withLock(DIR, () => mutex.readLock(DIR, disk), 0, disk);
    expect(held?.token).toEqual(expect.any(String));
    expect(held?.pid).toBe(process.pid);
    expect(disk.existsSync(`${DIR}/lock`)).toBe(false);
    expect(journalKinds(disk)).toEqual([]);
  });

  test("a lock that exists is busy, whatever it holds and however old it is", () => {
    const disk = memoryFs({ [`${DIR}/lock`]: "abandoned long ago" });
    expect(() => mutex.withLock(DIR, () => 1, 0, disk)).toThrow(/another guard run holds the state lock/);
    expect(() => mutex.withLock(DIR, () => 1, 30, disk)).toThrow(mutex.GuardError);
    expect(disk.text(`${DIR}/lock`)).toBe("abandoned long ago");
    expect(mutex.readLock(DIR, disk)).toMatchObject({ token: null, pid: null, at: null });
  });

  test("a lock that is not an object, or has other field types, has no owner", () => {
    expect(mutex.describeLock("[1]")).toEqual({ token: null, pid: null, at: null });
    expect(mutex.describeLock('{"token":1,"pid":"x","at":2}')).toEqual({ token: null, pid: null, at: null });
    expect(mutex.describeLock('{"token":"t","pid":4,"at":"now"}')).toEqual({ token: "t", pid: 4, at: "now" });
  });

  test("another failure to take the lock is raised, not mistaken for a busy lock", () => {
    const disk = memoryFs({});
    disk.writeFileSync = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(() => mutex.acquire(DIR, 0, disk)).toThrow(/EACCES/);
  });

  test("a release by a run that no longer owns the lock leaves it and records it", () => {
    const disk = memoryFs({});
    const token = mutex.acquire(DIR, 0, disk);
    disk.writeFileSync(`${DIR}/lock`, JSON.stringify({ token: "someone-else", pid: 1, at: "then" }));
    mutex.release(DIR, token, disk);
    expect(disk.existsSync(`${DIR}/lock`)).toBe(true);
    expect(journalKinds(disk)).toEqual(["wrong-owner-release"]);
  });

  test("a release when the lock is already gone records it and is not an error", () => {
    const disk = memoryFs({});
    mutex.withLock(
      DIR,
      () => {
        disk.unlinkSync(`${DIR}/lock`);
      },
      0,
      disk,
    );
    expect(journalKinds(disk)).toEqual(["lock-missing-at-release"]);
  });

  test("a lock that cannot be read or removed at release is recorded and left", () => {
    const unreadable = memoryFs({});
    const token = mutex.acquire(DIR, 0, unreadable);
    const read = unreadable.readFileSync;
    unreadable.readFileSync = ((path: string, ...rest: unknown[]) => {
      if (path.endsWith("/lock")) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return (read as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof read;
    mutex.release(DIR, token, unreadable);
    expect(journalKinds(unreadable)).toEqual(["lock-release-unreadable"]);

    const stuck = memoryFs({});
    const second = mutex.acquire(DIR, 0, stuck);
    stuck.unlinkSync = () => {
      throw new Error("EBUSY");
    };
    mutex.release(DIR, second, stuck);
    expect(journalKinds(stuck)).toEqual(["lock-release-failed"]);
    expect(stuck.existsSync(`${DIR}/lock`)).toBe(true);
  });

  test("a journal that cannot be written never hides the run", () => {
    const disk = memoryFs({});
    disk.mkdirSync = () => {
      throw new Error("read-only");
    };
    expect(() => {
      mutex.journal(DIR, "anything", {}, disk);
    }).not.toThrow();
    expect(mutex.readJournal(DIR, disk)).toEqual([]);
  });
});

describe("the state file", () => {
  test("it is written beside itself and renamed into place", () => {
    const disk = memoryFs({});
    mutex.writeAtomic(DIR, "state.json", "{}", disk);
    expect(disk.text(`${DIR}/state.json`)).toBe("{}");
    expect(disk.paths().filter((path) => path.endsWith(".tmp"))).toEqual([]);
    expect(disk.operations.some((operation) => operation.startsWith(`rename ${DIR}/state.json.`))).toBe(true);
  });

  test("a write that is interrupted keeps its temporary file, says so, and leaves the old state whole", () => {
    const disk = memoryFs({ [`${DIR}/state.json`]: baseline() });
    disk.renameSync = () => {
      throw new Error("interrupted");
    };
    expect(() => {
      state.writeState(DIR, JSON.parse(baseline({ x: 1 })) as Parameters<typeof state.writeState>[1], disk);
    }).toThrow(/interrupted/);
    expect(disk.text(`${DIR}/state.json`)).toBe(baseline());
    expect(disk.paths().filter((path) => path.endsWith(".tmp"))).toHaveLength(1);
    expect(journalKinds(disk)).toEqual(["interrupted-write"]);
  });
});

describe("offline lock recovery", () => {
  const killed = () => {
    const pending = { call: { client: "codex", session: "s", turn: "t", digest: "d", exclusive: false, route: null, completion: "result", allowances: {} } };
    return memoryFs({
      [`${DIR}/lock`]: JSON.stringify({ token: "dead-owner", pid: 999999, at: "2026-10-01T00:00:00.000Z" }),
      [`${DIR}/state.json`]: baseline(pending),
      [`${DIR}/state.json.1.2.abc.tmp`]: "{ half written",
      [`${DIR}/blobs/${"a".repeat(40)}`]: "approved content",
    });
  };

  test("it inspects without changing anything", () => {
    const disk = killed();
    const before = disk.paths();
    const report = recovery.inspect(DIR, disk);
    expect(report).toMatchObject({
      lock: { token: "dead-owner", pid: 999999 },
      temporaries: ["state.json.1.2.abc.tmp"],
      baseline: { status: "readable", pending: 1 },
    });
    expect(disk.paths()).toEqual(before);
    expect(recovery.describe(report)).toMatch(/lock is held \(pid 999999.*half-written.*1 call\(s\) are still reserved/is);
  });

  test("it moves the abandoned lock and the half-written file into the journal, and keeps the baseline, its blobs and its pending calls", () => {
    const disk = killed();
    const state_ = disk.text(`${DIR}/state.json`);
    const result = recovery.recover(DIR, recovery.inspect(DIR, disk), disk);
    expect(result.recovered).toBe(true);
    expect(disk.existsSync(`${DIR}/lock`)).toBe(false);
    expect(disk.paths().filter((path) => path.endsWith(".tmp") && !path.includes("/journal/"))).toEqual([]);
    expect(disk.paths().filter((path) => path.includes("/journal/recovered-"))).toHaveLength(2);
    expect(disk.text(`${DIR}/state.json`)).toBe(state_);
    expect(disk.text(`${DIR}/blobs/${"a".repeat(40)}`)).toBe("approved content");
    expect(recovery.inspect(DIR, disk).baseline).toEqual({ status: "readable", pending: 1 });
    expect(journalKinds(disk)).toContain("offline-recovery");
    expect(() => mutex.withLock(DIR, () => 1, 0, disk)).not.toThrow();
  });

  test("it does not touch a state directory that changed after it was inspected", () => {
    const disk = killed();
    const inspected = recovery.inspect(DIR, disk);
    disk.writeFileSync(`${DIR}/lock`, JSON.stringify({ token: "new-owner", pid: 1, at: "now" }));
    const result = recovery.recover(DIR, inspected, disk);
    expect(result.recovered).toBe(false);
    expect(disk.text(`${DIR}/lock`)).toMatch(/new-owner/);
    expect(disk.paths().filter((path) => path.includes("/journal/"))).toEqual([]);
  });

  test("it reports nothing to recover, and a baseline it cannot read is left for a person", () => {
    const clean = memoryFs({ [`${DIR}/state.json`]: baseline() });
    {
      const result = recovery.recover(DIR, recovery.inspect(DIR, clean), clean);
      expect(result.recovered).toBe(true);
      expect(result.message).toMatch(/Nothing to recover/);
    }
    const damaged = memoryFs({ [`${DIR}/lock`]: "x", [`${DIR}/state.json`]: "{ not json" });
    const report = recovery.inspect(DIR, damaged);
    expect(report.baseline).toMatchObject({ status: "unreadable" });
    expect(recovery.describe(report)).toMatch(/cannot be read.*left as it is/);
    recovery.recover(DIR, report, damaged);
    expect(damaged.text(`${DIR}/state.json`)).toBe("{ not json");
    expect(recovery.describe(recovery.inspect(`${DIR}-none`, memoryFs({})))).toMatch(/no approved baseline/);
  });

  test("a directory that cannot be listed is an error", () => {
    const disk = memoryFs({});
    disk.readdirSync = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(() => recovery.inspect(DIR, disk)).toThrow(/EACCES/);
  });

  describe("the command", () => {
    const dir = DIR;
    const run = (argv: string[], answer: string, disk: ReturnType<typeof memoryFs>, interactive = true) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = recovery.main(argv, {
        stateDir: dir,
        interactive,
        disk,
        readLine: () => answer,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
      });
      return { code, out: out.join(""), err: err.join("") };
    };
    const abandoned = () => memoryFs({ [`${dir}/lock`]: '{"token":"dead"}', [`${dir}/state.json`]: baseline() });

    test("it is a human operation: no arguments and an interactive terminal", () => {
      const disk = abandoned();
      {
        const result = run(["--force"], "recover", disk);
        expect(result.code).toBe(2);
        expect(result.err).toMatch(/usage/);
      }
      {
        const result = run([], "recover", disk, false);
        expect(result.code).toBe(2);
        expect(result.err).toMatch(/interactive terminal/);
      }
      expect(disk.existsSync(`${dir}/lock`)).toBe(true);
    });

    test("it recovers only after the person types the confirmation", () => {
      const disk = abandoned();
      {
        const result = run([], "yes", disk);
        expect(result.code).toBe(1);
        expect(result.out).toMatch(/Nothing was changed/);
      }
      expect(disk.existsSync(`${dir}/lock`)).toBe(true);
      {
        const result = run([], "recover", disk);
        expect(result.code).toBe(0);
        expect(result.out).toMatch(/Recovered/);
      }
      expect(disk.existsSync(`${dir}/lock`)).toBe(false);
      {
        const result = run([], "recover", disk);
        expect(result.code).toBe(0);
        expect(result.out).toMatch(/Nothing to recover/);
      }
    });

    test("a failure is reported, not thrown", () => {
      const disk = abandoned();
      disk.readdirSync = () => {
        throw new Error("boom");
      };
      {
        const result = run([], "recover", disk);
        expect(result.code).toBe(1);
        expect(result.err).toMatch(/Lock recovery failed: boom/);
      }
    });
  });
});
