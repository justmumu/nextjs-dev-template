import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { parseJson, type EditableManifest, type Versions } from "../support/json.ts";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const transaction = require("../../scripts/core/transaction.cjs") as typeof import("../../scripts/core/transaction.cjs");
const installState = require("../../scripts/core/install-state.cjs") as typeof import("../../scripts/core/install-state.cjs");
const toolchain = require("../../scripts/core/toolchain.cjs") as typeof import("../../scripts/core/toolchain.cjs");
const bootstrap = require("../../scripts/bootstrap.cjs") as typeof import("../../scripts/bootstrap.cjs");
const dependencies = require("../../scripts/dependencies.cjs") as typeof import("../../scripts/dependencies.cjs");
const development = require("../../scripts/development.cjs") as typeof import("../../scripts/development.cjs");

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "dependencies-integration-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const POLICY = "strictDepBuilds: true\nverifyDepsBeforeRun: error\nenablePrePostScripts: false\nskills:\n  dirs: []\n";
// A registry dependency for lock and repair scenarios: the disposable lock copy holds metadata only,
// so it cannot resolve file: fixtures. Policy forbids file: dependencies in real projects anyway.
const REGISTRY = { typescript: "6.0.3" };
const ENV_KEYS = ["FIXTURE_PROJECT", "FIXTURE_MODE", "FIXTURE_FAIL", "pnpm_config_store_dir", "pnpm_config_cache_dir"];
afterEach(() => {
  for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key);
});

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) }, out, err };
}

/** pnpm run/exec turns verifyDepsBeforeRun off for their children; the fixtures must see the project's own policy. */
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^pnpm_config_/i.test(key)));
}

function pnpm(cwd: string, args: string[]) {
  return spawnSync("pnpm", args, { cwd, env: cleanEnv(), encoding: "utf8", timeout: 170_000 });
}

function git(cwd: string, args: string[]) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@users.noreply.github.com",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@users.noreply.github.com",
  };
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

/** Every file outside node_modules and .git, as path -> bytes, to prove nothing else moved. */
function tree(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, tree(join(dir, entry.name), `${rel}/`));
    else files[rel] = readFileSync(join(dir, entry.name)).toString("latin1");
  }
  return files;
}

let counter = 0;
type Options = { deps?: Record<string, string>; allow?: Record<string, boolean>; install?: boolean };

