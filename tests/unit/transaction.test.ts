import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { memoryDisk, type Node } from "../support/memory-disk.ts";

type Transaction = typeof import("../../scripts/core/transaction.cjs");
const transaction = createRequire(import.meta.url)("../../scripts/core/transaction.cjs") as Transaction;

type Snapshot = ReturnType<Transaction["snapshot"]>;
type Entry = NonNullable<ReturnType<Snapshot["get"]>>;
type System = NonNullable<Parameters<Transaction["runTransaction"]>[0]["system"]>;
type Location = ReturnType<Transaction["locate"]>;

const file = (content: string, mode = 0o644): Entry => ({ type: "file", mode, content: Buffer.from(content) });
const link = (target: string): Entry => ({ type: "symlink", target });
const dir: Entry = { type: "dir" };
const MANIFEST = JSON.stringify({ name: "app", dependencies: {}, devDependencies: {} });

/** A snapshot as the snapshot machinery would record it: entries, and the directories that existed. */
function snap(entries: Record<string, Entry>, dirs: string[] = []): Snapshot {
  const snapshot: Snapshot = new Map(Object.entries(entries));
  snapshot.dirs = new Set(dirs);
  return snapshot;
}
const project = (extra: Record<string, Entry> = {}) =>
  snap({ "package.json": file(MANIFEST), "pnpm-lock.yaml": file("lock\n"), "AGENTS.md": file("# rules\n"), ...extra });
const without = (from: Snapshot, path: string) => {
  const copy = snap(Object.fromEntries(from), [...(from.dirs ?? [])]);
  copy.delete(path);
  return copy;
};

describe("what changed", () => {
  test("content, mode and kind differences are named in both directions", () => {
    const before = project({ "scripts/tool.cjs": file("a"), "tooling/x": link("a") });
    const after = snap({
      ...Object.fromEntries(without(without(before, "pnpm-lock.yaml"), "tooling/x")),
      "AGENTS.md": file("# changed\n"),
      "scripts/tool.cjs": file("a", 0o755),
      "scripts/new.cjs": file("x"),
      "tooling/x": file("now a file"),
    });
    expect(transaction.changedPaths(before, after)).toEqual(["AGENTS.md", "pnpm-lock.yaml", "scripts/new.cjs", "scripts/tool.cjs", "tooling/x"]);
  });

  test("identical snapshots, a retargeted link and an unchanged directory are told apart", () => {
    const before = project({ "tooling/l": link("a"), tooling: dir });
    expect(transaction.changedPaths(before, project({ "tooling/l": link("a"), tooling: dir }))).toEqual([]);
    expect(transaction.changedPaths(before, project({ "tooling/l": link("b"), tooling: dir }))).toEqual(["tooling/l"]);
  });
});

describe("what a rollback has to remove", () => {
  test("an added, retyped or retargeted entry is unlinked, deepest first", () => {
    const before = project({ "tooling/role.json": file("x"), "CLAUDE.md": link("AGENTS.md") });
    const now = project({
      "tooling/role.json": link("/etc/passwd"),
      "CLAUDE.md": link("package.json"),
      "scripts/injected/hook.cjs": file("evil"),
      "scripts/injected": dir,
      scripts: dir,
    });
    const removals = transaction.removalsFor(before, now);
    expect(removals.map(({ path, op }) => `${op} ${path}`)).toEqual([
      "unlink tooling/role.json",
      "unlink scripts/injected/hook.cjs",
      "rmdir scripts/injected",
      "rmdir scripts",
      "unlink CLAUDE.md",
    ]);
  });

  test("a directory the transaction created is removed unless something unrecorded is in it", () => {
    const now = project({ ".claude": dir, tooling: dir });
    expect(transaction.removalsFor(project(), now)).toEqual([
      { path: "tooling", op: "rmdir", keepNonEmpty: true },
      { path: ".claude", op: "rmdir", keepNonEmpty: true },
    ]);
  });

  test("a directory that existed before, with ordinary source in it, stays when a shadow configuration is removed from it", () => {
    const base = { "package.json": file(MANIFEST), "pnpm-lock.yaml": file("lock\n") };
    const before = snap(base, ["src"]);
    const now = snap({ ...base, src: dir, "src/eslint.config.mjs": file("hostile") });
    expect(transaction.removalsFor(before, now)).toEqual([{ path: "src/eslint.config.mjs", op: "unlink", keepNonEmpty: false }]);
  });

  test("a directory standing where the preimage had a file must go even when it is not empty", () => {
    const before = project({ "tooling/x": file("was a file") });
    const now = project({ "tooling/x": dir });
    expect(transaction.removalsFor(before, now)).toEqual([{ path: "tooling/x", op: "rmdir", keepNonEmpty: false }]);
  });

  test("nothing is removed when nothing differs", () => {
    expect(transaction.removalsFor(project(), project())).toEqual([]);
  });
});

