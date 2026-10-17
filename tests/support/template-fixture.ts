import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { parseJson } from "./json.ts";

const require = createRequire(import.meta.url);
export const root = resolve(import.meta.dirname, "../..");
export const commands = require("../../scripts/template/commands.cjs") as typeof import("../../scripts/template/commands.cjs");
export const render = require("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");
export const create = require("../../scripts/template/create.cjs") as typeof import("../../scripts/template/create.cjs");
export const initialize = require("../../scripts/template/initialize.cjs") as typeof import("../../scripts/template/initialize.cjs");
export const gitModule = require("../../scripts/template/git.cjs") as typeof import("../../scripts/template/git.cjs");
export const stateModule = require("../../scripts/template/state.cjs") as typeof import("../../scripts/template/state.cjs");
const { createCancellation } = require("../../scripts/testing/owned.cjs") as typeof import("../../scripts/testing/owned.cjs");

export type Host = ReturnType<typeof commands.realCreateHost>;

/** A Git configuration of a fixture user with a noreply identity, and an environment that reads only it. */
export function fixtureEnv(area: string, extra = ""): NodeJS.ProcessEnv {
  const config = join(area, `gitconfig-${String(Math.random()).slice(2, 8)}`);
  writeFileSync(config, `[user]\n\tname = Fixture User\n\temail = fixture@users.noreply.github.com\n${extra}`);
  return { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync("git", args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * A committed copy of this checkout, as a generator checkout (the local route) or as the copy GitHub
 * makes from the template (the initialization route): one commit by someone else, which is the only
 * thing the copy has in common with the template. `files` replaces or adds files before the commit.
 */
export function generatorCopy(
  area: string,
  name: string,
  env: NodeJS.ProcessEnv,
  files: Record<string, string | { content: string; mode: number }> = {},
): string {
  const dir = join(area, name);
  mkdirSync(dir);
  const listed = git(root, ["ls-files", "-co", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  for (const path of listed) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    copyFileSync(join(root, path), join(dir, path));
    chmodSync(join(dir, path), statSync(join(root, path)).mode & 0o777);
  }
  for (const [path, value] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === "string" ? value : value.content);
    if (typeof value !== "string") chmodSync(target, value.mode);
  }
  git(dir, ["init", "-q", "-b", "main"], env);
  git(dir, ["add", "-A"], env);
  git(dir, ["commit", "-q", "-m", "chore: copy of the template"], env);
  return dir;
}

/** The render inputs of a generator checkout: its own manifest and sources. */
export function inputsOf(dir: string) {
  return {
    manifest: parseJson<unknown>(readFileSync(join(dir, "tooling", "template-manifest.json"), "utf8")),
    bases: { template: join(dir, "template", "app"), root: dir },
  };
}

/** The real host, with the validation tools (and their smoke, which needs the installed application) replaced when a scenario is about what happens around them. */
export function hostFor(env: NodeJS.ProcessEnv, over: { run?: Host["run"]; disk?: Host["disk"]; smoke?: Host["smoke"] } = {}): Host {
  const host = commands.realCreateHost(createCancellation(), env);
  const smoke = over.smoke ?? (over.run ? () => Promise.resolve(null) : undefined);
  return { ...host, ...(over.run ? { run: over.run } : {}), ...(over.disk ? { disk: over.disk } : {}), ...(smoke ? { smoke } : {}) };
}

export const passing: Host["run"] = () => Promise.resolve(0);

/** Validation tools that pass and count how often they were started. */
export function counting(): { run: Host["run"]; runs: () => number } {
  let started = 0;
  return {
    run: () => {
      started += 1;
      return Promise.resolve(0);
    },
    runs: () => started,
  };
}

/** Validation tools that pass, and an interruption that arrives as soon as the first one starts. */
export function interrupting(): { run: Host["run"]; isCancelled: () => boolean } {
  let interrupted = false;
  return {
    run: () => {
      interrupted = true;
      return Promise.resolve(0);
    },
    isCancelled: () => interrupted,
  };
}

/** The host, with every scratch directory it hands out remembered. */
export function recordingScratch(host: Host): { host: Host; made: string[] } {
  const made: string[] = [];
  return {
    host: {
      ...host,
      scratch: (prefix) => {
        const dir = host.scratch(prefix);
        made.push(dir);
        return dir;
      },
    },
    made,
  };
}