/** A generated-application-shaped project with zero registry dependencies. */
function makeProject({ deps = {}, allow = {}, install = true }: Options = {}) {
  const dir = join(scratch, `project-${counter++}`);
  mkdirSync(join(dir, "tooling"), { recursive: true });
  cpSync(join(root, "scripts"), join(dir, "scripts"), {
    recursive: true,
    filter: (source) => !source.includes("/scripts/template") && !source.includes("/scripts/hooks"),
  });
  cpSync(join(import.meta.dirname, "../fixtures/packages"), join(dir, "pkgs"), { recursive: true });
  for (const name of ["policy.json", "capabilities.json"]) cpSync(join(root, "tooling", name), join(dir, "tooling", name));
  writeFileSync(join(dir, "tooling/project-role.json"), JSON.stringify({ role: "application", dependencyGraph: "root", seedWorkspaceMember: false }));
  cpSync(join(root, ".node-version"), join(dir, ".node-version"));
  const manifest = {
    name: "fixture-app",
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: `pnpm@${toolchain.readExpected(root).pnpm}`,
    engines: { node: toolchain.readExpected(root).node },
    scripts: { ...development.scriptsFor("application"), probe: "node -e 0" },
    devDependencies: deps,
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const builds = Object.entries(allow)
    .map(([name, value]) => `  "${name}@file:pkgs/${name}": ${value}\n`)
    .join("");
  writeFileSync(join(dir, "pnpm-workspace.yaml"), `${POLICY}allowBuilds:\n${builds || "  placeholder-free: false\n"}`);
  if (install) {
    const result = pnpm(dir, ["install", "--prefer-offline"]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
  }
  return dir;
}

const fileSpec = (name: string) => ({
  lockCopy: ["pkgs"],
  steps: [["add", "--save-dev", "--save-exact", `file:./pkgs/${name}`]],
  plan: { action: "add" as const, group: "dev" as const, name, valueOk: (value: string) => value.startsWith("file:") },
});

describe("lock consistency gate", () => {
  test("a matching lock passes and no byte of the active tree moves", () => {
    const dir = makeProject({ deps: REGISTRY });
    const before = tree(dir);
    const nodeModules = readdirSync(join(dir, "node_modules")).sort();
    expect(transaction.checkLock(dir).ok).toBe(true);
    expect(tree(dir)).toEqual(before);
    expect(readdirSync(join(dir, "node_modules")).sort()).toEqual(nodeModules);
  });

  test("a cold metadata cache is fetched on demand: a matching lock passes, input bytes and modes and the active tree stay put", () => {
    const dir = makeProject({ deps: REGISTRY });
    const before = tree(dir);
    const modes = Object.fromEntries(Object.keys(before).map((path) => [path, statSync(join(dir, path)).mode]));
    const nodeModules = readdirSync(join(dir, "node_modules")).sort();
    // Only this child process sees the empty cache; no shared cache or pnpm setting is touched.
    process.env.pnpm_config_cache_dir = join(scratch, `cold-cache-${counter++}`);
    const result = transaction.checkLock(dir);
    expect(result.ok, result.output).toBe(true);
    expect(tree(dir)).toEqual(before);
    expect(Object.fromEntries(Object.keys(before).map((path) => [path, statSync(join(dir, path)).mode]))).toEqual(modes);
    expect(readdirSync(join(dir, "node_modules")).sort()).toEqual(nodeModules);
  });

  test("a stale or missing lock fails nonzero and changes nothing", () => {
    const dir = makeProject({ deps: REGISTRY });
    const manifest = parseJson<EditableManifest>(readFileSync(join(dir, "package.json"), "utf8"));
    manifest.devDependencies["needs-build"] = "file:./pkgs/needs-build";
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
    let before = tree(dir);
    expect(transaction.checkLock(dir).ok).toBe(false);
    expect(tree(dir)).toEqual(before);
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ ...manifest, devDependencies: REGISTRY }, null, 2)}\n`);
    expect(transaction.checkLock(dir).ok).toBe(true);
    rmSync(join(dir, "pnpm-lock.yaml"));
    before = tree(dir);
    expect(transaction.checkLock(dir).ok).toBe(false);
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, "pnpm-lock.yaml"))).toBe(false);
  });

  test("the generator's own check passes every gate, including the unit suites and their coverage, touching nothing tracked", () => {
    const before = transaction.snapshot(root);
    const out = sink();
    expect(development.main(["check"], { root, io: out.io }), out.err.join("")).toBe(0);
    expect(transaction.changedPaths(before, transaction.snapshot(root))).toEqual([]);
    expect(out.out.join("")).toContain("lock: ok");
    for (const gate of ["lock", "format", "lint", "typecheck", "unit"]) expect(out.out.join("")).toContain(`${gate}: ok`);
    expect(out.err.join("")).not.toMatch(/check failed|not available yet/);
  });
});

describe("dependency add transaction with real pnpm and local fixture packages", () => {
  test("a clean add changes only the chosen map and the lock", () => {
    const dir = makeProject();
    const before = tree(dir);
    const { steps, plan, lockCopy } = fileSpec("plain-lib");
    const result = transaction.runTransaction({ root: dir, steps, plan, lockCopy });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    const after = tree(dir);
    const changed = Object.keys(after)
      .filter((path) => after[path] !== before[path])
      .sort();
    expect(changed).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(parseJson<EditableManifest>(after["package.json"] ?? "").devDependencies).toEqual({ "plain-lib": "file:pkgs/plain-lib" });
    expect(installState.dirtyReason(dir)).toBeNull();
  });

  /** Real pnpm, then a late writer: the lifecycle effect lands after pnpm's own manifest write. */
  function withLateWrite(dir: string, write: () => void): (args: readonly string[]) => { status: number | null; stdout: string; stderr: string } {
    return (args) => {
      const result = spawnSync("pnpm", args, { cwd: dir, env: cleanEnv(), encoding: "utf8" });
      write();
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
  }
  const rewriteCheck = (dir: string) => () => {
    const manifest = parseJson<EditableManifest>(readFileSync(join(dir, "package.json"), "utf8"));
    manifest.scripts.check = "node evil.cjs";
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  };

  test("a lifecycle script that rewrites scripts.check is rejected when pnpm succeeds", () => {
    const dir = makeProject({ allow: { "lifecycle-mutator": true } });
    const before = tree(dir);
    Object.assign(process.env, { FIXTURE_PROJECT: dir, FIXTURE_MODE: "scripts-check" });
    const { steps, plan, lockCopy } = fileSpec("lifecycle-mutator");
    const result = transaction.runTransaction({ root: dir, steps, plan, lockCopy, runner: withLateWrite(dir, rewriteCheck(dir)) });
    expect(result.status).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/outside the dependency maps/);
    expect(tree(dir)).toEqual(before);
    expect(installState.dirtyReason(dir)).not.toBeNull();
    expect(toolchain.gateErrors(dir).join("\n")).toContain("bootstrap.cjs repair");
  });

  test("a lifecycle script that rewrites scripts.check and then fails is rejected", () => {
    const dir = makeProject({ allow: { "lifecycle-mutator": true } });
    const before = tree(dir);
    Object.assign(process.env, { FIXTURE_PROJECT: dir, FIXTURE_MODE: "scripts-check", FIXTURE_FAIL: "1" });
    const { steps, plan, lockCopy } = fileSpec("lifecycle-mutator");
    const result = transaction.runTransaction({ root: dir, steps, plan, lockCopy, runner: withLateWrite(dir, rewriteCheck(dir)) });
    expect(result.status).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(tree(dir)).toEqual(before);
    expect(installState.dirtyReason(dir)).not.toBeNull();
  });

  test.each([
    ["workspace-permissions", "pnpm-workspace.yaml"],
    ["placeholder", "pnpm-workspace.yaml"],
    ["hook", "scripts/evil.cjs"],
  ])("lifecycle mutation %s is rolled back and reported", (mode, path) => {
    const dir = makeProject({ allow: { "lifecycle-mutator": true } });
    const before = tree(dir);
    Object.assign(process.env, { FIXTURE_PROJECT: dir, FIXTURE_MODE: mode });
    const { steps, plan, lockCopy } = fileSpec("lifecycle-mutator");
    const append = () => {
      writeFileSync(join(dir, "pnpm-workspace.yaml"), `${readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8")}  other-pkg: set this to true or false\n`);
    };
    const runner = mode === "placeholder" ? withLateWrite(dir, append) : undefined;
    const result = transaction.runTransaction({ root: dir, steps, plan, lockCopy, runner });
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toContain(`protected path changed: ${path}`);
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, "scripts/evil.cjs"))).toBe(false);
    expect(installState.dirtyReason(dir)).not.toBeNull();
  });

  test("a new build need gives a review result and adopts no policy", () => {
    const dir = makeProject();
    const before = tree(dir);
    const out = sink();
    const request = dependencies.requestFromArgv("add", ["--package=needs-build", "--group=dev"]);
    expect(request.action).toBe("add");
    const { steps, plan, lockCopy } = fileSpec("needs-build");
    const result = transaction.runTransaction({ root: dir, steps, plan, lockCopy });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/ERR_PNPM_IGNORED_BUILDS/);
    expect(tree(dir)).toEqual(before);
    expect(readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8")).not.toMatch(/needs-build/);
    expect(out.err).toEqual([]);
  });

  test("the public command refuses while the install is marked incomplete and while the guard is unresolved", () => {
    const dir = makeProject();
    installState.markDirty(dir, "test");
    const out = sink();
    expect(dependencies.main(["add", "--package=plain-lib", "--group=dev"], { root: dir, io: out.io })).toBe(1);
    expect(out.err.join("")).toContain("repair");
    installState.clearDirty(dir);
    writeFileSync(join(dir, "tooling/capabilities.json"), JSON.stringify({ guard: true, hooks: false }));
    const missing = sink();
    expect(dependencies.main(["add", "--package=plain-lib", "--group=dev"], { root: dir, io: missing.io })).toBe(1);
    expect(missing.err.join("")).toMatch(/guard/);
    mkdirSync(join(dir, "scripts/hooks"));
    writeFileSync(join(dir, "scripts/hooks/state.cjs"), "exports.status = () => ({ clean: false, reason: 'pending reservation' });\n");
    const pending = sink();
    expect(dependencies.main(["add", "--package=plain-lib", "--group=dev"], { root: dir, io: pending.io })).toBe(1);
    expect(pending.err.join("")).toContain("pending reservation");
  });
});

