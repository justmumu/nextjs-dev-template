import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { inventory } from "../../support/guard-repo.ts";
import { memoryFs } from "../../support/memory-fs.ts";

const require = createRequire(import.meta.url);
const repoModule = require("../../../scripts/hooks/repo.cjs") as typeof import("../../../scripts/hooks/repo.cjs");
const state = require("../../../scripts/hooks/state.cjs") as typeof import("../../../scripts/hooks/state.cjs");

const ROOT = "/p";
const GIT = "/p/.git";
const STATE = "/p/.git/protected-baseline";
const sha = (text: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
const hex = (seed: string) => createHash("sha1").update(seed).digest("hex");
/** NUL-terminated records, as `-z` output has them. */
const records = (...lines: string[]) => lines.map((line) => `${line}\u0000`).join("");

type GitAnswer = string | { status: number; stderr?: string } | { error: Error };

/** Git answered from a table keyed by the arguments; every call is recorded. */
function fakeGit(answers: Record<string, GitAnswer>) {
  const calls: { args: string; input: string | undefined }[] = [];
  const git = (args: string[], input?: string) => {
    const key = args.join(" ");
    calls.push({ args: key, input });
    const answer = Object.entries(answers).find(([prefix]) => key === prefix || key.startsWith(`${prefix} `))?.[1];
    if (answer === undefined) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(`unexpected: ${key}`) };
    if (typeof answer === "string") return { status: 0, stdout: Buffer.from(answer), stderr: "" };
    if ("error" in answer) return { status: null, stdout: Buffer.alloc(0), stderr: "", error: answer.error };
    return { status: answer.status, stdout: Buffer.alloc(0), stderr: answer.stderr ?? "" };
  };
  return { git, calls };
}

function repoOf(nodes: Parameters<typeof memoryFs>[0], answers: Record<string, GitAnswer> = {}) {
  const disk = memoryFs(nodes);
  const fake = fakeGit({
    "rev-parse --show-object-format": "sha1\n",
    "rev-parse --verify --quiet HEAD": `${hex("head")}\n`,
    "ls-files -s -z": "",
    "ls-tree -r -z HEAD": "",
    "config --get core.hooksPath": { status: 1 },
    ...answers,
  });
  const repo = repoModule.createRepo({ root: ROOT, gitDir: GIT, commonDir: GIT, codexHome: "/home/.codex", userHome: "/home", git: fake.git, disk }, inventory);
  return { repo, disk, calls: fake.calls };
}

describe("finding the protected paths", () => {
  test("the worktree walk finds protected files and shadows, and skips dependency trees, build output, links and nested checkouts", () => {
    const { repo } = repoOf({
      "/p/package.json": "{}",
      "/p/src/app.ts": "x",
      "/p/src/.npmrc": "x",
      "/p/scripts/dist/new.cjs": "x",
      "/p/dist/eslint.config.mjs": "generated",
      "/p/node_modules/x/.npmrc": "dependency",
      "/p/vendor/other/.git/HEAD": "ref",
      "/p/vendor/other/eslint.config.mjs": "nested",
      "/p/tooling/capabilities.json": "{}",
    });
    expect(repo.candidates([])).toEqual(["package.json", "scripts/dist/new.cjs", "src/.npmrc", "tooling/capabilities.json"]);
  });

  test("paths known only to the index, to HEAD or to the baseline are candidates too", () => {
    const { repo } = repoOf(
      { "/p/package.json": "{}" },
      {
        "ls-files -s -z": records(`100644 ${hex("a")} 0\tAGENTS.md`, `100644 ${hex("b")} 0\tsrc/app.ts`),
        "ls-tree -r -z HEAD": records(`100644 blob ${hex("c")}\ttooling/policy.json`, `040000 tree ${hex("d")}\tsrc`),
      },
    );
    expect(repo.candidates(["pnpm-lock.yaml", "src/other.ts"])).toEqual(["AGENTS.md", "package.json", "pnpm-lock.yaml", "tooling/policy.json"]);
    expect(repo.treePaths("HEAD")).toEqual(new Set(["tooling/policy.json"]));
  });

  test("a runaway tree is refused rather than half-checked", () => {
    const nodes: Record<string, string> = {};
    for (let index = 0; index < 20_010; index++) nodes[`/p/scripts/f${index}.cjs`] = "x";
    expect(() => repoOf(nodes).repo.candidates([])).toThrow(/too many protected candidates/);
  });
});

