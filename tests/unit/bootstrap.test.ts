import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

const bootstrap = createRequire(import.meta.url)("../../scripts/bootstrap.cjs") as typeof import("../../scripts/bootstrap.cjs");
type Host = NonNullable<NonNullable<Parameters<typeof bootstrap.main>[1]>["host"]>;
type Transaction = Parameters<Host["transact"]>[0];

const workspace = readFileSync(resolve(import.meta.dirname, "../../pnpm-workspace.yaml"), "utf8");
const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "fixture", private: true, dependencies: {}, devDependencies: {}, ...extra });

/** A machine on which everything is in order; a test overrides the one thing that is not. */
function machine(overrides: Partial<Host> = {}) {
  const calls: string[] = [];
  const transactions: { steps: string[][]; plan: Transaction["plan"]; kind: string | undefined }[] = [];
  const host: Host = {
    preflightErrors: () => [],
    dirtyReason: () => null,
    dirtyKind: () => null,
    recoveryCommand: () => "node scripts/bootstrap.cjs repair",
    guardRefusal: () => null,
    hooksRegistered: () => false,
    installHooks: () => calls.push("hooks"),
    checkLock: () => ({ ok: true, output: "" }),
    removeInstallState: () => calls.push("remove"),
    clearDirty: () => calls.push("clear"),
    transact: ({ steps, plan, kind }) => {
      calls.push("transact");
      transactions.push({ steps, plan, kind });
      return { ok: true, status: 0, violations: [], output: "pnpm said hello\n", restored: false };
    },
    run: (_command, args) => (args[0] === "show" ? { status: 0, stdout: manifest() } : { status: 0, stdout: "" }),
    readFile: (path) => (path.endsWith("pnpm-workspace.yaml") ? workspace : manifest()),
    exists: () => false,
    ...overrides,
  };
  return { host, calls, transactions };
}

function run(argv: string[], host: Host) {
  const sink = capture();
  const status = bootstrap.main(argv, { root: "/p", io: sink.io, host });
  return { status, out: sink.out(), err: sink.err() };
}

describe("usage", () => {
  test("an unknown or missing command prints the usage and does nothing", () => {
    for (const argv of [["nonsense"], []]) {
      const { host, calls } = machine();
      const result = run(argv, host);
      expect(result.status).toBe(2);
      expect(result.err).toMatch(/usage: node scripts\/bootstrap\.cjs setup \| repair \| guard-accept \| deps-lock/);
      expect(calls).toEqual([]);
    }
  });

  test("any argument is refused", () => {
    const { host, calls } = machine();
    const result = run(["setup", "--frozen-lockfile=false"], host);
    expect(result.status).toBe(2);
    expect(result.err).toMatch(/setup takes no arguments/);
    expect(calls).toEqual([]);
  });

  test("guard acceptance is refused until the guard exists, and says nothing was accepted", () => {
    const result = run(["guard-accept"], machine().host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/Nothing was accepted/);
  });
});

