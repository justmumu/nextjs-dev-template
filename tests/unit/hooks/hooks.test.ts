import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../../support/project.ts";

const require = createRequire(import.meta.url);
const preCommit = require("../../../scripts/hooks/pre-commit.cjs") as typeof import("../../../scripts/hooks/pre-commit.cjs");
const commitMsg = require("../../../scripts/hooks/commit-msg.cjs") as typeof import("../../../scripts/hooks/commit-msg.cjs");
const prePush = require("../../../scripts/hooks/pre-push.cjs") as typeof import("../../../scripts/hooks/pre-push.cjs");

const installState = require("../../../scripts/core/install-state.cjs") as typeof import("../../../scripts/core/install-state.cjs");
const processes = require("../../../scripts/core/process.cjs") as typeof import("../../../scripts/core/process.cjs");
const transaction = require("../../../scripts/core/transaction.cjs") as typeof import("../../../scripts/core/transaction.cjs");
const development = require("../../../scripts/development.cjs") as typeof import("../../../scripts/development.cjs");

type Host = Parameters<typeof preCommit.preCommit>[0];

/** A host whose steps are recorded and answer from `overrides`; `staged` is what the index holds. */
function host(staged: string[] | null, overrides: Partial<Host> = {}) {
  const calls: string[] = [];
  const step =
    <T>(name: string, answer: T) =>
    () => {
      calls.push(name);
      return answer;
    };
  const machine: Host = {
    guardActive: step("guardActive", true),
    guard: step("guard", 0),
    staged: step("staged", staged),
    stagedCheck: step("stagedCheck", { ok: true, output: "" }),
    lintStaged: step("lintStaged", 0),
    lock: step("lock", { ok: true, output: "" }),
    typecheck: step("typecheck", 0),
    ...overrides,
  };
  return { machine, calls };
}

describe("pre-commit", () => {
  test("starts with the staged guard check, then changed-file tooling, then the relevant whole-project checks", () => {
    const { machine, calls } = host(["package.json", "src/a.ts"]);
    expect(preCommit.preCommit(machine, capture().io)).toBe(0);
    expect(calls).toEqual(["guardActive", "guard", "stagedCheck", "staged", "lintStaged", "lock", "typecheck"]);
  });

  test("a refusing guard stops before anything else runs", () => {
    const { machine, calls } = host(["a.ts"], { guard: () => 1 });
    expect(preCommit.preCommit(machine, capture().io)).toBe(1);
    expect(calls).not.toContain("staged");
    expect(calls).not.toContain("lintStaged");
  });

  test("an inactive guard is not asked", () => {
    const { machine, calls } = host(["docs/a.md"], { guardActive: () => false });
    expect(preCommit.preCommit(machine, capture().io)).toBe(0);
    expect(calls).not.toContain("guard");
  });

  test("documents alone need neither the lock nor typing", () => {
    const { machine, calls } = host(["docs/a.md", "README.md"], { guardActive: () => false });
    expect(preCommit.preCommit(machine, capture().io)).toBe(0);
    expect(calls).toEqual(["stagedCheck", "staged", "lintStaged"]);
  });

  test.each(["src/a.ts", "src/b.tsx", "scripts/c.cjs", "tooling/d.mjs", "e.js", "tsconfig.json", "app/tsconfig.tooling.json"])(
    "%s makes typing relevant",
    (name) => {
      const { machine, calls } = host([name], { guardActive: () => false });
      expect(preCommit.preCommit(machine, capture().io)).toBe(0);
      expect(calls).toContain("typecheck");
    },
  );

  test.each(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"])("%s makes the lock check relevant", (name) => {
    const { machine, calls } = host([name], { guardActive: () => false });
    expect(preCommit.preCommit(machine, capture().io)).toBe(0);
    expect(calls).toContain("lock");
  });

  test("a stale lock, failing typing and failing lint-staged each fail the commit", () => {
    const sink = capture();
    expect(preCommit.preCommit(host(["package.json"], { guardActive: () => false, lock: () => ({ ok: false, output: "stale" }) }).machine, sink.io)).toBe(1);
    expect(sink.err()).toMatch(/pnpm-lock\.yaml does not match package\.json\nstale/);
    expect(preCommit.preCommit(host(["a.ts"], { guardActive: () => false, typecheck: () => 2 }).machine, capture().io)).toBe(1);
    const { machine, calls } = host(["a.ts"], { guardActive: () => false, lintStaged: () => 1 });
    expect(preCommit.preCommit(machine, capture().io)).toBe(1);
    expect(calls).not.toContain("typecheck");
  });

  test("an index that cannot be listed fails; an empty index has nothing to check", () => {
    const sink = capture();
    expect(preCommit.preCommit(host(null, { guardActive: () => false }).machine, sink.io)).toBe(1);
    expect(sink.err()).toMatch(/could not be listed/);
    const { machine, calls } = host([], { guardActive: () => false });
    expect(preCommit.preCommit(machine, capture().io)).toBe(0);
    expect(calls).toEqual(["stagedCheck", "staged"]);
  });

  test("Git's check of the staged diff rejects the commit before any tooling runs, with its own words", () => {
    const sink = capture();
    const { machine, calls } = host(["notes.txt"], {
      guardActive: () => false,
      stagedCheck: () => ({ ok: false, output: "notes.txt:1: leftover conflict marker\n" }),
    });
    expect(preCommit.preCommit(machine, sink.io)).toBe(1);
    expect(sink.err()).toMatch(/conflict markers or whitespace errors\nnotes\.txt:1: leftover conflict marker/);
    expect(calls).toEqual([]);
    const { machine: after, calls: order } = host(["a.ts"], { stagedCheck: () => ({ ok: false, output: "x" }) });
    expect(preCommit.preCommit(after, capture().io)).toBe(1);
    expect(order).toEqual(["guardActive", "guard"]);
  });

  test("main runs the injected host", () => {
    const { machine, calls } = host([], { guardActive: () => false });
    expect(preCommit.main([], { root: "/project", io: capture().io, host: machine })).toBe(0);
    expect(calls).toEqual(["stagedCheck", "staged"]);
  });
});

