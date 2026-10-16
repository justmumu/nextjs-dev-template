import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { guardArea } from "../support/guard-fixture.ts";

const require = createRequire(import.meta.url);
const { openRepo } = require("../../scripts/hooks/repo.cjs") as typeof import("../../scripts/hooks/repo.cjs");
const inventory = require("../../scripts/core/protected.cjs") as typeof import("../../scripts/core/protected.cjs");

const { area } = guardArea("guard-restore-");
let counter = 0;

/** A real repository with one committed protected file, and a sibling directory that is not part of it. */
function sandbox() {
  const base = join(area, `s${++counter}`);
  const root = join(base, "repo");
  const outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@users.noreply.github.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@users.noreply.github.com",
      },
    });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "AGENTS.md"), "# rules\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { root, outside, repo: openRepo(root, inventory) };
}

describe("a restore only ever touches what the worktree owns", () => {
  test("deleting a new protected file never follows a symlinked parent out of the worktree", () => {
    const { root, outside, repo } = sandbox();
    symlinkSync(outside, join(root, "scripts"));
    writeFileSync(join(outside, "owned.cjs"), "outside data\n");
    expect(() => {
      repo.restore("scripts/owned.cjs", null);
    }).toThrow(/symbolic link|outside the worktree/);
    expect(readFileSync(join(outside, "owned.cjs"), "utf8")).toBe("outside data\n");
    expect(lstatSync(join(root, "scripts")).isSymbolicLink()).toBe(true);
  });

  test("writing a baseline file never follows a symlinked parent, with the baseline file present or absent outside", () => {
    const { root, outside, repo } = sandbox();
    const id = repo.storeContent(Buffer.from("baseline\n"));
    symlinkSync(outside, join(root, "scripts"));
    writeFileSync(join(outside, "owned.cjs"), "outside data\n");
    expect(() => {
      repo.restore("scripts/owned.cjs", id);
    }).toThrow(/symbolic link|outside the worktree/);
    expect(readFileSync(join(outside, "owned.cjs"), "utf8")).toBe("outside data\n");
    rmSync(join(outside, "owned.cjs"));
    expect(() => {
      repo.restore("scripts/owned.cjs", id);
    }).toThrow(/symbolic link|outside the worktree/);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("a parent that is a symlink to another place inside the worktree is not followed either", () => {
    const { root, repo } = sandbox();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "user.ts"), "ordinary\n");
    symlinkSync(join(root, "src"), join(root, "scripts"));
    expect(() => {
      repo.restore("scripts/user.ts", null);
    }).toThrow(/symbolic link/);
    expect(readFileSync(join(root, "src", "user.ts"), "utf8")).toBe("ordinary\n");
  });

  test("an ancestor that is a file stops the restore and leaves it alone", () => {
    const { root, repo } = sandbox();
    writeFileSync(join(root, "scripts"), "not a directory\n");
    const id = repo.storeContent(Buffer.from("baseline\n"));
    expect(() => {
      repo.restore("scripts/owned.cjs", id);
    }).toThrow();
    expect(readFileSync(join(root, "scripts"), "utf8")).toBe("not a directory\n");
  });

  test("a file whose stored baseline copy is missing is kept, and the restore reports it", () => {
    const { root, repo } = sandbox();
    writeFileSync(join(root, "AGENTS.md"), "tampered\n");
    expect(() => {
      repo.restore("AGENTS.md", "0".repeat(40));
    }).toThrow(/no stored copy of AGENTS\.md/);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("tampered\n");
  });

  test("a non-empty directory in the way is kept with everything in it", () => {
    const { root, repo } = sandbox();
    mkdirSync(join(root, "tooling", "nested"), { recursive: true });
    writeFileSync(join(root, "tooling", "nested", "keep.json"), "{}\n");
    const id = repo.storeContent(Buffer.from("baseline\n"));
    for (const baseline of [null, id]) {
      expect(() => {
        repo.restore("tooling/nested", baseline);
      }).toThrow();
      expect(readFileSync(join(root, "tooling", "nested", "keep.json"), "utf8")).toBe("{}\n");
    }
  });

  test("ordinary restores inside the worktree still work: new directories, replaced files, removed overrides, replaced links", () => {
    const { root, outside, repo } = sandbox();
    const id = repo.storeContent(Buffer.from("baseline\n"));
    repo.restore("scripts/deep/owned.cjs", id);
    expect(readFileSync(join(root, "scripts", "deep", "owned.cjs"), "utf8")).toBe("baseline\n");
    writeFileSync(join(root, "scripts", "deep", "owned.cjs"), "edited\n");
    repo.restore("scripts/deep/owned.cjs", id);
    expect(readFileSync(join(root, "scripts", "deep", "owned.cjs"), "utf8")).toBe("baseline\n");
    repo.restore("scripts/deep/owned.cjs", null);
    expect(existsSync(join(root, "scripts", "deep", "owned.cjs"))).toBe(false);
    writeFileSync(join(outside, "target"), "outside data\n");
    symlinkSync(join(outside, "target"), join(root, "AGENTS.md.link"));
    symlinkSync(join(outside, "target"), join(root, "scripts", "deep", "link.cjs"));
    repo.restore("scripts/deep/link.cjs", id);
    expect(lstatSync(join(root, "scripts", "deep", "link.cjs")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(outside, "target"), "utf8")).toBe("outside data\n");
  });
});