describe("what a rollback has to write back", () => {
  test("only the preimage entries that are not as they were, parents first", () => {
    const before = project({ "scripts/tool.cjs": file("a"), scripts: dir, "a/b": file("1"), a: dir });
    const current = snap({ ...Object.fromEntries(without(without(without(before, "scripts"), "a"), "AGENTS.md")), "scripts/tool.cjs": file("hostile") });
    expect(transaction.writesFor(before, current).map(([path]) => path)).toEqual(["AGENTS.md", "a", "scripts", "scripts/tool.cjs"]);
  });
});

describe("what a transaction may not have done", () => {
  const manifestBefore = JSON.parse(MANIFEST) as Record<string, unknown>;
  const plan = { action: "none" } as const;
  const judged = (after: Snapshot) => transaction.violationsFor(project(), after, manifestBefore, plan);

  test("an untouched project has no violation, and the manifest and the lock may be rewritten", () => {
    expect(judged(project())).toEqual([]);
    expect(judged(project({ "pnpm-lock.yaml": file("new lock\n") }))).toEqual([]);
  });

  test("any other protected path that changed is named", () => {
    expect(judged(project({ "AGENTS.md": file("hostile"), "scripts/new.cjs": file("x") }))).toEqual([
      "protected path changed: AGENTS.md",
      "protected path changed: scripts/new.cjs",
    ]);
  });

  test("a manifest changed beyond the plan, unreadable, or gone is a violation", () => {
    expect(
      judged(project({ "package.json": file(JSON.stringify({ name: "app", scripts: { check: "evil" }, dependencies: {}, devDependencies: {} })) })).join("\n"),
    ).toMatch(/scripts/);
    expect(judged(project({ "package.json": file("{ not json") })).join("\n")).toMatch(/unreadable after the transaction/);
    expect(judged(without(project(), "package.json")).join("\n")).toMatch(/package\.json is missing/);
  });

  test("a deleted lock is a violation", () => {
    expect(judged(without(project(), "pnpm-lock.yaml"))).toContain("pnpm-lock.yaml is missing after the transaction");
  });
});

