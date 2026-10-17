import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { capture, scratchArea } from "../support/project.ts";
import {
  counting,
  create,
  interrupting,
  recordingScratch,
  fixtureEnv,
  generatorCopy,
  git,
  gitModule,
  hostFor,
  initialize,
  inputsOf,
  passing,
  render,
  stateModule,
  type Host,
} from "../support/template-fixture.ts";

// The GitHub route with a real Git, real files and real processes: the copy GitHub makes has one
// commit O by someone else, and is converted in place. The first test runs the real validation
// tools; the others are about what surrounds them and replace only those.
const scratch = scratchArea("template-initialize-");
const answers = { name: "made-app", owner: "made-owner" };

function copyOf(env: NodeJS.ProcessEnv, files: Record<string, string | { content: string; mode: number }> = {}) {
  const dir = generatorCopy(scratch.area, `copy-${String(Math.random()).slice(2, 8)}`, env, files);
  return { dir, inputs: inputsOf(dir), original: git(dir, ["rev-parse", "HEAD"], env).trim() };
}

async function initializeIn(copy: ReturnType<typeof copyOf>, host: Host, over: { isCancelled?: () => boolean; answers?: object } = {}) {
  const sink = capture();
  const status = await initialize.initializeCopy({
    host,
    io: sink.io,
    isCancelled: over.isCancelled ?? (() => false),
    root: copy.dir,
    inputs: copy.inputs,
    answers: over.answers ?? answers,
  });
  return { status, out: sink.out(), err: sink.err() };
}

/** What a refused or failed initialization must leave exactly as it was. */
function expectUntouched(copy: ReturnType<typeof copyOf>, env: NodeJS.ProcessEnv, head = copy.original) {
  expect(git(copy.dir, ["rev-parse", "HEAD"], env).trim()).toBe(head);
  expect(git(copy.dir, ["status", "--porcelain"], env)).toBe("");
  expect(existsSync(join(copy.dir, "scripts/template/create.cjs"))).toBe(true);
  expect(existsSync(join(copy.dir, ".template-state.json"))).toBe(false);
}

describe("a real GitHub initialization", () => {
  test("validates in staging, keeps O in the history under B0 and E0, and a second run changes nothing", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const host = hostFor(env);
    const { files, digest } = render.renderTree({ ...copy.inputs, answers });
    const result = await initializeIn(copy, host);
    expect(result.status, result.err).toBe(0);

    const [enrollment, pristine, copied] = git(copy.dir, ["log", "--format=%H|%an|%P|%s"], env)
      .trim()
      .split("\n")
      .map((line) => line.split("|")) as [string[], string[], string[]];
    expect(copied[0]).toBe(copy.original);
    expect(pristine[1]).toBe(gitModule.PROVENANCE.name);
    expect(pristine[2]).toBe(copy.original);
    expect(enrollment[1]).toBe("Fixture User");
    expect(enrollment[2]).toBe(pristine[0]);
    expect(git(copy.dir, ["rev-list", "--count", "HEAD"], env).trim()).toBe("3");

    const tree = git(copy.dir, ["ls-tree", "-r", "-z", pristine[0] ?? ""], env)
      .split("\0")
      .filter(Boolean)
      .map((line) => /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(line) as RegExpExecArray)
      .map((match) => ({ mode: match[1] as string, sha: match[2] as string, stage: "0", path: match[3] as string }));
    expect(gitModule.treeProblems(tree, files)).toEqual([]);
    for (const gone of ["scripts/template/create.cjs", "tooling/template-sentinel.json", "README.md", "tests/unit/template-transaction.test.ts"]) {
      expect(existsSync(join(copy.dir, gone)), gone).toBe(false);
    }
    expect(git(copy.dir, ["status", "--porcelain", "--ignored"], env)).toBe("");

    // The copy's own commit is recorded as exactly that; it names no upstream.
    const recorded = stateModule.parseState(readFileSync(join(copy.dir, ".template-state.json"), "utf8"));
    expect(recorded.source).toEqual({ kind: "github-template-copy", copiedCommit: copy.original });
    expect(recorded.baseline).toEqual({ commit: pristine[0], tree: git(copy.dir, ["rev-parse", `${pristine[0]}^{tree}`], env).trim() });
    expect(recorded.renderDigest).toBe(digest);
    expect(readFileSync(join(copy.dir, ".template-state.json"), "utf8")).not.toMatch(/https?:|github\.com|upstream/);

    // A full clone carries O, B0 and E0.
    const clone = join(scratch.area, "clone");
    git(scratch.area, ["clone", "-q", copy.dir, clone], env);
    expect(git(clone, ["rev-list", "--count", "HEAD"], env).trim()).toBe("3");
    expect(() => git(clone, ["merge-base", "--is-ancestor", copy.original, "HEAD"], env)).not.toThrow();

    // The sentinel repeated: nothing runs, nothing changes.
    const head = git(copy.dir, ["rev-parse", "HEAD"], env).trim();
    const counter = counting();
    const again = await initializeIn(copy, hostFor(env, { run: counter.run }));
    expect(again.status).toBe(0);
    expect(again.out).toMatch(/already initialized/);
    expect(counter.runs()).toBe(0);
    expect(git(copy.dir, ["rev-parse", "HEAD"], env).trim()).toBe(head);
  }, 900_000);
});

