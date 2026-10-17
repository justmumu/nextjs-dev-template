import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { capture, scratchArea } from "../support/project.ts";
import { create, fixtureEnv, generatorCopy, git, gitModule, hostFor, inputsOf, passing, render, root } from "../support/template-fixture.ts";
import { parseJson } from "../support/json.ts";

// Update previews with real Git repositories, files and processes: a source repository that moves, a
// project created from it, ordinary full clones, and a native merge in a disposable clone. Incoming
// code is inert, the project is only read, and conflicts are what the merge's index says they are.
const require = createRequire(import.meta.url);
const preview = require("../../scripts/template/preview.cjs") as typeof import("../../scripts/template/preview.cjs");
const provenance = require("../../scripts/template/provenance.cjs") as typeof import("../../scripts/template/provenance.cjs");

const scratch = scratchArea("template-preview-");
const marker = join(scratch.area, "incoming-code-ran");
process.env.U12_MARKER = marker;

type Files = Record<string, string | { content: string; mode: number }>;
interface Entry {
  type: "copy";
  base: "template" | "root";
  source: string;
  destination: string;
}
interface ManifestFile {
  entries: Entry[];
  [key: string]: unknown;
}

const write = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/** The manifest of a source checkout, changed by `edit`, as the text to commit. */
function manifestText(dir: string, edit: (manifest: ManifestFile) => void): string {
  const manifest = parseJson<ManifestFile>(readFileSync(join(dir, "tooling/template-manifest.json"), "utf8"));
  edit(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const templateEntry = (path: string): Entry => ({ type: "copy", base: "template", source: path, destination: path });

/** A source repository: the generator checkout with extra template files, one commit. */
function source(env: NodeJS.ProcessEnv, extra: Files = {}) {
  const base = generatorCopy(scratch.area, `src-${String(Math.random()).slice(2, 8)}`, env, extra);
  return base;
}

function sourceWithFiles(env: NodeJS.ProcessEnv, files: Record<string, string>) {
  const probe = generatorCopy(scratch.area, `probe-${String(Math.random()).slice(2, 8)}`, env);
  const extras: Files = {};
  for (const [path, content] of Object.entries(files)) extras[`template/app/${path}`] = content;
  extras["tooling/template-manifest.json"] = manifestText(probe, (manifest) => {
    for (const path of Object.keys(files)) manifest.entries.push(templateEntry(path));
  });
  rmSync(probe, { recursive: true, force: true });
  return source(env, extras);
}

/** Commits a change to the source: text replaces a file, null removes it. */
function advance(dir: string, env: NodeJS.ProcessEnv, changes: Record<string, string | null>, message = "feat: template change") {
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) rmSync(join(dir, path), { force: true });
    else write(dir, path, content);
  }
  git(dir, ["add", "-A"], env);
  git(dir, ["commit", "-q", "-m", message], env);
  return git(dir, ["rev-parse", "HEAD"], env).trim();
}

async function createApp(name: string, gen: string, env: NodeJS.ProcessEnv) {
  const host = hostFor(env, { run: passing });
  const dest = join(scratch.area, name);
  const inputs = inputsOf(gen);
  const sink = capture();
  const status = await create.createLocal({
    host,
    io: sink.io,
    isCancelled: () => false,
    inputs,
    answers: { name: "made-app", owner: "made-owner" },
    dest,
    source: () => create.generatorSource({ git: host.git, root: gen, manifest: inputs.manifest }),
  });
  if (status !== 0) throw new Error(sink.err());
  return dest;
}

const commitAll = (dir: string, env: NodeJS.ProcessEnv, message: string) => {
  git(dir, ["add", "-A"], env);
  git(dir, ["commit", "-q", "-m", message], env);
};

/** The preview host on this machine's Git, keeping the scratch directories it hands out so a scenario can inspect them. */
function previewHost(env: NodeJS.ProcessEnv, keep = false) {
  const made: string[] = [];
  const removed: string[] = [];
  return {
    made,
    removed,
    host: {
      git: gitModule.createGit({ env }),
      fs: require("node:fs") as typeof import("node:fs"),
      scratch: (prefix: string) => {
        const dir = mkdtempSync(join(scratch.area, prefix));
        made.push(dir);
        return dir;
      },
      remove: (dir: string) => {
        removed.push(dir);
        if (!keep) rmSync(dir, { recursive: true, force: true });
      },
    },
  };
}

