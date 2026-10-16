import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The Python template is behavior reference only. This ties each of its guard tests to the
// JavaScript test that proves the behavior, or to the unit that owns it, so a ported behavior cannot
// be claimed without a real proof and a pending one cannot be claimed as done (U6, U7, U9).

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

type Proof = { file: string; title: string };
type Entry = { sourceFile: string; sourceTest: string; status: string; owner: string; jsTests?: Proof[]; note?: string };
const parity = JSON.parse(read("tests/contracts/upstream-parity.json")) as {
  source: { revision: string; files: string[] };
  statuses: Record<string, string>;
  entries: Entry[];
};
const policy = JSON.parse(read("tooling/upstream-policy.json")) as {
  source: { revision: string };
  mapping: {
    entries: { source: string; behavior: string; owner: string; proof: Proof }[];
    differences: { id: string; reason: string; javascript: string; proof: Proof }[];
  };
};

const proves = ({ file, title }: Proof) => existsSync(resolve(root, file)) && read(file).includes(title);

describe("the guard behavior map", () => {
  test("it names the same pinned source revision as the policy mapping", () => {
    expect(parity.source.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(policy.source.revision).toBe(parity.source.revision);
  });

  test("every source test is listed once, with a known status and owner", () => {
    const keys = parity.entries.map((entry) => `${entry.sourceFile}::${entry.sourceTest}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of parity.entries) {
      expect(Object.keys(parity.statuses), entry.sourceTest).toContain(entry.status);
      expect(parity.source.files, entry.sourceTest).toContain(entry.sourceFile);
      expect(["U6", "U7", "U9"], entry.sourceTest).toContain(entry.owner);
    }
  });

  test("a carried or adapted behavior is owned by U6 and proven by a JavaScript test that exists", () => {
    for (const entry of parity.entries.filter((candidate) => ["carried", "adapted"].includes(candidate.status))) {
      expect(entry.owner, entry.sourceTest).toBe("U6");
      expect(entry.jsTests?.length ?? 0, entry.sourceTest).toBeGreaterThan(0);
      for (const proof of entry.jsTests ?? []) expect(proves(proof), `${entry.sourceTest}: ${proof.file} has no "${proof.title}"`).toBe(true);
    }
  });

  test("a pending behavior belongs to a later unit and says why; it is never recorded as proven", () => {
    const pending = parity.entries.filter((entry) => entry.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    for (const entry of pending) {
      expect(["U7", "U9"], entry.sourceTest).toContain(entry.owner);
      expect((entry.note ?? "").length, entry.sourceTest).toBeGreaterThan(20);
      for (const proof of entry.jsTests ?? []) expect(proves(proof), `${entry.sourceTest}: ${proof.file} has no "${proof.title}"`).toBe(true);
    }
  });

  test("a behavior that is not carried gives a reason, and a proof of the replacement when there is one", () => {
    for (const entry of parity.entries.filter((candidate) => candidate.status === "not-carried")) {
      expect((entry.note ?? "").length, entry.sourceTest).toBeGreaterThan(20);
      for (const proof of entry.jsTests ?? []) expect(proves(proof), `${entry.sourceTest}: ${proof.file} has no "${proof.title}"`).toBe(true);
    }
  });

  test("the age-based expiry is the one deliberate difference in the guard's calls, and it is recorded as such", () => {
    const expiry = parity.entries.find((entry) => entry.sourceTest === "test_running_calls_expire_after_an_hour");
    expect(expiry?.status).toBe("not-carried");
    expect(expiry?.note).toMatch(/KTD16.*KTD17/);
    expect(policy.mapping.differences.map((difference) => difference.id)).toContain("no-age-expiry");
  });
});

describe("the policy mapping", () => {
  test("every carried behavior names its owner and a proof that exists", () => {
    expect(policy.mapping.entries.length).toBeGreaterThan(0);
    for (const entry of policy.mapping.entries) {
      expect(entry.owner, entry.source).toBe("U6");
      expect(entry.behavior.length, entry.source).toBeGreaterThan(20);
      expect(proves(entry.proof), `${entry.source}: ${entry.proof.file} has no "${entry.proof.title}"`).toBe(true);
    }
  });

  test("every Node-port difference gives its reason and a proof that exists", () => {
    const ids = policy.mapping.differences.map((difference) => difference.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const difference of policy.mapping.differences) {
      expect(difference.reason.length, difference.id).toBeGreaterThan(20);
      expect(difference.javascript.length, difference.id).toBeGreaterThan(5);
      expect(proves(difference.proof), `${difference.id}: ${difference.proof.file} has no "${difference.proof.title}"`).toBe(true);
    }
  });
});
