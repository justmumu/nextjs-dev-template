import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { capture, scratchArea } from "../support/project.ts";
import { create, fixtureEnv, generatorCopy, git, gitModule, hostFor, initialize, inputsOf, passing, render, type Host } from "../support/template-fixture.ts";

// What creation and enrollment do when somebody else commits or stages something in the repository
// while they work, with a real Git: a person's HEAD, index and files are never overwritten, deleted
// or committed by the operation. The change is made by an ordinary commit or `git add` of a fixture
// user at the moment a chosen Git command is about to start.
const require = createRequire(import.meta.url);
const { run } = require("../../scripts/core/process.cjs") as typeof import("../../scripts/core/process.cjs");

const scratch = scratchArea("template-concurrency-");
const answers = { name: "made-app", owner: "made-owner" };

type Start = NonNullable<NonNullable<Parameters<typeof gitModule.createGit>[0]>["start"]>;

/** The host, with Git that lets `act` run once, just before the first command `when` selects starts in `target` (the staging copy has its own repository, which is left alone). */
function interfering(env: NodeJS.ProcessEnv, target: string, when: (args: readonly string[]) => boolean, act: (cwd: string) => void): Host {
  let done = false;
  const start: Start = (command, args, options) => {
    if (!done && options.cwd === target && when(args)) {
      done = true;
      act(options.cwd);
    }
    return run(command, args, options);
  };
  const host = hostFor(env, { run: passing });
  return { ...host, git: gitModule.createGit({ start, env }) };
}

const commitUser = (env: NodeJS.ProcessEnv) => (cwd: string) => {
  writeFileSync(join(cwd, "user.txt"), "somebody else's work\n");
  git(cwd, ["add", "user.txt"], env);
  git(cwd, ["commit", "-q", "-m", "user: work in progress"], env);
};
const stageUser = (env: NodeJS.ProcessEnv) => (cwd: string) => {
  writeFileSync(join(cwd, "user.txt"), "somebody else's work\n");
  git(cwd, ["add", "user.txt"], env);
};

function copyOf(env: NodeJS.ProcessEnv) {
  const dir = generatorCopy(scratch.area, `copy-${String(Math.random()).slice(2, 8)}`, env);
  return { dir, inputs: inputsOf(dir), original: git(dir, ["rev-parse", "HEAD"], env).trim() };
}

async function initializeIn(copy: ReturnType<typeof copyOf>, host: Host) {
  const sink = capture();
  const status = await initialize.initializeCopy({ host, io: sink.io, isCancelled: () => false, root: copy.dir, inputs: copy.inputs, answers });
  return { status, err: sink.err() };
}

/** The user's commit survived in HEAD and the index, with their file, and nothing of the operation was undone over it. */
function expectKept(copy: ReturnType<typeof copyOf>, env: NodeJS.ProcessEnv, err: string) {
  const head = git(copy.dir, ["rev-parse", "HEAD"], env).trim();
  expect(git(copy.dir, ["log", "-1", "--format=%s", head], env).trim()).toBe("user: work in progress");
  expect(git(copy.dir, ["rev-parse", "HEAD~1"], env).trim()).toBe(copy.original);
  expect(git(copy.dir, ["ls-files", "--stage", "user.txt"], env)).toMatch(/^100644 /);
  expect(git(copy.dir, ["diff", "--cached", "--name-only"], env)).toBe("");
  expect(readFileSync(join(copy.dir, "user.txt"), "utf8")).toBe("somebody else's work\n");
  // The installed application is still on disk, not reverted over a commit that may contain it.
  expect(existsSync(join(copy.dir, "scripts/template/create.cjs"))).toBe(false);
  expect(existsSync(join(copy.dir, "package.json"))).toBe(true);
  expect(existsSync(join(copy.dir, ".template-state.json"))).toBe(false);
  const backup = /template-backup-[A-Za-z0-9]+/.exec(err)?.[0];
  expect(backup, err).toBeDefined();
  expect(err).toMatch(/changed while the pristine commit was made, so nothing was undone/);
}