describe("the two routes", () => {
  test("give the same application tree for the same answers, and a matching origin is accepted", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    git(copy.dir, ["remote", "add", "origin", "git@github.com:Made-Owner/made-app.git"], env);
    expect((await initializeIn(copy, hostFor(env, { run: passing }))).status).toBe(0);

    const gen = copyOf(env);
    const dest = join(scratch.area, "local");
    const host = hostFor(env, { run: passing });
    expect(
      await create.createLocal({
        host,
        io: capture().io,
        isCancelled: () => false,
        inputs: gen.inputs,
        answers,
        dest,
        source: () => create.generatorSource({ git: host.git, root: gen.dir, manifest: gen.inputs.manifest }),
      }),
    ).toBe(0);
    const treeOf = (dir: string) => git(dir, ["rev-parse", "HEAD~1^{tree}"], env).trim();
    expect(treeOf(copy.dir)).toBe(treeOf(dest));
    expect(readFileSync(join(copy.dir, "package.json"), "utf8")).toBe(readFileSync(join(dest, "package.json"), "utf8"));
  });
});

describe("a copy that cannot be converted is refused before staging, untouched", () => {
  const refused: [string, (copy: ReturnType<typeof copyOf>, env: NodeJS.ProcessEnv) => void, RegExp, object?][] = [
    [
      "a changed tracked file",
      (c) => {
        appendFileSync(join(c.dir, "README.md"), "edit\n");
      },
      /not clean/,
    ],
    [
      "an untracked file",
      (c) => {
        writeFileSync(join(c.dir, "notes.txt"), "mine");
      },
      /not clean/,
    ],
    ["a staged change", (c, env) => (appendFileSync(join(c.dir, "README.md"), "x"), git(c.dir, ["add", "README.md"], env)), /not clean/],
    ["an assume-unchanged file", (c, env) => git(c.dir, ["update-index", "--assume-unchanged", "README.md"], env), /assume-unchanged or skip-worktree/],
    ["a skip-worktree file", (c, env) => git(c.dir, ["update-index", "--skip-worktree", "README.md"], env), /assume-unchanged or skip-worktree/],
    [
      "an ignored directory the render would write into",
      (c) => {
        writeFileSync(join(c.dir, ".git/info/exclude"), "public/\n");
        mkdirSync(join(c.dir, "public"));
        writeFileSync(join(c.dir, "public/mine.txt"), "mine");
      },
      /collides with the ignored directory public/,
    ],
    [
      "a workflow the render would not keep",
      (c, env) => {
        mkdirSync(join(c.dir, ".github/workflows"), { recursive: true });
        writeFileSync(join(c.dir, ".github/workflows/legacy.yml"), "on: push\n");
        git(c.dir, ["add", "-A"], env);
        git(c.dir, ["commit", "-q", "-m", "ci: workflow"], env);
      },
      /\.github\/workflows\/legacy\.yml would be removed/,
    ],
    [
      "a template's own origin",
      (c, env) => git(c.dir, ["remote", "add", "origin", "https://github.com/the-template/template.git"], env),
      /origin is the-template\/template/,
    ],
    [
      "the template's own repository over https, with the answers that name it",
      (c, env) => git(c.dir, ["remote", "add", "origin", "https://github.com/justmumu/nextjs-dev-template.git"], env),
      /origin is justmumu\/nextjs-dev-template, the template itself/,
      { name: "nextjs-dev-template", owner: "justmumu" },
    ],
    [
      "the template's own repository over ssh, with the answers that name it",
      (c, env) => git(c.dir, ["remote", "add", "origin", "git@github.com:justmumu/nextjs-dev-template.git"], env),
      /the template itself/,
      { name: "nextjs-dev-template", owner: "justmumu" },
    ],
    [
      "the template's own repository, with answers that do not name it",
      (c, env) => git(c.dir, ["remote", "add", "origin", "https://github.com/justmumu/nextjs-dev-template"], env),
      /the template itself/,
    ],
    [
      "a repository that is not a copy of the template",
      (c, env) => (git(c.dir, ["rm", "-q", "tooling/template-sentinel.json"], env), git(c.dir, ["commit", "-q", "-m", "chore: remove sentinel"], env)),
      /not an uninitialized copy/,
    ],
  ];

  test.each(refused)("%s", async (_name, change, message, named) => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    change(copy, env);
    const before = git(copy.dir, ["rev-parse", "HEAD"], env).trim();
    const statusBefore = git(copy.dir, ["status", "--porcelain"], env);
    const counter = counting();
    const result = await initializeIn(copy, hostFor(env, { run: counter.run }), named === undefined ? {} : { answers: named });
    expect(result.status).toBe(1);
    expect(result.err).toMatch(message);
    expect(counter.runs()).toBe(0);
    expect(git(copy.dir, ["rev-parse", "HEAD"], env).trim()).toBe(before);
    expect(git(copy.dir, ["status", "--porcelain"], env)).toBe(statusBefore);
    expect(existsSync(join(copy.dir, "scripts/template/create.cjs"))).toBe(true);
    expect(existsSync(join(copy.dir, ".template-state.json"))).toBe(false);
  });

  test("a tracked symlink above a rendered path", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    symlinkSync("docs", join(copy.dir, "public"));
    git(copy.dir, ["add", "public"], env);
    git(copy.dir, ["commit", "-q", "-m", "chore: link"], env);
    const result = await initializeIn(copy, hostFor(env, { run: passing }));
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/is, or is below, the tracked symlink public/);
    expect(existsSync(join(copy.dir, ".template-state.json"))).toBe(false);
  });
});

