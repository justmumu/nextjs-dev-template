import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { GIT_DIR, ROOT, STATE, commitId, commitIt, updating } from "../support/update-model.ts";

// The decisions of the update recovery, on an in-memory project: what each command does in each
// phase, what it refuses, and that nothing it did not write is ever overwritten. The same steps run
// against real Git and a real process in tests/integration/template-recovery.test.ts.
const require = createRequire(import.meta.url);
const recovery = require("../../scripts/template/recovery.cjs") as typeof import("../../scripts/template/recovery.cjs");
const journals = require("../../scripts/template/journal.cjs") as typeof import("../../scripts/template/journal.cjs");

const journalFile = `${GIT_DIR}/template-update/journal.json`;
const lockFile = `${GIT_DIR}/template-update/update.lock`;
const phaseOf = (model: ReturnType<typeof updating>) => journals.parseJournal(model.disk.text(journalFile) ?? "").phase;
const said = (model: ReturnType<typeof updating>) => model.output.out.join("");

describe("inspect", () => {
  test("says nothing is in progress, and names an orphan pending reference without removing it", () => {
    const model = updating();
    model.disk.disk.rmSync(journalFile);
    model.repo.refs.delete(journals.PENDING_REF);
    expect(recovery.inspect(model.host)).toBe(0);
    expect(said(model)).toMatch(/no template update is in progress/);

    model.repo.refs.set(journals.PENDING_REF, commitId("orphan"));
    expect(recovery.inspect(model.host)).toBe(1);
    expect(model.output.err.join("")).toMatch(/no update journal, but refs\/template-update\/pending points to/);
    expect(model.repo.refs.has(journals.PENDING_REF)).toBe(true);
  });

  test("describes a ready update, its owned file and the way on, without changing anything", () => {
    const model = updating();
    const before = model.disk.text(journalFile);
    expect(recovery.inspect(model.host)).toBe(0);
    expect(said(model)).toMatch(/phase: ready[\s\S]*\.template-state\.json: new[\s\S]*ready: finish it with guard-accept/);
    expect(model.disk.text(journalFile)).toBe(before);
    expect(model.calls.some((call) => /^(add|reset|update-ref|merge)/.test(call))).toBe(false);
  });

  test("tells a conflicted update from a ready one, and lists the unmerged paths", () => {
    const model = updating({ conflicted: true });
    expect(recovery.inspect(model.host)).toBe(0);
    expect(said(model)).toMatch(/unmerged: package\.json/);
    expect(said(model)).toMatch(/conflicted: resolve the unmerged paths/);
  });

  test("names the step a prepared update is waiting for, and a committed one", () => {
    const prepared = updating({ phase: "prepared", merged: false });
    expect(recovery.inspect(prepared.host)).toBe(0);
    expect(said(prepared)).toMatch(/resume or abort/);

    const done = updating();
    commitIt(done);
    expect(recovery.inspect(done.host)).toBe(0);
    expect(said(done)).toMatch(/the update was committed: run node scripts\/template\/update\.cjs resume/);
  });

  test("refuses to guess when the state file was changed by someone else", () => {
    const model = updating();
    model.disk.put(`${ROOT}/${STATE}`, '{ "edited": true }\n');
    expect(recovery.inspect(model.host)).toBe(1);
    expect(model.output.err.join("")).toMatch(/changed by someone else: manual recovery is needed/);
  });
});