const walk = (dir: string, skip: string[] = []): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (skip.includes(entry.name)) return [];
    return entry.isDirectory() ? walk(path, skip) : [path];
  });

/** Everything a preview must leave as it was: HEAD, index, refs, tags, every file outside .git, and every status. */
function snapshot(dir: string, env: NodeJS.ProcessEnv) {
  return {
    head: git(dir, ["rev-parse", "HEAD"], env),
    index: git(dir, ["ls-files", "-s"], env),
    refs: git(dir, ["for-each-ref"], env),
    tags: git(dir, ["tag"], env),
    status: git(dir, ["--no-optional-locks", "status", "--porcelain", "--ignored", "-uall"], env),
    files: Object.fromEntries(walk(dir, [".git"]).map((path) => [relative(dir, path), readFileSync(path).toString("base64")])),
    gitDir: walk(join(dir, ".git"))
      .map((path) => relative(dir, path))
      .filter((path) => !path.endsWith(".lock"))
      .sort(),
  };
}

const unmerged = (clone: string, env: NodeJS.ProcessEnv) =>
  [
    ...new Set(
      git(clone, ["ls-files", "-u", "-z"], env)
        .split("\0")
        .filter(Boolean)
        .map((line) => line.split("\t")[1] ?? ""),
    ),
  ].sort();