describe("setup", () => {
  test("installs from the frozen lock without node_modules, claims no hooks, and refuses a leftover incomplete install", () => {
    const dir = makeProject({ deps: REGISTRY });
    rmSync(join(dir, "node_modules"), { recursive: true });
    const out = sink();
    expect(bootstrap.main(["setup"], { root: dir, io: out.io })).toBe(0);
    expect(out.out.join("")).toMatch(/Git hooks are not installed/);
    expect(existsSync(join(dir, "node_modules/typescript/package.json"))).toBe(true);
    expect(installState.dirtyReason(dir)).toBeNull();
    installState.markDirty(dir, "left behind");
    const again = sink();
    expect(bootstrap.main(["setup"], { root: dir, io: again.io })).toBe(1);
    expect(again.err.join("")).toContain("repair");
  });
});

describe("repair", () => {
  test("an absent node_modules fails the pnpm run preflight while core repair still works", () => {
    const dir = makeProject({ deps: REGISTRY });
    rmSync(join(dir, "node_modules"), { recursive: true });
    const run = pnpm(dir, ["run", "probe"]);
    expect(run.status).not.toBe(0);
    const out = sink();
    const before = tree(dir);
    expect(bootstrap.main(["repair"], { root: dir, io: out.io })).toBe(0);
    expect(out.err.join("")).toBe("");
    expect(tree(dir)).toEqual(before);
    expect(installState.dirtyReason(dir)).toBeNull();
    expect(pnpm(dir, ["run", "probe"]).status).toBe(0);
  });

  test("a corrupt node_modules is rebuilt from the frozen lock", () => {
    const dir = makeProject({ deps: REGISTRY });
    rmSync(join(dir, "node_modules/.pnpm"), { recursive: true });
    writeFileSync(join(dir, "node_modules/.modules.yaml"), "{ not yaml");
    expect(bootstrap.main(["repair"], { root: dir, io: sink().io })).toBe(0);
    expect(existsSync(join(dir, "node_modules/typescript/package.json"))).toBe(true);
    expect(pnpm(dir, ["run", "probe"]).status).toBe(0);
  });

  test("a stale lock is not repaired by regenerating it and nothing is removed", () => {
    const dir = makeProject({ deps: REGISTRY });
    const manifest = parseJson<EditableManifest>(readFileSync(join(dir, "package.json"), "utf8"));
    manifest.devDependencies["needs-build"] = "file:./pkgs/needs-build";
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
    const before = tree(dir);
    const out = sink();
    expect(bootstrap.main(["repair"], { root: dir, io: out.io })).toBe(1);
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, "node_modules/typescript"))).toBe(true);
  });

  test("a failed repair leaves the drift marker in place and a later repair clears it", () => {
    const dir = makeProject({ deps: REGISTRY });
    installState.markDirty(dir, "earlier drift");
    // The store location is a regular file, so the install itself cannot succeed.
    const notAStore = join(scratch, `not-a-store-${counter++}`);
    writeFileSync(notAStore, "x");
    process.env.pnpm_config_store_dir = notAStore;
    const out = sink();
    expect(bootstrap.main(["repair"], { root: dir, io: out.io })).toBe(1);
    expect(installState.dirtyReason(dir)).not.toBeNull();
    expect(toolchain.gateErrors(dir).join("\n")).toContain("repair");
    delete process.env.pnpm_config_store_dir;
    expect(bootstrap.main(["repair"], { root: dir, io: sink().io })).toBe(0);
    expect(installState.dirtyReason(dir)).toBeNull();
  });
});

