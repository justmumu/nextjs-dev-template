import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const state = createRequire(import.meta.url)("../../scripts/core/install-state.cjs") as typeof import("../../scripts/core/install-state.cjs");

describe("incomplete-install marker", () => {
  test("no marker means the environment is not dirty", () => {
    expect(state.parseMarker(null)).toBeNull();
  });

  test("the marker keeps the reason and the kind it was written with", () => {
    const marker = state.parseMarker(state.markerText("a transaction was rejected", "deps-lock"));
    expect(marker?.kind).toBe("deps-lock");
    expect(marker?.reason).toContain("a transaction was rejected");
    expect(state.parseMarker(state.markerText("later failure"))).toEqual({ reason: "later failure", kind: null });
  });

  test("an empty marker is still dirty", () => {
    expect(state.parseMarker("\n")).toEqual({ reason: "unknown", kind: null });
  });
});

describe("recovery", () => {
  test("only an interrupted relock is recovered by the relock; every other drift is rebuilt from the frozen lock", () => {
    expect(state.recoveryFor("deps-lock")).toBe("node scripts/bootstrap.cjs deps-lock");
    expect(state.recoveryFor("repair")).toBe("node scripts/bootstrap.cjs repair");
    expect(state.recoveryFor(null)).toBe("node scripts/bootstrap.cjs repair");
  });
});

describe("guard capability boundary", () => {
  test("only an explicit clean answer lets the operation proceed", () => {
    expect(state.guardVerdict({ clean: true })).toBeNull();
    expect(state.guardVerdict({ clean: false, reason: "pending reservation" })).toMatch(/pending reservation/);
    for (const answer of [{ clean: 1 }, { clean: "true" }, {}, true, null, undefined, [], "clean"]) {
      expect(state.guardVerdict(answer), JSON.stringify(answer)).toMatch(/unresolved protected state \(unknown\)/);
    }
  });

  test("a reason that is not text is not shown", () => {
    expect(state.guardVerdict({ clean: false, reason: { nested: 1 } })).toMatch(/\(unknown\)/);
  });
});
