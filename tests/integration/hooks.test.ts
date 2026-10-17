import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, test } from "vitest";
import { generatorFixture, output, removeDir, root, scratchDir, writeProjectFile } from "../support/rendered-app.ts";

// Real Git with the owned hooks, the real lint-staged and commitlint, in a generator-shaped fixture
// that shares the installed toolchain. Git's local environment is cleared so nothing leaks from the
// repository that runs this test.

const installer = createRequire(import.meta.url)("../../scripts/hooks/install.cjs") as typeof import("../../scripts/hooks/install.cjs");
const scratch = scratchDir("hooks-");
afterAll(() => {
  removeDir(scratch);
});

const environment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && key !== "NODE_ENV")),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
});

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", args, { cwd, env: environment(), encoding: "utf8", timeout: 170_000 });
}

function must(cwd: string, ...args: string[]): string {
  const result = git(cwd, ...args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${output(result)}`);
  return result.stdout;
}

let counter = 0;
/** A Git repository holding the real scripts and configuration, with the owned hooks installed and nothing committed. */
function repository(extra: Record<string, string> = {}): string {
  counter += 1;
  const dir = generatorFixture(scratch, `repo-${String(counter)}`, {
    ".node-version": `${process.versions.node}\n`,
    "pnpm-lock.yaml": readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
    ...extra,
  });
  must(dir, "init", "-q", "-b", "main");
  must(dir, "config", "user.name", "Test");
  must(dir, "config", "user.email", "1+test@users.noreply.github.com");
  writeFileSync(join(dir, ".git/info/exclude"), "node_modules\n");
  installer.install({ root: dir });
  return dir;
}

const commit = (dir: string, message: string, ...flags: string[]) => git(dir, "commit", "-q", ...flags, "-m", message);
const seed = (dir: string) => {
  writeProjectFile(dir, "README.md", "# Project\n");
  must(dir, "add", "README.md");
};

describe("hook installation in real repositories", () => {
  test("a linked worktree shares the one hooks directory, and an unknown hook is never overwritten", () => {
    const dir = repository();
    seed(dir);
    expect(commit(dir, "chore: initial", "--no-verify").status).toBe(0);
    must(dir, "worktree", "add", "-q", join(scratch, "linked"), "-b", "linked");
    const main = installer.inspect({ root: dir });
    const linked = installer.inspect({ root: join(scratch, "linked") });
    expect(linked.dir).toBe(main.dir);
    expect(main.dir).toBe(join(dir, ".git/hooks"));
    expect(Object.values(main.hooks)).toEqual(["current", "current", "current"]);

    const foreign = "#!/bin/sh\necho mine\n";
    writeFileSync(join(main.dir, "pre-push"), foreign);
    chmodSync(join(main.dir, "pre-push"), 0o755);
    writeFileSync(join(main.dir, "pre-commit"), "#!/bin/sh\n# managed by nextjs-dev-template: pre-commit\nexit 0\n");
    expect(() => installer.install({ root: dir })).toThrow(/pre-push.*not managed by this template/);
    expect(readFileSync(join(main.dir, "pre-push"), "utf8")).toBe(foreign);
    expect(readFileSync(join(main.dir, "pre-commit"), "utf8")).toContain("exit 0");
  });

  test("a configured core.hooksPath is where the hooks go and is never changed; hooks left in the usual directory are reported", () => {
    const dir = repository();
    const custom = join(scratch, "custom-hooks");
    mkdirSync(custom);
    must(dir, "config", "core.hooksPath", custom);
    const result = installer.install({ root: dir });
    expect(result.dir).toBe(custom);
    expect(must(dir, "config", "--get", "core.hooksPath").trim()).toBe(custom);
    expect(result.notice).toHaveLength(3);
    expect(result.notice[0]).toContain(join(dir, ".git/hooks"));
    expect(existsSync(join(custom, "pre-commit"))).toBe(true);
  });
});

describe("pre-commit", () => {
  test("the first commit without HEAD formats staged files, restages the fixes and keeps names with spaces and Unicode literal", () => {
    const dir = repository();
    writeProjectFile(dir, "docs/ünï code file.md", "#   Title\n\n*   item\n");
    must(dir, "add", "docs");
    const result = commit(dir, "feat: add the guide");
    expect(result.status, output(result)).toBe(0);
    const committed = must(dir, "show", "HEAD:docs/ünï code file.md");
    expect(committed).toBe("# Title\n\n- item\n");
    expect(must(dir, "status", "--porcelain", "--untracked-files=no")).toBe("");
  }, 240_000);

  test("a partially staged file commits only the staged hunk and keeps the unstaged one in the working tree", () => {
    const dir = repository();
    writeProjectFile(dir, "notes.md", "# Notes\n\nfirst\n\nsecond\n");
    must(dir, "add", "notes.md");
    expect(commit(dir, "docs: add notes").status).toBe(0);
    writeProjectFile(dir, "notes.md", "# Notes\n\nfirst changed\n\nsecond\n");
    must(dir, "add", "notes.md");
    writeProjectFile(dir, "notes.md", "# Notes\n\nfirst changed\n\nsecond local edit\n");
    const result = commit(dir, "docs: change the first note");
    expect(result.status, output(result)).toBe(0);
    expect(must(dir, "show", "HEAD:notes.md")).toBe("# Notes\n\nfirst changed\n\nsecond\n");
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("# Notes\n\nfirst changed\n\nsecond local edit\n");
    expect(must(dir, "status", "--porcelain", "--untracked-files=no").trim()).toBe("M notes.md");
  }, 240_000);

  test("a formatter failure rejects the commit and leaves the index, working tree and history as they were", () => {
    const dir = repository();
    seed(dir);
    expect(commit(dir, "chore: initial").status).toBe(0);
    const head = must(dir, "rev-parse", "HEAD");
    writeProjectFile(dir, "broken.json", "{ not json");
    must(dir, "add", "broken.json");
    const result = commit(dir, "feat: add broken json");
    expect(result.status).not.toBe(0);
    expect(must(dir, "rev-parse", "HEAD")).toBe(head);
    expect(must(dir, "status", "--porcelain", "--untracked-files=no").trim()).toBe("A  broken.json");
    expect(readFileSync(join(dir, "broken.json"), "utf8")).toBe("{ not json");
  }, 240_000);

  test("staged TypeScript is checked with the whole project: a type error rejects the commit", () => {
    const dir = repository();
    writeProjectFile(dir, "tests/unit/typed.test.ts", 'export const value: number = "text";\n');
    must(dir, "add", "tests/unit/typed.test.ts");
    const result = commit(dir, "test: add a typed value");
    expect(result.status).not.toBe(0);
    expect(output(result)).toMatch(/TS2322|typecheck/);
    expect(git(dir, "rev-parse", "--verify", "HEAD").status).not.toBe(0);
  }, 240_000);

  test("a real text conflict staged with its markers still in it is rejected, as is a whitespace error, and a resolved one commits", () => {
    const dir = repository();
    writeProjectFile(dir, "settings.txt", "mode = base\n");
    must(dir, "add", "settings.txt");
    expect(commit(dir, "chore: initial").status).toBe(0);
    must(dir, "switch", "-q", "-c", "template");
    writeProjectFile(dir, "settings.txt", "mode = template\n");
    expect(commit(dir, "chore: template side", "-a").status).toBe(0);
    must(dir, "switch", "-q", "main");
    writeProjectFile(dir, "settings.txt", "mode = mine\n");
    expect(commit(dir, "chore: my side", "-a").status).toBe(0);
    const merged = git(dir, "merge", "--no-ff", "--no-commit", "template");
    expect(merged.status).toBe(1);
    expect(readFileSync(join(dir, "settings.txt"), "utf8")).toContain("<<<<<<<");

    // `git add` clears the native unmerged stages; the markers are still text in the file.
    must(dir, "add", "settings.txt");
    expect(must(dir, "ls-files", "-u")).toBe("");
    const head = must(dir, "rev-parse", "HEAD");
    const marked = commit(dir, "chore: merge the template");
    expect(marked.status, output(marked)).not.toBe(0);
    expect(output(marked)).toMatch(/leftover conflict marker/);
    expect(must(dir, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(dir, ".git/MERGE_HEAD"))).toBe(true);

    writeProjectFile(dir, "settings.txt", "mode = resolved  \n");
    must(dir, "add", "settings.txt");
    const spaced = commit(dir, "chore: merge the template");
    expect(spaced.status, output(spaced)).not.toBe(0);
    expect(output(spaced)).toMatch(/trailing whitespace/);

    writeProjectFile(dir, "settings.txt", "mode = resolved\n");
    must(dir, "add", "settings.txt");
    const clean = commit(dir, "chore: merge the template");
    expect(clean.status, output(clean)).toBe(0);
    expect(must(dir, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")).toHaveLength(3);
  }, 240_000);
});

describe("commit-msg", () => {
  const dir = repository();
  const attempt = (subject: string, ...flags: string[]) => commit(dir, subject, "--allow-empty", ...flags);

  test("ordinary and invalid Conventional subjects, and the 72-character limit", () => {
    expect(attempt("feat(guard): add the thing").status).toBe(0);
    const exact = `fix: ${"a".repeat(67)}`;
    expect(exact).toHaveLength(72);
    expect(attempt(exact).status).toBe(0);
    for (const subject of ["add the thing", "Feat: add the thing", "feature: add the thing", "fix:", `fix: ${"a".repeat(68)}`]) {
      const result = attempt(subject);
      expect(result.status, subject).not.toBe(0);
      expect(output(result), subject).toMatch(/subject|type|header|✖/);
    }
    expect(must(dir, "rev-list", "--count", "HEAD").trim()).toBe("2");
  }, 240_000);

  test("a regular merge commit stays possible", () => {
    must(dir, "switch", "-q", "-c", "topic");
    expect(attempt("feat: work on the topic").status).toBe(0);
    must(dir, "switch", "-q", "main");
    expect(attempt("fix: work on main").status).toBe(0);
    const merged = git(dir, "merge", "--no-ff", "topic");
    expect(merged.status, output(merged)).toBe(0);
    expect(must(dir, "log", "-1", "--format=%s")).toMatch(/^Merge branch 'topic'/);
  }, 240_000);
});

describe("pre-push", () => {
  test("a failing gate stops the push before any ref reaches the remote", () => {
    // An unsupported Node version in .node-version fails every gate's preflight at once.
    const dir = repository({ ".node-version": "1.0.0\n" });
    seed(dir);
    expect(commit(dir, "chore: initial", "--no-verify").status).toBe(0);
    const remote = join(scratch, "remote.git");
    must(scratch, "init", "-q", "--bare", remote);
    must(dir, "remote", "add", "origin", remote);
    const result = git(dir, "push", "origin", "main");
    expect(result.status).not.toBe(0);
    expect(output(result)).toMatch(/pre-push: check/);
    expect(output(result)).toMatch(/the push was stopped/);
    expect(must(remote, "for-each-ref")).toBe("");
  }, 240_000);
});