describe("a copy that changes while it is validated is left as it is", () => {
  test("a commit made meanwhile moves HEAD", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const result = await initializeIn(
      copy,
      hostFor(env, {
        run: (_command, args) => {
          if (args.includes("build")) {
            writeFileSync(join(copy.dir, "late.txt"), "late");
            git(copy.dir, ["add", "late.txt"], env);
            git(copy.dir, ["commit", "-q", "-m", "chore: late"], env);
          }
          return Promise.resolve(0);
        },
      }),
    );
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/HEAD moved/);
    expect(existsSync(join(copy.dir, "scripts/template/create.cjs"))).toBe(true);
    expect(existsSync(join(copy.dir, ".template-state.json"))).toBe(false);
    expect(git(copy.dir, ["status", "--porcelain"], env)).toBe("");
  });

  test("an edit made meanwhile is dirt, and is not overwritten", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const result = await initializeIn(
      copy,
      hostFor(env, {
        run: (_command, args) => {
          if (args.includes("build")) appendFileSync(join(copy.dir, "README.md"), "my edit\n");
          return Promise.resolve(0);
        },
      }),
    );
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/not clean/);
    expect(readFileSync(join(copy.dir, "README.md"), "utf8")).toMatch(/my edit\n$/);
  });

  test("a failed validation, or an interruption, changes nothing", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    expect((await initializeIn(copy, hostFor(env, { run: (_c, args) => Promise.resolve(args.includes("check") ? 1 : 0) }))).status).toBe(1);
    expectUntouched(copy, env);
    const stop = interrupting();
    const interrupted = await initializeIn(copy, hostFor(env, { run: stop.run }), { isCancelled: stop.isCancelled });
    expect(interrupted.status).toBe(1);
    expectUntouched(copy, env);
  });
});

