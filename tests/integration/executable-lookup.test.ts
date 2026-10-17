import { chmodSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { put, scratchArea } from "../support/project.ts";

const toolchain = createRequire(import.meta.url)("../../scripts/core/toolchain.cjs") as typeof import("../../scripts/core/toolchain.cjs");
const scratch = scratchArea("executable-lookup-");

describe("executable lookup", () => {
  test("finds the first executable file on a path list and skips directories and non-executables", () => {
    const first = scratch.project({ "tool-a": "x", "dir/placeholder": "" });
    const second = scratch.project({ "tool-a": "y", "tool-b": "y" });
    put(second, "tool-a", "y", 0o755);
    chmodSync(join(first, "tool-a"), 0o644);
    const list = ["", first, join(scratch.area, "does-not-exist"), second].join(delimiter);
    expect(toolchain.resolveOnPath("tool-a", list)).toBe(join(second, "tool-a"));
    expect(toolchain.resolveOnPath("tool-b", list)).toBeNull();
    expect(toolchain.resolveOnPath("dir", list)).toBeNull();
    expect(toolchain.resolveOnPath("tool-a", "")).toBeNull();
  });
});
