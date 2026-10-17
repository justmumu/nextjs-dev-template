import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { capture, put } from "./project.ts";

// What the release scenarios share: a Git that reads only a fixture configuration, the release
// commands bound to a real project directory (real Git, real formatter and changelog writer; only the
// lock check, a package-manager run that can use the network, is replaced), and small repository helpers.
export const root = resolve(import.meta.dirname, "../..");
const release = createRequire(import.meta.url)("../../scripts/release.cjs") as typeof import("../../scripts/release.cjs");
export const DATE = new Date("2026-10-17T09:00:00Z");

/** A Git configuration of a fixture user with a noreply identity, and an environment that reads only it. */
export function fixtureEnv(area: string): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(area, "git-config-"));
  const config = join(directory, "gitconfig");
  writeFileSync(config, `[user]\n\tname = Fixture User\n\temail = ${["fixture", "users.noreply.github.com"].join("@")}\n`);
  return { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** The release commands for the project at `dir`. */
export function hostAt(dir: string, env: NodeJS.ProcessEnv, over: { lock?: boolean } = {}) {
  const sink = capture();
  const prettier = join(root, "node_modules/prettier/bin/prettier.cjs");
  const host = {
    ...release.realHost({
      root: dir,
      io: sink.io,
      env,
      tools: { launch: (_pkg, _bin, args) => spawnSync(process.execPath, [prettier, ...args], { cwd: dir, env, encoding: "utf8" }).status ?? 1 },
    }),
    now: () => DATE,
    checkLock: () => ({ ok: over.lock !== false, output: "the lock differs" }),
  };
  return { host, sink };
}

export const write = (dir: string, path: string, content: string) => {
  put(dir, path, content);
};

export const commit = (dir: string, env: NodeJS.ProcessEnv, message: string) => {
  git(dir, ["add", "-A"], env);
  git(dir, ["commit", "-q", "-m", message], env);
};

/** Installs a Git hook of the repository that runs `body`. */
export function hook(dir: string, env: NodeJS.ProcessEnv, name: string, body: string) {
  const path = join(git(dir, ["rev-parse", "--absolute-git-dir"], env).trim(), "hooks", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

export const tags = (dir: string, env: NodeJS.ProcessEnv) => git(dir, ["tag", "--list"], env).trim();
export const status = (dir: string, env: NodeJS.ProcessEnv) => git(dir, ["status", "--porcelain", "--untracked-files=all"], env);
export const head = (dir: string, env: NodeJS.ProcessEnv) => git(dir, ["rev-parse", "HEAD"], env).trim();
