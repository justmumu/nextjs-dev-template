import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { capture } from "./project.ts";
import { create, generatorCopy, git, gitModule, hostFor, initialize, inputsOf, passing } from "./template-fixture.ts";
import { parseJson } from "./json.ts";

// A source repository that moves, applications made from it by either route, and the pieces of the
// update flow that a scenario drives: preview, apply, the user's own commits.
const require = createRequire(import.meta.url);
export const preview = require("../../scripts/template/preview.cjs") as typeof import("../../scripts/template/preview.cjs");
export const update = require("../../scripts/template/update.cjs") as typeof import("../../scripts/template/update.cjs");
export const recovery = require("../../scripts/template/recovery.cjs") as typeof import("../../scripts/template/recovery.cjs");
export const journals = require("../../scripts/template/journal.cjs") as typeof import("../../scripts/template/journal.cjs");
export const guardModule = require("../../scripts/hooks/guard.cjs") as typeof import("../../scripts/hooks/guard.cjs");

export type Files = Record<string, string | { content: string; mode: number }>;
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

export const write = (dir: string, path: string, content: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/** The manifest of a source checkout, changed by `edit`, as the text to commit. */
export function manifestText(dir: string, edit: (manifest: ManifestFile) => void): string {
  const manifest = parseJson<ManifestFile>(readFileSync(join(dir, "tooling/template-manifest.json"), "utf8"));
  edit(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export const templateEntry = (path: string): Entry => ({ type: "copy", base: "template", source: path, destination: path });

export const commitAll = (dir: string, env: NodeJS.ProcessEnv, message: string) => {
  git(dir, ["add", "-A"], env);
  git(dir, ["commit", "-q", "-m", message], env);
};

/** Commits a change to the source: text replaces a file, null removes it. */
export function advance(dir: string, env: NodeJS.ProcessEnv, changes: Record<string, string | null>, message = "feat: template change") {
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) rmSync(join(dir, path), { force: true });
    else write(dir, path, content);
  }
  commitAll(dir, env, message);
  return git(dir, ["rev-parse", "HEAD"], env).trim();
}

export function lineage(area: string) {
  /** A source repository: the generator checkout with extra template files, one commit. */
  function source(env: NodeJS.ProcessEnv, files: Record<string, string> = {}) {
    const probe = generatorCopy(area, `probe-${String(Math.random()).slice(2, 8)}`, env);
    const extras: Files = {};
    for (const [path, content] of Object.entries(files)) extras[`template/app/${path}`] = content;
    extras["tooling/template-manifest.json"] = manifestText(probe, (manifest) => {
      for (const path of Object.keys(files)) manifest.entries.push(templateEntry(path));
    });
    rmSync(probe, { recursive: true, force: true });
    return generatorCopy(area, `src-${String(Math.random()).slice(2, 8)}`, env, extras);
  }

  /** An application made by the local route into `name` (any directory name). */
  async function createApp(name: string, gen: string, env: NodeJS.ProcessEnv) {
    const host = hostFor(env, { run: passing });
    const dest = join(area, name);
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

  /** An application made by the GitHub route: a copy of the source with its own first commit, converted in place. */
  async function copiedApp(name: string, gen: string, env: NodeJS.ProcessEnv) {
    const dir = generatorCopy(area, name, env);
    const sink = capture();
    const status = await initialize.initializeCopy({
      host: hostFor(env, { run: passing }),
      io: sink.io,
      isCancelled: () => false,
      root: dir,
      inputs: inputsOf(gen),
      answers: { name: "made-app", owner: "made-owner" },
    });
    if (status !== 0) throw new Error(sink.err());
    return dir;
  }

  /** The preview host on this machine's Git, with scratch directories inside the area. */
  function previewHost(env: NodeJS.ProcessEnv) {
    return {
      git: gitModule.createGit({ env }),
      fs: require("node:fs") as typeof import("node:fs"),
      scratch: (prefix: string) => mkdtempSync(join(area, prefix)),
      remove: (dir: string) => {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** Previews `ref` of the source `gen` for `app` and writes the file, as the command does. */
  async function previewFile(app: string, env: NodeJS.ProcessEnv, gen: string, ref = "main") {
    const host = previewHost(env);
    const result = await preview.createPreview({ host, root: app, ref, url: `file://${gen}` });
    return { result, path: preview.writePreview({ host, root: app, preview: result }), host };
  }

  /** `template:apply` for `app`, as a person runs it. */
  async function applyPreview(app: string, env: NodeJS.ProcessEnv, gen: string, path: string, over: { url?: string } = {}) {
    const sink = capture();
    const status = await update.apply([`--preview=${path}`], {
      root: app,
      cwd: app,
      io: sink.io,
      host: previewHost(env),
      url: over.url ?? `file://${gen}`,
    });
    return { status, out: sink.out(), err: sink.err() };
  }

  return { source, createApp, copiedApp, previewHost, previewFile, applyPreview };
}

/** The guard's accept, run in this process against `dir` the way a person approves it. */
export function accept(dir: string): { status: number; out: string } {
  const out: string[] = [];
  const status = guardModule.main(["--event", "accept"], { cwd: dir, stdout: (text) => out.push(text), stderr: (text) => out.push(text) });
  return { status, out: out.join("") };
}

/** The raw recovery entry as a child process: Node alone, in `dir`, with no package manager and no installed packages. */
export function raw(dir: string, command: string) {
  const result = spawnSync(process.execPath, [join(dir, "scripts/template/update.cjs"), command], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

/** A recovery command run in this process against the project's own installed modules, as a person would run them in a healthy project. */
export function runIn(dir: string, command: string) {
  const sink = capture();
  const status = update.main([command], {
    io: sink.io,
    scripts: join(dir, "scripts"),
    load: (relative: string): unknown => require(join(dir, "scripts", relative)) as unknown,
  });
  return { status, out: sink.out(), err: sink.err() };
}