describe("pre-commit on the machine", () => {
  test("the real machine is the project's own capability reader, process starters, lock check and dispatcher", () => {
    const machine = preCommit.realMachine("/project", capture().io);
    expect(machine.capabilities).toBe(installState.capabilities);
    expect(machine.run).toBe(processes.run);
    expect(machine.runLogged).toBe(processes.runLogged);
    expect(machine.checkLock).toBe(transaction.checkLock);
    expect(machine.dispatch).toBe(development.mainSync);
    expect(typeof machine.launch).toBe("function");
  });

  type Machine = NonNullable<Parameters<typeof preCommit.realHost>[2]>;
  const root = "/project";

  function machine(overrides: Partial<Machine> = {}) {
    const calls: unknown[][] = [];
    const answers: Machine = {
      capabilities: (path) => {
        calls.push(["capabilities", path]);
        return { guard: true, hooks: true };
      },
      run: (command, args, options) => {
        calls.push([command, args, options.cwd]);
        return { status: 0, stdout: "a b.md\0ünï.ts\0", stderr: "" };
      },
      runLogged: (command, args, options) => {
        calls.push([command, args, options.cwd]);
        return { status: 0, stdout: "", stderr: "" };
      },
      launch: (pkg, bin, args) => {
        calls.push([pkg, bin, args]);
        return 4;
      },
      checkLock: (path) => {
        calls.push(["checkLock", path]);
        return { ok: true, output: "" };
      },
      dispatch: (argv, options) => {
        calls.push(["dispatch", argv, options.root]);
        return 5;
      },
      ...overrides,
    };
    return { host: preCommit.realHost(root, capture().io, answers), calls };
  }

  test("each step asks the machine exactly its own question", () => {
    const { host, calls } = machine();
    expect(host.guardActive()).toBe(true);
    expect(host.guard()).toBe(0);
    expect(host.stagedCheck()).toEqual({ ok: true, output: "a b.md\0ünï.ts\0" });
    expect(host.staged()).toEqual(["a b.md", "ünï.ts"]);
    expect(host.lintStaged()).toBe(4);
    expect(host.lock()).toEqual({ ok: true, output: "" });
    expect(host.typecheck()).toBe(5);
    expect(calls).toEqual([
      ["capabilities", root],
      ["sh", ["/project/scripts/hooks/launch.sh", "--client", "claude", "--event", "pre-commit"], root],
      ["git", ["diff", "--cached", "--check"], root],
      ["git", ["diff", "--cached", "--name-only", "-z"], root],
      ["lint-staged", "lint-staged", ["--config", "tooling/hooks/staged.mjs", "--concurrent", "false"]],
      ["checkLock", root],
      ["dispatch", ["typecheck"], root],
    ]);
  });

  test("a guard that cannot be started and an index that cannot be listed are failures, not passes", () => {
    const { host } = machine({
      runLogged: () => ({ status: null, stdout: "", stderr: "" }),
      run: () => ({ status: 128, stdout: "", stderr: "fatal" }),
    });
    expect(host.guard()).toBe(1);
    expect(host.staged()).toBeNull();
    expect(host.stagedCheck().ok).toBe(false);
  });
});

describe("commit-msg", () => {
  test("checks the message file against the one reviewed configuration", () => {
    const launched: [string, string, string[]][] = [];
    const status = commitMsg.main([".git/COMMIT_EDITMSG"], {
      root: "/project",
      io: capture().io,
      launch: (pkg, bin, args) => {
        launched.push([pkg, bin, args]);
        return 1;
      },
    });
    expect(status).toBe(1);
    expect(launched).toEqual([["@commitlint/cli", "commitlint", ["--config", "tooling/hooks/commit-message.mjs", "--edit", ".git/COMMIT_EDITMSG"]]]);
  });

  test.each([[[]], [["a", "b"]]])("%j is not exactly one message file", (argv) => {
    const sink = capture();
    expect(commitMsg.main(argv, { root: "/project", io: sink.io, launch: () => 0 })).toBe(2);
    expect(sink.err()).toMatch(/exactly the commit message file/);
  });
});

describe("pre-push", () => {
  test("runs the check and docs gates once each, in order", () => {
    const ran: string[] = [];
    const sink = capture();
    const status = prePush.main([], {
      root: "/project",
      io: sink.io,
      dispatch: (argv) => {
        ran.push(argv.join(" "));
        return 0;
      },
    });
    expect(status).toBe(0);
    expect(ran).toEqual(["check", "docs:build"]);
    expect(prePush.GATES).toEqual(["check", "docs:build"]);
  });

  test("stops at the first failing gate and keeps its status", () => {
    const ran: string[] = [];
    const sink = capture();
    const status = prePush.main([], {
      root: "/project",
      io: sink.io,
      dispatch: (argv) => {
        ran.push(argv.join(" "));
        return 3;
      },
    });
    expect(status).toBe(3);
    expect(ran).toEqual(["check"]);
    expect(sink.err()).toMatch(/check failed; the push was stopped/);
  });
});