describe("setup", () => {
  test("a Node or pnpm that is not the pinned one stops it before anything is installed", () => {
    const { host, calls } = machine({ preflightErrors: () => ["Node 24.21.0 is required (found 1.0.0). Install exactly that version."] });
    const result = run(["setup"], host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/Node 24\.21\.0 is required/);
    expect(calls).toEqual([]);
  });

  test("it does not build on an incomplete install, and names the one command that recovers", () => {
    const { host, calls } = machine({
      dirtyReason: () => "a dependency transaction did not finish",
      recoveryCommand: () => "node scripts/bootstrap.cjs deps-lock",
    });
    const result = run(["setup"], host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/incomplete install.*did not finish.*Run: node scripts\/bootstrap\.cjs deps-lock/s);
    expect(calls).toEqual([]);
  });

  test("it installs from the frozen lock without touching manifests, and says hooks are not installed while there is no installer", () => {
    const { host, calls, transactions } = machine();
    const result = run(["setup"], host);
    expect(result.status).toBe(0);
    expect(transactions).toEqual([{ steps: [["install", "--frozen-lockfile"]], plan: { action: "none" }, kind: undefined }]);
    expect(result.out).toMatch(/pnpm said hello/);
    expect(result.out).toMatch(/Git hooks are not installed/);
    expect(calls).not.toContain("hooks");
  });

  test("once the hook installer is registered it installs the hooks after the dependencies", () => {
    const { host, calls } = machine({ hooksRegistered: () => true });
    const result = run(["setup"], host);
    expect(result.status).toBe(0);
    expect(calls).toEqual(["transact", "hooks"]);
    expect(result.out).toMatch(/Git hooks installed/);
  });

  test("a rejected install fails, reports the violations and the recovery, and installs no hooks", () => {
    const { host, calls } = machine({
      hooksRegistered: () => true,
      transact: () => ({ ok: false, status: 0, violations: ["protected path changed: AGENTS.md"], output: "", restored: true }),
    });
    const result = run(["setup"], host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/protected files were restored.*recover with: node scripts\/bootstrap\.cjs repair.*- protected path changed: AGENTS\.md/s);
    expect(calls).not.toContain("hooks");
  });

  test("registry credentials in the package manager's output never reach the log", () => {
    const { host } = machine({
      transact: () => ({ ok: true, status: 0, violations: [], output: "//r.example/:_authToken=top-secret\n", restored: false }),
    });
    const result = run(["setup"], host);
    expect(result.out).not.toMatch(/top-secret/);
    expect(result.out).toMatch(/\[redacted\]/);
  });
});