describe("a clean preview", () => {
  test("merges the template's change with the user's own, leaves the project untouched and runs nothing incoming", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = sourceWithFiles(env, {});
    const app = await createApp("clean-app", gen, env);

    // The user's own work: a version, a dependency, a component, a note that looks like a conflict, a local ignored file.
    const pkg = parseJson<{ version: string; dependencies: Record<string, string> }>(readFileSync(join(app, "package.json"), "utf8"));
    pkg.version = "2.4.1";
    pkg.dependencies["left-pad"] = "1.3.0";
    writeFileSync(join(app, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    write(app, "src/components/custom.tsx", "export const Custom = () => null;\n");
    write(app, "src/notes.md", "<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> other\n");
    commitAll(app, env, "feat: the application's own work");
    write(app, ".env.local", "SECRET=1\n");

    // The template moves on: a config change, a new script, a new file, and code that would run if anything ran it.
    const upstreamPackage = parseJson<{ scripts: Record<string, string> }>(readFileSync(join(gen, "template/app/package.json"), "utf8"));
    upstreamPackage.scripts["upstream:new"] = "node scripts/development.cjs check";
    const renderer = readFileSync(join(gen, "scripts/template/render.cjs"), "utf8");
    const advanced = advance(gen, env, {
      "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// from the template\n`,
      "template/app/package.json": `${JSON.stringify({ ...upstreamPackage, scripts: { ...upstreamPackage.scripts, postinstall: `node -e "require('fs').writeFileSync('${marker}','x')"` } }, null, 2)}\n`,
      "template/app/public/new-asset.txt": "new\n",
      "scripts/template/render.cjs": `require("node:fs").writeFileSync(process.env.U12_MARKER ?? "/nonexistent/marker", "ran");\n${renderer}`,
      "tooling/template-manifest.json": manifestText(gen, (manifest) => manifest.entries.push(templateEntry("public/new-asset.txt"))),
    });

    // An annotated tag on the commit that is fetched would be followed by a default fetch; it must not be imported.
    git(gen, ["tag", "-a", "v9.9.9", "-m", "an upstream release"], env);
    const before = snapshot(app, env);
    const kept = previewHost(env, true);
    const result = await preview.createPreview({ host: kept.host, root: app, ref: "main", url: `file://${gen}` });
    const path = preview.writePreview({ host: kept.host, root: app, preview: result });

    expect(result.source).toEqual({ url: `file://${gen}`, ref: "main", sha: advanced });
    expect(result.result.status).toBe("clean");
    expect(result.result.conflicts).toEqual([]);
    expect(result.result.changes.map((change) => change.path).sort()).toEqual([
      "next.config.ts",
      "package.json",
      "public/new-asset.txt",
      "scripts/template/render.cjs",
    ]);

    // The project: only the preview file is new, in its Git directory.
    const after = snapshot(app, env);
    expect({ ...after, gitDir: [] }).toEqual({ ...before, gitDir: [] });
    expect(after.gitDir.filter((file) => !before.gitDir.includes(file))).toEqual([".git/template-update/preview.json"]);
    expect(path).toBe(join(app, ".git/template-update/preview.json"));
    expect(preview.parsePreview(readFileSync(path, "utf8"))).toEqual(result);
    expect(existsSync(join(app, ".env.local"))).toBe(true);

    // The disposable clone holds the real merge: the user's version, dependency and files, and the template's changes.
    const [clone] = kept.made.map((dir) => join(dir, "clone"));
    expect(clone).toBeDefined();
    const clonePath = clone ?? "";
    const merged = parseJson<{ version: string; dependencies: Record<string, string>; scripts: Record<string, string> }>(
      readFileSync(join(clonePath, "package.json"), "utf8"),
    );
    expect(merged.version).toBe("2.4.1");
    expect(merged.dependencies["left-pad"]).toBe("1.3.0");
    expect(merged.scripts["upstream:new"]).toBeDefined();
    expect(readFileSync(join(clonePath, "next.config.ts"), "utf8")).toContain("// from the template");
    expect(readFileSync(join(clonePath, "src/components/custom.tsx"), "utf8")).toContain("Custom");
    expect(readFileSync(join(clonePath, "src/notes.md"), "utf8")).toContain("<<<<<<< HEAD");
    expect(existsSync(join(clonePath, ".env.local"))).toBe(false);
    expect(unmerged(clonePath, env)).toEqual([]);
    expect(git(clonePath, ["rev-parse", "MERGE_HEAD"], env).trim()).toBe(result.next.commit);
    expect(git(clonePath, ["rev-parse", "HEAD"], env).trim()).toBe(before.head.trim());

    // The new pristine snapshot descends only from the old one, is made from the original answers and holds no state.
    const parents = git(clonePath, ["rev-list", "--parents", "-n", "1", result.next.commit], env).trim().split(" ");
    expect(parents.slice(1)).toEqual([result.baseline.commit]);
    const pristine = parseJson<{ version: string; dependencies: Record<string, string> }>(git(clonePath, ["show", `${result.next.commit}:package.json`], env));
    expect(pristine.version).toBe("0.0.0");
    expect(pristine.dependencies["left-pad"]).toBeUndefined();
    expect(git(clonePath, ["ls-tree", "-r", "--name-only", result.next.commit], env)).not.toContain(".template-state.json");

    // The source repository the engine fetched into holds the one commit and no tag or branch.
    const [sourceDir] = kept.made.map((dir) => join(dir, "source"));
    expect(git(sourceDir ?? "", ["for-each-ref"], env)).toBe("");
    expect(git(app, ["tag"], env)).toBe("");
    expect(git(sourceDir ?? "", ["rev-list", "--count", "--all"], env).trim()).toBe("0");

    expect(existsSync(marker)).toBe(false);
    for (const dir of kept.made) rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  test("is reproducible: the same source gives the same pristine commit and the same result", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = sourceWithFiles(env, {});
    const app = await createApp("repeat-app", gen, env);
    advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// again\n` });
    const first = await preview.createPreview({ host: previewHost(env).host, root: app, ref: "main", url: `file://${gen}` });
    const second = await preview.createPreview({ host: previewHost(env).host, root: app, ref: "main", url: `file://${gen}` });
    expect(second).toEqual(first);
  }, 120_000);

  test("a source that has not moved is current: nothing to merge", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = sourceWithFiles(env, {});
    const app = await createApp("current-app", gen, env);
    const result = await preview.createPreview({ host: previewHost(env).host, root: app, ref: "main", url: `file://${gen}` });
    expect(result.result.status).toBe("current");
    expect(result.result.changes).toEqual([]);
    expect(result.next.tree).toBe(result.baseline.tree);
  }, 120_000);
});

describe("conflicts are what the merge's index says", () => {
  test("same line, add/add, modify/delete both ways, binary, rename and file/directory are all reported with their stages", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = sourceWithFiles(env, {
      "public/gone.txt": "one\ntwo\nthree\n",
      "public/kept.txt": "alpha\nbeta\ngamma\n",
      "public/blob.bin": "bin\0base",
      "public/old-name.txt": "R1\nR2\nR3\nR4\nR5\nR6\nR7\nR8\n",
    });
    const app = await createApp("conflict-app", gen, env);

    const config = readFileSync(join(app, "next.config.ts"), "utf8");
    writeFileSync(join(app, "next.config.ts"), config.replace("typedRoutes: true,", "typedRoutes: false, // mine"));
    write(app, "public/added.txt", "mine\n");
    rmSync(join(app, "public/gone.txt"));
    write(app, "public/kept.txt", "alpha\nmine\ngamma\n");
    write(app, "public/blob.bin", "bin\0mine");
    rmSync(join(app, "public/old-name.txt"));
    write(app, "public/dir-conflict/inner.txt", "inner\n");
    commitAll(app, env, "feat: the application's own work");

    advance(gen, env, {
      "template/app/next.config.ts": readFileSync(join(gen, "template/app/next.config.ts"), "utf8").replace(
        "typedRoutes: true,",
        "typedRoutes: false, // theirs",
      ),
      "template/app/public/added.txt": "theirs\n",
      "template/app/public/gone.txt": "one\nTWO\nthree\n",
      "template/app/public/kept.txt": null,
      "template/app/public/blob.bin": "bin\0theirs",
      "template/app/public/old-name.txt": null,
      "template/app/public/new-name.txt": "R1\nR2\nR3\nR4\nR5\nR6\nR7\nR8\n",
      "template/app/public/dir-conflict": "a file\n",
      "tooling/template-manifest.json": manifestText(gen, (manifest) => {
        manifest.entries = manifest.entries.filter((entry) => !["public/kept.txt", "public/old-name.txt"].includes(entry.source));
        for (const path of ["public/added.txt", "public/new-name.txt", "public/dir-conflict"]) manifest.entries.push(templateEntry(path));
      }),
    });

    const before = snapshot(app, env);
    const kept = previewHost(env, true);
    const result = await preview.createPreview({ host: kept.host, root: app, ref: "main", url: `file://${gen}` });
    const clone = join(kept.made[0] ?? "", "clone");

    expect(result.result.status).toBe("conflicted");
    // The template's file cannot be where the project's directory is; Git keeps it beside it, named after the incoming commit.
    const moved = `public/dir-conflict~${result.next.commit}`;
    const byPath = Object.fromEntries(result.result.conflicts.map((conflict) => [conflict.path, conflict]));
    const kinds = Object.fromEntries(Object.entries(byPath).map(([path, conflict]) => [path, conflict.kind]));
    expect(kinds).toEqual({
      "next.config.ts": "content",
      "public/added.txt": "add/add",
      "public/gone.txt": "modify/delete",
      "public/kept.txt": "modify/delete",
      "public/blob.bin": "binary",
      "public/new-name.txt": "rename/delete",
      [moved]: "file/directory",
    });

    // The reported paths are exactly the merge's unmerged index paths.
    expect(Object.keys(byPath).sort()).toEqual(unmerged(clone, env));
    // Stages: which side has what.
    const has = (path: string) => ({
      base: byPath[path]?.stages.base !== null,
      ours: byPath[path]?.stages.ours !== null,
      theirs: byPath[path]?.stages.theirs !== null,
    });
    expect(has("next.config.ts")).toEqual({ base: true, ours: true, theirs: true });
    expect(has("public/added.txt")).toEqual({ base: false, ours: true, theirs: true });
    expect(has("public/gone.txt")).toEqual({ base: true, ours: false, theirs: true });
    expect(has("public/kept.txt")).toEqual({ base: true, ours: true, theirs: false });
    expect(has("public/new-name.txt")).toEqual({ base: true, ours: false, theirs: true });
    expect(has(moved)).toEqual({ base: false, ours: false, theirs: true });
    expect(git(clone, ["rev-parse", `:2:public/added.txt`], env).trim()).toBe(byPath["public/added.txt"]?.stages.ours?.sha);

    // The merge also changed paths that did not conflict; the list holds the rest.
    expect(result.result.changes.some((change) => change.status === "U")).toBe(true);

    expect(snapshot(app, env)).toEqual({ ...before, gitDir: expect.arrayContaining(before.gitDir) as string[] });
    expect(existsSync(join(app, ".git/MERGE_HEAD"))).toBe(false);
    for (const dir of kept.made) rmSync(dir, { recursive: true, force: true });
  }, 180_000);
});

