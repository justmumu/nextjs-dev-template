import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { memoryDisk } from "../support/memory-disk.ts";
import { parseJson } from "../support/json.ts";

// Decisions of creation and enrollment, judged with in-memory disks, a scripted Git and fake tools.
// The same flows against real repositories, files and processes are in tests/integration/template-*.test.ts.
const require = createRequire(import.meta.url);
const render = require("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");
const transaction = require("../../scripts/template/transaction.cjs") as typeof import("../../scripts/template/transaction.cjs");
const git = require("../../scripts/template/git.cjs") as typeof import("../../scripts/template/git.cjs");
const state = require("../../scripts/template/state.cjs") as typeof import("../../scripts/template/state.cjs");
const create = require("../../scripts/template/create.cjs") as typeof import("../../scripts/template/create.cjs");
const initialize = require("../../scripts/template/initialize.cjs") as typeof import("../../scripts/template/initialize.cjs");

type Host = import("../../scripts/template/transaction.cjs").Host;
type Entry = import("../../scripts/template/git.cjs").IndexEntry;

const fixture = resolve(import.meta.dirname, "../fixtures/render");
const manifest = parseJson(readFileSync(join(fixture, "manifest.json"), "utf8"));
const inputs = { manifest, bases: { template: join(fixture, "template"), root: join(fixture, "root") } };
const answers = { name: "demo-app", owner: "some-owner" };
const { files, digest } = render.renderTree({ ...inputs, answers });

/** Throws what is given, as code of an unknown origin might. */
const throwValue = (value: unknown): never => {
  throw value;
};

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const entryOf = (file: { path: string; mode: number; content: Buffer }, over: Partial<Entry> = {}): Entry => ({
  path: file.path,
  mode: file.mode === 0o755 ? "100755" : "100644",
  sha: git.blobId(file.content),
  stage: "0",
  ...over,
});
const tracked = (path: string, over: Partial<Entry> = {}): Entry => ({ path, mode: "100644", sha: A, stage: "0", ...over });
const rendered = (path: string, text: string, mode = 0o644) => ({ path, mode, content: Buffer.from(text) });

describe("the enrollment state", () => {
  const baseline = { commit: A, tree: B };
  const values = { name: "demo-app", description: "", owner: "o", version: "0.0.0" };
  const local = { kind: "local-generator", revision: C } as const;
  const text = state.serializeState(state.buildState({ baseline, source: local, answers: values, renderDigest: digest }));

  test("round-trips, and names the protocols it was written for", () => {
    const parsed = state.parseState(text);
    expect(parsed).toMatchObject({ schema: "nextjs-dev-template/state", stateVersion: 1, manifestProtocol: 1, baseline, source: local, renderDigest: digest });
    expect(parsed.answersDigest).toBe(state.answersDigest(values));
    expect(state.answersDigest({ ...values, owner: "other" })).not.toBe(parsed.answersDigest);
    expect(text.endsWith("\n")).toBe(true);
  });

  test("a GitHub copy records its own commit and claims no upstream repository or revision", () => {
    const copy = state.parseState(
      state.serializeState(state.buildState({ baseline, source: { kind: "github-template-copy", copiedCommit: C }, answers: values, renderDigest: digest })),
    );
    expect(copy.source).toEqual({ kind: "github-template-copy", copiedCommit: C });
    expect(JSON.stringify(copy)).not.toMatch(/https?:|github\.com|upstream/);
  });

  test.each<[string, (value: Record<string, unknown>) => void, RegExp]>([
    ["an unknown schema", (v) => (v["schema"] = "other"), /unsupported state schema/],
    ["an unknown version", (v) => (v["stateVersion"] = 2), /unsupported state version/],
    ["an unknown key", (v) => (v["extra"] = 1), /unknown key: extra/],
    ["a missing key", (v) => delete v["renderDigest"], /missing renderDigest/],
    ["another manifest protocol", (v) => (v["manifestProtocol"] = 2), /manifest protocol/],
    ["a short baseline commit", (v) => (v["baseline"] = { commit: "abc", tree: B }), /full lowercase object id/],
    ["a baseline that is not an object", (v) => (v["baseline"] = 1), /baseline must be an object/],
    ["a digest that is not a digest", (v) => (v["answersDigest"] = "x"), /sha-256 digest/],
    ["an unknown source kind", (v) => (v["source"] = { kind: "elsewhere" }), /unsupported state source kind/],
    ["a source that is not an object", (v) => (v["source"] = "x"), /source must be an object/],
    ["a local source with extra data", (v) => (v["source"] = { kind: "local-generator", revision: C, url: "x" }), /unknown key: url/],
    ["a short copied commit", (v) => (v["source"] = { kind: "github-template-copy", copiedCommit: "abc" }), /full lowercase object id/],
  ])("refuses %s", (_name, change, message) => {
    const value = parseJson(text);
    change(value);
    expect(() => state.parseState(JSON.stringify(value))).toThrow(message);
  });

  test("refuses text that is not a JSON object", () => {
    expect(() => state.parseState("{")).toThrow(/not valid JSON/);
    expect(() => state.parseState("[]")).toThrow(/must be an object/);
  });
});

describe("workflow parity", () => {
  const flow = rendered(".github/workflows/ci.yml", "on: push\n");
  test("identical bytes and mode pass; the rest of the tree is not compared", () => {
    expect(transaction.workflowParity([entryOf(flow), tracked("README.md")], [flow, rendered("README.md", "other")])).toEqual([]);
    expect(transaction.workflowParity([], [rendered("a.yml", "x")])).toEqual([]);
  });

  test("a difference in bytes, mode, or presence on either side is a problem", () => {
    expect(transaction.workflowParity([entryOf(flow)], [rendered(flow.path, "on: pull_request\n")])).toEqual([expect.stringContaining("differs in bytes")]);
    expect(transaction.workflowParity([entryOf(flow)], [{ ...flow, mode: 0o755 }])).toEqual([expect.stringContaining("differs in mode")]);
    expect(transaction.workflowParity([], [flow])).toEqual([expect.stringContaining("would be added")]);
    expect(transaction.workflowParity([entryOf(flow)], [])).toEqual([expect.stringContaining("would be removed")]);
  });
});

