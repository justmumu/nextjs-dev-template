import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { put, scratchArea } from "../support/project.ts";

const state = createRequire(import.meta.url)("../../scripts/core/install-state.cjs") as typeof import("../../scripts/core/install-state.cjs");
const scratch = scratchArea("install-state-");

describe("incomplete-install marker", () => {
  test("a project without a marker is not dirty", () => {
    const root = scratch.project();
    expect(state.dirtyReason(root)).toBeNull();
    expect(state.dirtyKind(root)).toBeNull();
    expect(state.recoveryCommand(root)).toBe("node scripts/bootstrap.cjs repair");
  });

  test("the marker keeps the reason, the kind and the one command that can recover", () => {
    const root = scratch.project();
    state.markDirty(root, "a transaction was rejected", "deps-lock");
    expect(state.dirtyReason(root)).toContain("a transaction was rejected");
    expect(state.dirtyKind(root)).toBe("deps-lock");
    expect(state.recoveryCommand(root)).toBe("node scripts/bootstrap.cjs deps-lock");
    state.markDirty(root, "later failure");
    expect(state.dirtyKind(root)).toBeNull();
    expect(state.recoveryCommand(root)).toBe("node scripts/bootstrap.cjs repair");
  });

  test("an empty marker is still dirty, and clearing it is idempotent", () => {
    const root = scratch.project();
    put(root, `node_modules/${state.MARKER}`, "\n");
    expect(state.dirtyReason(root)).toBe("unknown");
    state.clearDirty(root);
    state.clearDirty(root);
    expect(state.dirtyReason(root)).toBeNull();
  });
});

describe("removing the install state", () => {
  test("removes only the project's node_modules", () => {
    const root = scratch.project({ "src/keep.ts": "x", "node_modules/pkg/index.js": "y" });
    state.removeInstallState(root);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    expect(readFileSync(join(root, "src/keep.ts"), "utf8")).toBe("x");
  });

  test("unlinks a symlinked node_modules without following it", () => {
    const root = scratch.project();
    const elsewhere = scratch.project({ "kept.txt": "outside" });
    symlinkSync(elsewhere, join(root, "node_modules"));
    state.removeInstallState(root);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    expect(readFileSync(join(elsewhere, "kept.txt"), "utf8")).toBe("outside");
  });

  test("a file in place of node_modules is removed, and a missing one is fine", () => {
    const root = scratch.project({ node_modules: "not a directory" });
    state.removeInstallState(root);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    expect(() => {
      state.removeInstallState(root);
    }).not.toThrow();
  });
});

describe("guard capability boundary", () => {
  const withCapability = (guard: boolean, stateModule?: string) => {
    const root = scratch.project({ "tooling/capabilities.json": JSON.stringify({ guard, hooks: false }) });
    if (stateModule !== undefined) put(root, "scripts/hooks/state.cjs", stateModule);
    return root;
  };

  test("an unregistered guard claims nothing", () => {
    const root = withCapability(false);
    expect(state.capabilities(root)).toEqual({ guard: false, hooks: false });
    expect(state.guardRefusal(root)).toBeNull();
  });

  test("a registered guard without its state module refuses", () => {
    expect(state.guardRefusal(withCapability(true))).toMatch(/scripts\/hooks\/state\.cjs is missing/);
  });

  test("only an explicit clean answer lets the operation proceed", () => {
    expect(state.guardRefusal(withCapability(true, "exports.status = () => ({ clean: true });"))).toBeNull();
    expect(state.guardRefusal(withCapability(true, 'exports.status = () => ({ clean: false, reason: "pending reservation" });'))).toMatch(
      /pending reservation/,
    );
    expect(state.guardRefusal(withCapability(true, "exports.status = () => ({ clean: 1 });"))).toMatch(/unknown/);
    expect(state.guardRefusal(withCapability(true, "exports.status = () => true;"))).toMatch(/unknown/);
  });

  test("a state module that throws or is not a module of the contract refuses", () => {
    expect(state.guardRefusal(withCapability(true, 'exports.status = () => { throw new Error("broken ledger"); };'))).toMatch(/broken ledger/);
    expect(state.guardRefusal(withCapability(true, "module.exports = {};"))).toMatch(/could not be read/);
  });

  test("a capabilities file that is not an object is an error, not a claim", () => {
    const root = scratch.project();
    mkdirSync(join(root, "tooling"));
    writeFileSync(join(root, "tooling/capabilities.json"), "[]");
    expect(() => state.capabilities(root)).toThrow(/JSON object/);
  });
});