describe("resume", () => {
  test("a ready update is already applied: nothing is merged, written or removed", () => {
    const model = updating();
    expect(recovery.resume(model.host)).toBe(0);
    expect(recovery.resume(model.host)).toBe(0);
    expect(said(model)).toMatch(/already applied; nothing was merged again/);
    expect(model.repo.merges).toBe(0);
    expect(phaseOf(model)).toBe("ready");
    expect(model.disk.disk.existsSync(lockFile)).toBe(false);
  });

  test("a prepared update merges once, checks the result against the preview and goes on to ready", () => {
    const model = updating({ phase: "prepared", merged: false, stateOnDisk: "before" });
    expect(recovery.resume(model.host)).toBe(0);
    expect(model.repo.merges).toBe(1);
    expect(phaseOf(model)).toBe("ready");
    expect(model.disk.text(`${ROOT}/${STATE}`)).not.toContain('"stateVersion": 0');
    expect(model.repo.index.get(STATE)).toBe(model.journal.owned[0]?.after.blob);
    expect(recovery.resume(model.host)).toBe(0);
    expect(model.repo.merges).toBe(1);
  });

  test("a merge that has run but is not yet recorded is not run again", () => {
    const model = updating({ phase: "prepared", merged: true, stateOnDisk: "before" });
    expect(recovery.resume(model.host)).toBe(0);
    expect(model.repo.merges).toBe(0);
    expect(phaseOf(model)).toBe("ready");
  });

  test("a merged update whose state was written but not staged only stages it", () => {
    const model = updating({ phase: "merged" });
    model.repo.index.set(STATE, model.journal.owned[0]?.before.blob ?? "");
    expect(recovery.resume(model.host)).toBe(0);
    expect(phaseOf(model)).toBe("ready");
    expect(model.repo.index.get(STATE)).toBe(model.journal.owned[0]?.after.blob);
  });

  test("a merge result that is not the previewed one is refused, and the journal stays", () => {
    const model = updating({ phase: "prepared", merged: true, stateOnDisk: "before" });
    const changed = { ...model.journal, outputDigest: "0".repeat(64) };
    model.disk.put(journalFile, journals.serializeJournal(changed));
    expect(() => recovery.resume(model.host)).toThrow(/not the one the preview described/);
    expect(phaseOf(model)).toBe("prepared");
    expect(model.disk.disk.existsSync(lockFile)).toBe(false);
  });

  test("a merge that cannot start leaves the project as it was and removes the update", () => {
    const model = updating({ phase: "prepared", merged: false, stateOnDisk: "before" });
    model.repo.mergeStatus = 2;
    expect(() => recovery.resume(model.host)).toThrow(/the merge could not start and the project is unchanged: untracked files would be overwritten/);
    expect(model.disk.disk.existsSync(journalFile)).toBe(false);
    expect(model.repo.refs.has(journals.PENDING_REF)).toBe(false);
  });

  test("refuses a start that is not where the update began, tracked changes, another merge and another operation", () => {
    const moved = updating({ phase: "prepared", merged: false, stateOnDisk: "before" });
    moved.repo.head = commitId("elsewhere");
    expect(() => recovery.resume(moved.host)).toThrow(/HEAD moved without completing the update/);

    const dirty = updating({ phase: "prepared", merged: false, stateOnDisk: "before" });
    dirty.repo.dirty = ["next.config.ts"];
    expect(() => recovery.resume(dirty.host)).toThrow(/tracked files changed since the update began, so no merge was started/);

    const foreign = updating({ phase: "prepared", merged: false, stateOnDisk: "before" });
    foreign.disk.put(`${GIT_DIR}/MERGE_HEAD`, `${commitId("foreign")}\n`);
    expect(() => recovery.resume(foreign.host)).toThrow(/a merge other than this update's is waiting/);

    const busy = updating({ phase: "prepared", merged: false, stateOnDisk: "before" });
    busy.disk.put(`${GIT_DIR}/CHERRY_PICK_HEAD`, "x\n");
    expect(() => recovery.resume(busy.host)).toThrow(/another merge, rebase, cherry-pick or revert is in progress/);
  });

  test("a merged update whose merge is gone, or whose state someone else wrote, is refused", () => {
    const gone = updating({ phase: "merged" });
    gone.disk.disk.rmSync(`${GIT_DIR}/MERGE_HEAD`);
    expect(() => recovery.resume(gone.host)).toThrow(/the merge of this update is no longer waiting/);

    const edited = updating({ phase: "merged" });
    edited.disk.put(`${ROOT}/${STATE}`, "{}\n");
    expect(() => recovery.resume(edited.host)).toThrow(/\.template-state\.json was changed by someone else; it was not overwritten/);
  });

  test("a state that would not be the preview's is refused before it is written", () => {
    const model = updating({ phase: "merged", stateOnDisk: "before" });
    const owned = model.journal.owned[0];
    const changed = { ...model.journal, owned: [{ ...owned, after: { ...owned?.after, digest: "f".repeat(64) } }] };
    model.disk.put(journalFile, journals.serializeJournal(changed as never));
    expect(() => recovery.resume(model.host)).toThrow(/would not be what the preview bound/);
  });

  test("settles after the person's merge commit, and a commit that is not the update's is not taken for it", () => {
    const model = updating();
    commitIt(model);
    expect(recovery.settle(model.host)).toBe(true);
    expect(model.disk.disk.existsSync(journalFile)).toBe(false);
    expect(model.repo.refs.has(journals.PENDING_REF)).toBe(false);
    expect(recovery.resume(model.host)).toBe(0);
    expect(said(model)).toMatch(/no template update is in progress/);

    const other = updating();
    commitIt(other);
    other.repo.committed.set(`${other.repo.head}:${STATE}`, "{}\n");
    expect(recovery.settle(other.host)).toBe(false);
    expect(() => recovery.resume(other.host)).toThrow(/HEAD moved without completing the update/);
    expect(other.disk.disk.existsSync(journalFile)).toBe(true);

    const pair = updating();
    commitIt(pair);
    pair.repo.parents.set(pair.repo.head, [pair.journal.start.head]);
    expect(recovery.settle(pair.host)).toBe(false);
  });

  test("settle with no update in progress is true; a not yet committed update is not settled", () => {
    expect(recovery.settle(updating().host)).toBe(false);
    const none = updating();
    none.disk.disk.rmSync(journalFile);
    expect(recovery.settle(none.host)).toBe(true);
  });

  test("a held lock is respected and left alone", () => {
    const model = updating();
    model.disk.put(lockFile, "999\n");
    expect(() => recovery.resume(model.host)).toThrow(/another update command holds .*update\.lock/);
    expect(model.disk.disk.existsSync(lockFile)).toBe(true);
  });
});

describe("abort", () => {
  test("restores the state file, ends the merge and removes the bookkeeping and its backup", () => {
    const model = updating();
    expect(recovery.abort(model.host)).toBe(0);
    expect(model.disk.text(`${ROOT}/${STATE}`)).toBe(model.repo.committed.get(`${model.journal.start.head}:${STATE}`));
    expect(model.repo.index.get(STATE)).toBe(model.journal.owned[0]?.before.blob);
    expect(model.disk.disk.existsSync(`${GIT_DIR}/MERGE_HEAD`)).toBe(false);
    expect(model.disk.disk.existsSync(journalFile)).toBe(false);
    expect(model.repo.refs.has(journals.PENDING_REF)).toBe(false);
    expect([...model.disk.files.keys()].some((path) => path.includes("/backup/"))).toBe(false);
    expect(model.disk.disk.existsSync(lockFile)).toBe(false);
  });

  test("an update that never merged is removed when the tree is clean, and kept when it is not", () => {
    const clean = updating({ phase: "prepared", merged: false, stateOnDisk: "before" });
    expect(recovery.abort(clean.host)).toBe(0);
    expect(clean.disk.disk.existsSync(journalFile)).toBe(false);

    const dirty = updating({ phase: "prepared", merged: false, stateOnDisk: "before" });
    dirty.repo.dirty = ["next.config.ts"];
    expect(() => recovery.abort(dirty.host)).toThrow(/no merge is waiting but tracked files differ from HEAD[\s\S]*a backup of what was replaced is in/);
    expect(dirty.disk.disk.existsSync(journalFile)).toBe(true);
  });

  test("never overwrites a state file someone else changed", () => {
    const model = updating();
    model.disk.put(`${ROOT}/${STATE}`, '{ "edited": true }\n');
    expect(() => recovery.abort(model.host)).toThrow(/was changed by someone else; it was not overwritten and the update stays recorded/);
    expect(model.disk.text(`${ROOT}/${STATE}`)).toBe('{ "edited": true }\n');
    expect(model.disk.disk.existsSync(`${GIT_DIR}/MERGE_HEAD`)).toBe(true);
    expect([...model.disk.files.keys()].some((path) => path.includes("/backup/"))).toBe(false);
  });

  test("a failed merge abort keeps a backup and the journal, and a retry succeeds", () => {
    const model = updating();
    model.repo.failAbort = true;
    expect(() => recovery.abort(model.host)).toThrow(/Cannot merge[\s\S]*a backup of what was replaced is in .*\/backup\//);
    const kept = [...model.disk.files.keys()].filter((path) => path.includes("/backup/"));
    expect(kept.map((path) => path.split("/").pop()).sort()).toEqual(["journal.json", "owned-0"]);
    expect(model.disk.disk.existsSync(journalFile)).toBe(true);
    expect(model.disk.disk.existsSync(lockFile)).toBe(false);
    model.repo.failAbort = false;
    expect(recovery.abort(model.host)).toBe(0);
    expect([...model.disk.files.keys()].some((path) => path.includes("/backup/"))).toBe(false);
  });

  test("refuses when HEAD moved, the update is committed, another operation runs, or another merge waits", () => {
    const moved = updating();
    moved.repo.head = commitId("elsewhere");
    expect(() => recovery.abort(moved.host)).toThrow(/HEAD moved without completing the update, so it was not rewound/);

    const committed = updating();
    commitIt(committed);
    expect(() => recovery.abort(committed.host)).toThrow(/already committed; run resume/);

    const busy = updating();
    busy.disk.put(`${GIT_DIR}/REVERT_HEAD`, "x\n");
    expect(() => recovery.abort(busy.host)).toThrow(/another merge, rebase, cherry-pick or revert is in progress/);

    const foreign = updating();
    foreign.disk.put(`${GIT_DIR}/MERGE_HEAD`, `${commitId("foreign")}\n`);
    expect(() => recovery.abort(foreign.host)).toThrow(/the merge waiting is not this update's/);
  });

  test("refuses when the start of the state file no longer matches the journal", () => {
    const model = updating();
    model.repo.committed.set(`${model.journal.start.head}:${STATE}`, "{}\n");
    expect(() => recovery.abort(model.host)).toThrow(/at the start of the update no longer matches the journal/);
    expect(model.disk.disk.existsSync(journalFile)).toBe(true);
  });

  test("with no journal there is nothing to abort", () => {
    const model = updating();
    model.disk.disk.rmSync(journalFile);
    expect(recovery.abort(model.host)).toBe(0);
    expect(said(model)).toMatch(/no template update is in progress/);
  });
});

describe("the journal's first write", () => {
  test("is exclusive and whole: a second update cannot take its place", () => {
    const model = updating();
    model.disk.disk.rmSync(journalFile);
    recovery.createJournal(model.host, model.journal);
    expect(model.disk.text(journalFile)).toBe(journals.serializeJournal(model.journal));
    expect([...model.disk.files.keys()].filter((path) => path.endsWith(".new"))).toEqual([]);
    expect(() => {
      recovery.createJournal(model.host, model.journal);
    }).toThrow(/a template update is already in progress/);
    expect([...model.disk.files.keys()].filter((path) => path.endsWith(".new"))).toEqual([]);
  });

  test("an error other than an existing journal is not mistaken for one", () => {
    const model = updating();
    model.disk.disk.rmSync(journalFile);
    const host = {
      ...model.host,
      fs: {
        ...model.disk.disk,
        linkSync: () => {
          throw new Error("disk full");
        },
      },
    };
    expect(() => {
      recovery.createJournal(host as never, model.journal);
    }).toThrow(/disk full/);
  });

  test("the lock is released when the command fails", () => {
    const model = updating();
    expect(() =>
      recovery.exclusively(model.host, () => {
        throw new Error("boom");
      }),
    ).toThrow(/boom/);
    expect(model.disk.disk.existsSync(lockFile)).toBe(false);
  });

  test("a lock that cannot be created for another reason is that error", () => {
    const model = updating();
    const host = {
      ...model.host,
      fs: {
        ...model.disk.disk,
        writeFileSync: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      },
    };
    expect(() => recovery.exclusively(host as never, () => 1)).toThrow(/EACCES/);
  });
});