describe("collisions", () => {
  test("an ignored file or directory may stay unless the render writes onto it or through it", () => {
    expect(transaction.ignoredCollisions(["node_modules/", ".env", "coverage/"], ["src/a.ts", ".env.example"])).toEqual([]);
    expect(transaction.ignoredCollisions([".env"], [".env"])).toEqual([expect.stringContaining("ignored file")]);
    expect(transaction.ignoredCollisions(["docs/cache/"], ["docs/cache/a.md"])).toEqual([expect.stringContaining("ignored directory")]);
    expect(transaction.ignoredCollisions(["a/b"], ["a"])).toHaveLength(1);
  });

  test("a tracked symlink or submodule on or above a rendered path is refused", () => {
    expect(transaction.linkProblems([tracked("a.txt")], ["a.txt"])).toEqual([]);
    expect(transaction.linkProblems([tracked("lib", { mode: "120000" })], ["lib/x.ts"])).toEqual([expect.stringContaining("symlink lib")]);
    expect(transaction.linkProblems([tracked("vendor", { mode: "160000" })], ["vendor"])).toEqual([expect.stringContaining("submodule vendor")]);
  });
});

describe("the source repository", () => {
  const clean = { head: A, hidden: [], changes: [], inventory: [tracked("a.txt")] };

  test("a committed, clean repository without hidden flags is fit", () => {
    expect(transaction.sourceProblems(clean)).toEqual([]);
  });

  test("uncommitted work, hidden changes, unmerged entries and an unborn HEAD each refuse it", () => {
    expect(transaction.sourceProblems({ ...clean, head: null })).toEqual([expect.stringContaining("no commit")]);
    const many = Array.from({ length: 7 }, (_, i) => `?? f${String(i)}`);
    expect(transaction.sourceProblems({ ...clean, changes: many })).toEqual([expect.stringMatching(/not clean: .*\?\? f4, \.\.\./)]);
    expect(transaction.sourceProblems({ ...clean, changes: ["?? a"] })[0]).not.toContain("...");
    expect(transaction.sourceProblems({ ...clean, hidden: ["x"] })).toEqual([expect.stringContaining("assume-unchanged or skip-worktree")]);
    expect(transaction.sourceProblems({ ...clean, inventory: [tracked("c", { stage: "1" })] })).toEqual([expect.stringContaining("unmerged entries: c")]);
  });

  test("a moved HEAD, a changed file or new dirt between the first look and the write is drift", () => {
    expect(transaction.sourceDrift(clean, { ...clean })).toEqual([]);
    expect(transaction.sourceDrift(clean, { ...clean, head: B })).toEqual([expect.stringContaining("HEAD moved")]);
    expect(transaction.sourceDrift(clean, { ...clean, head: null })).toEqual(expect.arrayContaining([expect.stringContaining("to nothing")]));
    expect(transaction.sourceDrift({ ...clean, head: null }, clean)).toEqual([expect.stringContaining("from nothing")]);
    expect(transaction.sourceDrift(clean, { ...clean, inventory: [tracked("a.txt", { sha: B })] })).toEqual([expect.stringContaining("tracked files changed")]);
    expect(transaction.sourceDrift(clean, { ...clean, changes: [" M a.txt"] })).toEqual([expect.stringContaining("not clean")]);
  });
});

describe("what validation may leave behind", () => {
  const same = (path: string) => files.find((file) => file.path === path) ?? null;
  const read = (path: string) => same(path);

  test("unchanged files and no leftovers pass", () => {
    expect(transaction.stagingProblems(files, read, [])).toEqual([]);
  });

  test("a rewritten file, a changed mode, a missing file and an untracked leftover are each reported", () => {
    const [first, second, third] = files;
    if (!first || !second || !third) throw new Error("fixture");
    const problems = transaction.stagingProblems(
      files,
      (path) => {
        if (path === first.path) return { content: Buffer.from("formatted"), mode: first.mode };
        if (path === second.path) return { content: second.content, mode: second.mode === 0o755 ? 0o644 : 0o755 };
        if (path === third.path) return null;
        return same(path);
      },
      ["?? out/leftover.txt"],
    );
    expect(problems).toEqual([
      `${first.path} was changed by validation`,
      `${second.path} changed its mode during validation (${second.mode === 0o755 ? "644" : "755"}, rendered ${second.mode.toString(8)})`,
      `${third.path} is gone`,
      "validation left out/leftover.txt uncommitted or untracked",
    ]);
  });
});

describe("what validation may leave behind: permissions", () => {
  test("a permission-only difference with the same bytes and the same executable bit is a change", () => {
    const [first] = files;
    if (!first) throw new Error("fixture");
    const actual = (mode: number) => transaction.stagingProblems([first], () => ({ content: first.content, mode }), []);
    expect(actual(first.mode)).toEqual([]);
    expect(actual(first.mode & 0o600)).toEqual([expect.stringContaining("changed its mode during validation")]);
    expect(actual(first.mode | 0o020)).toEqual([expect.stringContaining("changed its mode")]);
    // The file type bits of a stat are not a permission.
    expect(actual(0o100000 | first.mode)).toEqual([]);
  });
});

describe("the installation plan", () => {
  test("adds new files, replaces what differs and removes what the render does not have", () => {
    const [first, second] = files;
    if (!first || !second) throw new Error("fixture");
    const plan = transaction.planInstall([entryOf(first), entryOf(second, { sha: A }), tracked("generator/only.cjs")], files);
    expect(plan.change.map((file) => file.path)).toEqual([second.path]);
    expect(plan.add.map((file) => file.path)).toEqual(files.filter((file) => file !== first && file !== second).map((file) => file.path));
    expect(plan.remove).toEqual(["generator/only.cjs"]);
    expect(transaction.planInstall([entryOf(first, { mode: first.mode === 0o755 ? "100644" : "100755" })], [first]).change).toHaveLength(1);
  });
});