describe("identifying what is on disk, in the index and in a commit", () => {
  test("a file is its blob id, an executable adds a suffix, a link is its target, anything else is absent", () => {
    const { repo } = repoOf({
      "/p/AGENTS.md": "# r\n",
      "/p/scripts/run.sh": { content: "#!/bin/sh\n", mode: 0o100755 },
      "/p/CLAUDE.md": { link: "AGENTS.md" },
      "/p/scripts/tool/x.cjs": "x",
    });
    expect(repo.worktreeIds(["AGENTS.md", "scripts/run.sh", "CLAUDE.md", "missing", "scripts/tool", "AGENTS.md/child"])).toEqual({
      "AGENTS.md": sha("# r\n"),
      "scripts/run.sh": `${sha("#!/bin/sh\n")}:x`,
      "CLAUDE.md": "symlink:AGENTS.md",
      missing: null,
      "scripts/tool": null,
      "AGENTS.md/child": null,
    });
  });

  test("the index and a commit say the same thing, and a conflict is not a staged entry", () => {
    const { repo } = repoOf(
      {},
      {
        "ls-files -s -z": records(
          `100644 ${hex("a")} 0\tAGENTS.md`,
          `100755 ${hex("b")} 0\tscripts/run.sh`,
          `120000 ${hex("c")} 0\tCLAUDE.md`,
          `100644 ${hex("d")} 2\tpackage.json`,
        ),
        "ls-tree -r -z HEAD": records(`100644 blob ${hex("a")}\tAGENTS.md`, `120000 blob ${hex("c")}\tCLAUDE.md`),
        [`cat-file blob ${hex("c")}`]: "AGENTS.md",
      },
    );
    const paths = ["AGENTS.md", "scripts/run.sh", "CLAUDE.md", "package.json", "tsconfig.json"];
    expect(repo.indexIds(paths)).toEqual({
      "AGENTS.md": hex("a"),
      "scripts/run.sh": `${hex("b")}:x`,
      "CLAUDE.md": "symlink:AGENTS.md",
      "package.json": null,
      "tsconfig.json": null,
    });
    expect(repo.treeIds(paths)).toEqual({
      "AGENTS.md": hex("a"),
      "scripts/run.sh": null,
      "CLAUDE.md": "symlink:AGENTS.md",
      "package.json": null,
      "tsconfig.json": null,
    });
    expect(repo.unmerged(paths)).toEqual(new Set(["package.json"]));
  });

  test("a revision that does not exist names nothing, and an unborn branch has no head", () => {
    const { repo } = repoOf({}, { "rev-parse --verify --quiet nope": { status: 1 }, "rev-parse --verify --quiet HEAD": { status: 1 } });
    expect(repo.treeIds(["AGENTS.md"], "nope")).toEqual({ "AGENTS.md": null });
    expect(repo.head()).toBeNull();
    expect(repo.treePaths("nope")).toEqual(new Set());
  });

  test("the answer of a run is cached for the event, and resetting the index asks again", () => {
    const { repo, calls } = repoOf({}, { "reset -q --pathspec-from-file=- --pathspec-file-nul": "" });
    repo.indexIds([]);
    repo.indexIds([]);
    repo.treeIds([]);
    repo.treeIds([]);
    expect(calls.filter((call) => call.args === "ls-files -s -z")).toHaveLength(1);
    expect(calls.filter((call) => call.args === "ls-tree -r -z HEAD")).toHaveLength(1);
    repo.resetIndex([]);
    repo.resetIndex(["AGENTS.md", "a b.md"]);
    repo.indexIds([]);
    expect(calls.find((call) => call.args.startsWith("reset"))?.input).toBe("AGENTS.md\0a b.md");
    expect(calls.filter((call) => call.args === "ls-files -s -z")).toHaveLength(2);
  });

  test("staged names, unfinished operations and committed objects", () => {
    const { repo, disk } = repoOf(
      {},
      {
        "diff --cached --name-only -z --diff-filter=A": records("src/.npmrc", "AGENTS.md"),
        "diff --cached --name-only -z": records("a"),
        [`cat-file blob ${hex("o")}`]: "content",
      },
    );
    expect(repo.stagedNames("A")).toEqual(["src/.npmrc", "AGENTS.md"]);
    expect(repo.stagedNames()).toEqual(["a"]);
    expect(repo.readObject(hex("o"))?.toString()).toBe("content");
    expect(repo.readObject(hex("missing"))).toBeNull();
    expect(repo.operationInProgress()).toBe(false);
    disk.writeFileSync(`${GIT}/MERGE_HEAD`, "x");
    expect(repo.operationInProgress()).toBe(true);
  });

  test("a Git that cannot run, or that fails, is an error and never an empty answer", () => {
    expect(() =>
      repoOf({}, { "rev-parse --show-object-format": "sha1\n", "ls-files -s -z": { error: new Error("spawn git ENOENT") } }).repo.indexIds([]),
    ).toThrow(/git ls-files could not run: spawn git ENOENT/);
    expect(() => repoOf({}, { "ls-files -s -z": { status: 128, stderr: "fatal: not a git repository" } }).repo.indexIds([])).toThrow(
      /failed: fatal: not a git repository/,
    );
  });
});