describe("repair", () => {
  test("a lock that does not match the manifest removes nothing and is never regenerated", () => {
    const { host, calls } = machine({ checkLock: () => ({ ok: false, output: "ERR_PNPM_OUTDATED_LOCKFILE //r.example/:_authToken=top-secret" }) });
    const result = run(["repair"], host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/does not match package\.json.*Nothing was removed/s);
    expect(result.err).not.toMatch(/top-secret|deps-lock again/);
    expect(calls).toEqual([]);
  });

  test("an interrupted relock is pointed back at the relock", () => {
    const { host } = machine({ checkLock: () => ({ ok: false, output: "" }), dirtyKind: () => "deps-lock" });
    expect(run(["repair"], host).err).toMatch(/run node scripts\/bootstrap\.cjs deps-lock again/);
  });

  test("it removes the install state only after the lock was confirmed, rebuilds, and then clears the marker", () => {
    const { host, calls, transactions } = machine();
    const result = run(["repair"], host);
    expect(result.status).toBe(0);
    expect(calls).toEqual(["remove", "transact", "clear"]);
    expect(transactions[0]?.steps).toEqual([["install", "--frozen-lockfile"]]);
    expect(result.out).toMatch(/global store was not touched/);
  });

  test("a rebuild that fails leaves the marker in place", () => {
    const { host, calls } = machine({ transact: () => ({ ok: false, status: 1, violations: [], output: "", restored: true }) });
    expect(run(["repair"], host).status).toBe(1);
    expect(calls).toEqual(["remove"]);
  });

  test("a wrong Node or pnpm stops it before the lock is read", () => {
    const { host, calls } = machine({
      preflightErrors: () => ["pnpm 12.14.0 is required"],
      checkLock: () => {
        throw new Error("must not be consulted");
      },
    });
    expect(run(["repair"], host).status).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe("deps-lock", () => {
  test("the environment is checked first, then the guard, then an unrelated incomplete install", () => {
    expect(run(["deps-lock"], machine({ preflightErrors: () => ["Node is wrong"] }).host).err).toMatch(/Node is wrong/);
    expect(run(["deps-lock"], machine({ guardRefusal: () => "the guard reports an unresolved protected state (baseline not accepted)" }).host).err).toMatch(
      /baseline not accepted/,
    );
    const dirty = machine({ dirtyReason: () => "install interrupted", dirtyKind: () => "repair" });
    const result = run(["deps-lock"], dirty.host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/incomplete install.*install interrupted.*Run: node scripts\/bootstrap\.cjs repair/s);
    expect(dirty.calls).toEqual([]);
  });

  test("an interrupted relock may be retried", () => {
    const { host, transactions } = machine({ dirtyReason: () => "relock interrupted", dirtyKind: () => "deps-lock" });
    expect(run(["deps-lock"], host).status).toBe(0);
    expect(transactions).toHaveLength(1);
  });

  test("without a committed baseline there is nothing to approve against", () => {
    const { host, calls } = machine({ run: () => ({ status: 128, stdout: "" }) });
    const result = run(["deps-lock"], host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/needs a committed baseline/);
    expect(calls).toEqual([]);
  });

  test("protected files that differ from the baseline are named and not approved", () => {
    const { host, calls } = machine({
      run: (_command, args) =>
        args[0] === "show" ? { status: 0, stdout: manifest() } : { status: 0, stdout: " M AGENTS.md\0 M package.json\0?? src/new.ts\0" },
    });
    const result = run(["deps-lock"], host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/do(?:es)? not approve them:\nAGENTS\.md/);
    expect(result.err).not.toMatch(/package\.json\n|src\/new/);
    expect(calls).toEqual([]);
  });

  test("a failing git status refuses instead of assuming the tree is clean", () => {
    const { host } = machine({ run: (_command, args) => (args[0] === "show" ? { status: 0, stdout: manifest() } : { status: 1, stdout: "" }) });
    expect(run(["deps-lock"], host).err).toMatch(/git status failed/);
  });

  test("a manifest edited beyond its dependency maps is outside the boundary", () => {
    const { host, calls } = machine({ readFile: (path) => (path.endsWith("pnpm-workspace.yaml") ? workspace : manifest({ scripts: { check: "evil" } })) });
    const result = run(["deps-lock"], host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/outside the dependency-only boundary:\n- .*scripts/);
    expect(calls).toEqual([]);
  });

  test("an approved edit relocks and then installs frozen, as a relock that can be retried", () => {
    const { host, transactions } = machine();
    const result = run(["deps-lock"], host);
    expect(result.status).toBe(0);
    expect(transactions).toEqual([
      {
        steps: [
          ["install", "--lockfile-only", "--no-frozen-lockfile"],
          ["install", "--frozen-lockfile"],
        ],
        plan: { action: "none" },
        kind: "deps-lock",
      },
    ]);
    expect(result.out).toMatch(/Lock regenerated from the approved manifest/);
  });

  test("a relock the transaction rejected fails", () => {
    const { host } = machine({ transact: () => ({ ok: false, status: 0, violations: ["x"], output: "", restored: true }) });
    expect(run(["deps-lock"], host).status).toBe(1);
  });
});

describe("boundary of an approved relock", () => {
  const files = { head: manifest(), manifest: manifest(), workspace, npmrc: null };

  test("a dependency-only edit of a reviewed workspace is inside", () => {
    expect(bootstrap.boundaryProblems({ ...files, manifest: manifest({ dependencies: { left: "1.0.0" } }) })).toEqual([]);
  });

  test("a hostile .npmrc, workspace or non-JSON manifest is outside", () => {
    expect(bootstrap.boundaryProblems({ ...files, npmrc: "script-shell=/bin/evil\n" }).join("\n")).toMatch(/script-shell/);
    expect(bootstrap.boundaryProblems({ ...files, workspace: `${workspace}\nonlyBuiltDependencies:\n  evil: true\n` }).length).toBeGreaterThan(0);
    expect(bootstrap.boundaryProblems({ ...files, manifest: "{ nope" }).join("\n")).toMatch(/package\.json is not valid JSON/);
  });
});

describe("protected files that differ", () => {
  test("only protected paths other than the manifest and the lock are reported, whatever their status code", () => {
    const porcelain = [" M AGENTS.md", "?? scripts/new.cjs", "A  package.json", " M pnpm-lock.yaml", "?? src/app/page.tsx", "x"].join("\0");
    expect(bootstrap.differingProtected(porcelain)).toEqual(["AGENTS.md", "scripts/new.cjs"]);
    expect(bootstrap.differingProtected("")).toEqual([]);
  });
});
