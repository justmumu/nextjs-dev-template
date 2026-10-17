import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { capture, scratchArea } from "../support/project.ts";
import { fixtureEnv, git, stateModule } from "../support/template-fixture.ts";
import { parseJson } from "../support/json.ts";
import { accept, advance, runIn, commitAll, journals, lineage, manifestText, templateEntry, update, write } from "../support/template-lineage.ts";

// Taking an update for real: a source repository that moves, applications made by both routes, a
// native merge in the project that is left uncommitted, the guard's acceptance of it and the user's
// own merge commit. Incoming code is inert; a preview file is only a claim that is proven again.
const scratch = scratchArea("template-update-");
const { source, createApp, copiedApp, previewFile, applyPreview, previewHost } = lineage(scratch.area);

const pkgOf = (dir: string) =>
  parseJson<{ version: string; dependencies: Record<string, string>; scripts: Record<string, string> }>(readFileSync(join(dir, "package.json"), "utf8"));
const stateOf = (dir: string) => stateModule.parseState(readFileSync(join(dir, ".template-state.json"), "utf8"));
const refs = (dir: string, env: NodeJS.ProcessEnv) => git(dir, ["for-each-ref", "--format=%(refname)"], env).trim().split("\n").filter(Boolean);
const gitDirOf = (dir: string, env: NodeJS.ProcessEnv) => git(dir, ["rev-parse", "--absolute-git-dir"], env).trim();