describe("keeping and restoring approved content", () => {
  test("content is stored once by its id and read back, and a link or an absent file stores nothing", () => {
    const { repo, disk } = repoOf({
      "/p/AGENTS.md": "# r\n",
      "/p/scripts/run.sh": { content: "#!/bin/sh\n", mode: 0o100755 },
      "/p/CLAUDE.md": { link: "AGENTS.md" },
    });
    expect(repo.capture("AGENTS.md")).toBe(sha("# r\n"));
    expect(repo.capture("scripts/run.sh")).toBe(`${sha("#!/bin/sh\n")}:x`);
    expect(repo.capture("CLAUDE.md")).toBe("symlink:AGENTS.md");
    expect(repo.capture("missing")).toBeNull();
    expect(repo.capture("AGENTS.md")).toBe(sha("# r\n"));
    expect(disk.paths().filter((path) => path.startsWith(`${STATE}/blobs/`))).toEqual(
      [`${STATE}/blobs/${sha("# r\n")}`, `${STATE}/blobs/${sha("#!/bin/sh\n")}`].sort(),
    );
    expect(repo.readBlob(`${sha("#!/bin/sh\n")}:x`)?.toString()).toBe("#!/bin/sh\n");
    expect(repo.readBlob("symlink:AGENTS.md")).toBeNull();
    expect(repo.readBlob(null)).toBeNull();
    expect(repo.readBlob("not-an-id")).toBeNull();
    expect(repo.storeContent(Buffer.from("policy"))).toBe(sha("policy"));
    expect(repo.readWorktree("AGENTS.md")?.toString()).toBe("# r\n");
    expect(repo.readWorktree("CLAUDE.md")).toBeNull();
    expect(repo.readWorktree("missing")).toBeNull();
  });

  test("a restore puts back a file, an executable or a link, and removes what was not approved", () => {
    const { repo, disk } = repoOf({ "/p/AGENTS.md": "# r\n", "/p/scripts/run.sh": { content: "#!/bin/sh\n", mode: 0o100755 } });
    const file = repo.capture("AGENTS.md");
    const script = repo.capture("scripts/run.sh");
    disk.writeFileSync("/p/AGENTS.md", "tampered");
    repo.restore("AGENTS.md", file);
    expect(disk.text("/p/AGENTS.md")).toBe("# r\n");
    expect(disk.modeOf("/p/AGENTS.md")).toBe(0o644);
    disk.unlinkSync("/p/scripts/run.sh");
    repo.restore("scripts/run.sh", script);
    expect(disk.text("/p/scripts/run.sh")).toBe("#!/bin/sh\n");
    expect(disk.modeOf("/p/scripts/run.sh")).toBe(0o755);
    disk.symlinkSync("elsewhere", "/p/scripts/link");
    repo.restore("scripts/link", null);
    expect(disk.paths()).not.toContain("/p/scripts/link");
    repo.restore("scripts/new/dir/file.cjs", "symlink:../x");
    expect(disk.linkOf("/p/scripts/new/dir/file.cjs")).toBe("../x");
    repo.restore("AGENTS.md", "symlink:src/app.ts");
    expect(disk.linkOf("/p/AGENTS.md")).toBe("src/app.ts");
    repo.restore("scripts/never-existed.cjs", null);
  });

  test("a restore has nothing to copy from, or a directory in the way, or a path out of the worktree: it fails loudly", () => {
    const { repo, disk } = repoOf({ "/p/AGENTS.md": "x", "/p/scripts/dir/inner.cjs": "x", "/outside/target": "x", "/p/scripts/escape": { link: "/outside" } });
    expect(() => {
      repo.restore("AGENTS.md", hex("unknown"));
    }).toThrow(/no stored copy of AGENTS\.md/);
    expect(() => {
      repo.restore("scripts/dir", null);
    }).toThrow(/ENOTEMPTY/);
    disk.unlinkSync("/p/scripts/dir/inner.cjs");
    repo.restore("scripts/dir", null);
    expect(disk.paths()).not.toContain("/p/scripts/dir");
    const id = repo.storeContent(Buffer.from("payload"));
    expect(() => {
      repo.restore("scripts/escape/target", id);
    }).toThrow(/is a symbolic link/);
    expect(disk.text("/outside/target")).toBe("x");
  });

  test("pruning drops copies the baseline no longer needs, and links are never copies", () => {
    const { repo, disk } = repoOf({});
    const keep = repo.storeContent(Buffer.from("keep"));
    repo.storeContent(Buffer.from("drop"));
    repo.prune([`${keep}:x`, "symlink:x", null]);
    expect(disk.paths().map((path) => path.split("/").pop())).toEqual([keep]);
  });
});