describe("a transaction judged without a disk", () => {
  type Recorded = { events: string[]; marks: { reason: string; kind: string | undefined }[] };

  /** A system whose snapshots are scripted; `restoreFails` makes the rollback itself fail. */
  function fakeSystem(snapshots: Snapshot[], options: { lock?: boolean; restoreFails?: boolean } = {}): { system: System; recorded: Recorded } {
    const recorded: Recorded = { events: [], marks: [] };
    const queue = [...snapshots];
    const where: Location = { root: "/p", git: null };
    const system: System = {
      locate: () => where,
      snapshot: () => queue.shift() ?? queue[0] ?? snap({}),
      restore: () => {
        recorded.events.push("restore");
        if (options.restoreFails) throw new Error("rollback incomplete");
      },
      markDirty: (_root, reason, kind) => {
        recorded.events.push("mark");
        recorded.marks.push({ reason, kind });
      },
      clearDirty: () => recorded.events.push("clear"),
      checkLock: () => {
        recorded.events.push("lock");
        return { ok: options.lock ?? true, output: "" };
      },
    };
    return { system, recorded };
  }
  const run = (system: System, runner: Parameters<Transaction["runTransaction"]>[0]["runner"], kind?: string) =>
    transaction.runTransaction({ root: "/p", steps: [["install"]], plan: { action: "none" }, runner, kind, system });
  const ok = () => ({ status: 0, stdout: "out\n", stderr: "" });

  test("an acceptable result clears the incomplete-install marker it set first", () => {
    const { system, recorded } = fakeSystem([project(), project({ "pnpm-lock.yaml": file("new\n") })]);
    expect(run(system, ok)).toEqual({ ok: true, status: 0, violations: [], output: "out\n", restored: false });
    expect(recorded.events).toEqual(["mark", "lock", "clear"]);
    expect(recorded.marks[0]?.reason).toMatch(/did not finish/);
  });

  test("a protected file edited by the manager is rejected and restored, and the lock is not even consulted", () => {
    const { system, recorded } = fakeSystem([project(), project({ "AGENTS.md": file("evil") })]);
    const result = run(system, ok, "deps-lock");
    expect(result).toMatchObject({ ok: false, restored: true, violations: ["protected path changed: AGENTS.md"] });
    expect(recorded.events).toEqual(["mark", "restore", "mark"]);
    expect(recorded.marks.at(-1)).toEqual({ reason: "a dependency transaction was rejected", kind: "deps-lock" });
  });

  test("a failing manager keeps its exit status and stops the steps", () => {
    const { system, recorded } = fakeSystem([project(), project()]);
    const seen: string[] = [];
    const result = transaction.runTransaction({
      root: "/p",
      steps: [["first"], ["second"], ["third"]],
      plan: { action: "none" },
      system,
      runner: (args) => {
        seen.push(args.join(" "));
        return { status: args[0] === "second" ? 7 : 0, stdout: `${args[0] ?? ""}\n`, stderr: "" };
      },
    });
    expect(seen).toEqual(["first", "second"]);
    expect(result).toMatchObject({ ok: false, status: 7, restored: true, violations: [], output: "first\nsecond\n" });
    expect(recorded.marks.at(-1)?.reason).toMatch(/failed/);
  });

  test("a manager that did not report a status counts as failed", () => {
    const { system } = fakeSystem([project(), project()]);
    expect(run(system, () => ({ status: null, stdout: "", stderr: "" })).status).toBe(1);
  });

  test("a lock that no longer matches the manifest is a violation of an otherwise clean result", () => {
    const { system } = fakeSystem([project(), project()], { lock: false });
    expect(run(system, ok).violations).toEqual(["the lock does not match package.json after the transaction"]);
  });

  test("a manager that throws is rolled back, the incomplete install is recorded, and the error is not swallowed", () => {
    const { system, recorded } = fakeSystem([project()]);
    expect(() =>
      run(system, () => {
        throw new Error("manager crashed");
      }),
    ).toThrow(/manager crashed/);
    expect(recorded.events).toEqual(["mark", "restore", "mark"]);
    expect(recorded.marks.at(-1)?.reason).toMatch(/interrupted/);
  });

  test("a rollback that cannot finish is written into the marker and thrown", () => {
    const { system, recorded } = fakeSystem([project(), project({ "AGENTS.md": file("evil") })], { restoreFails: true });
    expect(() => run(system, ok)).toThrow(/rollback incomplete/);
    expect(recorded.marks.at(-1)?.reason).toMatch(/rejected; rollback incomplete/);
  });

  test("a project without a manifest cannot start a transaction, and nothing is marked", () => {
    const { system, recorded } = fakeSystem([snap({ "AGENTS.md": file("x") })]);
    expect(() => run(system, ok)).toThrow(/package\.json is missing/);
    expect(recorded.events).toEqual([]);
  });
});