/** The user's own work on a fresh application: a version, a dependency, a component, and a local ignored file. */
function userWork(app: string, env: NodeJS.ProcessEnv) {
  const pkg = pkgOf(app);
  pkg.version = "2.4.1";
  pkg.dependencies["left-pad"] = "1.3.0";
  writeFileSync(join(app, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  write(app, "src/components/custom.tsx", "export const Custom = () => null;\n");
  commitAll(app, env, "feat: the application's own work");
  write(app, ".env.local", "SECRET=1\n");
}

/** What a person does after a clean `template:apply`: approve the diff, commit normally, settle. */
function finish(app: string, env: NodeJS.ProcessEnv) {
  const accepted = accept(app);
  expect(accepted.status, accepted.out).toBe(0);
  git(app, ["commit", "-q", "--no-edit"], env);
  const settled = runIn(app, "resume");
  expect(settled.status, settled.err).toBe(0);
}

describe("applying a clean preview", () => {
  test("the merge waits uncommitted, the guard accepts it only after the person, and a normal commit and settle finish it", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = source(env, {});
    const app = await createApp("clean-app", gen, env);
    userWork(app, env);
    const start = git(app, ["rev-parse", "HEAD"], env).trim();
    const first = stateOf(app);
    expect(accept(app).status).toBe(0);

    const upstream = advance(gen, env, {
      "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// from the template\n`,
      "template/app/public/new-asset.txt": "new\n",
      "scripts/hooks/commit-msg.cjs": `${readFileSync(join(gen, "scripts/hooks/commit-msg.cjs"), "utf8")}// a guard-side tooling change\n`,
      "tooling/template-manifest.json": manifestText(gen, (manifest) => manifest.entries.push(templateEntry("public/new-asset.txt"))),
    });
    const { result, path } = await previewFile(app, env, gen);
    expect(result.result.status).toBe("clean");
    const kept = `${path}.kept`;
    cpSync(path, kept);

    const applied = await applyPreview(app, env, gen, path);
    expect(applied.status, applied.err).toBe(0);
    expect(applied.out).toMatch(/clean and not committed/);

    // Nothing is committed: HEAD stays, the merge waits, and the new snapshot is kept by a reference.
    expect(git(app, ["rev-parse", "HEAD"], env).trim()).toBe(start);
    expect(git(app, ["rev-parse", "MERGE_HEAD"], env).trim()).toBe(result.next.commit);
    expect(git(app, ["rev-parse", journals.PENDING_REF], env).trim()).toBe(result.next.commit);
    expect(git(app, ["ls-files", "-u"], env)).toBe("");
    const journal = journals.parseJournal(readFileSync(join(gitDirOf(app, env), "template-update/journal.json"), "utf8"));
    expect(journal.phase).toBe("ready");
    expect(journal.source.sha).toBe(upstream);

    // The state is part of the same reviewed merge: staged, moved to the new snapshot, with the enrollment kept and the upstream named.
    const moved = stateOf(app);
    expect(moved.baseline).toEqual({ commit: result.next.commit, tree: result.next.tree });
    expect(moved.source).toEqual(first.source);
    expect(moved.answersDigest).toBe(first.answersDigest);
    expect(moved.upstream).toEqual({ url: `file://${gen}`, sha: upstream });
    expect(git(app, ["diff", "--cached", "--name-only"], env)).toContain(".template-state.json");
    expect(git(app, ["show", "HEAD:.template-state.json"], env)).not.toContain("upstream");

    // The user's work and the ignored file are intact next to the template's changes.
    expect(pkgOf(app).version).toBe("2.4.1");
    expect(pkgOf(app).dependencies["left-pad"]).toBe("1.3.0");
    expect(readFileSync(join(app, "src/components/custom.tsx"), "utf8")).toContain("Custom");
    expect(readFileSync(join(app, "next.config.ts"), "utf8")).toContain("// from the template");
    expect(readFileSync(join(app, ".env.local"), "utf8")).toBe("SECRET=1\n");

    // Acceptance is the person's: the guard states the guard-file change it is accepting, and then the merge commit is normal.
    const accepted = accept(app);
    expect(accepted.status).toBe(0);
    expect(accepted.out).toContain("scripts/hooks/commit-msg.cjs");
    expect(accepted.out).toContain(".template-state.json");
    git(app, ["commit", "-q", "--no-edit"], env);
    const [merge, parentA, parentB] = git(app, ["rev-list", "--parents", "-n", "1", "HEAD"], env).trim().split(" ");
    expect([parentA, parentB]).toEqual([start, result.next.commit]);
    expect(git(app, ["log", "-1", "--format=%s"], env).trim()).toBe(`chore(template): update to ${upstream.slice(0, 12)}`);
    expect(stateOf(app)).toEqual(moved);
    expect(git(app, ["show", `${merge}:.template-state.json`], env)).toBe(readFileSync(join(app, ".template-state.json"), "utf8"));

    // Settling removes the bookkeeping, not the history, and the next preview sees the new baseline.
    expect(runIn(app, "resume").status).toBe(0);
    expect(existsSync(join(gitDirOf(app, env), "template-update/journal.json"))).toBe(false);
    expect(refs(app, env)).toEqual(["refs/heads/main"]);
    expect(git(app, ["merge-base", "--is-ancestor", result.next.commit, "HEAD"], env)).toBe("");
    const again = await previewFile(app, env, gen);
    expect(again.result.result.status).toBe("current");

    // A preview file made before the update does not apply to the project it changed.
    const stale = await applyPreview(app, env, gen, kept);
    expect(stale.status).toBe(1);
    expect(stale.err).toMatch(/HEAD moved|run template:preview again/);
  }, 240_000);
});

describe("two updates from ordinary full clones", () => {
  test("keep the version, dependency and custom files, and stop on a real package and lock conflict until a person resolves it", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = source(env, {});
    const app = await createApp("project [space]", gen, env);
    userWork(app, env);
    const original = stateOf(app);
    const templateText = (path: string) => readFileSync(join(gen, "template/app", path), "utf8");

    // First update, then the old checkout is removed: nothing may depend on its refs, caches or ignored files.
    advance(gen, env, { "template/app/next.config.ts": `${templateText("next.config.ts")}// one\n` });
    const first = await previewFile(app, env, gen);
    const done = await applyPreview(app, env, gen, first.path);
    expect(done.status, done.err).toBe(0);
    finish(app, env);
    const clone = join(scratch.area, "clone [two]");
    git(scratch.area, ["clone", "-q", app, clone], env);
    rmSync(app, { recursive: true, force: true });
    expect(refs(clone, env).filter((ref) => ref.includes("template"))).toEqual([]);
    expect(existsSync(join(clone, ".env.local"))).toBe(false);

    // The user changes the very lines the template changes next, in the package and in the lock.
    const start = pkgOf(clone).scripts["start"] ?? "";
    expect(start).not.toBe("");
    const mine = readFileSync(join(clone, "package.json"), "utf8").replace(start, `${start} --mine`);
    writeFileSync(join(clone, "package.json"), mine);
    writeFileSync(
      join(clone, "pnpm-lock.yaml"),
      readFileSync(join(clone, "pnpm-lock.yaml"), "utf8").replace("lockfileVersion: '9.0'", "lockfileVersion: '9.0' # mine"),
    );
    write(clone, "src/components/second.tsx", "export const Second = () => null;\n");
    commitAll(clone, env, "feat: more of the application's own work");
    const start2 = git(clone, ["rev-parse", "HEAD"], env).trim();

    const upstream = advance(gen, env, {
      "template/app/package.json": templateText("package.json").replace(start, `${start} --theirs`),
      "template/app/pnpm-lock.yaml": templateText("pnpm-lock.yaml").replace("lockfileVersion: '9.0'", "lockfileVersion: '9.0' # theirs"),
    });
    const second = await previewFile(clone, env, gen);
    expect(second.result.result.status).toBe("conflicted");
    expect(second.result.result.conflicts.map((conflict) => conflict.path)).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(second.result.baseline.commit).toBe(stateOf(clone).baseline.commit);

    const applied = await applyPreview(clone, env, gen, second.path);
    expect(applied.status, applied.err).toBe(0);
    expect(applied.out).toMatch(/stopped on conflicts/);
    expect(git(clone, ["ls-files", "-u"], env)).toMatch(/package\.json/);
    expect(git(clone, ["ls-files", "-u"], env)).toMatch(/pnpm-lock\.yaml/);

    // Unmerged index stages are never accepted, and the conflicted files are not restored away.
    const refused = accept(clone);
    expect(refused.status).toBe(1);
    expect(readFileSync(join(clone, "package.json"), "utf8")).toContain("<<<<<<<");

    // Staging the markers is not resolving: the normal commit's hook gate is covered in hooks.test.ts; here the person resolves for real.
    writeFileSync(join(clone, "package.json"), mine.replace(`${start} --mine`, `${start} --mine --theirs`));
    writeFileSync(
      join(clone, "pnpm-lock.yaml"),
      readFileSync(join(clone, "pnpm-lock.yaml"), "utf8").replace(/<<<<<<<[\s\S]*?>>>>>>> [^\n]*\n/, "lockfileVersion: '9.0'\n"),
    );
    git(clone, ["add", "package.json", "pnpm-lock.yaml"], env);
    expect(git(clone, ["ls-files", "-u"], env)).toBe("");
    const mid = accept(clone);
    expect(mid.status, mid.out).toBe(0);
    git(clone, ["commit", "-q", "--no-edit"], env);
    expect(runIn(clone, "resume").status).toBe(0);

    // The two updates sit in the history as two merges over the application's own commits; the state names the latest snapshot.
    const log = git(clone, ["log", "--first-parent", "--format=%s"], env).trim().split("\n");
    expect(log.filter((subject) => subject.startsWith("chore(template): update to "))).toHaveLength(2);
    expect(stateOf(clone).upstream?.sha).toBe(upstream);
    expect(stateOf(clone).source).toEqual(original.source);
    expect(pkgOf(clone).version).toBe("2.4.1");
    expect(pkgOf(clone).dependencies["left-pad"]).toBe("1.3.0");
    expect(readFileSync(join(clone, "src/components/second.tsx"), "utf8")).toContain("Second");
    expect(readFileSync(join(clone, "src/components/custom.tsx"), "utf8")).toContain("Custom");
    expect(git(clone, ["rev-parse", "HEAD^1"], env).trim()).toBe(start2);
    expect(refs(clone, env).filter((ref) => ref.includes("template"))).toEqual([]);
  }, 300_000);
});

