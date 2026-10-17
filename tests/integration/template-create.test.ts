import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { capture, scratchArea } from "../support/project.ts";
import {
  counting,
  create,
  fixtureEnv,
  interrupting,
  generatorCopy,
  git,
  gitModule,
  hostFor,
  inputsOf,
  passing,
  render,
  stateModule,
  type Host,
} from "../support/template-fixture.ts";

// Local creation with a real Git, real files and real processes. Only the scenarios about what
// surrounds the validation tools replace them; the two that prove the validation itself
// (this file's first test, and the GitHub route's in template-initialize.test.ts) run the real tools.
const scratch = scratchArea("template-create-");
const answers = { name: "made-app", owner: "made-owner" };

const walk = (dir: string, prefix = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );

function generator(env: NodeJS.ProcessEnv, files: Record<string, string> = {}) {
  const dir = generatorCopy(scratch.area, `gen-${String(Math.random()).slice(2, 8)}`, env, files);
  return { dir, inputs: inputsOf(dir) };
}

async function createIn(gen: ReturnType<typeof generator>, host: Host, dest: string, over: { answers?: object; isCancelled?: () => boolean } = {}) {
  const sink = capture();
  const status = await create.createLocal({
    host,
    io: sink.io,
    isCancelled: over.isCancelled ?? (() => false),
    inputs: gen.inputs,
    answers: over.answers ?? answers,
    dest,
    source: () => create.generatorSource({ git: host.git, root: gen.dir, manifest: gen.inputs.manifest }),
  });
  return { status, out: sink.out(), err: sink.err() };
}

describe("a real local creation, with the capabilities that U16 activates already on", () => {
  test("validates the guard-and-hooks profile in staging, leaves two clean commits, and sets up later in the project", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = generator(env, { "tooling/capabilities.json": '{\n  "guard": true,\n  "hooks": true\n}\n' });
    const host = hostFor(env);
    const dest = join(scratch.area, "created");
    const result = await createIn(gen, host, dest, { answers: { name: "real-app", owner: "real-owner" } });
    expect(result.status, result.err).toBe(0);

    const { files, digest } = render.renderTree({ ...gen.inputs, answers: { name: "real-app", owner: "real-owner" } });
    const log = git(dest, ["log", "--format=%an|%ae|%P|%s"], env).trim().split("\n");
    expect(log).toHaveLength(2);
    const [enrollment, pristine] = log.map((line) => line.split("|")) as [string[], string[]];
    expect(pristine).toEqual([gitModule.PROVENANCE.name, gitModule.PROVENANCE.email, "", "chore(template): pristine render"]);
    expect(enrollment[0]).toBe("Fixture User");
    expect(enrollment[1]).toBe("fixture@users.noreply.github.com");
    expect(enrollment[2]).toBe(git(dest, ["rev-parse", "HEAD~1"], env).trim());
    const [b0] = git(dest, ["rev-list", "--max-parents=0", "HEAD"], env).trim().split("\n");

    // B0 is exactly the rendered tree; the state file is in E0 only.
    const tree = git(dest, ["ls-tree", "-r", "-z", b0 ?? ""], env)
      .split("\0")
      .filter(Boolean)
      .map((line) => /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(line) as RegExpExecArray)
      .map((match) => ({ mode: match[1] as string, sha: match[2] as string, stage: "0", path: match[3] as string }));
    expect(gitModule.treeProblems(tree, files)).toEqual([]);
    expect(git(dest, ["ls-tree", "-r", "--name-only", "HEAD"], env).split("\n")).toContain(".template-state.json");
    expect(tree.map((entry) => entry.path)).not.toContain(".template-state.json");

    const recorded = stateModule.parseState(readFileSync(join(dest, ".template-state.json"), "utf8"));
    expect(recorded.source).toEqual({ kind: "local-generator", revision: git(gen.dir, ["rev-parse", "HEAD"], env).trim() });
    expect(recorded.baseline.commit).toBe(b0);
    expect(recorded.baseline.tree).toBe(git(dest, ["rev-parse", `${b0}^{tree}`], env).trim());
    expect(recorded.renderDigest).toBe(digest);

    // Clean source, history and state: no install, cache, hook, machine path or identity of the generator.
    expect(git(dest, ["status", "--porcelain", "--ignored"], env)).toBe("");
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
    expect(existsSync(join(dest, ".git", "hooks"))).toBe(false);
    expect(git(dest, ["config", "--local", "--list"], env)).not.toMatch(/user\.|remote\./);
    for (const file of files) {
      expect(readFileSync(join(dest, file.path)).equals(file.content), file.path).toBe(true);
      expect(statSync(join(dest, file.path)).mode & 0o777, file.path).toBe(file.mode);
      expect(file.content.includes(scratch.area), file.path).toBe(false);
    }
    expect(readFileSync(join(dest, ".template-state.json"), "utf8")).not.toContain(scratch.area);
    expect(
      walk(dest)
        .filter((path) => !path.startsWith(".git/"))
        .sort(),
    ).toEqual([...files.map((file) => file.path), ".template-state.json"].sort());

    // A full clone carries both commits.
    const clone = join(scratch.area, "clone");
    git(scratch.area, ["clone", "-q", dest, clone], env);
    expect(git(clone, ["rev-list", "--count", "HEAD"], env).trim()).toBe("2");

    // Setup is the later, explicit step: it establishes the project's own hooks and binding.
    const setup = await host.run(process.execPath, ["scripts/bootstrap.cjs", "setup"], { cwd: dest, env: host.env });
    expect(setup).toBe(0);
    for (const hook of ["pre-commit", "commit-msg", "pre-push"]) expect(existsSync(join(dest, ".git", "hooks", hook)), hook).toBe(true);
    expect(git(dest, ["status", "--porcelain"], env)).toBe("");
  }, 900_000);
});