describe("what a snapshot records", () => {
  const where: Location = { root: "/p", git: null };
  const snapshotOf = (nodes: Record<string, Node>, location: Location = where) => transaction.snapshot(location, memoryDisk(nodes));

  test("protected content is recorded and ordinary source and dependency trees are not", () => {
    const snapshot = snapshotOf({
      "/p/package.json": "{}",
      "/p/AGENTS.md": "# rules\n",
      "/p/scripts/tool.cjs": "x",
      "/p/tooling/project-role.json": "{}",
      "/p/src/app/page.tsx": "ordinary",
      "/p/node_modules/x/index.js": "dependency",
      "/p/.git/config": "git",
    });
    expect([...snapshot.keys()].sort()).toEqual(["AGENTS.md", "package.json", "scripts", "scripts/tool.cjs", "tooling", "tooling/project-role.json"]);
    expect(snapshot.get("scripts/tool.cjs")).toEqual({ type: "file", mode: 0o644, content: Buffer.from("x") });
    expect(snapshot.get("scripts")).toEqual({ type: "dir" });
  });

  test("the mode of a file is part of what is recorded", () => {
    expect(snapshotOf({ "/p/scripts/run.cjs": { content: "x", mode: 0o100755 } }).get("scripts/run.cjs")).toMatchObject({ mode: 0o755 });
  });

  test("a protected symlink is recorded as a link and never followed; an ordinary one is not recorded", () => {
    const snapshot = snapshotOf({ "/p/CLAUDE.md": { link: "AGENTS.md" }, "/p/src/link.ts": { link: "/etc/passwd" }, "/p/AGENTS.md": "x" });
    expect(snapshot.get("CLAUDE.md")).toEqual({ type: "symlink", target: "AGENTS.md" });
    expect(snapshot.has("src/link.ts")).toBe(false);
  });

  test("a configuration file below the root that would override the root's is recorded, wherever it sits", () => {
    const snapshot = snapshotOf({
      "/p/src/deep/eslint.config.mjs": "export default [];\n",
      "/p/src/deep/other.ts": "x",
      "/p/template/app/eslint.config.mjs": "seed",
    });
    expect([...snapshot.keys()].filter((key) => key.endsWith(".mjs"))).toEqual(["src/deep/eslint.config.mjs", "template/app/eslint.config.mjs"]);
    expect(snapshot.get("src")).toEqual({ type: "dir" });
    expect(snapshot.has("src/deep/other.ts")).toBe(false);
  });

  test("every directory met is listed, recorded or not, so a created directory can be told from an existing one", () => {
    const snapshot = snapshotOf({ "/p/src/app/page.tsx": "x", "/p/scripts/a.cjs": "x" });
    expect([...(snapshot.dirs ?? [])].sort()).toEqual(["scripts", "src", "src/app"]);
    expect(snapshot.has("src")).toBe(false);
  });

  test("git state outside the working tree that decides which hooks run is recorded under its own keys", () => {
    const git = { common: "/repo/.git", dir: "/repo/.git/worktrees/w" };
    const snapshot = snapshotOf(
      {
        "/p/package.json": "{}",
        "/repo/.git/config": "[core]",
        "/repo/.git/hooks/pre-commit": "hook",
        "/repo/.git/worktrees/w/config.worktree": "[core]",
        "/repo/.git/worktrees/w/hooks/post-commit": "hook",
        "/repo/.git/HEAD": "ref",
      },
      { root: "/p", git },
    );
    expect([...snapshot.keys()].filter((key) => key.startsWith("@git:")).sort()).toEqual([
      "@git:common/config",
      "@git:common/hooks",
      "@git:common/hooks/pre-commit",
      "@git:dir/config.worktree",
      "@git:dir/hooks",
      "@git:dir/hooks/post-commit",
    ]);
  });

  test("an ordinary checkout has one git directory and no worktree entries", () => {
    const git = { common: "/p/.git", dir: "/p/.git" };
    const snapshot = snapshotOf({ "/p/.git/config": "[core]", "/p/.git/config.worktree": "ignored", "/p/package.json": "{}" }, { root: "/p", git });
    expect([...snapshot.keys()].sort()).toEqual(["@git:common/config", "package.json"]);
  });

  test("a path whose parent is a file is absent, but any other failure to read is not hidden", () => {
    expect(() =>
      transaction.snapshot(where, {
        ...memoryDisk({ "/p/AGENTS.md": "x" }),
        readFileSync: () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      }),
    ).toThrow(/EACCES/);
  });

  test("a key maps back to the path it was read from", () => {
    const git = { common: "/repo/.git", dir: "/repo/.git/worktrees/w" };
    const located: Location = { root: "/p", git };
    expect(transaction.pathOf(located, "AGENTS.md")).toBe("/p/AGENTS.md");
    expect(transaction.pathOf(located, "scripts/a/b.cjs")).toBe("/p/scripts/a/b.cjs");
    expect(transaction.pathOf(located, "@git:common/hooks/pre-commit")).toBe("/repo/.git/hooks/pre-commit");
    expect(transaction.pathOf(located, "@git:dir/config.worktree")).toBe("/repo/.git/worktrees/w/config.worktree");
    expect(transaction.pathOf({ root: "/p", git: null }, "@git:common/config")).toBe("/p/@git:common/config");
  });
});

