import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture, roleFiles, scratchArea } from "../support/project.ts";

const bootstrap = createRequire(import.meta.url)("../../scripts/bootstrap.cjs") as typeof import("../../scripts/bootstrap.cjs");
const state = createRequire(import.meta.url)("../../scripts/core/install-state.cjs") as typeof import("../../scripts/core/install-state.cjs");
const scratch = scratchArea("bootstrap-");

const project = (extra: Record<string, string> = {}) =>
  scratch.project({ ...roleFiles("application"), "tooling/capabilities.json": JSON.stringify({ guard: false, hooks: false }), ...extra });

describe("bootstrap usage", () => {
  test("an unknown command prints the usage and fails", () => {
    const sink = capture();
    expect(bootstrap.main(["nonsense"], { root: project(), io: sink.io })).toBe(2);
    expect(sink.err()).toMatch(/usage: node scripts\/bootstrap\.cjs setup \| repair \| guard-accept \| deps-lock/);
  });

  test("no command and any argument are refused", () => {
    expect(bootstrap.main([], { root: project(), io: capture().io })).toBe(2);
    const sink = capture();
    expect(bootstrap.main(["setup", "--frozen-lockfile=false"], { root: project(), io: sink.io })).toBe(2);
    expect(sink.err()).toMatch(/setup takes no arguments/);
  });

  test("guard acceptance is refused until the guard exists, and says nothing was accepted", () => {
    const sink = capture();
    expect(bootstrap.main(["guard-accept"], { root: project(), io: sink.io })).toBe(1);
    expect(sink.err()).toMatch(/Nothing was accepted/);
  });
});

describe("environment refusals before any change", () => {
  test("a Node or pnpm that is not the pinned one stops every installing command", () => {
    for (const command of ["setup", "repair", "deps-lock"]) {
      const root = project({ ".node-version": "1.0.0\n", "package.json": JSON.stringify({ packageManager: "pnpm@12.14.0" }) });
      const sink = capture();
      expect(bootstrap.main([command], { root, io: sink.io }), command).toBe(1);
      expect(sink.err(), command).toMatch(/Node 1\.0\.0 is required/);
    }
  });

  test("setup does not build on an incomplete install", () => {
    const root = project();
    state.markDirty(root, "a dependency transaction did not finish");
    const sink = capture();
    expect(bootstrap.main(["setup"], { root, io: sink.io })).toBe(1);
    expect(sink.err()).toMatch(/incomplete install.*node scripts\/bootstrap\.cjs repair/);
  });

  test("a relock is refused while the guard reports an unresolved state, and while another failure is unrepaired", () => {
    const guarded = project({
      "tooling/capabilities.json": JSON.stringify({ guard: true, hooks: false }),
      "scripts/hooks/state.cjs": 'exports.status = () => ({ clean: false, reason: "baseline not accepted" });',
    });
    const sink = capture();
    expect(bootstrap.main(["deps-lock"], { root: guarded, io: sink.io })).toBe(1);
    expect(sink.err()).toMatch(/baseline not accepted/);

    const dirty = project();
    state.markDirty(dirty, "install interrupted", "repair");
    const sinkDirty = capture();
    expect(bootstrap.main(["deps-lock"], { root: dirty, io: sinkDirty.io })).toBe(1);
    expect(sinkDirty.err()).toMatch(/Run: node scripts\/bootstrap\.cjs repair/);
  });
});