describe("installing over a source, from a backup", () => {
  const root = "/repo";
  const plan = (add: ReturnType<typeof rendered>[], change: ReturnType<typeof rendered>[], remove: string[]) => ({ add, change, remove });
  const original = {
    "/repo/old.cjs": "old",
    "/repo/keep/a.txt": "A",
    "/repo/keep/b.txt": "B",
    "/repo/gen/only.cjs": "gen",
    "/repo/run.sh": { content: "#!/bin/sh\n", mode: 0o755 },
  };
  const next = [rendered("run.sh", "#!/bin/sh\necho 2\n", 0o755)];

  test("replaces, removes and adds, drops directories it emptied, and keeps nothing it did not need", () => {
    const disk = memoryDisk(original);
    disk.mkdirSync("/backup");
    transaction.installTree({ disk, root, plan: plan([rendered("new/dir/n.txt", "n")], next, ["gen/only.cjs"]), backup: "/backup" });
    expect(disk.paths()).toEqual(expect.arrayContaining(["/repo/new/dir/n.txt", "/repo/run.sh"]));
    expect(disk.paths()).not.toContain("/repo/gen/only.cjs");
    expect(disk.operations).toContain("rmdir /repo/gen");
    expect(disk.readFileSync("/repo/run.sh").toString()).toContain("echo 2");
    expect(disk.readFileSync("/backup/gen/only.cjs").toString()).toBe("gen");
    expect(disk.readFileSync("/backup/run.sh").toString()).toBe("#!/bin/sh\n");
  });

  test("nested directories that its removals empty are each dropped once, and put back by a rollback", () => {
    const disk = memoryDisk({ "/repo/a/b/c.txt": "c", "/repo/a/b/d/e.txt": "e", "/repo/a/keep.txt": "k", "/repo/z.txt": "z" });
    disk.mkdirSync("/backup");
    const { undo } = transaction.installTree({ disk, root, plan: plan([], [], ["a/b/c.txt", "a/b/d/e.txt"]), backup: "/backup" });
    expect(disk.operations.filter((operation) => operation.startsWith("rmdir"))).toEqual(["rmdir /repo/a/b/d", "rmdir /repo/a/b"]);
    expect(undo()).toEqual([]);
    expect(disk.readFileSync("/repo/a/b/d/e.txt").toString()).toBe("e");
    expect(disk.readFileSync("/repo/a/b/c.txt").toString()).toBe("c");
  });

  test("a failure takes every step back: removed files, replaced files, added files and the directories it made", () => {
    const disk = memoryDisk(original);
    disk.mkdirSync("/backup");
    const failing = {
      ...disk,
      writeFileSync: (path: string, content: Buffer, options: { mode: number }) => {
        if (path === "/repo/new/dir/z.txt") throw new Error("disk full");
        disk.writeFileSync(path, content, options);
      },
    };
    expect(() =>
      transaction.installTree({
        disk: failing,
        root,
        plan: plan([rendered("new/dir/n.txt", "n"), rendered("new/dir/z.txt", "z")], next, ["gen/only.cjs"]),
        backup: "/backup",
      }),
    ).toThrow(/installation failed and was taken back: disk full/);
    expect(disk.readFileSync("/repo/gen/only.cjs").toString()).toBe("gen");
    expect(disk.readFileSync("/repo/run.sh").toString()).toBe("#!/bin/sh\n");
    expect(disk.paths().filter((path) => path.startsWith("/repo/new"))).toEqual([]);
    expect(disk.lstatSync("/repo/gen").isDirectory()).toBe(true);
  });

  test("a rollback that cannot restore names the exact paths, and a path changed meanwhile is never overwritten", () => {
    const disk = memoryDisk(original);
    disk.mkdirSync("/backup");
    let installed = 0;
    const racing = {
      ...disk,
      writeFileSync: (path: string, content: Buffer, options: { mode: number }) => {
        if (path.startsWith("/repo/new/")) {
          installed += 1;
          if (installed === 1) {
            disk.writeFileSync(path, content, options);
            disk.writeFileSync(path, Buffer.from("user edit"), options);
            return;
          }
          throw new Error("boom");
        }
        if (path === "/repo/gen/only.cjs") throw new Error("restore refused");
        disk.writeFileSync(path, content, options);
      },
    };
    let caught: unknown;
    try {
      transaction.installTree({
        disk: racing,
        root,
        plan: plan([rendered("new/a.txt", "a"), rendered("new/b.txt", "b")], [], ["gen/only.cjs"]),
        backup: "/backup",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(transaction.InstallError);
    expect((caught as InstanceType<typeof transaction.InstallError>).failures).toEqual(expect.arrayContaining(["/repo/new/a.txt", "/repo/gen/only.cjs"]));
    expect((caught as Error).message).toContain("could not be taken back completely");
    expect(disk.readFileSync("/repo/new/a.txt").toString()).toBe("user edit");
    expect(disk.readFileSync("/backup/gen/only.cjs").toString()).toBe("gen");
  });

  test("a file that is not the regular file Git tracks stops the installation before anything changes", () => {
    const disk = memoryDisk({ ...original, "/repo/link.cjs": { link: "/elsewhere" } });
    expect(() => transaction.installTree({ disk, root, plan: plan([], [], ["link.cjs", "old.cjs"]), backup: "/backup" })).toThrow(
      /link.cjs is not the regular file/,
    );
    expect(disk.operations.filter((operation) => operation.startsWith("unlink"))).toEqual([]);
    expect(() => transaction.installTree({ disk, root, plan: plan([], [], ["keep"]), backup: "/backup" })).toThrow(/not the regular file/);
    expect(() => transaction.installTree({ disk, root, plan: plan([], [], ["missing.cjs"]), backup: "/backup" })).toThrow(/not the regular file/);
  });

  describe("rollback owns only what this installation wrote", () => {
    const swapped = (nodes: Record<string, string | { link: string } | { content: string; mode: number }>, replaceAfterWrite: string) => {
      const disk = memoryDisk(nodes);
      disk.mkdirSync("/backup");
      const racing = {
        ...disk,
        writeFileSync: (path: string, content: Buffer, options: { mode: number }) => {
          disk.writeFileSync(path, content, options);
          if (path === replaceAfterWrite) {
            disk.unlinkSync(path);
            disk.symlinkSync("/outside/user.txt", path);
          }
        },
      };
      return { disk, racing };
    };
    const caught = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error as InstanceType<typeof transaction.InstallError>;
      }
      throw new Error("expected the installation to fail");
    };

    test("a changed file replaced by a link is not written through: the path is named and the link stays", () => {
      const { disk, racing } = swapped({ "/repo/a.txt": "old", "/outside/user.txt": "new" }, "/repo/a.txt");
      const failing = {
        ...racing,
        chmodSync: (path: string, mode: number) => {
          if (path.startsWith("/repo/")) throw new Error("chmod refused");
          racing.chmodSync(path, mode);
        },
      };
      const error = caught(() => transaction.installTree({ disk: failing, root, plan: plan([], [rendered("a.txt", "new")], []), backup: "/backup" }));
      expect(error.failures).toEqual(["/repo/a.txt"]);
      expect(error.message).toContain("could not be taken back completely");
      expect(disk.lstatSync("/repo/a.txt").isSymbolicLink()).toBe(true);
      expect(disk.readFileSync("/outside/user.txt").toString()).toBe("new");
      expect(disk.operations.filter((operation) => operation === "write /outside/user.txt")).toEqual([]);
      expect(disk.operations.filter((operation) => operation === "write /repo/a.txt")).toHaveLength(1);
      expect(disk.readFileSync("/backup/a.txt").toString()).toBe("old");
    });

    test("a new file replaced by a link is not unlinked: the path is named", () => {
      const { disk, racing } = swapped({ "/repo/keep": "k", "/outside/user.txt": "user" }, "/repo/n.txt");
      const failing = {
        ...racing,
        chmodSync: (path: string, mode: number) => {
          if (path.startsWith("/repo/")) throw new Error("chmod refused");
          racing.chmodSync(path, mode);
        },
      };
      const error = caught(() => transaction.installTree({ disk: failing, root, plan: plan([rendered("n.txt", "n")], [], []), backup: "/backup" }));
      expect(error.failures).toEqual(["/repo/n.txt"]);
      expect(disk.lstatSync("/repo/n.txt").isSymbolicLink()).toBe(true);
      expect(disk.operations.filter((operation) => operation.startsWith("unlink"))).toEqual(["unlink /repo/n.txt"]);
    });

    test("a write that fails after changing part of a file is taken back from the backup, not reported as nothing to do", () => {
      const disk = memoryDisk({ "/repo/a.txt": "old\n", "/repo/b.txt": "b" });
      disk.mkdirSync("/backup");
      const tearing = {
        ...disk,
        writeFileSync: (path: string, content: Buffer, options: { mode: number }) => {
          if (path === "/repo/a.txt" && content.toString() === "new\n") {
            disk.writeFileSync(path, content.subarray(0, 1), options);
            throw new Error("disk error after one byte");
          }
          disk.writeFileSync(path, content, options);
        },
      };
      const error = caught(() =>
        transaction.installTree({ disk: tearing, root, plan: plan([rendered("n.txt", "n")], [rendered("a.txt", "new\n")], []), backup: "/backup" }),
      );
      expect(error.message).toBe("installation failed and was taken back: disk error after one byte");
      expect(error.failures).toEqual([]);
      expect(disk.readFileSync("/repo/a.txt").toString()).toBe("old\n");
      expect(disk.paths()).not.toContain("/repo/n.txt");
    });

    test("a torn write whose restore also fails names the file and leaves the backup as the only copy", () => {
      const disk = memoryDisk({ "/repo/a.txt": "old\n" });
      disk.mkdirSync("/backup");
      let writes = 0;
      const tearing = {
        ...disk,
        writeFileSync: (path: string, content: Buffer, options: { mode: number }) => {
          if (path === "/repo/a.txt") {
            writes += 1;
            disk.writeFileSync(path, content.subarray(0, 1), options);
            throw new Error(writes === 1 ? "disk error" : "still failing");
          }
          disk.writeFileSync(path, content, options);
        },
      };
      const error = caught(() => transaction.installTree({ disk: tearing, root, plan: plan([], [rendered("a.txt", "new\n")], []), backup: "/backup" }));
      expect(error.message).toContain("could not be taken back completely");
      expect(error.failures).toEqual(["/repo/a.txt"]);
      expect(disk.readFileSync("/backup/a.txt").toString()).toBe("old\n");
    });

    test("a torn first write leaves an existing file for recovery because its identity was not captured", () => {
      for (const leaves of [false, true]) {
        const disk = memoryDisk({ "/repo/keep": "k" });
        disk.mkdirSync("/backup");
        const tearing = {
          ...disk,
          writeFileSync: (path: string, content: Buffer, options: { mode: number }) => {
            if (path !== "/repo/n.txt") {
              disk.writeFileSync(path, content, options);
              return;
            }
            if (leaves) disk.writeFileSync(path, content.subarray(0, 1), options);
            throw new Error("no space");
          },
        };
        const error = caught(() => transaction.installTree({ disk: tearing, root, plan: plan([rendered("n.txt", "new")], [], []), backup: "/backup" }));
        expect(error.failures).toEqual(leaves ? ["/repo/n.txt"] : []);
        expect(disk.paths().includes("/repo/n.txt")).toBe(leaves);
      }
    });

    test("the permissions a file had are what a rollback restores, and what the backup keeps", () => {
      const disk = memoryDisk({ "/repo/private.txt": { content: "old", mode: 0o600 }, "/repo/gone.txt": { content: "g", mode: 0o640 } });
      disk.mkdirSync("/backup");
      const { undo } = transaction.installTree({ disk, root, plan: plan([], [rendered("private.txt", "new")], ["gone.txt"]), backup: "/backup" });
      expect(disk.lstatSync("/backup/private.txt").mode).toBe(0o600);
      expect(disk.lstatSync("/repo/private.txt").mode).toBe(0o644);
      expect(undo()).toEqual([]);
      expect(disk.lstatSync("/repo/private.txt").mode).toBe(0o600);
      expect(disk.lstatSync("/repo/gone.txt").mode).toBe(0o640);
      expect(disk.readFileSync("/repo/private.txt").toString()).toBe("old");
    });
  });

  test("a symlinked directory on the way is refused, and a successful installation can still be taken back", () => {
    const linked = memoryDisk({ ...original, "/repo/lnk": { link: "/x" } });
    expect(() => transaction.installTree({ disk: linked, root, plan: plan([rendered("lnk/a.txt", "a")], [], []), backup: "/backup" })).toThrow(
      /unsafe directory/,
    );
    const disk = memoryDisk(original);
    disk.mkdirSync("/backup");
    const { undo } = transaction.installTree({ disk, root, plan: plan([rendered("new/n.txt", "n")], next, ["old.cjs"]), backup: "/backup" });
    expect(undo()).toEqual([]);
    expect(disk.readFileSync("/repo/old.cjs").toString()).toBe("old");
    expect(disk.readFileSync("/repo/run.sh").toString()).toBe("#!/bin/sh\n");
    expect(disk.lstatSync("/repo/run.sh").mode).toBe(0o755);
    expect(disk.paths()).not.toContain("/repo/new/n.txt");
  });
});

// ---- the flows, with a recording host -------------------------------------------------------------------

interface World {
  host: Host & { log: string[] };
  io: { stdout: (text: string) => unknown; stderr: (text: string) => unknown };
  out: () => string;
  err: () => string;
}

function world(
  over: {
    git?: Record<string, unknown>;
    run?: Host["run"];
    read?: Host["read"];
    nodes?: Record<string, string>;
    write?: Host["write"];
    smoke?: Host["smoke"];
  } = {},
): World {
  const log: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const base = {
    init: (cwd: string) => log.push(`init ${cwd}`),
    commitPristine: (cwd: string, list: unknown[], options: { parent: string | null }) => {
      log.push(`pristine ${cwd} ${options.parent ?? "root"}`);
      return { commit: B, tree: C };
    },
    commitAsCaller: (cwd: string, paths: string[]) => log.push(`enroll ${cwd} ${paths.join(",")}`),
    changes: () => [] as string[],
    head: () => A,
    hasIdentity: () => true,
    untouched: () => true,
  };
  const host = {
    git: { ...base, ...over.git } as unknown as Host["git"],
    disk: memoryDisk({ "/work/x": "x", "/virtual/created-project/.keep": "", "/scratch/template-staging-/app/public/favicon.svg": "<svg/>", ...over.nodes }),
    scratch: (prefix: string) => {
      log.push(`scratch ${prefix}`);
      return `/scratch/${prefix}`;
    },
    remove: (dir: string) => log.push(`remove ${dir}`),
    write:
      over.write ??
      ((_files: unknown, dir: string) => {
        log.push(`write ${dir}`);
        return { undo: () => log.push(`undo ${dir}`) };
      }),
    read:
      over.read ??
      ((path: string) => {
        const file = files.find((candidate) => path.endsWith(`/${candidate.path}`));
        return file ? { content: file.content, mode: file.mode } : null;
      }),
    run:
      over.run ??
      ((_command: string, args: readonly string[]) => {
        log.push(`run ${args.join(" ")}`);
        return Promise.resolve(0);
      }),
    smoke:
      over.smoke ??
      (() => {
        log.push("smoke");
        return Promise.resolve(null);
      }),
    env: {},
    log,
  } as Host & { log: string[] };
  return { host, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, out: () => out.join(""), err: () => err.join("") };
}

describe("staging validation", () => {
  const go = (w: World, isCancelled = () => false) => transaction.stageAndValidate({ host: w.host, io: w.io, files, isCancelled });

  test("renders into scratch with a committed baseline, runs every step in order, and always removes the scratch", async () => {
    const w = world();
    expect(await go(w)).toBe(true);
    expect(w.host.log).toEqual([
      "scratch template-staging-",
      "write /scratch/template-staging-/app",
      "init /scratch/template-staging-/app",
      "pristine /scratch/template-staging-/app root",
      "run scripts/bootstrap.cjs setup",
      "run run check",
      "run run docs:build",
      "run run build",
      "smoke",
      "remove /scratch/template-staging-",
    ]);
  });

  test("the steps are the application's own setup, check, docs and build", () => {
    expect(transaction.VALIDATION_STEPS.map((step) => `${step.command === process.execPath ? "node" : step.command} ${step.args.join(" ")}`)).toEqual([
      "node scripts/bootstrap.cjs setup",
      "pnpm run check",
      "pnpm run docs:build",
      "pnpm run build",
    ]);
  });

  test("a failing step stops the run, names the step and still removes the scratch", async () => {
    const w = world({ run: (_c, args) => Promise.resolve(args.includes("docs:build") ? 1 : 0) });
    expect(await go(w)).toBe(false);
    expect(w.err()).toMatch(/failed at docs:build; nothing was written to the target/);
    expect(w.host.log.at(-1)).toBe("remove /scratch/template-staging-");
  });

  test("a smoke that fails stops the run, names the reason and still removes the scratch; an interruption during it is no success", async () => {
    const w = world({ smoke: () => Promise.resolve("no page answered") });
    expect(await go(w)).toBe(false);
    expect(w.err()).toMatch(/failed at smoke: no page answered; nothing was written to the target/);
    expect(w.host.log.at(-1)).toBe("remove /scratch/template-staging-");
    let cancelled = false;
    const during = world({
      smoke: () => {
        cancelled = true;
        return Promise.resolve(null);
      },
    });
    expect(await go(during, () => cancelled)).toBe(false);
  });

  test("the nonce asset is in the staged public directory before the build, handed to the smoke, and gone before the purity check and on every exit", async () => {
    const asset = (w: World) => w.host.disk.readdirSync("/scratch/template-staging-/app/public").filter((name) => name.startsWith("template-smoke-"));
    let seen: { nonce: string; present: string[]; body: string } | null = null;
    let builtWith: string[] | null = null;
    const w = world({
      run: (_command, args) => {
        if (args.includes("build")) builtWith = asset(w);
        return Promise.resolve(0);
      },
      smoke: ({ nonce }) => {
        const present = asset(w);
        seen = {
          nonce,
          present,
          body: present.length === 1 ? w.host.disk.readFileSync(`/scratch/template-staging-/app/public/${present[0] ?? ""}`).toString() : "",
        };
        return Promise.resolve(null);
      },
    });
    expect(await go(w)).toBe(true);
    const { nonce, present, body } = seen as unknown as { nonce: string; present: string[]; body: string };
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(present).toEqual([`template-smoke-${nonce}.txt`]);
    expect(builtWith).toEqual(present);
    expect(body).toBe(nonce);
    expect(asset(w)).toEqual([]);
    for (const failing of [{ build: 1 }, { smoke: "no page" }]) {
      const f = world({
        run: (_c, args) => Promise.resolve("build" in failing && args.includes("build") ? 1 : 0),
        smoke: () => Promise.resolve("smoke" in failing ? "no page" : null),
      });
      expect(await go(f)).toBe(false);
      expect(asset(f)).toEqual([]);
    }
    // The build step plants it; a failure before the build never creates it.
    const early = world({ run: (_c, args) => Promise.resolve(args.includes("check") ? 1 : 0) });
    expect(await go(early)).toBe(false);
    expect(early.host.disk.readdirSync("/scratch/template-staging-/app/public")).toEqual(["favicon.svg"]);
  });

  test("a command that did not even start fails the run", async () => {
    expect(await go(world({ run: () => Promise.resolve(null) }))).toBe(false);
  });

  test("a validator that rewrote a rendered file fails the run instead of adopting its output", async () => {
    const w = world({ read: () => ({ content: Buffer.from("reformatted"), mode: 0o644 }) });
    expect(await go(w)).toBe(false);
    expect(w.err()).toMatch(/changed the rendered application.*was changed by validation/s);
  });

  test("an interruption stops before the next step, whether it arrives between steps or during one", async () => {
    let cancelled = false;
    const between = world({ run: () => Promise.resolve(0) });
    expect(await go(between, () => cancelled)).toBe(true);
    const early = world();
    cancelled = true;
    expect(await go(early, () => cancelled)).toBe(false);
    expect(early.host.log.filter((line) => line.startsWith("run"))).toEqual([]);
    cancelled = false;
    const during = world({
      run: () => {
        cancelled = true;
        return Promise.resolve(0);
      },
    });
    expect(await go(during, () => cancelled)).toBe(false);
    expect(during.host.log.filter((line) => line.startsWith("run"))).toEqual([]);
    expect(during.host.log.at(-1)).toMatch(/^remove/);
  });
});

describe("enrollment", () => {
  const input = (w: World) => ({
    host: w.host,
    io: w.io,
    root: "/work",
    state: {
      baseline: { commit: B, tree: C },
      source: { kind: "local-generator", revision: A } as const,
      answers: { name: "demo-app", description: "", owner: "o", version: "0.0.0" },
      renderDigest: digest,
    },
  });

  test("writes the state file and commits it as the caller", () => {
    const w = world();
    expect(transaction.enroll(input(w))).toEqual({ ok: true, commit: A });
    expect(w.host.log).toEqual(["enroll /work .template-state.json"]);
    expect(state.parseState(w.host.disk.readFileSync("/work/.template-state.json").toString()).baseline).toEqual({ commit: B, tree: C });
  });

  test("a commit that fails is not success, and says what remains and that nothing of the user's was removed", () => {
    const w = world({
      git: {
        commitAsCaller: () => {
          throw new Error("hook failed");
        },
      },
    });
    expect(transaction.enroll(input(w))).toEqual({ ok: false });
    expect(w.err()).toMatch(/hook failed.*pristine commit b+ and \.template-state\.json are in \/work; no file of yours was removed/s);
  });

  test("a commit that succeeds but leaves changes behind is not success", () => {
    const w = world({ git: { changes: () => ["?? stray"] } });
    expect(transaction.enroll(input(w)).ok).toBe(false);
    expect(w.err()).toContain("?? stray");
    const text = world({
      git: {
        commitAsCaller: () => {
          throwValue("plain text");
        },
      },
    });
    expect(transaction.enroll(input(text)).ok).toBe(false);
    expect(text.err()).toContain("plain text");
  });
});

describe("source revision of a local render", () => {
  const read = (changes: string[], head: string | null = A, hidden: string[] = []) => ({
    git: { head: () => head, changes: () => changes, hiddenFlags: () => hidden } as unknown as Host["git"],
    root: "/gen",
    manifest,
  });

  test("lists what the render reads: declared sources, the manifest and the renderer", () => {
    const parsed = {
      entries: [
        { base: "template", source: "package.json" },
        { base: "root", source: ".node-version" },
      ],
    };
    expect(create.sourcePaths(parsed)).toEqual([".node-version", "scripts/template", "template/app/package.json", "tooling/template-manifest.json"]);
  });

  test("is claimed only for a committed generator whose render inputs are unchanged", () => {
    expect(create.generatorSource(read([" M README.md", "?? scratch.txt"]))).toEqual({ kind: "local-generator", revision: A });
    expect(() => create.generatorSource(read([], null))).toThrow(/no commit/);
    expect(() => create.generatorSource(read([" M scripts/template/render.cjs"]))).toThrow(/uncommitted changes in what the render reads/);
    expect(() => create.generatorSource(read(["?? scripts/template/new.cjs"]))).toThrow(/uncommitted changes/);
  });

  test("a file the render reads that Git is told to ignore changes of makes the revision untrue", () => {
    expect(create.generatorSource(read([], A, ["README.md", "docs/guide.md"]))).toEqual({ kind: "local-generator", revision: A });
    expect(() => create.generatorSource(read([], A, ["scripts/template/render.cjs"]))).toThrow(/hide their changes from Git.*scripts\/template\/render\.cjs/);
    expect(() => create.generatorSource(read([], A, ["tooling/template-manifest.json"]))).toThrow(/assume-unchanged or skip-worktree/);
  });

  test("the nearest existing ancestor of a destination is where the identity is checked", () => {
    const w = world();
    expect(create.nearestExisting(w.host, "/work/new/deep")).toBe("/work");
    expect(create.nearestExisting(w.host, "/nowhere/at/all")).toBe("/");
  });
});

describe("local creation", () => {
  const dest = "/virtual/created-project";
  const run = (w: World, over: { isCancelled?: () => boolean } = {}) =>
    create.createLocal({
      host: w.host,
      io: w.io,
      isCancelled: over.isCancelled ?? (() => false),
      inputs,
      answers,
      dest,
      source: () => ({ kind: "local-generator", revision: C }),
    });

  test("validates in staging, then writes, records the pristine commit and enrolls, in that order", async () => {
    const w = world();
    expect(await run(w)).toBe(0);
    const log = w.host.log.filter((line) => !line.startsWith("run") && !line.startsWith("scratch"));
    expect(log).toEqual([
      "write /scratch/template-staging-/app",
      "init /scratch/template-staging-/app",
      "pristine /scratch/template-staging-/app root",
      "smoke",
      "remove /scratch/template-staging-",
      `write ${dest}`,
      `init ${dest}`,
      `pristine ${dest} root`,
      `enroll ${dest} .template-state.json`,
    ]);
    expect(
      JSON.parse(
        w
          .out()
          .split("\n")
          .filter((line) => line.startsWith("{"))[0] ?? "{}",
      ),
    ).toEqual({ files: files.length, digest, baseline: B, enrollment: A });
    expect(w.out()).toMatch(/no Git hooks yet.*staging copy/);
  });

  test("a missing Git identity stops before anything is staged or written", async () => {
    const w = world({ git: { hasIdentity: () => false } });
    expect(await run(w)).toBe(1);
    expect(w.err()).toMatch(/no author or committer identity/);
    expect(w.host.log).toEqual([]);
  });

  test("a failed validation, or an interruption, writes nothing to the target", async () => {
    const failed = world({ run: () => Promise.resolve(1) });
    expect(await run(failed)).toBe(1);
    expect(failed.host.log.filter((line) => line.includes(dest))).toEqual([]);
    const stopped = world();
    expect(await run(stopped, { isCancelled: () => true })).toBe(1);
    expect(stopped.host.log.filter((line) => line.includes(dest))).toEqual([]);
  });

  test("a failure to record the pristine commit takes back the repository and the files it wrote", async () => {
    const w = world({
      git: {
        commitPristine: (cwd: string) => {
          if (cwd === dest) throw new Error("index.lock exists");
          return { commit: B, tree: C };
        },
      },
    });
    expect(await run(w)).toBe(1);
    expect(w.host.log.slice(-3)).toEqual([`init ${dest}`, `remove ${dest}/.git`, `undo ${dest}`]);
    expect(w.err()).toMatch(/taken back: index.lock exists/);
    const plain = world({
      git: {
        init: (cwd: string) => {
          if (cwd === dest) throwValue("no git");
        },
      },
    });
    expect(await run(plain)).toBe(1);
    expect(plain.err()).toContain("no git");
  });

  test("a repository that is no longer the empty one it made is kept with everything in it, and says so", async () => {
    const w = world({
      git: {
        commitPristine: (cwd: string) => {
          if (cwd === dest) throw new Error("HEAD is no longer unborn");
          return { commit: B, tree: C };
        },
        untouched: (cwd: string) => cwd !== dest,
      },
    });
    expect(await run(w)).toBe(1);
    expect(w.host.log.filter((line) => line.startsWith("remove") && line.includes(dest))).toEqual([]);
    expect(w.host.log.filter((line) => line.startsWith("undo"))).toEqual([]);
    expect(w.err()).toMatch(
      /HEAD is no longer unborn\), and the repository in \/virtual\/created-project is no longer empty: it was changed meanwhile, so nothing was removed/,
    );
  });

  test("a failed enrollment is not success and keeps the project", async () => {
    const w = world({
      git: {
        commitAsCaller: () => {
          throw new Error("commit-msg hook rejected");
        },
      },
    });
    expect(await run(w)).toBe(1);
    expect(w.err()).toMatch(/commit-msg hook rejected/);
    expect(w.host.log.some((line) => line.startsWith("undo") || line.startsWith("remove /virtual"))).toBe(false);
  });

  test("refuses invalid answers and a destination that is not empty before any other step", async () => {
    const w = world();
    await expect(
      create.createLocal({
        host: w.host,
        io: w.io,
        isCancelled: () => false,
        inputs,
        answers: { name: "Bad Name" },
        dest,
        source: () => ({ kind: "local-generator", revision: C }),
      }),
    ).rejects.toThrow(/lowercase npm package name/);
    await expect(
      create.createLocal({
        host: w.host,
        io: w.io,
        isCancelled: () => false,
        inputs,
        answers,
        dest: "relative",
        source: () => ({ kind: "local-generator", revision: C }),
      }),
    ).rejects.toThrow(/absolute/);
    expect(w.host.log).toEqual([]);
  });
});