describe("a project that cannot prove its lineage", () => {
  async function pair() {
    const env = fixtureEnv(scratch.area);
    const gen = sourceWithFiles(env, {});
    const app = await createApp(`lineage-${String(Math.random()).slice(2, 8)}`, gen, env);
    advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// more\n` });
    return { env, gen, app };
  }

  async function refused(env: NodeJS.ProcessEnv, gen: string, app: string) {
    const before = snapshot(app, env);
    const used = previewHost(env);
    let code = "";
    try {
      await preview.createPreview({ host: used.host, root: app, ref: "main", url: `file://${gen}` });
    } catch (error) {
      if (!(error instanceof provenance.Refusal)) throw error;
      code = error.code;
    }
    expect(snapshot(app, env)).toEqual(before);
    expect(used.made.every((dir) => used.removed.includes(dir))).toBe(true);
    expect(existsSync(join(app, ".git/template-update"))).toBe(false);
    return code;
  }

  test("a shallow clone", async () => {
    const { env, gen, app } = await pair();
    const shallow = join(scratch.area, "shallow-clone");
    git(scratch.area, ["clone", "-q", "--depth=1", `file://${app}`, shallow], env);
    expect(await refused(env, gen, shallow)).toBe("shallow-history");
  }, 120_000);

  test("history rewritten so that the baseline is no ancestor", async () => {
    const { env, gen, app } = await pair();
    git(app, ["checkout", "-q", "--orphan", "rewritten"], env);
    git(app, ["commit", "-q", "-m", "chore: squashed"], env);
    expect(await refused(env, gen, app)).toBe("baseline-unreachable");
  }, 120_000);

  test("a baseline the repository no longer has", async () => {
    const { env, gen, app } = await pair();
    const lost = join(scratch.area, "lost-baseline");
    git(scratch.area, ["clone", "-q", "--no-local", app, lost], env);
    git(lost, ["checkout", "-q", "--orphan", "rewritten"], env);
    git(lost, ["commit", "-q", "-m", "chore: squashed"], env);
    git(lost, ["branch", "-D", "main"], env);
    git(lost, ["remote", "remove", "origin"], env);
    git(lost, ["reflog", "expire", "--expire=now", "--all"], env);
    git(lost, ["gc", "-q", "--prune=now"], env);
    expect(await refused(env, gen, lost)).toBe("baseline-missing");
  }, 120_000);

  test("a state whose baseline tree is not the commit's tree", async () => {
    const { env, gen, app } = await pair();
    const statePath = join(app, ".template-state.json");
    const state = parseJson<{ baseline: { tree: string } }>(readFileSync(statePath, "utf8"));
    state.baseline.tree = "0".repeat(40);
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    commitAll(app, env, "chore: edit state");
    expect(await refused(env, gen, app)).toBe("baseline-mismatch");
  }, 120_000);

  test("answers that are not the ones recorded", async () => {
    const { env, gen, app } = await pair();
    const statePath = join(app, ".template-state.json");
    const state = parseJson<{ answersDigest: string }>(readFileSync(statePath, "utf8"));
    state.answersDigest = "0".repeat(64);
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    commitAll(app, env, "chore: edit state");
    expect(await refused(env, gen, app)).toBe("answers-mismatch");
  }, 120_000);

  test("a project that was never enrolled", async () => {
    const { env, gen, app } = await pair();
    git(app, ["rm", "-q", ".template-state.json"], env);
    git(app, ["commit", "-q", "-m", "chore: drop state"], env);
    expect(await refused(env, gen, app)).toBe("not-enrolled");
  }, 120_000);

  test("a ref the source does not have", async () => {
    const { env, gen, app } = await pair();
    const before = snapshot(app, env);
    const used = previewHost(env);
    await expect(preview.createPreview({ host: used.host, root: app, ref: "no-such-branch", url: `file://${gen}` })).rejects.toMatchObject({
      code: "source-unreachable",
    });
    expect(snapshot(app, env)).toEqual(before);
    expect(used.made.every((dir) => used.removed.includes(dir))).toBe(true);
  }, 120_000);
});