describe("creation around the validation", () => {
  test("two names give two projects with the same contract, each its own state", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = generator(env);
    const trees: string[] = [];
    for (const name of ["first-app", "second-app"]) {
      const dest = join(scratch.area, name);
      const result = await createIn(gen, hostFor(env, { run: passing }), dest, { answers: { name, owner: "some-owner" } });
      expect(result.status, result.err).toBe(0);
      expect((JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as { name: string }).name).toBe(name);
      expect(git(dest, ["status", "--porcelain"], env)).toBe("");
      trees.push(readFileSync(join(dest, ".template-state.json"), "utf8"));
    }
    expect(trees[0]).not.toBe(trees[1]);
  });

  test("the staged manifest holds no install, cache, build or hook path", () => {
    const { files } = render.renderTree({ ...render.defaultInputs(), answers });
    const generated =
      /(^|\/)(node_modules|\.next|\.git|\.githooks|\.husky|coverage|dist|cache|\.turbo|playwright-report|test-results)(\/|$)|\.tsbuildinfo$|next-env\.d\.ts$|\.template-/;
    expect(files.map((file) => file.path).filter((path) => generated.test(path) && path !== ".template-state.json")).toEqual([]);
    expect(files.map((file) => file.path)).not.toContain(".template-state.json");
  });

  test("a failing validation step leaves a missing destination missing and an empty one empty", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = generator(env);
    const failing: Host["run"] = (_command, args) => Promise.resolve(args.includes("build") ? 1 : 0);
    const missing = join(scratch.area, "never-made");
    const first = await createIn(gen, hostFor(env, { run: failing }), missing);
    expect(first.status).toBe(1);
    expect(first.err).toMatch(/failed at build; nothing was written to the target/);
    expect(existsSync(missing)).toBe(false);
    const empty = join(scratch.area, "empty-dir");
    mkdirSync(empty);
    expect((await createIn(gen, hostFor(env, { run: failing }), empty)).status).toBe(1);
    expect(readdirSync(empty)).toEqual([]);
  });

  test("a validator that rewrites a tracked file is refused instead of its output becoming the template", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = generator(env);
    const dest = join(scratch.area, "rewritten");
    const result = await createIn(
      gen,
      hostFor(env, {
        run: (_command, args, { cwd }) => {
          if (args.includes("check")) appendFileSync(join(cwd, "src/app/page.tsx"), "// formatted\n");
          return Promise.resolve(0);
        },
      }),
      dest,
    );
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/src\/app\/page\.tsx was changed by validation/);
    expect(existsSync(dest)).toBe(false);
  });

  test("a validator that leaves an untracked file behind is refused", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = generator(env);
    const result = await createIn(
      gen,
      hostFor(env, {
        run: (_command, args, { cwd }) => {
          if (args.includes("build")) writeFileSync(join(cwd, "leftover.txt"), "x");
          return Promise.resolve(0);
        },
      }),
      join(scratch.area, "leftover"),
    );
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/leftover\.txt uncommitted or untracked/);
  });

  test("a destination that is not empty, is a file, or sits below a symlink is refused before anything is staged", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = generator(env);
    const counter = counting();
    const full = join(scratch.area, "full");
    mkdirSync(full);
    writeFileSync(join(full, "mine.txt"), "mine");
    const file = join(scratch.area, "a-file");
    writeFileSync(file, "x");
    const real = join(scratch.area, "real-dir");
    mkdirSync(real);
    const link = join(scratch.area, "link");
    symlinkSync(real, link);
    for (const [dest, message] of [
      [full, /not empty/],
      [file, /not a directory/],
      [join(link, "sub"), /symlink/],
    ] as const) {
      await expect(createIn(gen, hostFor(env, { run: counter.run }), dest)).rejects.toThrow(message);
    }
    expect(counter.runs()).toBe(0);
    expect(readFileSync(join(full, "mine.txt"), "utf8")).toBe("mine");
    expect(readdirSync(real)).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("a generator with uncommitted changes in what the render reads cannot claim a revision", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = generator(env);
    appendFileSync(join(gen.dir, "template/app/src/app/page.tsx"), "// edited\n");
    await expect(createIn(gen, hostFor(env, { run: passing }), join(scratch.area, "unclaimed"))).rejects.toThrow(
      /uncommitted changes in what the render reads/,
    );
    expect(existsSync(join(scratch.area, "unclaimed"))).toBe(false);
  });

  test.each(["--assume-unchanged", "--skip-worktree"])(
    "an input of the render that Git is told to ignore (%s) cannot be recorded as a clean revision",
    async (flag) => {
      const env = fixtureEnv(scratch.area);
      const gen = generator(env);
      git(gen.dir, ["update-index", flag, "template/app/src/app/page.tsx"], env);
      appendFileSync(join(gen.dir, "template/app/src/app/page.tsx"), "// hidden edit\n");
      expect(git(gen.dir, ["status", "--porcelain"], env)).toBe("");
      const counter = counting();
      const dest = join(scratch.area, "hidden-input");
      await expect(createIn(gen, hostFor(env, { run: counter.run }), dest)).rejects.toThrow(/hide their changes from Git/);
      expect(counter.runs()).toBe(0);
      expect(existsSync(dest)).toBe(false);
      expect(git(gen.dir, ["ls-files", "-v", "template/app/src/app/page.tsx"], env)).toMatch(/^[hS] /);
    },
  );

  test("a flag on a file the render does not read is not in the way", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = generator(env);
    git(gen.dir, ["update-index", "--assume-unchanged", "README.md"], env);
    const result = await createIn(gen, hostFor(env, { run: passing }), join(scratch.area, "unrelated-flag"));
    expect(result.status, result.err).toBe(0);
  });

  test("a validator that changes only the permissions of a file is refused, and the destination stays missing", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = generator(env);
    const dest = join(scratch.area, "permissions");
    const result = await createIn(
      gen,
      hostFor(env, {
        run: (_command, args, { cwd }) => {
          if (args.includes("check")) chmodSync(join(cwd, "package.json"), 0o600);
          return Promise.resolve(0);
        },
      }),
      dest,
    );
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/package\.json changed its mode during validation \(600, rendered 644\)/);
    expect(existsSync(dest)).toBe(false);
  });

  test("a staged application whose production server does not start fails at the smoke and creates nothing", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = generator(env);
    // The validation tools pass without installing anything, so there is no server to start: the real smoke runs against that.
    const real = hostFor(env);
    const host = hostFor(env, { run: passing, smoke: (options) => real.smoke(options) });
    const dest = join(scratch.area, "no-server");
    const result = await createIn(gen, host, dest);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/staging validation failed at smoke: .* exited \(status 1\) before it answered http:\/\/127\.0\.0\.1:\d+\//);
    expect(result.err).toMatch(/nothing was written to the target/);
    expect(existsSync(dest)).toBe(false);
  }, 120_000);

  test("no Git identity stops before staging and creates nothing", async () => {
    const env = fixtureEnv(scratch.area);
    writeFileSync(env["GIT_CONFIG_GLOBAL"] ?? "", "[user]\n\tuseConfigOnly = true\n");
    const gen = generator(fixtureEnv(scratch.area));
    const counter = counting();
    const result = await createIn(gen, hostFor(env, { run: counter.run }), join(scratch.area, "anonymous"));
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/no author or committer identity/);
    expect(counter.runs()).toBe(0);
    expect(existsSync(join(scratch.area, "anonymous"))).toBe(false);
  });

  test("a hook that rejects the enrollment commit is not success: the pristine commit and state stay, nothing is deleted, and committing completes it", async () => {
    const hooks = join(scratch.area, "failing-hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho rejected by hook >&2\nexit 1\n", { mode: 0o755 });
    const env = fixtureEnv(scratch.area, `[core]\n\thooksPath = ${hooks}\n`);
    const gen = generator(fixtureEnv(scratch.area));
    const dest = join(scratch.area, "hook-rejected");
    const result = await createIn(gen, hostFor(env, { run: passing }), dest);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/enrollment did not complete/);
    expect(result.err).toMatch(/no file of yours was removed/);
    expect(git(dest, ["rev-list", "--count", "HEAD"], env).trim()).toBe("1");
    expect(existsSync(join(dest, ".template-state.json"))).toBe(true);
    expect(existsSync(join(dest, "package.json"))).toBe(true);
    git(dest, ["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore(template): enroll project in template updates"], env);
    expect(git(dest, ["status", "--porcelain"], env)).toBe("");
  });

  test("an interruption during validation creates nothing", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = generator(env);
    const stop = interrupting();
    const dest = join(scratch.area, "interrupted");
    const result = await createIn(gen, hostFor(env, { run: stop.run }), dest, { isCancelled: stop.isCancelled });
    expect(result.status).toBe(1);
    expect(existsSync(dest)).toBe(false);
  });
});