describe("deps-lock after an approved manifest edit", () => {
  function committed() {
    const dir = makeProject();
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "baseline"]);
    return dir;
  }
  function approveEdit(dir: string, change: (manifest: EditableManifest) => void = (manifest) => (manifest.devDependencies.typescript = "6.0.3")) {
    const manifest = parseJson<EditableManifest>(readFileSync(join(dir, "package.json"), "utf8"));
    change(manifest);
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  test("a stale lock blocks pnpm run; deps-lock relocks only the approved manifest and the gates work again", () => {
    const dir = committed();
    approveEdit(dir);
    const manifestBytes = readFileSync(join(dir, "package.json"), "utf8");
    expect(pnpm(dir, ["run", "probe"]).status).not.toBe(0);
    const out = sink();
    expect(bootstrap.main(["deps-lock"], { root: dir, io: out.io })).toBe(0);
    expect(out.err.join("")).toBe("");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(manifestBytes);
    expect(readFileSync(join(dir, "pnpm-lock.yaml"), "utf8")).toContain("typescript");
    expect(transaction.checkLock(dir).ok).toBe(true);
    expect(pnpm(dir, ["run", "probe"]).status).toBe(0);
    expect(installState.dirtyReason(dir)).toBeNull();
  });

  test.each([
    ["a script", (manifest: EditableManifest) => (manifest.scripts.check = "node evil.cjs")],
    ["an engine", (manifest: EditableManifest) => (manifest.engines.node = "*")],
    ["a non-exact dependency", (manifest: EditableManifest) => (manifest.devDependencies.typescript = "^6.0.0")],
    ["a file dependency", (manifest: EditableManifest) => (manifest.devDependencies.typescript = "file:./pkgs/plain-lib")],
  ])("%s is outside the approved boundary", (_label, change) => {
    const dir = committed();
    approveEdit(dir, change);
    const before = tree(dir);
    const out = sink();
    expect(bootstrap.main(["deps-lock"], { root: dir, io: out.io })).toBe(1);
    expect(out.err.join("")).toMatch(/outside the dependency-only boundary/);
    expect(tree(dir)).toEqual(before);
  });

  test("a changed workspace file, an untracked tooling file, a missing baseline and an unresolved guard all refuse", () => {
    const dir = committed();
    approveEdit(dir);
    const before = tree(dir);
    writeFileSync(join(dir, "pnpm-workspace.yaml"), `${readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8")}# edit\n`);
    expect(bootstrap.main(["deps-lock"], { root: dir, io: sink().io })).toBe(1);
    git(dir, ["checkout", "--", "pnpm-workspace.yaml"]);
    writeFileSync(join(dir, "tooling/extra.json"), "{}");
    expect(bootstrap.main(["deps-lock"], { root: dir, io: sink().io })).toBe(1);
    rmSync(join(dir, "tooling/extra.json"));
    writeFileSync(join(dir, "tooling/capabilities.json"), JSON.stringify({ guard: true, hooks: false }));
    mkdirSync(join(dir, "scripts/hooks"));
    git(dir, ["add", "-A"]);
    git(dir, ["stash", "-q", "--keep-index"]);
    git(dir, ["stash", "drop", "-q"]);
    writeFileSync(join(dir, "scripts/hooks/state.cjs"), "exports.status = () => ({ clean: false, reason: 'conflict' });\n");
    git(dir, ["add", "-A"]);
    git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "register guard"]);
    approveEdit(dir);
    const guarded = sink();
    expect(bootstrap.main(["deps-lock"], { root: dir, io: guarded.io }).valueOf()).toBe(1);
    expect(guarded.err.join("")).toContain("conflict");
    expect(before["pnpm-lock.yaml"]).toBeDefined();
    const bare = makeProject();
    expect(bootstrap.main(["deps-lock"], { root: bare, io: sink().io })).toBe(1);
  });

  test("a failed relock restores the preimage and marks the install incomplete", () => {
    const dir = committed();
    approveEdit(dir, (manifest) => (manifest.devDependencies["definitely-not-a-published-package-u3"] = "1.0.0"));
    const before = tree(dir);
    expect(bootstrap.main(["deps-lock"], { root: dir, io: sink().io })).toBe(1);
    expect(tree(dir)).toEqual(before);
    expect(installState.dirtyReason(dir)).not.toBeNull();
  });
});