describe("an engine that does not support the source's protocol", () => {
  test("is told so before any of the source's code could run, and nothing changes", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = sourceWithFiles(env, {});
    const app = await createApp("protocol-app", gen, env);
    advance(gen, env, {
      "tooling/template-manifest.json": manifestText(gen, (manifest) => {
        manifest.protocol = 2;
        manifest.entries.push({ type: "script", source: "scripts/render-v2.cjs" } as never);
      }),
      "scripts/render-v2.cjs": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
      "scripts/template/render.cjs": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    });
    const before = snapshot(app, env);
    const sink = capture();
    const used = previewHost(env);
    const status = await preview.templatePreview(["--ref=main"], { root: app, io: sink.io, host: used.host, url: `file://${gen}` });
    expect(status).toBe(1);
    expect(sink.err()).toMatch(/does not support/);
    expect(existsSync(marker)).toBe(false);
    expect(snapshot(app, env)).toEqual(before);
    expect(used.made.every((dir) => used.removed.includes(dir))).toBe(true);
  }, 120_000);
});

describe("a clone of the project, and the next source revision", () => {
  test("previews from an ordinary full clone with the original gone, twice, with no tags or private refs", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = sourceWithFiles(env, {});
    git(gen, ["tag", "-a", "v9.9.9", "-m", "an upstream release"], env);
    const original = await createApp("origin-app", gen, env);
    const clone = join(scratch.area, "full-clone");
    git(scratch.area, ["clone", "-q", "--no-local", original, clone], env);
    rmSync(original, { recursive: true, force: true });

    const first = advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// one\n` });
    const before = snapshot(clone, env);
    const one = await preview.createPreview({ host: previewHost(env).host, root: clone, ref: "main", url: `file://${gen}` });
    expect(one.source.sha).toBe(first);
    expect(one.result.status).toBe("clean");

    const second = advance(gen, env, {
      "template/app/public/favicon.svg": `${readFileSync(join(gen, "template/app/public/favicon.svg"), "utf8")}<!-- two -->\n`,
    });
    const two = await preview.createPreview({ host: previewHost(env).host, root: clone, ref: "main", url: `file://${gen}` });
    expect(two.source.sha).toBe(second);
    expect(two.next.commit).not.toBe(one.next.commit);
    expect(two.result.changes.map((change) => change.path).sort()).toEqual(["next.config.ts", "public/favicon.svg"]);
    expect(preview.staleReasons(one, { ...preview.currentBindings({ git: previewHost(env).host.git, root: clone, sourceSha: second }) })).toEqual([
      "the source ref points to another commit",
    ]);

    const after = snapshot(clone, env);
    expect({ ...after, gitDir: [] }).toEqual({ ...before, gitDir: [] });
    expect(after.tags).toBe("");
    expect(git(clone, ["for-each-ref", "--format=%(refname)"], env)).toBe(before.refs.replace(/[0-9a-f]{40} commit\t/g, ""));
  }, 180_000);

  test("the application's own module graph previews on its own, as a separate process", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = sourceWithFiles(env, {});
    const app = await createApp("process-app", gen, env);
    advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// from the template\n` });
    const driver =
      "const { templatePreview } = require('./scripts/template/preview.cjs');" +
      "const io = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) };" +
      "templatePreview(['--ref=main'], { root: process.cwd(), io, url: process.env.SOURCE_URL }).then((status) => { process.exitCode = status; });";
    const result = spawnSync(process.execPath, ["-e", driver], { cwd: app, env: { ...env, SOURCE_URL: `file://${gen}` }, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/status: clean/);
    const written = preview.parsePreview(readFileSync(join(app, ".git/template-update/preview.json"), "utf8"));
    expect(written.result.changes.map((change) => change.path)).toEqual(["next.config.ts"]);
  }, 120_000);
});

