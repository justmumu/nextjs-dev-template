import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const toolchain = createRequire(import.meta.url)("../../scripts/toolchain.cjs") as typeof import("../../scripts/toolchain.cjs");
const scratch = mkdtempSync(join(tmpdir(), "toolchain-contract-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("pnpm", args, { cwd, env, encoding: "utf8", timeout: 170_000 });
}

function scratchProject(name: string, manifest: Record<string, unknown>) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", private: true, ...manifest }));
  return dir;
}

describe("exact runtime and manager", () => {
  const expected = toolchain.readExpected(root);

  test("accepts the pinned Node and pnpm", () => {
    expect(toolchain.checkEnvironment({ node: expected.node, pnpm: expected.pnpm }, expected)).toEqual([]);
  });

  test("rejects another Node or pnpm with the expected version in the message", () => {
    const errors = toolchain.checkEnvironment({ node: "24.0.0", pnpm: "11.0.0" }, expected);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain(expected.node);
    expect(errors[1]).toContain(expected.pnpm);
  });

  test("rejects a missing pnpm", () => {
    expect(toolchain.checkEnvironment({ node: expected.node, pnpm: null }, expected)[0]).toContain("pnpm");
  });

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

describe("single source of pins", () => {
  const versions = JSON.parse(readFileSync(join(root, "tooling/versions.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  test("root manifest, .node-version and engines project tooling/versions.json", () => {
    expect(manifest.devDependencies).toEqual(versions.root.devDependencies);
    expect(manifest.packageManager).toBe(`pnpm@${versions.pnpm}`);
    expect(manifest.engines.node).toBe(versions.node);
    expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toBe(versions.node);
    expect(manifest.devEngines).toBeUndefined();
  });

  test("every pin is exact", () => {
    const all = { ...versions.root.devDependencies, ...versions.seed.dependencies, ...versions.seed.devDependencies };
    for (const [name, range] of Object.entries(all)) expect(range, name).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("commit identity", () => {
  const pattern = toolchain.readPolicy(root).commitIdentity.emailPattern;

  test("accepts GitHub noreply author and committer", () => {
    const entry = { rev: "a1", author: "1+someone@users.noreply.github.com", committer: "someone@users.noreply.github.com" };
    expect(toolchain.commitIdentityErrors([entry], pattern)).toEqual([]);
  });

  test("reports author and committer separately", () => {
    const entry = { rev: "b2", author: "me@example.com", committer: "me@example.com" };
    const errors = toolchain.commitIdentityErrors([entry], pattern);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/b2.*author/);
    expect(errors[1]).toMatch(/b2.*committer/);
  });

  test("no owner e-mail is stored in template manifests or state", () => {
    const tracked = ["package.json", ...readdirSync(join(root, "tooling")).map((name) => `tooling/${name}`)];
    expect(tracked.length).toBeGreaterThan(0);
    for (const file of tracked) {
      const emails = readFileSync(join(root, file), "utf8").match(/[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z][A-Za-z0-9-]*)+/g) ?? [];
      expect(emails, file).toEqual([]);
    }
  });
});

describe("isolated dependency graphs", () => {
  test("root graph is the generator only: no workspace members, links or parent overrides", () => {
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    expect(lock).not.toMatch(/workspace:|link:\.\./);
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).not.toMatch(/^packages:/m);
    expect(workspace).not.toMatch(/^overrides:/m);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).private).toBe(true);
  });

  test("the pinned seed tool set installs as its own graph without peer conflicts or build scripts", () => {
    const { seed, node } = JSON.parse(readFileSync(join(root, "tooling/versions.json"), "utf8"));
    const dir = scratchProject("seed-fixture", {
      type: "module",
      packageManager: `pnpm@${toolchain.readExpected(root).pnpm}`,
      engines: { node },
      dependencies: seed.dependencies,
      devDependencies: seed.devDependencies,
    });
    writeFileSync(join(dir, "pnpm-workspace.yaml"), `allowBuilds:\n${seed.deniedBuilds.map((name: string) => `  ${name}: false\n`).join("")}`);
    const install = run(dir, ["install", "--config.strict-peer-dependencies=true", "--config.engine-strict=true"]);
    expect(install.stderr + install.stdout).not.toMatch(/ERR_PNPM|WARN.*peer/i);
    expect(install.status).toBe(0);
    const lock = readFileSync(join(dir, "pnpm-lock.yaml"), "utf8");
    expect(lock).not.toMatch(/workspace:|link:\.\./);
    const listed = JSON.parse(run(dir, ["list", "--depth", "-1", "--json"]).stdout);
    expect(listed).toHaveLength(1);
    expect(listed[0].path).toBe(dir);
    const types = run(dir, ["exec", "tsc", "--version"]);
    expect(types.stdout).toContain(seed.devDependencies.typescript);
  });
});
