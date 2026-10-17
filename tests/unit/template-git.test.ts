import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { parseJson } from "../support/json.ts";

// The Git runner the template tooling uses, with Git scripted: which commands it issues, how it reads
// their output and what it refuses. Real repositories are in tests/integration/template-*.test.ts.
const require = createRequire(import.meta.url);
const render = require("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");
const git = require("../../scripts/template/git.cjs") as typeof import("../../scripts/template/git.cjs");

type Entry = import("../../scripts/template/git.cjs").IndexEntry;

const fixture = resolve(import.meta.dirname, "../fixtures/render");
const manifest = parseJson(readFileSync(join(fixture, "manifest.json"), "utf8"));
const inputs = { manifest, bases: { template: join(fixture, "template"), root: join(fixture, "root") } };
const { files } = render.renderTree({ ...inputs, answers: { name: "demo-app", owner: "some-owner" } });

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

describe("git object ids and trees", () => {
  test("a blob id is the one Git gives the bytes", () => {
    expect(git.blobId(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  test("the index must be exactly the rendered files, with their bytes and modes", () => {
    expect(
      git.treeProblems(
        files.map((file) => entryOf(file)),
        files,
      ),
    ).toEqual([]);
    const [first, second, third] = files;
    if (!first || !second || !third) throw new Error("fixture");
    const problems = git.treeProblems(
      [
        entryOf(first, { stage: "2" }),
        entryOf(second, { mode: "100755" === entryOf(second).mode ? "100644" : "100755" }),
        entryOf(third, { sha: A }),
        tracked("extra.txt"),
      ],
      files,
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${first.path} is unmerged`),
        expect.stringContaining(`${second.path} has mode`),
        expect.stringContaining(`${third.path} differs from the rendered bytes`),
        expect.stringContaining("extra.txt is in the index but was not rendered"),
      ]),
    );
    expect(git.treeProblems([], files)).toHaveLength(files.length);
  });

  test("the generator's own objects read no configuration of the machine and carry its own identity", () => {
    const own = git.internalEnv({ HOME: "/h", GIT_DIR: "/x", GIT_AUTHOR_NAME: "Someone", PATH: "/bin" });
    expect(own).toMatchObject({ PATH: "/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_EMAIL: git.PROVENANCE.email });
    expect(own).not.toHaveProperty("GIT_DIR");
    expect(own["GIT_AUTHOR_NAME"]).toBe(git.PROVENANCE.name);
    expect(git.PROVENANCE.email).toMatch(/@users\.noreply\.github\.com$/);
  });

  test("the caller's environment keeps its Git configuration but cannot point Git at another repository", () => {
    const env = git.userEnv({ GIT_CONFIG_GLOBAL: "/c", GIT_DIR: "/other", GIT_INDEX_FILE: "/i", PATH: "/bin" });
    expect(env).toEqual({ GIT_CONFIG_GLOBAL: "/c", PATH: "/bin" });
  });
});

describe("the Git runner", () => {
  type Call = { args: string[]; env: NodeJS.ProcessEnv };
  const scripted = (answer: (args: string[]) => { status?: number | null; stdout?: string; stderr?: string }) => {
    const calls: Call[] = [];
    const start = (_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      const stripped = args.filter((arg) => !["--literal-pathspecs", "core.quotepath=false", "core.autocrlf=false", "core.safecrlf=false", "-c"].includes(arg));
      calls.push({ args: stripped, env: options.env ?? {} });
      const { status = 0, stdout = "", stderr = "" } = answer(stripped);
      return { status, stdout, stderr };
    };
    return { calls, runner: git.createGit({ start, env: { GIT_CONFIG_GLOBAL: "/caller", HOME: "/h" } }) };
  };

  test("reads the index, hidden flags, changes and ignored paths from NUL-separated output", () => {
    const { runner } = scripted((args) => {
      const [command] = args;
      if (command === "ls-files" && args.includes("-s")) return { stdout: `100644 ${A} 0\ta b.txt\u0000120000 ${B} 0\tlink\u0000` };
      if (command === "ls-files" && args.includes("-v")) return { stdout: "H kept\u0000h hidden.txt\u0000S skipped.txt\u0000" };
      if (command === "ls-files") return { stdout: "node_modules/\u0000.env\u0000" };
      if (command === "status") return { stdout: "?? new.txt\u0000 M old.txt\u0000" };
      return { status: 1 };
    });
    expect(runner.inventory("/r")).toEqual([
      { mode: "100644", sha: A, stage: "0", path: "a b.txt" },
      { mode: "120000", sha: B, stage: "0", path: "link" },
    ]);
    expect(runner.hiddenFlags("/r")).toEqual(["hidden.txt", "skipped.txt"]);
    expect(runner.changes("/r")).toEqual(["?? new.txt", " M old.txt"]);
    expect(runner.ignored("/r")).toEqual(["node_modules/", ".env"]);
  });

  test("an unreadable index entry or a failed command is an error that says what failed", () => {
    expect(() => scripted(() => ({ stdout: "garbage\u0000" })).runner.inventory("/r")).toThrow(/unreadable index entry/);
    expect(() => scripted(() => ({ status: 128, stderr: "fatal: not a repo\n" })).runner.toplevel("/r")).toThrow(
      /rev-parse --show-toplevel failed: fatal: not a repo/,
    );
    expect(() => scripted(() => ({ status: null })).runner.treeOf("/r", "HEAD")).toThrow(/exit null/);
  });

  test("head, origin and identity answer null or false when Git has none", () => {
    const none = scripted(() => ({ status: 1 })).runner;
    expect(none.head("/r")).toBeNull();
    expect(none.origin("/r")).toBeNull();
    expect(none.hasIdentity("/r")).toBe(false);
    const some = scripted(() => ({ stdout: `${A}\n` })).runner;
    expect(some.head("/r")).toBe(A);
    expect(some.origin("/r")).toBe(A);
    expect(some.hasIdentity("/r")).toBe(true);
    expect(some.toplevel("/r")).toBe(A);
    expect(some.treeOf("/r", "HEAD")).toBe(A);
  });

  const listing = (list: readonly { path: string; mode: number; content: Buffer }[]) =>
    list.map((file) => `${entryOf(file).mode} ${entryOf(file).sha} 0\t${file.path}\u0000`).join("");
  const held = files.map((file) => entryOf(file));

  test("a pristine commit builds the tree in an index of its own, moves HEAD only from the expected commit, then adopts the commit into the real index", () => {
    const { calls, runner } = scripted((args) => {
      if (args[0] === "rev-parse") return { stdout: "/r/.git\n" };
      if (args[0] === "ls-files") return { stdout: listing(files) };
      if (args[0] === "write-tree") return { stdout: `${B}\n` };
      if (args[0] === "commit-tree") return { stdout: `${C}\n` };
      return {};
    });
    expect(runner.commitPristine("/r", files, { parent: A, message: "m", index: held })).toEqual({ commit: C, tree: B });
    expect(calls.map((call) => call.args[0])).toEqual([
      "rev-parse",
      "read-tree",
      "add",
      "ls-files",
      "write-tree",
      "commit-tree",
      "ls-files",
      "update-ref",
      "ls-files",
      "read-tree",
      "update-index",
    ]);
    expect(calls.find((call) => call.args[0] === "add")?.args).toEqual(["add", "-f", "--", ...files.map((file) => file.path)]);
    expect(calls.find((call) => call.args[0] === "commit-tree")?.args).toEqual(["commit-tree", B, "-p", A, "-m", "m"]);
    const privateIndex = calls.find((call) => call.args[0] === "add")?.env["GIT_INDEX_FILE"];
    expect(privateIndex).toMatch(/^\/r\/\.git\/template-pristine-.*\.index$/);
    // Only the tree construction uses the private index; the real index is read, then replaced, and never written before HEAD moved.
    const withPrivate = calls.filter((call) => call.env["GIT_INDEX_FILE"] === privateIndex).map((call) => call.args[0]);
    expect(withPrivate).toEqual(["read-tree", "add", "ls-files", "write-tree"]);
    const update = calls.findIndex((call) => call.args[0] === "update-ref");
    expect(calls[update]?.args).toEqual(["update-ref", "-m", "m", "HEAD", C, A]);
    expect(calls.slice(update + 1).map((call) => call.args.join(" "))).toEqual(["ls-files -s -z", `read-tree -m -i ${A} ${C}`, "update-index -q --refresh"]);
    // Everything that writes runs with the generator's own identity and no configuration of the machine; the two reads of the real index are the caller's.
    const writes = calls.filter((call) => call.args[0] !== "ls-files" || call.env["GIT_INDEX_FILE"] !== undefined);
    expect(writes.every((call) => call.env["GIT_CONFIG_GLOBAL"] === "/dev/null" && call.env["GIT_AUTHOR_EMAIL"] === git.PROVENANCE.email)).toBe(true);
  });

  test("a first commit has no parent and expects HEAD not to exist; a tree that is not the rendered one is refused", () => {
    const first = scripted((args) => {
      if (args[0] === "ls-files") return { stdout: "" };
      return { stdout: `${C}\n` };
    });
    first.runner.commitPristine("/r", [], { parent: null, message: "m", index: [] });
    expect(first.calls.find((call) => call.args[0] === "commit-tree")?.args).not.toContain("-p");
    expect(first.calls.find((call) => call.args[0] === "update-ref")?.args.at(-1)).toBe("0".repeat(40));
    const bent = scripted((args) => (args[0] === "ls-files" ? { stdout: "" } : {}));
    expect(() => bent.runner.commitPristine("/r", files, { parent: null, message: "m", index: [] })).toThrow(/pristine tree is not the rendered tree/);
    expect(bent.calls.map((call) => call.args[0])).not.toContain("update-ref");
  });

  test("a real index that is not the one the caller saw stops the commit before HEAD moves, and an HEAD that moved is never overwritten", () => {
    const staged = scripted((args) => {
      if (args[0] === "ls-files") return { stdout: listing(files) };
      return { stdout: `${C}\n` };
    });
    // The private index reads back the rendered files; the real one is expected to be empty but is not.
    expect(() => staged.runner.commitPristine("/r", files, { parent: A, message: "m", index: [] })).toThrow(/index changed before HEAD was moved/);
    expect(staged.calls.map((call) => call.args[0])).not.toContain("update-ref");
    const moved = scripted((args) => {
      if (args[0] === "ls-files") return { stdout: listing(files) };
      if (args[0] === "update-ref") return { status: 128, stderr: "fatal: cannot lock ref 'HEAD': is at X but expected A\n" };
      return { stdout: `${C}\n` };
    });
    expect(() => moved.runner.commitPristine("/r", files, { parent: A, message: "m", index: held })).toThrow(/HEAD is no longer .*it was not moved/);
    expect(moved.calls.map((call) => call.args[0])).not.toContain("update-index");
    let reads = 0;
    const changing = scripted((args) => {
      if (args[0] === "ls-files") {
        reads += 1;
        // The third reading is the real index after HEAD moved: somebody staged something in between.
        return { stdout: reads === 3 ? "" : listing(files) };
      }
      return { stdout: `${C}\n` };
    });
    expect(() => changing.runner.commitPristine("/r", files, { parent: A, message: "m", index: held })).toThrow(/index changed after HEAD moved/);
    expect(changing.calls.map((call) => call.args[0])).not.toContain("update-index");
    expect(changing.calls.filter((call) => call.args[0] === "read-tree").map((call) => call.args.join(" "))).toEqual(["read-tree --empty"]);
  });

  test("a large tree is added in chunks, init uses no template, and the enrollment commit is the caller's, with hooks", () => {
    const many = Array.from({ length: 250 }, (_, i) => rendered(`f${String(i)}.txt`, String(i)));
    const { calls, runner } = scripted((args) => {
      if (args[0] === "ls-files") return { stdout: many.map((file) => `100644 ${git.blobId(file.content)} 0\t${file.path}\u0000`).join("") };
      if (args[0] === "diff") return { stdout: ".template-state.json\u0000" };
      return { stdout: `${C}\n` };
    });
    runner.commitPristine("/r", many, { parent: null, message: "m", index: many.map((file) => entryOf(file)) });
    expect(calls.filter((call) => call.args[0] === "add")).toHaveLength(3);
    runner.init("/r");
    runner.commitAsCaller("/r", [".template-state.json"], "msg", { head: C });
    expect(calls.find((call) => call.args[0] === "init")?.args).toEqual(["init", "--quiet", "--initial-branch=main", "--template=", "."]);
    const asCaller = calls.filter((call) => call.args[0] === "commit");
    expect(asCaller).toHaveLength(1);
    expect(asCaller[0]?.env["GIT_CONFIG_GLOBAL"]).toBe("/caller");
    expect(asCaller[0]?.args).toEqual(["commit", "--quiet", "-m", "msg", "--only", "--", ".template-state.json"]);
    expect(asCaller[0]?.args).not.toContain("--no-verify");
  });

  test("the enrollment commit refuses when HEAD moved or anything but its own paths is staged, and unstages only its own", () => {
    const moved = scripted((args) => (args[0] === "rev-parse" ? { stdout: `${A}\n` } : {}));
    expect(() => {
      moved.runner.commitAsCaller("/r", ["s.json"], "msg", { head: B });
    }).toThrow(/HEAD is no longer b+; nothing was committed/);
    expect(moved.calls.map((call) => call.args[0])).toEqual(["rev-parse"]);
    const dirty = scripted((args) => (args[0] === "diff" ? { stdout: "s.json\u0000user.txt\u0000" } : {}));
    expect(() => {
      dirty.runner.commitAsCaller("/r", ["s.json"], "msg");
    }).toThrow(/other changes are staged \(user\.txt\); nothing was committed/);
    expect(dirty.calls.map((call) => call.args[0])).toEqual(["add", "diff", "reset"]);
    expect(dirty.calls.at(-1)?.args).toEqual(["reset", "-q", "--", "s.json"]);
  });

  test("a repository is untouched only while it has no commit, no ref and an empty index; anything unreadable is not provable", () => {
    const answers = (head: number, refs: string, index: string) =>
      scripted((args) => {
        if (args[0] === "rev-parse") return { status: head, stdout: head === 0 ? `${A}\n` : "" };
        if (args[0] === "for-each-ref") return { stdout: refs };
        return { stdout: index };
      }).runner;
    expect(answers(1, "", "").untouched("/r")).toBe(true);
    expect(answers(0, "", "").untouched("/r")).toBe(false);
    expect(answers(1, "refs/heads/main\n", "").untouched("/r")).toBe(false);
    expect(answers(1, "", `100644 ${A} 0\tuser.txt\u0000`).untouched("/r")).toBe(false);
    expect(scripted(() => ({ status: 128 })).runner.untouched("/r")).toBe(false);
  });
});

describe("what an update asks of Git", () => {
  const scripted = (answer: (args: string[]) => { status?: number | null; stdout?: string; stderr?: string }) => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const start = (_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      const stripped = args.filter((arg) => !["--literal-pathspecs", "core.quotepath=false", "core.autocrlf=false", "core.safecrlf=false", "-c"].includes(arg));
      calls.push({ args: stripped, env: options.env ?? {} });
      const { status = 0, stdout = "", stderr = "" } = answer(stripped);
      return { status, stdout, stderr };
    };
    const bytes = (_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args: args.filter((arg) => !arg.startsWith("--literal") && !arg.startsWith("core.") && arg !== "-c"), env: options.env ?? {} });
      return args.includes("missing")
        ? { status: 128, stdout: Buffer.alloc(0), stderr: "fatal: bad object\n" }
        : { status: 0, stdout: Buffer.from([0, 255, 1]), stderr: "" };
    };
    return { calls, runner: git.createGit({ start, bytes, env: { GIT_CONFIG_GLOBAL: "/caller", HOME: "/h" } }) };
  };

  test("a blob is read as the bytes Git stores, with none of the machine's configuration", () => {
    const { runner, calls } = scripted(() => ({}));
    expect([...runner.blob("/r", "abc:file.bin")]).toEqual([0, 255, 1]);
    expect(calls[0]?.args.slice(-3)).toEqual(["cat-file", "blob", "abc:file.bin"]);
    expect(calls[0]?.env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(() => runner.blob("/r", "missing")).toThrow(/cat-file blob missing failed: fatal: bad object/);
  });

  test("history questions are answered by Git's exit status", () => {
    const answers = (status: number, stdout = "") => scripted(() => ({ status, stdout })).runner;
    expect(answers(0, "true\n").isShallow("/r")).toBe(true);
    expect(answers(0, "false\n").isShallow("/r")).toBe(false);
    expect(() => answers(128).isShallow("/r")).toThrow();
    expect(answers(0).hasCommit("/r", A)).toBe(true);
    expect(answers(128).hasCommit("/r", A)).toBe(false);
    expect(answers(0).isAncestor("/r", A, B)).toBe(true);
    expect(answers(1).isAncestor("/r", A, B)).toBe(false);
  });

  test("a fetch brings one ref, no tags and no hook, and the ref cannot be read as an option", () => {
    const { runner, calls } = scripted(() => ({}));
    runner.fetchRef("/r", "file:///up", "main");
    expect(calls[0]?.args).toEqual(["core.hooksPath=/dev/null", "fetch", "--quiet", "--no-tags", "--depth=1", "--", "file:///up", "main"]);
    expect(calls[0]?.env["GIT_CONFIG_GLOBAL"]).toBe("/caller");
  });

  test("a merge stops before committing, overwrites no ignored file and returns Git's own status", () => {
    const { runner, calls } = scripted(() => ({ status: 1, stdout: "CONFLICT (content): Merge conflict in a\n" }));
    expect(runner.mergeNoCommit("/r", C)).toMatchObject({ status: 1, stdout: expect.stringContaining("CONFLICT") as string });
    expect(calls[0]?.args).toEqual(["merge", "--no-ff", "--no-commit", "--no-overwrite-ignore", "--no-stat", "-m", "template update preview", C]);
    expect(calls[0]?.env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
  });

  test("a snapshot is built in an index of its own, from the files where they were written, and moves nothing", () => {
    const listing = files.map((file) => `${entryOf(file).mode} ${entryOf(file).sha} 0\t${file.path}\u0000`).join("");
    const { runner, calls } = scripted((args) => {
      if (args[0] === "ls-files") return { stdout: listing };
      if (args[0] === "write-tree") return { stdout: `${B}\n` };
      if (args[0] === "commit-tree") return { stdout: `${C}\n` };
      return {};
    });
    expect(runner.commitSnapshot("/clone/.git", "/render", files, { parent: A, message: "m", date: "@1 +0000" })).toEqual({ commit: C, tree: B });
    expect(calls.map((call) => call.args[0])).toEqual(["read-tree", "add", "ls-files", "write-tree", "commit-tree"]);
    for (const call of calls) {
      expect(call.env["GIT_DIR"]).toBe("/clone/.git");
      expect(call.env["GIT_WORK_TREE"]).toBe("/render");
      expect(call.env["GIT_INDEX_FILE"]).toMatch(/^\/clone\/\.git\/template-snapshot-.+\.index$/);
      expect(call.env["GIT_COMMITTER_DATE"]).toBe("@1 +0000");
    }
    expect(calls.map((call) => call.args[0])).not.toContain("update-ref");
  });

  test("a snapshot that is not the rendered files is refused before any commit is made", () => {
    const { runner, calls } = scripted((args) => (args[0] === "ls-files" ? { stdout: "" } : {}));
    expect(() => runner.commitSnapshot("/clone/.git", "/render", files, { parent: A, message: "m", date: "@1 +0000" })).toThrow(/not the rendered tree/);
    expect(calls.map((call) => call.args[0])).not.toContain("commit-tree");
  });
});