/** A bare project directory: enough for the transaction itself, with a stub runner standing in for pnpm. */
function bareProject(files: Record<string, string> = {}) {
  const dir = join(scratch, `bare-${counter++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "bare", version: "0.0.0", private: true })}\n`);
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lock-before\n");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
const succeeds = (effect: () => void) => () => {
  effect();
  return { status: 0, stdout: "", stderr: "" };
};
const fails = (effect: () => void) => () => {
  effect();
  return { status: 1, stdout: "", stderr: "" };
};

describe("transaction covers the whole policy-defining surface", () => {
  test("a successful install that rewrites AGENTS.md or CLAUDE.md is rejected and restored", () => {
    const dir = bareProject({ "AGENTS.md": "reviewed policy\n", "CLAUDE.md": "reviewed claude\n" });
    const result = transaction.runTransaction({
      root: dir,
      steps: [["install"]],
      plan: { action: "none" },
      runner: succeeds(() => {
        writeFileSync(join(dir, "AGENTS.md"), "changed by install\n");
        writeFileSync(join(dir, "CLAUDE.md"), "changed by install\n");
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining(["protected path changed: AGENTS.md", "protected path changed: CLAUDE.md"]));
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("reviewed policy\n");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("reviewed claude\n");
    expect(installState.dirtyReason(dir)).not.toBeNull();
  });

  test.each([
    [".pnpmfile.mjs"],
    [".pnpmfile.cjs"],
    [".npmrc"],
    ["tsconfig.json"],
    ["tsconfig.build.json"],
    ["next.config.ts"],
    ["eslint.config.mjs"],
    [".prettierrc.json"],
    ["prettier.config.mjs"],
    ["vitest.config.ts"],
    ["playwright.config.ts"],
    ["docs/docs.config.mjs"],
    [".githooks/pre-commit"],
    ["nested/.npmrc"],
    ["nested/deeper/pnpm-workspace.yaml"],
    ["nested/eslint.config.mjs"],
    ["nested/.pnpmfile.mjs"],
  ])("a lifecycle that creates %s is rejected and removed", (path) => {
    const dir = bareProject();
    const result = transaction.runTransaction({
      root: dir,
      steps: [["install"]],
      plan: { action: "none" },
      runner: succeeds(() => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), "export default {};\n");
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toContain(path);
    expect(existsSync(join(dir, path))).toBe(false);
  });

  test("the whole inventory is one shared source that both roles' static configs come from", () => {
    const inventory = require("../../scripts/core/protected.cjs") as typeof import("../../scripts/core/protected.cjs");
    for (const path of [
      "AGENTS.md",
      "CLAUDE.md",
      ".pnpmfile.mjs",
      "tsconfig.json",
      "next.config.ts",
      "eslint.config.mjs",
      ".prettierrc.json",
      "vitest.config.ts",
      "playwright.config.ts",
      "pnpm-workspace.yaml",
    ]) {
      expect(inventory.isProtectedFile(path), path).toBe(true);
    }
    expect(inventory.isProtectedFile("src/app/page.tsx")).toBe(false);
    expect(inventory.isProtectedFile("README.md")).toBe(false);
    expect(inventory.isShadowOverride("nested/.npmrc")).toBe(true);
    expect(inventory.isShadowOverride(".npmrc")).toBe(false);
    expect(inventory.isShadowOverride("src/app/page.tsx")).toBe(false);
  });

  test("an application's user source and ordinary files may change during an install", () => {
    const dir = makeProject();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/page.tsx"), "a\n");
    const result = transaction.runTransaction({
      root: dir,
      steps: [["install"]],
      plan: { action: "none" },
      runner: succeeds(() => {
        writeFileSync(join(dir, "src/page.tsx"), "b\n");
      }),
    });
    expect(result.ok).toBe(true);
  });

  test("a hook or config change in a linked worktree's resolved Git directories is rejected and restored", () => {
    const main = join(scratch, `main-${counter++}`);
    mkdirSync(main);
    git(main, ["init", "-q", "-b", "main"]);
    writeFileSync(join(main, "package.json"), `${JSON.stringify({ name: "wt", version: "0.0.0", private: true })}\n`);
    writeFileSync(join(main, "pnpm-lock.yaml"), "lock\n");
    git(main, ["add", "-A"]);
    git(main, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"]);
    const linked = join(scratch, `linked-${counter++}`);
    git(main, ["worktree", "add", "-q", "-b", "feature", linked]);
    expect(statSync(join(linked, ".git")).isFile()).toBe(true);
    const common = join(main, ".git");
    mkdirSync(join(common, "hooks"), { recursive: true });
    writeFileSync(join(common, "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(common, "hooks", "pre-commit"), 0o755);
    const config = readFileSync(join(common, "config"), "utf8");
    const result = transaction.runTransaction({
      root: linked,
      steps: [["install"]],
      plan: { action: "none" },
      runner: succeeds(() => {
        writeFileSync(join(common, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
        writeFileSync(join(common, "hooks", "post-commit"), "#!/bin/sh\n");
        writeFileSync(join(common, "config"), `${config}[core]\n\thooksPath = /tmp/elsewhere\n`);
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/git.*hooks\/pre-commit/);
    expect(readFileSync(join(common, "hooks", "pre-commit"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(statSync(join(common, "hooks", "pre-commit")).mode & 0o777).toBe(0o755);
    expect(existsSync(join(common, "hooks", "post-commit"))).toBe(false);
    expect(readFileSync(join(common, "config"), "utf8")).toBe(config);
  });
});

describe("transaction rollback is exact", () => {
  test.each([
    ["a successful", succeeds],
    ["a failing", fails],
  ])("%s run that retargets a symlink restores the original target and writes through nothing", (_label, outcome) => {
    const outside = join(scratch, `outside-${counter++}`);
    writeFileSync(outside, "outside untouched\n");
    const dir = bareProject({ "scripts/original.cjs": "o\n", "scripts/replaced.cjs": "r\n" });
    symlinkSync("original.cjs", join(dir, "scripts/alias.cjs"));
    const result = transaction.runTransaction({
      root: dir,
      steps: [["install"]],
      plan: { action: "none" },
      runner: outcome(() => {
        unlinkSync(join(dir, "scripts/alias.cjs"));
        symlinkSync("replaced.cjs", join(dir, "scripts/alias.cjs"));
        unlinkSync(join(dir, "scripts/original.cjs"));
        symlinkSync(outside, join(dir, "scripts/original.cjs"));
      }),
    });
    expect(result.ok).toBe(false);
    expect(readlinkSync(join(dir, "scripts/alias.cjs"))).toBe("original.cjs");
    expect(lstatSync(join(dir, "scripts/original.cjs")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, "scripts/original.cjs"), "utf8")).toBe("o\n");
    expect(readFileSync(outside, "utf8")).toBe("outside untouched\n");
  });

  test("a replaced directory symlink is unlinked, never followed, and file modes are restored", () => {
    const outsideDir = join(scratch, `outside-dir-${counter++}`);
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "tool.cjs"), "outside\n");
    const dir = bareProject();
    mkdirSync(join(dir, "tooling"));
    writeFileSync(join(dir, "tooling/tool.cjs"), "inside\n", { mode: 0o755 });
    chmodSync(join(dir, "tooling/tool.cjs"), 0o755);
    const result = transaction.runTransaction({
      root: dir,
      steps: [["install"]],
      plan: { action: "none" },
      runner: succeeds(() => {
        rmSync(join(dir, "tooling"), { recursive: true });
        symlinkSync(outsideDir, join(dir, "tooling"));
      }),
    });
    expect(result.ok).toBe(false);
    expect(lstatSync(join(dir, "tooling")).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, "tooling/tool.cjs"), "utf8")).toBe("inside\n");
    expect(statSync(join(dir, "tooling/tool.cjs")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(outsideDir, "tool.cjs"), "utf8")).toBe("outside\n");
  });
});

describe("late edits to the requested package are caught by the frozen lock", () => {
  test("a manifest that disagrees with the lock after a successful step is rejected even though the map delta looks allowed", () => {
    const dir = makeProject();
    const before = tree(dir);
    const result = transaction.runTransaction({
      root: dir,
      steps: [["noop"]],
      plan: { action: "add", group: "dev", name: "typescript", version: "6.0.3" },
      runner: succeeds(() => {
        const manifest = parseJson<EditableManifest>(readFileSync(join(dir, "package.json"), "utf8"));
        manifest.devDependencies.typescript = "6.0.3";
        writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join("\n")).toMatch(/lock could not be verified against package\.json/);
    expect(tree(dir)).toEqual(before);
  });
});

describe("deps-lock retry after a failed relock", () => {
  function committedEmpty() {
    const dir = makeProject();
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    git(dir, ["add", "-A"]);
    git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "baseline"]);
    return dir;
  }

  test("failure keeps the drift, a retry of the same approved relock succeeds, and normal pnpm run works with the manifest bytes preserved", () => {
    const dir = committedEmpty();
    const manifest = parseJson<EditableManifest>(readFileSync(join(dir, "package.json"), "utf8"));
    manifest.devDependencies.typescript = "6.0.3";
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const approvedBytes = readFileSync(join(dir, "package.json"), "utf8");
    const lockBefore = readFileSync(join(dir, "pnpm-lock.yaml"), "utf8");
    const notAStore = join(scratch, `not-a-store-${counter++}`);
    writeFileSync(notAStore, "x");
    process.env.pnpm_config_store_dir = notAStore;
    const failed = sink();
    expect(bootstrap.main(["deps-lock"], { root: dir, io: failed.io })).toBe(1);
    delete process.env.pnpm_config_store_dir;
    expect(readFileSync(join(dir, "pnpm-lock.yaml"), "utf8")).toBe(lockBefore);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(approvedBytes);
    expect(installState.dirtyReason(dir)).not.toBeNull();
    // The recovery message names the command that can actually progress.
    expect(toolchain.gateErrors(dir).join("\n")).toContain("deps-lock");
    // Repair refuses a stale lock and points back at deps-lock.
    const repaired = sink();
    expect(bootstrap.main(["repair"], { root: dir, io: repaired.io })).toBe(1);
    expect(repaired.err.join("")).toContain("deps-lock");
    // The same approved relock is retried; drift clears only when the frozen sync succeeds.
    const retry = sink();
    expect(bootstrap.main(["deps-lock"], { root: dir, io: retry.io })).toBe(0);
    expect(retry.err.join("")).toBe("");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(approvedBytes);
    expect(installState.dirtyReason(dir)).toBeNull();
    expect(pnpm(dir, ["run", "probe"]).status).toBe(0);
  });

  test("a retry still refuses a policy edit made after the failure and keeps the drift", () => {
    const dir = committedEmpty();
    const manifest = parseJson<EditableManifest>(readFileSync(join(dir, "package.json"), "utf8"));
    manifest.devDependencies.typescript = "6.0.3";
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const notAStore = join(scratch, `not-a-store-${counter++}`);
    writeFileSync(notAStore, "x");
    process.env.pnpm_config_store_dir = notAStore;
    expect(bootstrap.main(["deps-lock"], { root: dir, io: sink().io })).toBe(1);
    delete process.env.pnpm_config_store_dir;
    manifest.scripts.check = "node evil.cjs";
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const refused = sink();
    expect(bootstrap.main(["deps-lock"], { root: dir, io: refused.io })).toBe(1);
    expect(refused.err.join("")).toMatch(/outside the dependency-only boundary/);
    expect(installState.dirtyReason(dir)).not.toBeNull();
  });

  test("a drift that no failed relock left behind is not retried through deps-lock", () => {
    const dir = committedEmpty();
    installState.markDirty(dir, "some other drift");
    const out = sink();
    expect(bootstrap.main(["deps-lock"], { root: dir, io: out.io })).toBe(1);
    expect(out.err.join("")).toContain("repair");
  });
});

describe("guard seam fails closed", () => {
  const refusal = (source: string | null) => {
    const dir = makeProject({ install: false });
    writeFileSync(join(dir, "tooling/capabilities.json"), JSON.stringify({ guard: true, hooks: false }));
    if (source !== null) {
      mkdirSync(join(dir, "scripts/hooks"), { recursive: true });
      writeFileSync(join(dir, "scripts/hooks/state.cjs"), source);
    }
    return installState.guardRefusal(dir);
  };

  test("an unregistered guard claims nothing", () => {
    const dir = makeProject({ install: false });
    expect(installState.guardRefusal(dir)).toBeNull();
  });

  test.each([
    ["a missing module", null],
    ["a module that throws", "exports.status = () => { throw new Error('boom'); };\n"],
    ["a module that does not load", "throw new Error('bad load');\n"],
    ["a module without status", "exports.other = 1;\n"],
    ["a non-object answer", "exports.status = () => true;\n"],
    ["a truthy but not clean answer", "exports.status = () => ({ clean: 'yes' });\n"],
    ["an unclean answer", "exports.status = () => ({ clean: false, reason: 'pending reservation' });\n"],
  ])("%s refuses", (_label, source) => {
    expect(refusal(source)).not.toBeNull();
  });

  test("only an explicit clean: true proceeds", () => {
    expect(refusal("exports.status = () => ({ clean: true });\n")).toBeNull();
  });
});

describe("reviewed tool pins versus ordinary dependencies", () => {
  function generatorProject() {
    const dir = makeProject({ install: false });
    const versions = parseJson<Versions>(readFileSync(join(root, "tooling/versions.json"), "utf8"));
    cpSync(join(root, "tooling/versions.json"), join(dir, "tooling/versions.json"));
    writeFileSync(join(dir, "tooling/project-role.json"), JSON.stringify({ role: "generator" }));
    const manifest = parseJson<EditableManifest>(readFileSync(join(dir, "package.json"), "utf8"));
    manifest.devDependencies = versions.root.devDependencies;
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return dir;
  }

  test.each([[["add", "--package=typescript@6.0.2", "--group=dev"]], [["remove", "--package=typescript", "--group=dev"]], [["upgrade", "--package=vitest"]]])(
    "%j is refused before anything runs, because the pin is a reviewed tooling change",
    (argv) => {
      const dir = generatorProject();
      const before = tree(dir);
      const out = sink();
      expect(dependencies.main(argv, { root: dir, io: out.io })).toBe(1);
      expect(out.err.join("")).toContain("reviewed tool pin");
      expect(tree(dir)).toEqual(before);
      expect(installState.dirtyReason(dir)).toBeNull();
    },
  );

  test("an application has no reviewed pins, so its own dependencies are never blocked by the generator's", () => {
    const dir = makeProject({ install: false });
    expect(dependencies.reviewedPins(dir)).toEqual({});
  });
});

describe("rollback ownership: only recorded protected paths are ever removed", () => {
  function bare() {
    const dir = join(scratch, `bare-${counter++}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "bare", version: "0.0.0", private: true })}\n`);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lock-before\n");
    return dir;
  }
  const failing = (act: () => void) => () => {
    act();
    return { status: 1, stdout: "", stderr: "" };
  };
  const rollback = (dir: string, act: () => void) =>
    transaction.runTransaction({ root: dir, steps: [["install"]], plan: { action: "none" }, runner: failing(act) });

  test("a shadow override added inside ordinary source goes; the source directory and its files stay", () => {
    const dir = bare();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/user.ts"), "export const user = 1;\n");
    const result = rollback(dir, () => {
      writeFileSync(join(dir, "src/.npmrc"), "ignore-scripts=false\n");
      writeFileSync(join(dir, "src/added.ts"), "export const added = 1;\n");
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, "src/.npmrc"))).toBe(false);
    expect(readFileSync(join(dir, "src/user.ts"), "utf8")).toBe("export const user = 1;\n");
    expect(readFileSync(join(dir, "src/added.ts"), "utf8")).toBe("export const added = 1;\n");
  });

  test("a directory created during the transaction keeps its unrecorded content and loses only the override", () => {
    const dir = bare();
    rollback(dir, () => {
      mkdirSync(join(dir, "fresh"));
      writeFileSync(join(dir, "fresh/.npmrc"), "x\n");
      writeFileSync(join(dir, "fresh/notes.txt"), "mine\n");
    });
    expect(existsSync(join(dir, "fresh/.npmrc"))).toBe(false);
    expect(readFileSync(join(dir, "fresh/notes.txt"), "utf8")).toBe("mine\n");
  });

  test("an empty directory is removed only when the transaction created it", () => {
    const dir = bare();
    mkdirSync(join(dir, "kept"));
    rollback(dir, () => {
      mkdirSync(join(dir, "made"));
      writeFileSync(join(dir, "made/.npmrc"), "x\n");
      writeFileSync(join(dir, "kept/.npmrc"), "x\n");
    });
    expect(existsSync(join(dir, "made"))).toBe(false);
    expect(lstatSync(join(dir, "kept")).isDirectory()).toBe(true);
    expect(existsSync(join(dir, "kept/.npmrc"))).toBe(false);
  });

  test("a restore that cannot finish throws with the paths, keeps the drift marker and deletes nothing else", () => {
    const dir = bare();
    writeFileSync(join(dir, ".npmrc"), "reviewed\n");
    expect(() =>
      rollback(dir, () => {
        unlinkSync(join(dir, ".npmrc"));
        mkdirSync(join(dir, ".npmrc"));
        writeFileSync(join(dir, ".npmrc/user.txt"), "mine\n");
      }),
    ).toThrow(/\.npmrc/);
    expect(readFileSync(join(dir, ".npmrc/user.txt"), "utf8")).toBe("mine\n");
    expect(installState.dirtyReason(dir)).toMatch(/rollback/);
  });

  test("the docs site configuration and its helpers are policy, template seed configuration too, ordinary seed source is not", () => {
    const dir = bare();
    mkdirSync(join(dir, "docs/.vitepress"), { recursive: true });
    writeFileSync(join(dir, "docs/.vitepress/config.ts"), "export default {};\n");
    mkdirSync(join(dir, "template/app/src"), { recursive: true });
    writeFileSync(join(dir, "template/app/tsconfig.json"), "{}\n");
    writeFileSync(join(dir, "template/app/src/page.tsx"), "export {};\n");
    const result = rollback(dir, () => {
      writeFileSync(join(dir, "docs/.vitepress/config.ts"), "export default { hacked: true };\n");
      mkdirSync(join(dir, "docs/.vitepress/config"));
      writeFileSync(join(dir, "docs/.vitepress/config/nav.ts"), "export {};\n");
      writeFileSync(join(dir, "template/app/tsconfig.json"), '{"extends":"x"}\n');
      writeFileSync(join(dir, "template/app/src/page.tsx"), "export const edited = 1;\n");
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(dir, "docs/.vitepress/config.ts"), "utf8")).toBe("export default {};\n");
    expect(existsSync(join(dir, "docs/.vitepress/config"))).toBe(false);
    expect(readFileSync(join(dir, "template/app/tsconfig.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(dir, "template/app/src/page.tsx"), "utf8")).toBe("export const edited = 1;\n");
    const protectedRel = require("../../scripts/core/protected.cjs") as typeof import("../../scripts/core/protected.cjs");
    expect(protectedRel.isProtectedFile("template/app/src/page.tsx")).toBe(false);
    expect(protectedRel.isProtectedFile("template/app/eslint.config.mjs")).toBe(true);
  });
});

describe("deps:upgrade without a name is the whole set or nothing", () => {
  test("in the generator it refuses before running pnpm and names the pins and the reviewed path", () => {
    const dir = makeProject({ install: false });
    const versions = parseJson<Versions>(readFileSync(join(root, "tooling/versions.json"), "utf8"));
    cpSync(join(root, "tooling/versions.json"), join(dir, "tooling/versions.json"));
    writeFileSync(join(dir, "tooling/project-role.json"), JSON.stringify({ role: "generator" }));
    const manifest = parseJson<EditableManifest>(readFileSync(join(dir, "package.json"), "utf8"));
    manifest.devDependencies = { ...versions.root.devDependencies, "left-pad": "1.3.0" };
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const before = tree(dir);
    const calls: string[][] = [];
    const out = sink();
    const runner = (args: readonly string[]) => {
      calls.push([...args]);
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(dependencies.main(["upgrade"], { root: dir, io: out.io, runner })).toBe(1);
    expect(calls).toEqual([]);
    expect(out.err.join("")).toMatch(/reviewed tool pin.*typescript/s);
    expect(out.err.join("")).toMatch(/--package=/);
    expect(tree(dir)).toEqual(before);
    expect(installState.dirtyReason(dir)).toBeNull();
  });

  test("an application upgrades every dependency in one pnpm call", () => {
    const dir = makeProject({ deps: { "left-pad": "1.3.0" }, install: false });
    const calls: string[][] = [];
    const out = sink();
    dependencies.main(["upgrade"], { root: dir, io: out.io, runner: (args) => (calls.push([...args]), { status: 1, stdout: "", stderr: "" }) });
    expect(calls).toEqual([["update", "--latest", "--save-exact"]]);
  });
});
