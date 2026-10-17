import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { GIT_DIR, ROOT, STATE, commitId, memoryDisk, updating } from "../support/update-model.ts";

// The journal's strict reading and the question the guard asks of it, judged on data and an
// in-memory repository. The same question is asked of real Git in tests/integration/guard-routes.test.ts.
const require = createRequire(import.meta.url);
const journals = require("../../scripts/template/journal.cjs") as typeof import("../../scripts/template/journal.cjs");

const model = updating();
const text = journals.serializeJournal(model.journal);
const edit = (change: (journal: Record<string, unknown>) => void) => {
  const copy = JSON.parse(text) as Record<string, unknown>;
  change(copy);
  return JSON.stringify(copy);
};

describe("parseJournal", () => {
  test("reads what it wrote", () => {
    expect(journals.parseJournal(text)).toEqual(model.journal);
    expect(journals.journalPaths(GIT_DIR).journal).toBe(`${GIT_DIR}/template-update/journal.json`);
  });

  test.each([
    ["not JSON", "{ nope", /not valid JSON/],
    ["an array", "[]", /file must be an object/],
    ["an unknown key", edit((journal) => (journal["extra"] = 1)), /unexpected keys/],
    ["a missing key", edit((journal) => Reflect.deleteProperty(journal, "owned")), /unexpected keys/],
    ["another schema", edit((journal) => (journal["schema"] = "other")), /not an update journal this engine understands/],
    ["another version", edit((journal) => (journal["journalVersion"] = 2)), /not an update journal this engine understands/],
    ["an unknown phase", edit((journal) => (journal["phase"] = "done")), /phase is not valid/],
    ["a non-boolean flag", edit((journal) => (journal["conflicted"] = "yes")), /conflicted flag is not valid/],
    ["another pending ref", edit((journal) => (journal["pendingRef"] = "refs/heads/main")), /pending ref is not valid/],
    ["owned files that are not a list", edit((journal) => (journal["owned"] = {})), /owned files are not valid/],
    ["a short commit", edit((journal) => ((journal["next"] as Record<string, unknown>)["commit"] = "abc")), /next commit is not valid/],
    [
      "a bad digest",
      edit((journal) => {
        journal["owned"] = [{ path: STATE, before: { digest: "x", blob: commitId("b") }, after: { digest: "a".repeat(64), blob: commitId("a") } }];
      }),
      /before digest is not valid/,
    ],
    ["an owned file of another shape", edit((journal) => (journal["owned"] = [1])), /owned file must be an object/],
  ])("refuses %s", (_label, source, message) => {
    expect(() => journals.parseJournal(source)).toThrow(message);
  });
});

describe("readJournal", () => {
  test("is null without a journal and an error with an unreadable one", () => {
    const disk = memoryDisk();
    expect(journals.readJournal(GIT_DIR, disk.disk as never)).toBeNull();
    disk.put(journals.journalPaths(GIT_DIR).journal, "{");
    expect(() => journals.readJournal(GIT_DIR, disk.disk as never)).toThrow(/not valid JSON/);
  });

  test("fileDigest is the digest of a regular file and null for anything else", () => {
    const disk = memoryDisk({ "/a": "bytes" });
    expect(journals.fileDigest("/a", disk.disk as never)).toBe(journals.sha256("bytes"));
    expect(journals.fileDigest("/missing", disk.disk as never)).toBeNull();
  });
});