describe("GitHub initialization while somebody else commits or stages", () => {
  test("a commit made right before the pristine commit is built keeps HEAD, index, files and the backup", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const host = interfering(env, copy.dir, (args) => args.includes("--absolute-git-dir") || args.includes("--empty"), commitUser(env));
    const result = await initializeIn(copy, host);
    expect(result.status, result.err).toBe(1);
    expectKept(copy, env, result.err);
  }, 120_000);

  test("a commit made after commit-tree and before update-ref is not overwritten by the rollback", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const host = interfering(env, copy.dir, (args) => args.includes("update-ref"), commitUser(env));
    const result = await initializeIn(copy, host);
    expect(result.status, result.err).toBe(1);
    expectKept(copy, env, result.err);
  }, 120_000);

  test("a change staged while the pristine tree is built, without moving HEAD, is kept, staged, and nothing was undone over it", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const host = interfering(env, copy.dir, (args) => args[0] === "commit-tree" || args.includes("commit-tree"), stageUser(env));
    const result = await initializeIn(copy, host);
    expect(result.status, result.err).toBe(1);
    expect(git(copy.dir, ["rev-parse", "HEAD"], env).trim()).toBe(copy.original);
    expect(git(copy.dir, ["ls-files", "--stage", "user.txt"], env)).toMatch(/^100644 /);
    expect(readFileSync(join(copy.dir, "user.txt"), "utf8")).toBe("somebody else's work\n");
    expect(existsSync(join(copy.dir, "package.json"))).toBe(true);
    expect(result.err).toMatch(/changed while the pristine commit was made, so nothing was undone/);
  }, 120_000);

  test("a change staged just as HEAD moves keeps its entry; the pristine commit stands and the rest of the index is not rewritten over it", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const host = interfering(env, copy.dir, (args) => args.includes("update-ref"), stageUser(env));
    const result = await initializeIn(copy, host);
    expect(result.status, result.err).toBe(1);
    expect(git(copy.dir, ["rev-parse", "HEAD~1"], env).trim()).toBe(copy.original);
    expect(git(copy.dir, ["log", "-1", "--format=%an"], env).trim()).toBe(gitModule.PROVENANCE.name);
    expect(git(copy.dir, ["ls-files", "--stage", "user.txt"], env)).toMatch(/^100644 /);
    expect(readFileSync(join(copy.dir, "user.txt"), "utf8")).toBe("somebody else's work\n");
    expect(existsSync(join(copy.dir, "package.json"))).toBe(true);
    expect(existsSync(join(copy.dir, ".template-state.json"))).toBe(false);
    expect(result.err).toMatch(/index changed after HEAD moved to the pristine commit/);
    expect(result.err).toMatch(/changed while the pristine commit was made, so nothing was undone/);
  }, 120_000);

  test("a change staged before the enrollment commit is not absorbed by it", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const host = interfering(env, copy.dir, (args) => args.includes("add") && args.includes(".template-state.json"), stageUser(env));
    const result = await initializeIn(copy, host);
    expect(result.status, result.err).toBe(1);
    expect(result.err).toMatch(/enrollment did not complete: .*other changes are staged \(user\.txt\)/);
    expect(git(copy.dir, ["log", "--format=%an"], env).trim().split("\n")).toEqual([gitModule.PROVENANCE.name, "Fixture User"]);
    expect(git(copy.dir, ["diff", "--cached", "--name-only"], env).trim()).toBe("user.txt");
    expect(existsSync(join(copy.dir, ".template-state.json"))).toBe(true);
    expect(git(copy.dir, ["ls-files", "--stage", ".template-state.json"], env)).toBe("");
  }, 120_000);

  test("a change staged at the enrollment commit boundary stays out of that commit", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const host = interfering(env, copy.dir, (args) => args.includes("commit"), stageUser(env));
    const result = await initializeIn(copy, host);
    expect(result.status, result.err).toBe(1);
    expect(git(copy.dir, ["diff", "--cached", "--name-only"], env).trim()).toBe("user.txt");
    expect(git(copy.dir, ["ls-tree", "HEAD", "user.txt"], env)).toBe("");
    expect(readFileSync(join(copy.dir, "user.txt"), "utf8")).toBe("somebody else's work\n");
  }, 120_000);

  test("a change staged as the real index adopts the pristine tree stays staged", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const host = interfering(env, copy.dir, (args) => args.includes("read-tree") && !args.includes("--empty"), stageUser(env));
    const result = await initializeIn(copy, host);
    expect(result.status, result.err).toBe(1);
    expect(git(copy.dir, ["diff", "--cached", "--name-only"], env).trim()).toBe("user.txt");
    expect(git(copy.dir, ["ls-tree", "HEAD", "user.txt"], env)).toBe("");
    expect(readFileSync(join(copy.dir, "user.txt"), "utf8")).toBe("somebody else's work\n");
  }, 120_000);
});

describe("local creation while somebody else commits", () => {
  test("a commit made between commit-tree and update-ref keeps the repository, its history and the files", async () => {
    const env = fixtureEnv(scratch.area);
    const dir = generatorCopy(scratch.area, `gen-${String(Math.random()).slice(2, 8)}`, env);
    const dest = join(scratch.area, `created-${String(Math.random()).slice(2, 8)}`);
    const sink = capture();
    const host = interfering(env, dest, (args) => args.includes("update-ref"), commitUser(env));
    const { files } = render.renderTree({ ...inputsOf(dir), answers });
    const status = await create.createLocal({
      host,
      io: sink.io,
      isCancelled: () => false,
      inputs: inputsOf(dir),
      answers,
      dest,
      source: () => ({ kind: "local-generator", revision: "0".repeat(40) }),
    });
    expect(status, sink.err()).toBe(1);
    expect(sink.err()).toMatch(/no longer empty: it was changed meanwhile, so nothing was removed/);
    expect(git(dest, ["log", "--format=%s"], env).trim()).toBe("user: work in progress");
    expect(readFileSync(join(dest, "user.txt"), "utf8")).toBe("somebody else's work\n");
    for (const file of files) expect(readFileSync(join(dest, file.path)).equals(file.content), file.path).toBe(true);
  }, 120_000);
});