describe("a rollback that has to keep going", () => {
  test("every step is attempted, and what failed is listed", () => {
    const ran: string[] = [];
    const step = (path: string, fails: boolean) => ({
      path,
      step: () => {
        ran.push(path);
        if (fails) throw new Error(`${path} is locked`);
      },
    });
    expect(transaction.attemptAll([step("a", true), step("b", false), step("c", true)])).toEqual(["a: a is locked", "c: c is locked"]);
    expect(ran).toEqual(["a", "b", "c"]);
    expect(transaction.attemptAll([])).toEqual([]);
  });

  test("a rollback is complete only when nothing failed, and the error names every failure", () => {
    expect(() => {
      transaction.assertRestored([]);
    }).not.toThrow();
    expect(() => {
      transaction.assertRestored(["a: a is locked", "c: c is locked"]);
    }).toThrow(/rollback incomplete; these protected paths could not be restored: a: a is locked; c: c is locked$/);
  });

  test("only a created container that still holds unrecorded content may be left standing", () => {
    const notEmpty = Object.assign(new Error("ENOTEMPTY"), { code: "ENOTEMPTY" });
    const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
    expect(transaction.keptNonEmpty(notEmpty, true)).toBe(true);
    expect(transaction.keptNonEmpty(notEmpty, false)).toBe(false);
    expect(transaction.keptNonEmpty(denied, true)).toBe(false);
  });
});

