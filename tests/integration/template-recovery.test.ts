import { existsSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { capture, scratchArea } from "../support/project.ts";
import { fixtureEnv, git, gitModule, stateModule } from "../support/template-fixture.ts";
import { parseJson } from "../support/json.ts";
import { accept, advance, commitAll, journals, lineage, raw, update, write } from "../support/template-lineage.ts";

// The ways out of an update that is in progress, for real: the raw recovery entry as a child process
// of Node alone in a project whose package.json is conflicted and that has no node_modules, a merge
// killed between its steps, a state file someone else changed, and a bookkeeping that must outlive any age.
const scratch = scratchArea("template-recovery-");
const { source, createApp, previewFile, applyPreview, previewHost } = lineage(scratch.area);

const gitDirOf = (dir: string, env: NodeJS.ProcessEnv) => git(dir, ["rev-parse", "--absolute-git-dir"], env).trim();
const journalPath = (dir: string, env: NodeJS.ProcessEnv) => join(gitDirOf(dir, env), "template-update/journal.json");
const refs = (dir: string, env: NodeJS.ProcessEnv) => git(dir, ["for-each-ref", "--format=%(refname)"], env).trim().split("\n").filter(Boolean);
const tracked = (dir: string, env: NodeJS.ProcessEnv) => git(dir, ["status", "--porcelain", "--untracked-files=no"], env);

/** An application with its own work, a template change that conflicts in package.json and the lock, and the conflicted update applied. */
async function conflicted() {
  const env = fixtureEnv(scratch.area);
  const gen = source(env, {});
  const app = await createApp(`recover-${String(Math.random()).slice(2, 8)}`, gen, env);
  const templateText = (path: string) => readFileSync(join(gen, "template/app", path), "utf8");
  const start = (JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["start"] ?? "";
  writeFileSync(join(app, "package.json"), readFileSync(join(app, "package.json"), "utf8").replace(start, `${start} --mine`));
  writeFileSync(
    join(app, "pnpm-lock.yaml"),
    readFileSync(join(app, "pnpm-lock.yaml"), "utf8").replace("lockfileVersion: '9.0'", "lockfileVersion: '9.0' # mine"),
  );
  commitAll(app, env, "feat: my own changes");
  write(app, ".env.local", "SECRET=1\n");
  advance(gen, env, {
    "template/app/package.json": templateText("package.json").replace(start, `${start} --theirs`),
    "template/app/pnpm-lock.yaml": templateText("pnpm-lock.yaml").replace("lockfileVersion: '9.0'", "lockfileVersion: '9.0' # theirs"),
  });
  const made = await previewFile(app, env, gen);
  return { env, gen, app, ...made, head: git(app, ["rev-parse", "HEAD"], env).trim() };
}

describe("the raw recovery entry", () => {
  test("inspects, resumes without a second merge and aborts, with a conflicted package.json, no node_modules and no package manager", async () => {
    const { env, gen, app, path, head } = await conflicted();
    const before = {
      index: git(app, ["ls-files", "-s"], env),
      state: readFileSync(join(app, ".template-state.json"), "utf8"),
      package: readFileSync(join(app, "package.json"), "utf8"),
    };
    expect((await applyPreview(app, env, gen, path)).status).toBe(0);
    expect(() => {
      JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
    }).toThrow();
    expect(existsSync(join(app, "node_modules"))).toBe(false);

    const inspected = raw(app, "inspect");
    expect(inspected.err).toBe("");
    expect(inspected.status).toBe(0);
    expect(inspected.out).toMatch(/phase: ready/);
    expect(inspected.out).toMatch(/unmerged: package\.json/);
    expect(inspected.out).toMatch(/unmerged: pnpm-lock\.yaml/);
    expect(inspected.out).toMatch(/\.template-state\.json: new/);

    // A repeated resume applies nothing again: the index, MERGE_HEAD and HEAD are exactly as they were.
    const merged = {
      index: git(app, ["ls-files", "-s", "-u"], env),
      merge: git(app, ["rev-parse", "MERGE_HEAD"], env),
      package: readFileSync(join(app, "package.json"), "utf8"),
    };
    for (let i = 0; i < 2; i += 1) {
      const resumed = raw(app, "resume");
      expect(resumed.status, resumed.err).toBe(0);
      expect(resumed.out).toMatch(/already applied; nothing was merged again/);
    }
    expect({
      index: git(app, ["ls-files", "-s", "-u"], env),
      merge: git(app, ["rev-parse", "MERGE_HEAD"], env),
      package: readFileSync(join(app, "package.json"), "utf8"),
    }).toEqual(merged);

    // The user's tracked and ignored files are put back by abort, the bookkeeping goes, the preview file stays.
    const aborted = raw(app, "abort");
    expect(aborted.status, aborted.err).toBe(0);
    expect(git(app, ["rev-parse", "HEAD"], env).trim()).toBe(head);
    expect(git(app, ["ls-files", "-s"], env)).toBe(before.index);
    expect(readFileSync(join(app, ".template-state.json"), "utf8")).toBe(before.state);
    expect(readFileSync(join(app, "package.json"), "utf8")).toBe(before.package);
    expect(tracked(app, env)).toBe("");
    expect(existsSync(join(gitDirOf(app, env), "MERGE_HEAD"))).toBe(false);
    expect(existsSync(journalPath(app, env))).toBe(false);
    expect(refs(app, env).filter((ref) => ref.includes("template"))).toEqual([]);
    expect(readFileSync(join(app, ".env.local"), "utf8")).toBe("SECRET=1\n");
    expect(existsSync(path)).toBe(true);
    expect(raw(app, "inspect").out).toMatch(/no template update is in progress/);

    // After an abort the same preview can be applied again; nothing of the first attempt is in the way.
    expect((await applyPreview(app, env, gen, path)).status).toBe(0);
    expect(raw(app, "abort").status).toBe(0);
  }, 300_000);

  test("an unknown command or extra argument is a usage error", async () => {
    const { app } = await conflicted();
    const none = raw(app, "restore");
    expect(none.status).toBe(2);
    expect(none.err).toMatch(/usage: node scripts\/template\/update\.cjs inspect\|abort\|resume/);
  }, 300_000);
});

describe("an update killed between its steps", () => {
  /** Applies with a Git whose chosen call dies the way a killed process would: after the earlier steps, before the later ones. */
  async function killedAt(over: (git: ReturnType<typeof gitModule.createGit>) => Partial<ReturnType<typeof gitModule.createGit>>) {
    const made = await conflicted();
    const host = previewHost(made.env);
    const killed = { ...host, git: { ...host.git, ...over(host.git) } };
    const sink = capture();
    await expect(
      update.apply([`--preview=${made.path}`], { root: made.app, cwd: made.app, io: sink.io, host: killed, url: `file://${made.gen}` }),
    ).rejects.toThrow(/killed/);
    return made;
  }

  test("before the merge: resume does the merge once, then nothing again", async () => {
    // The preview's own merge in its disposable clone is the first call; the project's is the second.
    let calls = 0;
    const { app, env, head } = await killedAt((real) => ({
      mergeNoCommit: (cwd, commit, message) => {
        calls += 1;
        if (calls > 1) throw new Error("killed");
        return real.mergeNoCommit(cwd, commit, message);
      },
    }));
    expect(git(app, ["rev-parse", "HEAD"], env).trim()).toBe(head);
    expect(existsSync(join(gitDirOf(app, env), "MERGE_HEAD"))).toBe(false);
    expect(journals.parseJournal(readFileSync(journalPath(app, env), "utf8")).phase).toBe("prepared");
    expect(existsSync(join(gitDirOf(app, env), "template-update/update.lock"))).toBe(false);
    expect(raw(app, "inspect").out).toMatch(/phase: prepared/);

    const resumed = raw(app, "resume");
    expect(resumed.status, resumed.err).toBe(0);
    expect(journals.parseJournal(readFileSync(journalPath(app, env), "utf8")).phase).toBe("ready");
    const merged = git(app, ["ls-files", "-s", "-u"], env);
    expect(raw(app, "resume").out).toMatch(/already applied/);
    expect(git(app, ["ls-files", "-s", "-u"], env)).toBe(merged);
    expect(raw(app, "abort").status).toBe(0);
    expect(tracked(app, env)).toBe("");
  }, 300_000);

  test("after the merge, before the state: resume writes the state once; abort from here restores it", async () => {
    const { app, env, head } = await killedAt((real) => ({
      out: (cwd, args, own, extra) => {
        if (args[0] === "add" && args.includes(".template-state.json")) throw new Error("killed");
        return real.out(cwd, args, own, extra);
      },
    }));
    expect(journals.parseJournal(readFileSync(journalPath(app, env), "utf8")).phase).toBe("merged");
    expect(raw(app, "inspect").status).toBe(0);
    const resumed = raw(app, "resume");
    expect(resumed.status, resumed.err).toBe(0);
    expect(journals.parseJournal(readFileSync(journalPath(app, env), "utf8")).phase).toBe("ready");
    expect(git(app, ["diff", "--cached", "--name-only"], env)).toContain(".template-state.json");
    expect(raw(app, "abort").status).toBe(0);
    expect(git(app, ["rev-parse", "HEAD"], env).trim()).toBe(head);
    expect(tracked(app, env)).toBe("");
    expect(stateModule.parseState(readFileSync(join(app, ".template-state.json"), "utf8")).upstream).toBeUndefined();
  }, 300_000);
});

describe("ownership and failure", () => {
  test("a state file someone else changed is never overwritten, by abort or resume, and the update stays recorded", async () => {
    const { env, gen, app, path } = await conflicted();
    expect((await applyPreview(app, env, gen, path)).status).toBe(0);
    writeFileSync(join(app, ".template-state.json"), '{ "edited": "by a person" }\n');
    for (const command of ["abort", "resume"]) {
      const refused = raw(app, command);
      expect(refused.status).toBe(1);
      expect(refused.err).toMatch(/\.template-state\.json was changed by someone else; it was not overwritten/);
    }
    const inspected = raw(app, "inspect");
    expect(inspected.status).toBe(1);
    expect(inspected.out).toMatch(/changed by someone else/);
    expect(readFileSync(join(app, ".template-state.json"), "utf8")).toBe('{ "edited": "by a person" }\n');
    expect(existsSync(join(gitDirOf(app, env), "MERGE_HEAD"))).toBe(true);
    expect(existsSync(journalPath(app, env))).toBe(true);
  }, 300_000);

  /** A clean update applied and waiting: the merge result is staged and can be edited on top. */
  async function clean() {
    const env = fixtureEnv(scratch.area);
    const gen = source(env, {});
    const app = await createApp(`clean-${String(Math.random()).slice(2, 8)}`, gen, env);
    advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// clean\n` });
    const made = await previewFile(app, env, gen);
    const head = git(app, ["rev-parse", "HEAD"], env).trim();
    expect((await applyPreview(app, env, gen, made.path)).status).toBe(0);
    return { env, gen, app, head, ...made };
  }

  test("a failed abort leaves a backup, the journal and a way to retry once the cause is gone", async () => {
    const { env, app, head } = await clean();
    const config = join(app, "next.config.ts");
    writeFileSync(config, `${readFileSync(config, "utf8")}// a person's edit on top of the merge\n`);
    const failed = raw(app, "abort");
    expect(failed.status).toBe(1);
    expect(failed.err).toMatch(/a backup of what was replaced is in .*template-update\/backup\//);
    const backups = readdirSync(join(gitDirOf(app, env), "template-update/backup"));
    expect(backups).toHaveLength(1);
    const backup = join(gitDirOf(app, env), "template-update/backup", backups[0] ?? "");
    expect(readdirSync(backup).sort()).toEqual(["journal.json", "owned-0"]);
    expect(existsSync(journalPath(app, env))).toBe(true);
    expect(existsSync(join(gitDirOf(app, env), "template-update/update.lock"))).toBe(false);
    expect(readFileSync(config, "utf8")).toContain("a person's edit");

    git(app, ["checkout", "--", "next.config.ts"], env);
    const retried = raw(app, "abort");
    expect(retried.status, retried.err).toBe(0);
    expect(git(app, ["rev-parse", "HEAD"], env).trim()).toBe(head);
    expect(tracked(app, env)).toBe("");
    expect(existsSync(join(gitDirOf(app, env), "template-update/backup"))).toBe(false);
  }, 300_000);

  test("the bookkeeping never expires by age, a held lock is respected, and a journal that cannot be read is not guessed at", async () => {
    const { env, app } = await clean();
    const long = new Date("2001-01-01T00:00:00Z");
    utimesSync(journalPath(app, env), long, long);
    utimesSync(join(gitDirOf(app, env), "refs/template-update/pending"), long, long);
    expect(raw(app, "resume").out).toMatch(/already applied/);
    expect(existsSync(journalPath(app, env))).toBe(true);
    expect(refs(app, env)).toContain(journals.PENDING_REF);

    const lock = join(gitDirOf(app, env), "template-update/update.lock");
    writeFileSync(lock, "999999\n");
    const held = raw(app, "abort");
    expect(held.status).toBe(1);
    expect(held.err).toMatch(/another update command holds .*update\.lock/);
    expect(existsSync(join(gitDirOf(app, env), "MERGE_HEAD"))).toBe(true);
    rmSync(lock);

    const text = readFileSync(journalPath(app, env), "utf8");
    writeFileSync(journalPath(app, env), text.slice(0, text.length / 2));
    for (const command of ["inspect", "abort", "resume"]) {
      const unreadable = raw(app, command);
      expect(unreadable.status, command).toBe(1);
      expect(unreadable.err).toMatch(/update journal is not valid JSON/);
    }
    expect(refs(app, env)).toContain(journals.PENDING_REF);
    expect(existsSync(join(gitDirOf(app, env), "MERGE_HEAD"))).toBe(true);
    writeFileSync(journalPath(app, env), text);
    expect(raw(app, "abort").status).toBe(0);
  }, 300_000);

  test("a pending reference without a journal is reported and kept", async () => {
    const { env, app, head } = await clean();
    expect(raw(app, "abort").status).toBe(0);
    git(app, ["update-ref", journals.PENDING_REF, head], env);
    const orphan = raw(app, "inspect");
    expect(orphan.status).toBe(1);
    expect(orphan.err).toMatch(/no update journal, but refs\/template-update\/pending points to/);
    expect(refs(app, env)).toContain(journals.PENDING_REF);
  }, 300_000);

  test("after the person's own merge commit, resume finishes the bookkeeping once; a commit that is not the update's is not taken for it", async () => {
    const { env, app } = await clean();
    const accepted = accept(app);
    expect(accepted.status, accepted.out).toBe(0);
    // The person drops the update's state from the commit: the merge is committed, but it is not the update.
    git(app, ["reset", "-q", "HEAD", "--", ".template-state.json"], env);
    git(app, ["checkout", "--", ".template-state.json"], env);
    git(app, ["commit", "-q", "--no-edit"], env);
    const inspected = raw(app, "inspect");
    expect(inspected.status).toBe(0);
    expect(inspected.out).not.toMatch(/was committed/);
    expect(raw(app, "resume").status).toBe(1);
    expect(existsSync(journalPath(app, env))).toBe(true);
  }, 300_000);

  test("a committed update is settled by resume, and by the next apply, never by age", async () => {
    const { env, gen, app } = await clean();
    expect(accept(app).status).toBe(0);
    git(app, ["commit", "-q", "--no-edit"], env);
    write(app, "application-note.txt", "work after the update\n");
    commitAll(app, env, "feat: continue application work");
    const laterHead = git(app, ["rev-parse", "HEAD"], env);
    expect(raw(app, "inspect").out).toMatch(/the update was committed/);
    expect(raw(app, "resume").out).toMatch(/committed; its journal and pending snapshot were removed/);
    expect(existsSync(journalPath(app, env))).toBe(false);
    expect(refs(app, env).filter((ref) => ref.includes("template"))).toEqual([]);
    expect(raw(app, "resume").out).toMatch(/no template update is in progress/);
    expect(git(app, ["rev-parse", "HEAD"], env)).toBe(laterHead);
    expect(readFileSync(join(app, "application-note.txt"), "utf8")).toBe("work after the update\n");

    // The next apply settles on its own: a second update, committed and not resumed, does not stand in the way of a third.
    advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// again\n` });
    const again = await previewFile(app, env, gen);
    expect((await applyPreview(app, env, gen, again.path)).status).toBe(0);
    expect(accept(app).status).toBe(0);
    git(app, ["commit", "-q", "--no-edit"], env);
    write(app, "application-note.txt", "more work after the second update\n");
    commitAll(app, env, "feat: continue after second update");
    advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// third\n` });
    const third = await previewFile(app, env, gen);
    const applied = await applyPreview(app, env, gen, third.path);
    expect(applied.status, applied.err).toBe(0);
    expect(journals.parseJournal(readFileSync(journalPath(app, env), "utf8")).source.sha).toBe(third.result.source.sha);
    expect(parseJson<{ phase: string }>(readFileSync(journalPath(app, env), "utf8")).phase).toBe("ready");
  }, 300_000);

  test("resume refuses an update already aborted with native Git without reporting it applied", async () => {
    const { env, app, head } = await clean();
    git(app, ["merge", "--abort"], env);
    const before = { state: readFileSync(join(app, ".template-state.json"), "utf8"), index: git(app, ["ls-files", "-s"], env) };
    const resumed = raw(app, "resume");
    expect(resumed.status).toBe(1);
    expect(resumed.out).not.toContain("already applied");
    expect(git(app, ["rev-parse", "HEAD"], env).trim()).toBe(head);
    expect(readFileSync(join(app, ".template-state.json"), "utf8")).toBe(before.state);
    expect(git(app, ["ls-files", "-s"], env)).toBe(before.index);
    expect(existsSync(journalPath(app, env))).toBe(true);
    expect(raw(app, "abort").status).toBe(0);
  }, 300_000);

  test("recovery preserves a replaced pending ref before abort and after commit", async () => {
    const { env, app, head } = await clean();
    const next = git(app, ["rev-parse", journals.PENDING_REF], env).trim();
    const before = { state: readFileSync(join(app, ".template-state.json"), "utf8"), index: git(app, ["ls-files", "-s"], env) };
    git(app, ["update-ref", journals.PENDING_REF, head], env);
    for (const command of ["abort", "resume"]) {
      expect(raw(app, command).status, command).toBe(1);
      expect(git(app, ["rev-parse", journals.PENDING_REF], env).trim()).toBe(head);
      expect(existsSync(journalPath(app, env))).toBe(true);
      expect(git(app, ["ls-files", "-s"], env)).toBe(before.index);
      expect(readFileSync(join(app, ".template-state.json"), "utf8")).toBe(before.state);
    }
    git(app, ["update-ref", journals.PENDING_REF, next], env);
    expect(accept(app).status).toBe(0);
    git(app, ["commit", "-q", "--no-edit"], env);
    git(app, ["update-ref", journals.PENDING_REF, head], env);
    expect(raw(app, "resume").status).toBe(1);
    expect(git(app, ["rev-parse", journals.PENDING_REF], env).trim()).toBe(head);
    expect(existsSync(journalPath(app, env))).toBe(true);
    // Cleanup can be interrupted after removing its own ref but before removing the journal.
    git(app, ["update-ref", "-d", journals.PENDING_REF, head], env);
    expect(raw(app, "resume").status).toBe(0);
    expect(existsSync(journalPath(app, env))).toBe(false);
  }, 300_000);
});
