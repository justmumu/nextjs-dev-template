import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, test } from "vitest";
import { parseJson, type Listed, type Versions } from "../support/json.ts";

const root = resolve(import.meta.dirname, "../..");
const toolchain = createRequire(import.meta.url)("../../scripts/core/toolchain.cjs") as typeof import("../../scripts/core/toolchain.cjs");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "toolchain-integration-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("pnpm", args, { cwd, env, encoding: "utf8", timeout: 170_000 });
}

function scratchProject(name: string, manifest: Record<string, unknown>) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", private: true, ...manifest }));
  return dir;
}

describe("exact runtime and manager against real pnpm", () => {
  const expected = toolchain.readExpected(root);

  test("the pinned manager and Node are what is running", () => {
    const pnpm = run(root, ["--version"]);
    expect(toolchain.checkEnvironment({ node: process.versions.node, pnpm: pnpm.stdout.trim() }, expected)).toEqual([]);
  });

  test("pnpm refuses a project that names another package manager", () => {
    const dir = scratchProject("wrong-manager", { packageManager: "yarn@4.9.0" });
    const result = run(dir, ["install"], { ...process.env, COREPACK_ENABLE_STRICT: "0" });
    expect(result.status).not.toBe(0);
  });

  test("pnpm refuses a dependency set whose engines exclude this Node", () => {
    const dir = scratchProject("wrong-node", { engines: { node: ">=999" }, devEngines: undefined });
    const result = run(dir, ["install", "--config.engine-strict=true"]);
    expect(result.status).not.toBe(0);
  });
});

describe("preflight never downloads or switches the package manager", () => {
  const expected = toolchain.readExpected(root);

  /** A stand-in pnpm that records the environment the preflight gives it. */
  function fakePnpm(name: string, version: string) {
    const bin = join(scratch, name, "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(scratch, name, "env.log");
    writeFileSync(
      join(bin, "pnpm"),
      `#!/bin/sh\necho "$COREPACK_ENABLE_NETWORK $COREPACK_ENABLE_AUTO_PIN $pnpm_config_pm_on_fail" > '${log}'\necho ${version}\n`,
    );
    chmodSync(join(bin, "pnpm"), 0o755);
    return { bin, log };
  }

  test("the probe runs with Corepack downloads and manager switching switched off", () => {
    const { bin, log } = fakePnpm("env-capture", expected.pnpm);
    const dir = scratchProject("preflight-env", { packageManager: `pnpm@${expected.pnpm}` });
    writeFileSync(join(dir, ".node-version"), `${process.versions.node}\n`);
    const saved = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${saved}`;
    try {
      expect(toolchain.preflightErrors(dir)).toEqual([]);
    } finally {
      process.env.PATH = saved;
    }
    expect(readFileSync(log, "utf8").trim()).toBe("0 0 ignore");
  });

  test("a different installed manager is reported with expected and found versions", () => {
    const { bin } = fakePnpm("wrong-version", "9.15.0");
    const dir = scratchProject("preflight-wrong", { packageManager: `pnpm@${expected.pnpm}` });
    writeFileSync(join(dir, ".node-version"), `${process.versions.node}\n`);
    const saved = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${saved}`;
    try {
      const errors = toolchain.preflightErrors(dir).join("\n");
      expect(errors).toContain(expected.pnpm);
      expect(errors).toContain("9.15.0");
    } finally {
      process.env.PATH = saved;
    }
  });

  // The real manager binary: with its default settings it would switch to the version a project
  // names; with the preflight environment it reports what is installed.
  const cached = join(process.env.COREPACK_HOME ?? join(homedir(), ".cache", "node", "corepack"), "v1", "pnpm", expected.pnpm, "bin", "pnpm.mjs");
  test.skipIf(!existsSync(cached))("the installed manager is reported, not the one a project names", () => {
    const dir = scratchProject("preflight-real", { packageManager: "pnpm@9.15.0" });
    const bin = join(scratch, "real-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\nexec '${process.execPath}' '${cached}' "$@"\n`);
    chmodSync(join(bin, "pnpm"), 0o755);
    const saved = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${saved}`;
    try {
      expect(toolchain.pnpmVersion(dir)).toBe(expected.pnpm);
    } finally {
      process.env.PATH = saved;
    }
  });

  test("a manager that cannot be run without a download is an expected/found error, not a download", () => {
    const bin = join(scratch, "refusing", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\necho "Network access disabled by the environment" >&2\nexit 1\n');
    chmodSync(join(bin, "pnpm"), 0o755);
    const dir = scratchProject("preflight-refused", { packageManager: `pnpm@${expected.pnpm}` });
    writeFileSync(join(dir, ".node-version"), `${process.versions.node}\n`);
    const saved = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${saved}`;
    try {
      const errors = toolchain.preflightErrors(dir).join("\n");
      expect(errors).toContain(expected.pnpm);
      expect(errors).toContain("Network access disabled");
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("isolated seed dependency graph", () => {
  test("the pinned seed tool set installs as its own graph without peer conflicts or build scripts", () => {
    const { seed, node } = parseJson<Versions>(readFileSync(join(root, "tooling/versions.json"), "utf8"));
    const dir = scratchProject("seed-fixture", {
      type: "module",
      packageManager: `pnpm@${toolchain.readExpected(root).pnpm}`,
      engines: { node },
      dependencies: seed.dependencies,
      devDependencies: seed.devDependencies,
    });
    writeFileSync(join(dir, "pnpm-workspace.yaml"), readFileSync(join(root, "template/app/pnpm-workspace.yaml")));
    const install = run(dir, ["install", "--config.strict-peer-dependencies=true", "--config.engine-strict=true"]);
    expect(install.stderr + install.stdout).not.toMatch(/ERR_PNPM|WARN.*peer/i);
    expect(install.status).toBe(0);
    const lock = readFileSync(join(dir, "pnpm-lock.yaml"), "utf8");
    expect(lock).not.toMatch(/workspace:|link:\.\./);
    expect(lock).toContain("  vitepress@1.6.4>@docsearch/js: 3.9.0\n  vitepress@1.6.4>@docsearch/css: 3.9.0\n");
    expect(lock).not.toMatch(/\/@docsearch\/(?:js|css)@3\.8\./);
    const listed = parseJson<Listed[]>(run(dir, ["list", "--depth", "-1", "--json"]).stdout);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.path).toBe(dir);
    const types = run(dir, ["exec", "tsc", "--version"]);
    expect(types.stdout).toContain(seed.devDependencies.typescript);
  });
});
