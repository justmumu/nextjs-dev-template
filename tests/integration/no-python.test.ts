import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const toolchain = createRequire(import.meta.url)("../../scripts/toolchain.cjs") as typeof import("../../scripts/toolchain.cjs");
const scratch = mkdtempSync(join(tmpdir(), "no-python-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("frozen install and vitest work with only node and pnpm on PATH", () => {
  const pnpm = toolchain.resolveOnPath("pnpm", process.env.PATH ?? "");
  expect(pnpm, "pnpm is a host-owned prerequisite").not.toBeNull();

  const bin = join(scratch, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(pnpm as string, join(bin, "pnpm"));
  const env = { PATH: bin, HOME: join(scratch, "home"), COREPACK_HOME: process.env.COREPACK_HOME ?? join(process.env.HOME ?? "", ".cache/node/corepack") };
  mkdirSync(env.HOME);
  for (const forbidden of ["python", "python3", "uv", "make", "pip", "copier"]) {
    expect(toolchain.resolveOnPath(forbidden, env.PATH), forbidden).toBeNull();
  }

  const project = join(scratch, "project");
  mkdirSync(project);
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".node-version"]) copyFileSync(join(root, file), join(project, file));

  const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: project, env, encoding: "utf8", timeout: 170_000 });
  expect(install.stderr + install.stdout).not.toMatch(/ERR_PNPM_IGNORED_BUILDS|node-gyp|gyp ERR/);
  expect(install.status).toBe(0);

  const vitest = spawnSync("pnpm", ["exec", "vitest", "--version"], { cwd: project, env, encoding: "utf8" });
  expect(vitest.status).toBe(0);
}, 180_000);