describe("putting a tree back", () => {
  const where: Location = { root: "/p", git: null };
  const tree = {
    "/p/package.json": MANIFEST,
    "/p/AGENTS.md": "# rules\n",
    "/p/CLAUDE.md": { link: "AGENTS.md" },
    "/p/scripts/tool.cjs": { content: "module.exports = 1;\n", mode: 0o755 },
    "/p/tooling/project-role.json": '{"role":"application"}',
    "/p/src/app/page.tsx": "export {};\n",
  };

  test("edited, deleted, retyped, retargeted and added protected paths come back, and ordinary source is left alone", () => {
    const disk = memoryDisk(tree);
    const before = transaction.snapshot(where, disk);
    disk.writeFileSync("/p/AGENTS.md", Buffer.from("# hostile\n"), { mode: 0o644 });
    disk.unlinkSync("/p/scripts/tool.cjs");
    disk.mkdirSync("/p/scripts/injected");
    disk.writeFileSync("/p/scripts/injected/hook.cjs", Buffer.from("evil"), { mode: 0o644 });
    disk.unlinkSync("/p/tooling/project-role.json");
    disk.symlinkSync("/etc/passwd", "/p/tooling/project-role.json");
    disk.unlinkSync("/p/CLAUDE.md");
    disk.symlinkSync("package.json", "/p/CLAUDE.md");
    disk.writeFileSync("/p/src/app/page.tsx", Buffer.from("export const edited = 1;\n"), { mode: 0o644 });

    transaction.restore(where, before, disk);

    const after = transaction.snapshot(where, disk);
    expect(transaction.changedPaths(before, after)).toEqual([]);
    expect(disk.readFileSync("/p/AGENTS.md").toString()).toBe("# rules\n");
    expect(disk.lstatSync("/p/scripts/tool.cjs").mode).toBe(0o755);
    expect(disk.readlinkSync("/p/CLAUDE.md")).toBe("AGENTS.md");
    expect(disk.paths()).not.toContain("/p/scripts/injected/hook.cjs");
    expect(() => disk.lstatSync("/p/scripts/injected")).toThrow(/ENOENT/);
    expect(disk.readFileSync("/p/src/app/page.tsx").toString()).toBe("export const edited = 1;\n");
  });

  test("a symlink that was retargeted is unlinked, never followed, before it is made again", () => {
    const disk = memoryDisk(tree);
    const before = transaction.snapshot(where, disk);
    disk.unlinkSync("/p/CLAUDE.md");
    disk.symlinkSync("package.json", "/p/CLAUDE.md");
    disk.operations.length = 0;
    transaction.restore(where, before, disk);
    expect(disk.operations).toEqual(["unlink /p/CLAUDE.md", "mkdir /p", "symlink /p/CLAUDE.md -> AGENTS.md"]);
  });

  test("a file is written with its mode and then given it again, because a write alone is subject to the umask", () => {
    const disk = memoryDisk(tree);
    const before = transaction.snapshot(where, disk);
    disk.unlinkSync("/p/scripts/tool.cjs");
    disk.operations.length = 0;
    transaction.restore(where, before, disk);
    expect(disk.operations).toEqual(["mkdir /p/scripts", "write /p/scripts/tool.cjs", "chmod /p/scripts/tool.cjs 755"]);
  });

  test("directories the transaction created go, unless unrecorded content is in them", () => {
    const disk = memoryDisk(tree);
    const before = transaction.snapshot(where, disk);
    disk.mkdirSync("/p/.claude/empty", { recursive: true });
    disk.mkdirSync("/p/tooling/extra");
    disk.writeFileSync("/p/tooling/extra/note.txt", Buffer.from("kept?"), { mode: 0o644 });
    transaction.restore(where, before, disk);
    expect(() => disk.lstatSync("/p/.claude")).toThrow(/ENOENT/);
    expect(() => disk.lstatSync("/p/tooling/extra")).toThrow(/ENOENT/);
  });

  test("a rollback that cannot remove one thing still puts back the rest, and says what failed", () => {
    const disk = memoryDisk(tree);
    const before = transaction.snapshot(where, disk);
    disk.writeFileSync("/p/AGENTS.md", Buffer.from("# hostile\n"), { mode: 0o644 });
    disk.writeFileSync("/p/scripts/injected.cjs", Buffer.from("evil"), { mode: 0o644 });
    const stubborn = {
      ...disk,
      unlinkSync: (path: string) => {
        if (path.endsWith("injected.cjs")) throw new Error("EPERM: immutable");
        disk.unlinkSync(path);
      },
    };
    expect(() => {
      transaction.restore(where, before, stubborn);
    }).toThrow(/rollback incomplete.*scripts\/injected\.cjs: EPERM: immutable/);
    expect(disk.readFileSync("/p/AGENTS.md").toString()).toBe("# rules\n");
  });

  test("git state outside the working tree is put back through its own location", () => {
    const git = { common: "/repo/.git", dir: "/repo/.git" };
    const located: Location = { root: "/p", git };
    const disk = memoryDisk({ ...tree, "/repo/.git/config": "[core]\n", "/repo/.git/hooks/pre-commit": "original" });
    const before = transaction.snapshot(located, disk);
    disk.writeFileSync("/repo/.git/hooks/pre-commit", Buffer.from("evil"), { mode: 0o644 });
    disk.writeFileSync("/repo/.git/hooks/post-commit", Buffer.from("evil"), { mode: 0o644 });
    transaction.restore(located, before, disk);
    expect(disk.readFileSync("/repo/.git/hooks/pre-commit").toString()).toBe("original");
    expect(disk.paths()).not.toContain("/repo/.git/hooks/post-commit");
  });

  test("the git directories are read from what git reports, and not at all outside a repository", () => {
    expect(transaction.locationFrom("/p", { status: 0, stdout: "/repo/.git/worktrees/w\n/repo/.git\n" })).toEqual({
      root: "/p",
      git: { dir: "/repo/.git/worktrees/w", common: "/repo/.git" },
    });
    expect(transaction.locationFrom("/p", { status: 128, stdout: "" })).toEqual({ root: "/p", git: null });
    expect(transaction.locationFrom("/p", { status: 0, stdout: "" })).toEqual({ root: "/p", git: null });
  });
});