describe("GitHub initialization", () => {
  const root = "/copy";
  const nodes = { "/copy/tooling/project-role.json": JSON.stringify({ role: "generator" }) };
  const copyNodes = { ...nodes, "/copy/scripts/template/render.cjs": "gen", "/copy/tooling/template-sentinel.json": "{}" };
  const copyEntries = [tracked("tooling/project-role.json"), tracked(initialize.SENTINEL), tracked("scripts/template/render.cjs")];
  const gitOver = (over: Record<string, unknown> = {}) => ({
    toplevel: () => root,
    committed: () => false,
    origin: () => null,
    ignored: () => [] as string[],
    hiddenFlags: () => [] as string[],
    inventory: () => copyEntries,
    treeOf: () => C,
    ...over,
  });
  const run = (w: World) => initialize.initializeCopy({ host: w.host, io: w.io, isCancelled: () => false, root, inputs, answers });

  test("converts the copy: validate in staging, install from a backup, B0 as a child of O, then E0", async () => {
    const w = world({ git: gitOver(), nodes: copyNodes });
    expect(await run(w)).toBe(0);
    const log = w.host.log.filter((line) => !line.startsWith("run") && !line.startsWith("scratch"));
    expect(log).toEqual([
      "write /scratch/template-staging-/app",
      "init /scratch/template-staging-/app",
      "pristine /scratch/template-staging-/app root",
      "smoke",
      "remove /scratch/template-staging-",
      `pristine ${root} ${A}`,
      "remove /scratch/template-backup-",
      `enroll ${root} .template-state.json`,
    ]);
    const report = JSON.parse(
      w
        .out()
        .split("\n")
        .filter((line) => line.startsWith("{"))[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(report).toMatchObject({ copiedCommit: A, baseline: B, enrollment: A });
    const enrolled = state.parseState(w.host.disk.readFileSync("/copy/.template-state.json").toString());
    expect(enrolled.source).toEqual({ kind: "github-template-copy", copiedCommit: A });
  });

  test("a repository that already has the committed state is initialized: nothing happens", async () => {
    const w = world({ git: gitOver({ committed: () => true }) });
    expect(await run(w)).toBe(0);
    expect(w.out()).toMatch(/already initialized/);
    expect(w.host.log).toEqual([]);
  });

  test("anything that is not an uninitialized generator copy is refused untouched", async () => {
    for (const w of [
      world({ git: gitOver(), nodes: {} }),
      world({ git: gitOver({ inventory: () => [tracked("tooling/project-role.json")] }), nodes }),
      world({ git: gitOver(), nodes: { "/copy/tooling/project-role.json": JSON.stringify({ role: "application" }) } }),
      world({ git: gitOver(), nodes: { "/copy/tooling/project-role.json": "{" } }),
      world({ git: gitOver({ toplevel: () => "/elsewhere" }), nodes }),
    ]) {
      expect(await run(w)).toBe(1);
      expect(w.host.log).toEqual([]);
    }
  });

  test("the origin must be the new repository; a checkout of the template itself is never converted", () => {
    const names = { name: "@scope/demo-app", owner: "Some-Owner" };
    expect(initialize.originProblem(null, names)).toBeNull();
    expect(initialize.originProblem("https://github.com/some-owner/demo-app.git", names)).toBeNull();
    expect(initialize.originProblem("git@github.com:some-owner/demo-app", names)).toBeNull();
    expect(initialize.originProblem("https://github.com/someone/template", names)).toMatch(/not the repository some-owner\/demo-app/);
    expect(initialize.originProblem("https://example.com/x.git", names)).toMatch(/does not name a GitHub repository/);
    expect(initialize.originProblem("https://github.com/o/r", { name: "r", owner: null })).toMatch(/not the repository \/r/);
  });

  test("the template's own repository is refused whatever the answers name, over any spelling of its origin", () => {
    const own = { name: "nextjs-dev-template", owner: "justmumu" };
    for (const origin of [
      "https://github.com/justmumu/nextjs-dev-template.git",
      "https://github.com/justmumu/nextjs-dev-template",
      "git@github.com:justmumu/nextjs-dev-template.git",
      "https://token@github.com/JustMumu/Nextjs-Dev-Template/",
    ]) {
      expect(initialize.originProblem(origin, own)).toMatch(/justmumu\/nextjs-dev-template, the template itself/);
      expect(initialize.originProblem(origin, { name: "@scope/demo-app", owner: "Some-Owner" })).toMatch(/the template itself/);
    }
    expect(initialize.originProblem("https://github.com/justmumu/nextjs-dev-template-fork.git", own)).toMatch(
      /not the repository justmumu\/nextjs-dev-template/,
    );
  });

  test("every precondition is reported together, and nothing is staged: dirt, hidden flags, links, ignored collisions, workflows, origin", async () => {
    const files = render.renderTree({ ...inputs, answers }).files;
    const first = files[0];
    if (!first) throw new Error("fixture");
    const w = world({
      git: gitOver({
        origin: () => "https://github.com/template/owner",
        changes: () => ["?? dirt"],
        hiddenFlags: () => ["hidden.txt"],
        inventory: () => [...copyEntries, tracked(first.path, { mode: "120000" }), tracked(".github/workflows/ci.yml")],
        ignored: () => [first.path],
      }),
      nodes,
    });
    expect(await run(w)).toBe(1);
    for (const expected of [/origin is template\/owner/, /not clean/, /assume-unchanged/, /symlink/, /ignored file/, /would be removed/])
      expect(w.err()).toMatch(expected);
    expect(w.host.log).toEqual([]);
  });

  test("a failed validation leaves the copy untouched, and so does drift during validation", async () => {
    const failed = world({ git: gitOver(), nodes, run: () => Promise.resolve(1) });
    expect(await run(failed)).toBe(1);
    expect(failed.host.log.some((line) => line.includes(`pristine ${root}`))).toBe(false);
    let heads = 0;
    const moved = world({ git: gitOver({ head: () => (heads++ === 0 ? A : C) }), nodes });
    expect(await run(moved)).toBe(1);
    expect(moved.err()).toMatch(/changed during validation.*HEAD moved/s);
    expect(moved.host.log.some((line) => line.includes(`pristine ${root}`))).toBe(false);
    const cancelled = await initialize.initializeCopy({
      host: world({ git: gitOver(), nodes }).host,
      io: failed.io,
      isCancelled: () => true,
      root,
      inputs,
      answers,
    });
    expect(cancelled).toBe(1);
  });

  test("a failure to record B0 puts the files back, leaves the index and HEAD alone (it never wrote them) and drops the backup", async () => {
    const w = world({
      git: gitOver({
        commitPristine: (cwd: string) => {
          if (cwd === root) throw new Error("index.lock exists");
          return { commit: B, tree: C };
        },
      }),
      nodes: copyNodes,
    });
    expect(await run(w)).toBe(1);
    expect(w.err()).toMatch(/index.lock exists/);
    expect(w.host.log.some((line) => line.startsWith("reset"))).toBe(false);
    expect(w.host.log.at(-1)).toBe("remove /scratch/template-backup-");
    expect(w.host.disk.readFileSync("/copy/scripts/template/render.cjs").toString()).toBe("gen");
    expect(() => w.host.disk.lstatSync("/copy/package.json")).toThrow(/ENOENT/);
    expect(w.host.log.some((line) => line.startsWith("enroll"))).toBe(false);
  });

  test("when the installation cannot be taken back the backup is kept and the paths are named", async () => {
    const base = world({ git: gitOver(), nodes: copyNodes });
    const real = base.host.disk;
    base.host.disk = {
      ...real,
      writeFileSync: (path: string, content: Buffer, options: { mode: number }) => {
        if (path === "/copy/package.json") throw new Error("disk full");
        if (path === "/copy/scripts/template/render.cjs") throw new Error("read-only");
        real.writeFileSync(path, content, options);
      },
    };
    expect(await run(base)).toBe(1);
    expect(base.err()).toMatch(/could not be restored: .*render\.cjs.*Your original files are kept in \/scratch\/template-backup-/s);
    expect(base.host.log).not.toContain("remove /scratch/template-backup-");
  });

  test("a HEAD or index that changed meanwhile is never undone over: the installation, the backup and their paths stay", async () => {
    for (const moves of ["head", "index"]) {
      let failed = false;
      const w = world({
        git: gitOver({
          commitPristine: (cwd: string) => {
            if (cwd === root) {
              failed = true;
              throw new Error("HEAD is no longer " + A);
            }
            return { commit: B, tree: C };
          },
          head: () => (failed && moves === "head" ? C : A),
          inventory: () => (failed && moves === "index" ? [...copyEntries, tracked("user.txt")] : copyEntries),
        }),
        nodes: copyNodes,
      });
      expect(await run(w)).toBe(1);
      expect(w.err()).toMatch(/changed while the pristine commit was made, so nothing was undone/);
      expect(w.err()).toContain("/scratch/template-backup-");
      expect(w.host.log).not.toContain("remove /scratch/template-backup-");
      // The installed files stay: they may be part of what somebody committed.
      expect(w.host.disk.lstatSync("/copy/package.json").isSymbolicLink()).toBe(false);
      expect(w.host.log.some((line) => line.startsWith("enroll"))).toBe(false);
    }
  });

  test("a failed enrollment after B0 is not success; B0 and the state stay", async () => {
    const w = world({
      git: gitOver({
        commitAsCaller: () => {
          throw new Error("hook");
        },
      }),
      nodes: copyNodes,
    });
    expect(await run(w)).toBe(1);
    expect(w.err()).toMatch(/enrollment did not complete: hook/);
  });
});