describe("installing over the copy", () => {
  const failingDisk = (host: Host, fails: (path: string) => boolean): Host["disk"] => ({
    ...host.disk,
    writeFileSync: (path, content, options) => {
      if (fails(path)) throw new Error(`injected failure writing ${path}`);
      host.disk.writeFileSync(path, content, options);
    },
  });

  test("a failure part-way restores every file, the index and HEAD from the backup, and drops the backup", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const base = hostFor(env, { run: passing });
    const { host: recording, made: scratches } = recordingScratch(base);
    const host = { ...recording, disk: failingDisk(base, (path) => path === join(copy.dir, "src/app/page.tsx")) };
    const result = await initializeIn(copy, host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/installation failed and was taken back: injected failure/);
    expectUntouched(copy, env);
    expect(git(copy.dir, ["diff", "--stat"], env)).toBe("");
    expect(
      readdirSync(copy.dir)
        .filter((name) => name !== ".git")
        .sort(),
    ).toEqual(git(copy.dir, ["ls-tree", "--name-only", "HEAD"], env).trim().split("\n").sort());
    expect(scratches.filter((path) => existsSync(path))).toEqual([]);
  });

  test("a rollback that fails keeps the backup, names the paths, and the copy can be restored from Git", async () => {
    const env = fixtureEnv(scratch.area);
    const copy = copyOf(env);
    const base = hostFor(env, { run: passing });
    const { host: recording, made: scratches } = recordingScratch(base);
    const readme = join(copy.dir, "README.md");
    const original = readFileSync(readme);
    const host = { ...recording, disk: failingDisk(base, (path) => path === join(copy.dir, "src/app/page.tsx") || path === readme) };
    const result = await initializeIn(copy, host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/could not be restored: .*README\.md/);
    const backup = scratches.find((path) => path.includes("template-backup-")) ?? "";
    expect(result.err).toContain(backup);
    expect(readFileSync(join(backup, "README.md")).equals(original)).toBe(true);
    expect(git(copy.dir, ["rev-parse", "HEAD"], env).trim()).toBe(copy.original);
    // The exact commands the message names put the copy back.
    git(copy.dir, ["checkout", "-q", copy.original, "--", "."], env);
    expect(readFileSync(readme).equals(original)).toBe(true);
    for (const path of scratches) host.remove(path);
  });

  test("an enrollment rejected by a hook is not success; B0 stays on top of O, no file is removed, and committing the state file completes it", async () => {
    const hooks = join(scratch.area, "failing-hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho rejected by hook >&2\nexit 1\n", { mode: 0o755 });
    const strict = fixtureEnv(scratch.area, `[core]\n\thooksPath = ${hooks}\n`);
    const copy = copyOf(fixtureEnv(scratch.area));
    const failed = await initializeIn(copy, hostFor(strict, { run: passing }));
    expect(failed.status).toBe(1);
    expect(failed.err).toMatch(/enrollment did not complete/);
    expect(failed.err).toMatch(/commit \.template-state\.json/);
    expect(git(copy.dir, ["rev-parse", "HEAD~1"], strict).trim()).toBe(copy.original);
    expect(existsSync(join(copy.dir, ".template-state.json"))).toBe(true);
    expect(existsSync(join(copy.dir, "package.json"))).toBe(true);

    // The converted tree no longer carries the initialization command: the route that exists is an ordinary commit.
    expect(existsSync(join(copy.dir, "scripts/template/initialize.cjs"))).toBe(false);
    const gone = spawnSync(process.execPath, ["scripts/template/initialize.cjs", "--name=made-app", "--owner=made-owner"], { cwd: copy.dir, encoding: "utf8" });
    expect(gone.status).not.toBe(0);
    expect(gone.stderr).toMatch(/Cannot find module/);
    expect(git(copy.dir, ["status", "--porcelain"], strict)).toBe("A  .template-state.json\n");

    const fixed = fixtureEnv(scratch.area);
    git(copy.dir, ["add", ".template-state.json"], fixed);
    git(copy.dir, ["commit", "-q", "-m", "chore(template): enroll project in template updates"], fixed);
    expect(git(copy.dir, ["rev-list", "--count", "HEAD"], fixed).trim()).toBe("3");
    expect(git(copy.dir, ["status", "--porcelain"], fixed)).toBe("");
    expect(stateModule.parseState(readFileSync(join(copy.dir, ".template-state.json"), "utf8")).source).toEqual({
      kind: "github-template-copy",
      copiedCommit: copy.original,
    });
  });
});
