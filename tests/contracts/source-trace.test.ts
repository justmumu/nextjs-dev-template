import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The Python template's remaining test files are behavior reference only. This ties each of their tests to
// the JavaScript test that proves the behavior, or says why it is not carried, so the trace names tests
// that exist rather than intentions (the guard files have upstream-parity.json, the update file
// update-parity.json).
const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
interface Entry {
  sourceFile: string;
  sourceTest: string;
  status: string;
  owner: string;
  note?: string;
  jsTests?: { file: string; title: string }[];
}
const trace = JSON.parse(read("tests/contracts/source-trace.json")) as {
  source: { revision: string; files: string[] };
  statuses: Record<string, string>;
  entries: Entry[];
};
const guardParity = JSON.parse(read("tests/contracts/upstream-parity.json")) as { source: { revision: string } };

describe("the source-to-test trace", () => {
  test("names the pinned revision and every source file", () => {
    expect(trace.source.revision).toBe(guardParity.source.revision);
    expect(trace.source.files).toEqual([
      "tests/test_copier.py",
      "tests/test_bootstrap.py",
      "tests/test_bootstrap_integration.py",
      "tests/test_development_workflow.py",
      "tests/test_development_integration.py",
      "tests/test_release.py",
      "tests/test_release_workflow.py",
    ]);
  });

  test("lists each source test once, with a known status, and the counts the source files have", () => {
    const keys = trace.entries.map((entry) => `${entry.sourceFile}::${entry.sourceTest}`);
    expect(new Set(keys).size).toBe(keys.length);
    const counts = Object.fromEntries(trace.source.files.map((file) => [file, trace.entries.filter((entry) => entry.sourceFile === file).length]));
    expect(counts).toEqual({
      "tests/test_copier.py": 8,
      "tests/test_bootstrap.py": 13,
      "tests/test_bootstrap_integration.py": 16,
      "tests/test_development_workflow.py": 19,
      "tests/test_development_integration.py": 5,
      "tests/test_release.py": 19,
      "tests/test_release_workflow.py": 2,
    });
    for (const entry of trace.entries) {
      expect(Object.keys(trace.statuses), entry.sourceTest).toContain(entry.status);
      expect(entry.sourceTest, entry.sourceTest).toMatch(/^test_[a-z0-9_]+$/);
    }
  });

  test("a carried or adapted behavior is proven by a JavaScript test that exists, and says what changed when adapted", () => {
    for (const entry of trace.entries.filter((candidate) => candidate.status !== "not-carried")) {
      expect(entry.jsTests?.length ?? 0, entry.sourceTest).toBeGreaterThan(0);
      for (const { file, title } of entry.jsTests ?? [])
        expect(existsSync(resolve(root, file)) && read(file).includes(title), `${entry.sourceTest}: ${file} has no "${title}"`).toBe(true);
      if (entry.status === "adapted") expect((entry.note ?? "").length, entry.sourceTest).toBeGreaterThan(20);
    }
  });

  test("a behavior that is not carried gives its reason, and only Python-specific tooling is left out", () => {
    const left = trace.entries.filter((entry) => entry.status === "not-carried");
    expect(left.length).toBeLessThan(10);
    for (const entry of left) expect((entry.note ?? "").length, entry.sourceTest).toBeGreaterThan(20);
  });
});