describe("the Git hooks of the worktree", () => {
  const hooks = {
    "/p/.git/hooks/pre-commit": { content: "#!/bin/sh\n", mode: 0o100755 },
    "/p/.git/hooks/pre-commit.sample": "sample",
    "/p/.git/hooks/sub/x": "dir",
  };

  test("scripts are recorded with their ids and modes, samples and directories are not", () => {
    const { repo } = repoOf(hooks, { "config --get core.hooksPath": "/tmp/elsewhere\n" });
    expect(repo.hooks(false)).toEqual({ path: "/tmp/elsewhere", scripts: { "pre-commit": `${sha("#!/bin/sh\n")}:755` } });
    expect(repoOf({}).repo.hooks(false)).toEqual({ path: null, scripts: {} });
  });

  test("keeping a baseline stores the scripts, and restoring puts them back with their mode and drops others", () => {
    const { repo, disk } = repoOf(hooks);
    const baseline = repo.hooks(true);
    disk.writeFileSync("/p/.git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
    disk.chmodSync("/p/.git/hooks/pre-commit", 0o644);
    disk.writeFileSync("/p/.git/hooks/post-commit", "planted");
    repo.restoreHooks(baseline);
    expect(disk.text("/p/.git/hooks/pre-commit")).toBe("#!/bin/sh\n");
    expect(disk.modeOf("/p/.git/hooks/pre-commit")).toBe(0o755);
    expect(disk.paths()).not.toContain("/p/.git/hooks/post-commit");
    expect(() => {
      repo.restoreHooks({ path: null, scripts: { "pre-push": `${hex("unknown")}:755` } });
    }).toThrow(/no stored copy of the pre-push Git hook/);
  });
});

describe("the dependency environment", () => {
  const modules = (extra: Parameters<typeof memoryFs>[0] = {}) => ({
    "/p/node_modules/.modules.yaml": { content: "layout: 5\n", mode: 0o100644, mtimeMs: 5 },
    "/p/node_modules/.bin/tool": { content: "#!/bin/sh\n", mode: 0o100755, mtimeMs: 6 },
    "/p/node_modules/.pnpm/a@1/node_modules/a/index.js": "1",
    "/p/node_modules/a": { link: ".pnpm/a@1/node_modules/a" },
    "/p/node_modules/@scope/b": { link: "../.pnpm/b@1/node_modules/b" },
    "/p/node_modules/.vite/cache": "cache",
    ...extra,
  });

  test("there is nothing to fingerprint without node_modules", () => {
    expect(repoOf({}).repo.environment()).toBe("absent");
  });

  test("links, binaries, scoped links and the modules manifest are part of it; caches and package contents are not", () => {
    const base = repoOf(modules()).repo.environment();
    expect(repoOf(modules()).repo.environment()).toBe(base);
    expect(repoOf(modules({ "/p/node_modules/a": { link: "elsewhere" } })).repo.environment()).not.toBe(base);
    expect(repoOf(modules({ "/p/node_modules/@scope/b": { link: "../x" } })).repo.environment()).not.toBe(base);
    expect(repoOf(modules({ "/p/node_modules/.bin/evil": "x" })).repo.environment()).not.toBe(base);
    expect(repoOf(modules({ "/p/node_modules/.bin/tool": { content: "#!/bin/sh\nx\n", mode: 0o100755, mtimeMs: 6 } })).repo.environment()).not.toBe(base);
    expect(repoOf(modules({ "/p/node_modules/.modules.yaml": { content: "layout: 5\n", mode: 0o100644, mtimeMs: 99 } })).repo.environment()).not.toBe(base);
    expect(repoOf(modules({ "/p/node_modules/.pnpm/evil@1/x": "x" })).repo.environment()).not.toBe(base);
    expect(repoOf(modules({ "/p/node_modules/new/index.js": "x" })).repo.environment()).not.toBe(base);
    expect(repoOf(modules({ "/p/node_modules/.vite/other": "changed" })).repo.environment()).toBe(base);
    expect(repoOf(modules({ "/p/node_modules/.pnpm/a@1/node_modules/a/index.js": "changed and longer" })).repo.environment()).toBe(base);
  });
});

describe("the user's Codex files and settings", () => {
  test("they are read and written by name, and only those two names exist", () => {
    const { repo, disk } = repoOf({ "/home/.codex/config.toml": "model = 'x'\n" });
    expect(repo.userFile("config.toml")).toEqual({ path: "/home/.codex/config.toml", content: Buffer.from("model = 'x'\n") });
    expect(repo.userFile("hooks.json").content).toBeNull();
    repo.writeUserFile("hooks.json", Buffer.from("{}"));
    expect(disk.text("/home/.codex/hooks.json")).toBe("{}");
    expect(() => repo.userFile("../../etc/passwd")).toThrow(/unknown user file/);
    expect(repo.userHome).toBe("/home");
    repo.writeText("/p/.claude/settings.json", "{}");
    expect(repo.readText("/p/.claude/settings.json")).toBe("{}");
    expect(repo.readText("/p/missing")).toBeNull();
  });

  test("a link is resolved through its deepest existing part", () => {
    const { repo } = repoOf({ "/p/docs": { link: "/p/real" }, "/p/real/file.md": "x" });
    expect(repo.realpath("/p/docs/file.md")).toBe("/p/real/file.md");
    expect(repo.realpath("/p/docs/not-yet/file.md")).toBe("/p/real/not-yet/file.md");
    expect(repo.realpath("/p/missing/deep/file")).toBe("/p/missing/deep/file");
  });
});

describe("the state on disk", () => {
  const baseline = (extra: Record<string, unknown> = {}) =>
    ({
      version: 2,
      policy: "p".repeat(40),
      files: {},
      approved: {},
      head: null,
      hooks: { path: null, scripts: {} },
      environment: "absent",
      environmentBlocked: false,
      user: {},
      blocked: null,
      inflight: {},
      window: [],
      needsEvaluation: false,
      ...extra,
    }) as ReturnType<typeof state.parseState>;

  test("a baseline is written whole, read back, and absent before the first run", () => {
    const disk = memoryFs({});
    expect(state.readState(STATE, disk)).toBeNull();
    state.writeState(STATE, baseline({ head: hex("h") }), disk);
    expect(state.readState(STATE, disk)?.head).toBe(hex("h"));
    expect(disk.paths()).toEqual([`${STATE}/state.json`]);
    expect(disk.operations.some((operation) => operation.startsWith("rename"))).toBe(true);
  });

  test("an oversized or damaged baseline is an error", () => {
    const disk = memoryFs({ [`${STATE}/state.json`]: "x".repeat(state.MAX_STATE_BYTES + 1) });
    expect(() => state.readState(STATE, disk)).toThrow(/unreasonably large/);
    expect(() => state.readState(STATE, memoryFs({ [`${STATE}/state.json`]: "{" }))).toThrow(/not valid JSON/);
    const unreadable = memoryFs({});
    Object.assign(unreadable, {
      statSync: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    expect(() => state.readState(STATE, unreadable)).toThrow(/EACCES/);
  });

  test("the lock is taken, released and never reclaimed by age", () => {
    const disk = memoryFs({});
    expect(state.withLock(STATE, () => disk.existsSync(`${STATE}/lock`), 0, disk)).toBe(true);
    expect(disk.existsSync(`${STATE}/lock`)).toBe(false);
    disk.writeFileSync(`${STATE}/lock`, "abandoned long ago");
    expect(() => state.withLock(STATE, () => 1, 0, disk)).toThrow(/another guard run holds the state lock/);
    expect(disk.text(`${STATE}/lock`)).toBe("abandoned long ago");
    expect(() => state.withLock(STATE, () => 1, 40, disk)).toThrow(/holds the state lock/);
  });

  test("a lock removed from under a run is not an error, and another failure to take it is", () => {
    const disk = memoryFs({});
    state.withLock(
      STATE,
      () => {
        disk.unlinkSync(`${STATE}/lock`);
      },
      0,
      disk,
    );
    expect(disk.existsSync(`${STATE}/lock`)).toBe(false);
    const broken = memoryFs({});
    const write = broken.writeFileSync;
    broken.writeFileSync = ((path: string, ...rest: unknown[]) => {
      if (path.endsWith("/lock")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      (write as (...args: unknown[]) => void)(path, ...rest);
    }) as typeof broken.writeFileSync;
    expect(() => state.withLock(STATE, () => 1, 0, broken)).toThrow(/EACCES/);
  });

  test("an unfinished operation and the status that reads it", () => {
    const disk = memoryFs({ [`${STATE}/state.json`]: JSON.stringify(baseline()) });
    expect(state.status("/unused", { gitDir: GIT, disk })).toEqual({ clean: true });
    disk.writeFileSync(`${GIT}/rebase-merge`, "");
    expect(state.status("/unused", { gitDir: GIT, disk }).reason).toMatch(/waiting to be finished/);
    expect(state.operationInProgress(GIT, disk)).toBe(true);
  });

  test("a blob that is stored twice is kept once, and another failure to store it is an error", () => {
    const disk = memoryFs({});
    state.storeBlob(STATE, hex("a"), Buffer.from("one"), disk);
    state.storeBlob(STATE, hex("a"), Buffer.from("two"), disk);
    expect(state.readBlob(STATE, hex("a"), disk)?.toString()).toBe("one");
    const broken = memoryFs({});
    broken.writeFileSync = () => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    };
    expect(() => {
      state.storeBlob(STATE, hex("b"), Buffer.from("x"), broken);
    }).toThrow(/ENOSPC/);
    state.pruneBlobs(`${STATE}/none`, [], disk);
  });
});