describe("a preview that no longer describes the update", () => {
  test("goes stale when HEAD, the state, the installed engine or the source changes", async () => {
    const env = fixtureEnv(scratch.area);
    const gen = sourceWithFiles(env, {});
    const app = await createApp("stale-app", gen, env);
    const sha = advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// one\n` });
    const used = previewHost(env);
    const result = await preview.createPreview({ host: used.host, root: app, ref: "main", url: `file://${gen}` });
    const now = () => preview.currentBindings({ git: used.host.git, root: app, sourceSha: sha });
    expect(preview.staleReasons(result, now())).toEqual([]);

    // The installed engine: a changed helper of the renderer changes the binding.
    const altered = mkdtempSync(join(scratch.area, "engine-"));
    cpSync(join(root, "scripts/core"), join(altered, "core"), { recursive: true });
    cpSync(join(root, "scripts/template"), join(altered, "template"), { recursive: true });
    cpSync(join(root, "scripts/hooks"), join(altered, "hooks"), { recursive: true });
    expect(preview.engineDigest(altered)).toBe(preview.engineDigest(join(root, "scripts")));
    writeFileSync(join(altered, "template/inputs.cjs"), `${readFileSync(join(altered, "template/inputs.cjs"), "utf8")}// changed\n`);
    const withEngine = preview.currentBindings({ git: used.host.git, root: app, sourceSha: sha, scriptsRoot: altered });
    expect(preview.staleReasons(result, withEngine)).toEqual(["the installed engine changed"]);
    expect(preview.ENGINE_FILES.every((file) => existsSync(join(root, "scripts", file)))).toBe(true);

    // The state: a rewrite that still parses stales the preview, together with HEAD.
    const statePath = join(app, ".template-state.json");
    writeFileSync(statePath, readFileSync(statePath, "utf8").replace("{\n", "{ \n"));
    commitAll(app, env, "chore: reformat state");
    expect(preview.staleReasons(result, now())).toEqual(["HEAD moved", "the committed template state changed"]);

    // A new commit of the project moves HEAD alone.
    const fresh = await preview.createPreview({ host: used.host, root: app, ref: "main", url: `file://${gen}` });
    expect(preview.staleReasons(fresh, now())).toEqual([]);
    write(app, "src/extra.ts", "export {};\n");
    commitAll(app, env, "feat: extra");
    expect(preview.staleReasons(fresh, now())).toEqual(["HEAD moved"]);

    // The source: its ref resolves to another commit.
    const next = advance(gen, env, { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// two\n` });
    expect(preview.staleReasons(fresh, preview.currentBindings({ git: used.host.git, root: app, sourceSha: next }))).toEqual([
      "HEAD moved",
      "the source ref points to another commit",
    ]);
  }, 180_000);
});

describe("the emitted module graph", () => {
  const requires = (text: string) => [...text.matchAll(/require\("(\.[^"]+)"\)/g)].map((match) => match[1] ?? "");

  test("the files an application receives are the files the preview entry needs, no more", () => {
    const { files } = render.renderTree({ ...render.defaultInputs(), answers: { name: "graph-app" } });
    const bytes = new Map(files.map((file) => [file.path, file.content.toString("utf8")]));
    const needed = new Set<string>();
    const visit = (path: string) => {
      if (needed.has(path)) return;
      needed.add(path);
      const text = bytes.get(path);
      expect(text, `${path} is not emitted`).toBeDefined();
      for (const required of requires(text ?? "")) {
        const dir = path.split("/").slice(0, -1);
        const parts = [...dir];
        for (const part of required.split("/")) {
          if (part === "..") parts.pop();
          else if (part !== ".") parts.push(part);
        }
        visit(parts.join("/"));
      }
    };
    visit("scripts/template/preview.cjs");
    // The apply and recovery entry, and the loader it reads as a file instead of requiring it (see update.cjs).
    visit("scripts/template/update.cjs");
    visit("scripts/hooks/entry.cjs");
    expect([...needed].map((path) => path.replace(/^scripts\//, "")).sort()).toEqual([...preview.ENGINE_FILES].sort());
    expect(bytes.has("scripts/template/create.cjs")).toBe(false);
    expect(bytes.has("scripts/template/initialize.cjs")).toBe(false);
    expect(bytes.has("scripts/template/transaction.cjs")).toBe(false);
    expect(bytes.has("scripts/template/seed.cjs")).toBe(false);
    expect(parseJson<{ scripts: Record<string, string> }>(bytes.get("package.json") ?? "").scripts["template:preview"]).toBe(
      "node scripts/development.cjs template:preview",
    );
  });
});