describe("a GitHub copy", () => {
  test("keeps its own first commit as the copy's, names the chosen upstream revision apart from it, and updates like the local route", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = source(env, {});
    const app = await copiedApp("copied-app", gen, env);
    const enrolled = stateOf(app);
    if (enrolled.source.kind !== "github-template-copy") throw new Error("expected the copy route");
    const copied = enrolled.source.copiedCommit;
    userWork(app, env);

    const upstream = advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// copy\n` });
    const { result, path } = await previewFile(app, env, gen);
    expect(result.result.status).toBe("clean");
    const applied = await applyPreview(app, env, gen, path);
    expect(applied.status, applied.err).toBe(0);
    finish(app, env);

    const updated = stateOf(app);
    expect(updated.source).toEqual({ kind: "github-template-copy", copiedCommit: copied });
    expect(updated.upstream?.sha).toBe(upstream);
    expect(updated.upstream?.sha).not.toBe(copied);
    expect(git(app, ["merge-base", "--is-ancestor", copied, "HEAD"], env)).toBe("");
    expect(git(app, ["rev-list", "--count", "--first-parent", "HEAD"], env).trim()).toBe("5");
    expect(pkgOf(app).version).toBe("2.4.1");
  }, 300_000);
});

describe("the preview file is only a claim", () => {
  async function prepared(extra: Record<string, string | null> = {}) {
    const env = fixtureEnv(scratch.area);
    const gen = source(env, {});
    const app = await createApp(`claim-${String(Math.random()).slice(2, 8)}`, gen, env);
    advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// claim\n`, ...extra });
    const made = await previewFile(app, env, gen);
    return { env, gen, app, ...made };
  }
  const untouched = (app: string, env: NodeJS.ProcessEnv) => {
    expect(existsSync(join(gitDirOf(app, env), "MERGE_HEAD"))).toBe(false);
    expect(existsSync(join(gitDirOf(app, env), "template-update/journal.json"))).toBe(false);
    expect(refs(app, env).filter((ref) => ref.includes("template"))).toEqual([]);
    expect(git(app, ["status", "--porcelain"], env)).toBe("");
  };
  const edited = (path: string, change: (preview: Record<string, Record<string, unknown>>) => void) => {
    const preview = parseJson<Record<string, Record<string, unknown>>>(readFileSync(path, "utf8"));
    change(preview);
    const target = `${path}.edited`;
    writeFileSync(target, JSON.stringify(preview, null, 2));
    return target;
  };

  test("another source, another result, another snapshot or a stale head each refuse before anything changes", async () => {
    const { env, gen, app, path } = await prepared();
    const url = edited(path, (preview) => {
      if (preview["source"]) preview["source"]["url"] = "https://example.invalid/other.git";
    });
    const other = await applyPreview(app, env, gen, url);
    expect(other.status).toBe(1);
    expect(other.err).toMatch(/another source/);

    const production = capture();
    expect(await update.apply([`--preview=${path}`], { root: app, cwd: app, io: production.io, host: previewHost(env) })).toBe(1);
    expect(production.err()).toMatch(/another source/);

    for (const change of [
      (preview: Record<string, Record<string, unknown>>) => {
        if (preview["result"]) preview["result"]["status"] = "current";
      },
      (preview: Record<string, Record<string, unknown>>) => {
        if (preview["result"]) preview["result"]["outputDigest"] = "0".repeat(64);
      },
      (preview: Record<string, Record<string, unknown>>) => {
        if (preview["next"]) preview["next"]["renderDigest"] = "1".repeat(64);
      },
      (preview: Record<string, Record<string, unknown>>) => {
        if (preview["bindings"]) preview["bindings"]["engineDigest"] = "2".repeat(64);
      },
    ]) {
      const result = await applyPreview(app, env, gen, edited(path, change));
      expect(result.status).toBe(1);
      expect(result.err).toMatch(/not what updating now would do/);
    }

    write(app, "src/moved.ts", "export {};\n");
    commitAll(app, env, "feat: head moves");
    const moved = await applyPreview(app, env, gen, path);
    expect(moved.status).toBe(1);
    expect(moved.err).toMatch(/HEAD moved/);
    untouched(app, env);
  }, 300_000);

  test("a source ref that moved since the preview, uncommitted or hidden changes, and a merge in progress each refuse", async () => {
    const { env, gen, app, path } = await prepared();
    const dirty = join(app, "next.config.ts");
    const original = readFileSync(dirty, "utf8");
    writeFileSync(dirty, `${original}// uncommitted\n`);
    const unclean = await applyPreview(app, env, gen, path);
    expect(unclean.status).toBe(1);
    expect(unclean.err).toMatch(/commit or stash the tracked changes first:\s+M next\.config\.ts/);
    git(app, ["checkout", "--", "next.config.ts"], env);

    git(app, ["update-index", "--assume-unchanged", "next.config.ts"], env);
    const hidden = await applyPreview(app, env, gen, path);
    expect(hidden.status).toBe(1);
    expect(hidden.err).toMatch(/ignore changes to tracked files/);
    git(app, ["update-index", "--no-assume-unchanged", "next.config.ts"], env);

    writeFileSync(join(gitDirOf(app, env), "CHERRY_PICK_HEAD"), git(app, ["rev-parse", "HEAD"], env));
    const busy = await applyPreview(app, env, gen, path);
    expect(busy.status).toBe(1);
    expect(busy.err).toMatch(/CHERRY_PICK_HEAD exists/);
    rmSync(join(gitDirOf(app, env), "CHERRY_PICK_HEAD"));

    advance(gen, env, {
      "template/app/public/moved.txt": "x\n",
      "tooling/template-manifest.json": manifestText(gen, (manifest) => manifest.entries.push(templateEntry("public/moved.txt"))),
    });
    const moved = await applyPreview(app, env, gen, path);
    expect(moved.status).toBe(1);
    expect(moved.err).toMatch(/not what updating now would do/);
    untouched(app, env);
  }, 300_000);

  test("an update that would change the installed engine is refused with its reason and the project stays as it was", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = source(env, {});
    const app = await createApp("engine-app", gen, env);
    advance(gen, env, { "scripts/template/inputs.cjs": `${readFileSync(join(gen, "scripts/template/inputs.cjs"), "utf8")}// a new engine\n` });
    const { path, result } = await previewFile(app, env, gen);
    expect(result.result.changes.map((change) => change.path)).toEqual(["scripts/template/inputs.cjs"]);
    const refusal = await applyPreview(app, env, gen, path);
    expect(refusal.status).toBe(1);
    expect(refusal.err).toMatch(/changes the installed update engine \(scripts\/template\/inputs\.cjs\)/);
    expect(existsSync(join(gitDirOf(app, env), "template-update/journal.json"))).toBe(false);
    expect(git(app, ["status", "--porcelain"], env)).toBe("");
  }, 300_000);

  test("a source that has not moved is current: nothing is applied", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = source(env, {});
    const app = await createApp("current-app", gen, env);
    const { path } = await previewFile(app, env, gen);
    const result = await applyPreview(app, env, gen, path);
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/nothing was changed/);
    expect(git(app, ["status", "--porcelain"], env)).toBe("");
    expect(existsSync(join(gitDirOf(app, env), "template-update/journal.json"))).toBe(false);
  }, 300_000);

  test("a second apply while an update is in progress is refused, and the first one stays", async () => {
    const { env, gen, app, path } = await prepared();
    expect((await applyPreview(app, env, gen, path)).status).toBe(0);
    const again = await applyPreview(app, env, gen, path);
    expect(again.status).toBe(1);
    expect(again.err).toMatch(/update is in progress/);
    expect(git(app, ["rev-parse", "--verify", "MERGE_HEAD"], env).trim()).toHaveLength(40);
  }, 300_000);
});

