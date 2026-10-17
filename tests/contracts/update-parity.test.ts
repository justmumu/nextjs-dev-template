import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The Python template's update test file is behavior reference only. This ties each of its tests to the
// JavaScript test that proves the behavior in the lineage protocol, or says why it is not carried.
const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
interface Entry {
  sourceTest: string;
  status: string;
  note?: string;
  jsTests: { file: string; title: string }[];
}
const parity = JSON.parse(read("tests/contracts/update-parity.json")) as { source: { revision: string; file: string }; entries: Entry[] };
const guardParity = JSON.parse(read("tests/contracts/upstream-parity.json")) as { source: { revision: string } };

describe("the update behavior map", () => {
  test("names the pinned revision of the guard map and each source test once", () => {
    expect(parity.source.revision).toBe(guardParity.source.revision);
    expect(parity.source.file).toBe("tests/test_copier_update.py");
    expect(parity.entries.map((entry) => entry.sourceTest).sort()).toEqual([
      "test_github_copy_updates_from_its_own_history_without_setup_credentials",
      "test_template_updates_preserve_initial_and_released_versions",
      "test_update_distributes_guard_completion_and_preserves_state",
      "test_update_preserves_changes_or_reports_real_conflict",
    ]);
  });

  test("every behavior is proven by a JavaScript test that exists, and an adaptation says what changed", () => {
    for (const entry of parity.entries) {
      expect(["carried", "adapted"], entry.sourceTest).toContain(entry.status);
      expect(entry.jsTests.length, entry.sourceTest).toBeGreaterThan(0);
      for (const { file, title } of entry.jsTests)
        expect(existsSync(resolve(root, file)) && read(file).includes(title), `${entry.sourceTest}: ${file} has no "${title}"`).toBe(true);
      if (entry.status === "adapted") expect((entry.note ?? "").length, entry.sourceTest).toBeGreaterThan(20);
    }
  });
});
