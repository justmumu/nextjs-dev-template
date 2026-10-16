import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

export const root = resolve(import.meta.dirname, "../..");
const render = createRequire(import.meta.url)("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");

export const scratchDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
export const removeDir = (dir: string) => {
  rmSync(dir, { recursive: true, force: true });
};

/**
 * Environment for child tools: no telemetry, and none of the NODE_ENV that Vitest sets, which Next.js
 * treats as non-standard and answers by changing its behavior.
 */
const { NODE_ENV: _vitestNodeEnv, ...inherited } = process.env;
export const childEnv: NodeJS.ProcessEnv = { ...inherited, NEXT_TELEMETRY_DISABLED: "1", CI: "1" };

export function run(cwd: string, command: string, args: string[], timeout = 170_000, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(command, args, { cwd, env: { ...childEnv, ...env }, encoding: "utf8", timeout });
}

export const output = (result: SpawnSyncReturns<string>) => `${result.stdout}${result.stderr}`;

/** Renders the real application seed into `scratch/name` and installs it from its frozen lock. */
export function installRenderedApp(scratch: string, name: string): string {
  const { manifest, bases } = render.defaultInputs();
  const { files } = render.renderTree({ manifest, bases, answers: { name } });
  const dest = join(scratch, name);
  render.writeTree(files, dest);
  const install = run(dest, "pnpm", ["install", "--frozen-lockfile", "--config.strict-peer-dependencies=true", "--config.engine-strict=true"]);
  if (install.status !== 0) throw new Error(`frozen install failed:\n${output(install)}`);
  return dest;
}

export function writeProjectFile(dir: string, path: string, content: string) {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/**
 * A generator-shaped scratch project that reuses the root toolchain without copying node_modules.
 * It carries the real dispatcher, scripts and configuration, so `runGate` exercises the canonical
 * command rather than a hand-built ESLint invocation.
 */
export function generatorFixture(scratch: string, name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  mkdirSync(dir);
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
  for (const config of ["eslint.config.mjs", "tsconfig.json", "package.json", ".prettierrc.json", ".prettierignore", "pnpm-workspace.yaml"]) {
    copyFileSync(join(root, config), join(dir, config));
  }
  for (const directory of ["tooling", "scripts"]) cpSync(join(root, directory), join(dir, directory), { recursive: true });
  for (const [path, content] of Object.entries(files)) writeProjectFile(dir, path, content);
  return dir;
}

/** Runs a canonical `pnpm run` command of a generator fixture through the real dispatcher. */
export function runGate(dir: string, command: string): SpawnSyncReturns<string> {
  const entry = 'process.exitCode = require("./scripts/development.cjs").main(process.argv.slice(1), { skipPreflight: true });';
  return run(dir, process.execPath, ["-e", entry, command]);
}

/** Runs a canonical command in either a generator fixture or a rendered application. */
export const gate = (dir: string, command: string, kind: "generator" | "application"): SpawnSyncReturns<string> =>
  kind === "generator" ? runGate(dir, command) : run(dir, "pnpm", ["run", command]);

/** Runs the unit gate (every coverage-measured suite, each on its own) of a project without the other `check` gates. */
export function runUnitGate(dir: string): SpawnSyncReturns<string> {
  const entry =
    "const { unit } = require('./scripts/development.cjs');" +
    "process.exitCode = unit([], { root: process.cwd(), cwd: process.cwd(), io: { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) } });";
  return run(dir, process.execPath, ["-e", entry]);
}