describe("application versions", () => {
  test("an application that was never bumped keeps its initial 0.0.0 through an update, as one released at 2.4.1 keeps that", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = source(env, {});
    const app = await createApp("initial-version", gen, env);
    expect(pkgOf(app).version).toBe("0.0.0");
    advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// version\n` });
    const { path } = await previewFile(app, env, gen);
    expect((await applyPreview(app, env, gen, path)).status).toBe(0);
    finish(app, env);
    expect(pkgOf(app).version).toBe("0.0.0");
    expect(git(app, ["show", "HEAD^2:package.json"], env)).toContain('"version": "0.0.0"');
  }, 300_000);
});

describe("the public command", () => {
  test("the application's own files apply with the production defaults: the public source only, one preview, nothing else read", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = source(env, {});
    const app = await createApp("command-app", gen, env);
    const script =
      "const io = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) };" +
      "require('./scripts/template/update.cjs').apply(process.argv.slice(1), { root: process.cwd(), cwd: process.cwd(), io }).then((status) => { process.exitCode = status; });";
    const run = (...args: string[]) => spawnSync(process.execPath, ["-e", script, "--", ...args], { cwd: app, env: process.env, encoding: "utf8" });
    const missing = run("--preview=.git/template-update/preview.json");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/the preview file .* could not be read/);

    // A preview made against a fixture source names a source that is not the template's public repository.
    advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// public\n` });
    const { path } = await previewFile(app, env, gen);
    const other = run(`--preview=${path}`);
    expect(other.status).toBe(1);
    expect(other.stderr).toMatch(/another source than the template's public repository/);
    expect(git(app, ["status", "--porcelain"], env)).toBe("");
    expect(existsSync(join(gitDirOf(app, env), "template-update/journal.json"))).toBe(false);
  }, 120_000);
});