describe("what the guard may call an update's own merge", () => {
  const facts = (change: (held: ReturnType<typeof journals.readFacts>) => void = () => undefined) => {
    const ready = updating();
    const read = journals.readFacts({
      root: ROOT,
      gitDir: GIT_DIR,
      disk: ready.disk.disk as never,
      git: (args) => {
        try {
          return { status: 0, stdout: (ready.host.git as unknown as { out: (cwd: string, args: string[]) => string }).out(ROOT, args) };
        } catch {
          return { status: 1, stdout: "" };
        }
      },
      journal: ready.journal,
    });
    change(read);
    return { journal: ready.journal, read };
  };

  test("a finished, resolved, unmodified update is owned", () => {
    const { journal, read } = facts();
    expect(read.head).toBe(journal.start.head);
    expect(read.mergeHeads).toEqual([journal.next.commit]);
    expect(read.pending).toBe(journal.next.commit);
    expect(journals.ownedMergeProblem(journal, read)).toBeNull();
  });

  test.each([
    ["a moved HEAD", (held: ReturnType<typeof journals.readFacts>) => ({ ...held, head: commitId("elsewhere") }), /HEAD is not where/],
    ["another operation", (held: ReturnType<typeof journals.readFacts>) => ({ ...held, otherOperation: true }), /another merge, rebase/],
    ["no merge", (held: ReturnType<typeof journals.readFacts>) => ({ ...held, mergeHeads: [] }), /merge waiting is not the template update's/],
    [
      "another merge",
      (held: ReturnType<typeof journals.readFacts>) => ({ ...held, mergeHeads: [commitId("x")] }),
      /merge waiting is not the template update's/,
    ],
    ["two merge heads", (held: ReturnType<typeof journals.readFacts>) => ({ ...held, mergeHeads: [held.mergeHeads[0] ?? "", commitId("x")] }), /merge waiting/],
    ["a missing pending snapshot", (held: ReturnType<typeof journals.readFacts>) => ({ ...held, pending: null }), /pending snapshot is missing/],
    ["an unmerged path", (held: ReturnType<typeof journals.readFacts>) => ({ ...held, unmerged: true }), /still has unmerged paths/],
    [
      "a changed state file",
      (held: ReturnType<typeof journals.readFacts>) => ({ ...held, owned: [{ path: STATE, worktree: "0".repeat(64), index: held.owned[0]?.index ?? null }] }),
      /is not what the template update wrote/,
    ],
    [
      "an unstaged state file",
      (held: ReturnType<typeof journals.readFacts>) => ({ ...held, owned: [{ path: STATE, worktree: held.owned[0]?.worktree ?? null, index: null }] }),
      /is not what the template update wrote/,
    ],
  ])("%s is not", (_label, change, message) => {
    const { journal, read } = facts();
    expect(journals.ownedMergeProblem(journal, change(read))).toMatch(message);
  });

  test("an update that has not finished its own steps is not", () => {
    const { journal, read } = facts();
    expect(journals.ownedMergeProblem({ ...journal, phase: "merged" }, read)).toMatch(/has not finished its own steps/);
  });

  test("ownedMerge answers no without a journal and with one that cannot be read, and says why", () => {
    const disk = memoryDisk();
    const git = () => ({ status: 1, stdout: "" });
    expect(journals.ownedMerge({ root: ROOT, gitDir: GIT_DIR, disk: disk.disk as never, git })).toEqual({
      owned: false,
      reason: "no template update is in progress",
    });
    disk.put(journals.journalPaths(GIT_DIR).journal, "{");
    expect(journals.ownedMerge({ root: ROOT, gitDir: GIT_DIR, disk: disk.disk as never, git })).toEqual({
      owned: false,
      reason: "the update journal is not valid JSON",
    });
  });

  test("ownedMerge reads the repository: owned when everything matches, with a reason when a ref is gone", () => {
    const ready = updating();
    const git = (args: string[]) => {
      try {
        return { status: 0, stdout: (ready.host.git as unknown as { out: (cwd: string, args: string[]) => string }).out(ROOT, args) };
      } catch {
        return { status: 1, stdout: "" };
      }
    };
    expect(journals.ownedMerge({ root: ROOT, gitDir: GIT_DIR, disk: ready.disk.disk as never, git })).toEqual({ owned: true, reason: null });
    ready.repo.refs.delete(journals.PENDING_REF);
    expect(journals.ownedMerge({ root: ROOT, gitDir: GIT_DIR, disk: ready.disk.disk as never, git }).reason).toMatch(/pending snapshot is missing/);
  });
});
