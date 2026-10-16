import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { parseJson, type Manifest, type Versions } from "../support/json.ts";

const root = resolve(import.meta.dirname, "../..");
const render = createRequire(import.meta.url)("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");
const versions = parseJson<Versions>(readFileSync(join(root, "tooling/versions.json"), "utf8"));

function renderFor(answers: Record<string, unknown>) {
  const { manifest, bases } = render.defaultInputs();
  return render.renderTree({ manifest, bases, answers });
}

const description = 'He said "hi" \\ ✓';
const a = renderFor({ name: "first-app", description, owner: "first-owner" });
const b = renderFor({ name: "second-app", owner: "second-owner" });
const paths = a.files.map((file) => file.path);
const byPath = (result: typeof a, path: string) => (result.files.find((file) => file.path === path)?.content as Buffer).toString("utf8");

describe("real seed render", () => {
  test("emits the application role files and nothing from the generator", () => {
    expect(paths).toEqual([
      ".env.example",
      ".gitignore",
      ".node-version",
      ".prettierignore",
      ".prettierrc.json",
      "eslint.config.mjs",
      "next.config.ts",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "public/favicon.svg",
      "scripts/bootstrap.cjs",
      "scripts/core/args.cjs",
      "scripts/core/dependency-policy.cjs",
      "scripts/core/focused-run.cjs",
      "scripts/core/install-state.cjs",
      "scripts/core/json.cjs",
      "scripts/core/process.cjs",
      "scripts/core/protected.cjs",
      "scripts/core/quality.cjs",
      "scripts/core/testing.cjs",
      "scripts/core/toolchain.cjs",
      "scripts/core/transaction.cjs",
      "scripts/dependencies.cjs",
      "scripts/development.cjs",
      "src/app/error.tsx",
      "src/app/globals.css",
      "src/app/layout.tsx",
      "src/app/not-found.tsx",
      "src/app/page.module.css",
      "src/app/page.tsx",
      "tests/app/error.test.tsx",
      "tests/app/home.test.tsx",
      "tests/app/layout.test.tsx",
      "tests/app/not-found.test.tsx",
      "tests/contracts/coverage-policy.test.ts",
      "tests/contracts/suite-classification.test.ts",
      "tests/integration/bootstrap.test.ts",
      "tests/integration/dependencies-cli.test.ts",
      "tests/integration/development-gates.test.ts",
      "tests/integration/executable-lookup.test.ts",
      "tests/integration/install-state.test.ts",
      "tests/integration/process.test.ts",
      "tests/integration/transaction.test.ts",
      "tests/setup/app.ts",
      "tests/support/json.ts",
      "tests/support/memory-disk.ts",
      "tests/support/project.ts",
      "tests/unit/bootstrap.test.ts",
      "tests/unit/commands.test.ts",
      "tests/unit/dependencies.test.ts",
      "tests/unit/dependency-policy.test.ts",
      "tests/unit/gates.test.ts",
      "tests/unit/install-state.test.ts",
      "tests/unit/process.test.ts",
      "tests/unit/protected.test.ts",
      "tests/unit/quality.test.ts",
      "tests/unit/suppression-policy.test.ts",
      "tests/unit/testing.test.ts",
      "tests/unit/toolchain.test.ts",
      "tests/unit/transaction.test.ts",
      "tooling/capabilities.json",
      "tooling/eslint/shared.mjs",
      "tooling/eslint/suppression-policy.mjs",
      "tooling/policy.json",
      "tooling/project-role.json",
      "tooling/vitest/suite.ts",
      "tsconfig.json",
      "tsconfig.tooling.json",
      "vitest.app.config.ts",
      "vitest.config.ts",
      "vitest.infrastructure.config.ts",
      "vitest.integration.config.ts",
    ]);
    expect(paths).toEqual(b.files.map((file) => file.path));
    for (const forbidden of [
      /template-manifest/,
      /^scripts\/template/,
      /^tests\/(?:fixtures|generator)\/|^tests\/integration\/(?!(?:bootstrap|dependencies-cli|development-gates|executable-lookup|install-state|process|transaction)\.test\.ts$)/,
      /^tests\/(?:unit\/(?:renderer|generator-commands)|contracts\/(?:rendered-output|toolchain|command-parity)|support\/rendered-app)/,
      /^tooling\/(?!project-role\.json$|policy\.json$|capabilities\.json$|eslint\/(?:shared|suppression-policy)\.mjs$|vitest\/suite\.ts$)/,
      /\.py$/,
      /pyproject|Makefile|copier|uv\.lock/i,
      /auth|prisma|drizzle|database|db\//i,
    ]) {
      for (const path of paths) expect(path, String(forbidden)).not.toMatch(forbidden);
    }
  });

  test("emitted tests assume nothing the generator alone provides", () => {
    const tests = a.files.filter((file) => file.path.startsWith("tests/"));
    expect(tests.length).toBeGreaterThan(10);
    for (const file of tests) {
      expect(file.content.toString("utf8"), file.path).not.toMatch(/join\(root, "tooling\/versions|render\.cjs|template-manifest|scripts\/template/);
    }
  });

  test("explicit application role is emitted and differs from the generator's own role file", () => {
    expect(JSON.parse(byPath(a, "tooling/project-role.json"))).toEqual({ role: "application", dependencyGraph: "root", seedWorkspaceMember: false });
    expect(parseJson(readFileSync(join(root, "tooling/project-role.json"), "utf8")).role).toBe("generator");
  });

  test("package.json carries the reviewed pins as its own graph", () => {
    const manifest = parseJson<Manifest>(byPath(a, "package.json"));
    expect(manifest.name).toBe("first-app");
    expect(manifest.version).toBe("0.0.0");
    expect(manifest.description).toBe(description);
    expect(manifest.private).toBe(true);
    expect(manifest.packageManager).toBe(`pnpm@${versions.pnpm}`);
    expect(manifest.engines?.node).toBe(versions.node);
    expect(manifest.dependencies).toEqual(versions.seed.dependencies);
    expect(manifest.devDependencies).toEqual(versions.seed.devDependencies);
    expect(JSON.stringify(manifest)).not.toMatch(/workspace:|link:|file:|\.\.\//);
  });

  test("workspace file makes the app its own root and denies the reviewed builds only", () => {
    const workspace = byPath(a, "pnpm-workspace.yaml");
    expect(workspace).not.toMatch(/^packages:|^overrides:/m);
    for (const name of versions.seed.deniedBuilds) expect(workspace).toContain(`${name}: false`);
    expect(workspace).not.toMatch(/allowBuilds:[\s\S]*: true|dangerouslyAllowAllBuilds/);
    expect(byPath(a, ".node-version")).toBe(readFileSync(join(root, ".node-version"), "utf8"));
    expect(byPath(a, ".node-version").trim()).toBe(versions.node);
  });

  test("lock is independent of the generator and of the personalization", () => {
    const lock = byPath(a, "pnpm-lock.yaml");
    expect(lock).toBe(byPath(b, "pnpm-lock.yaml"));
    expect(lock).not.toMatch(/workspace:|link:|first-app|second-app/);
    expect(lock).not.toMatch(/\/(?:home|tmp|Users)\//);
    expect(lock).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    for (const [name, version] of Object.entries({ ...versions.seed.dependencies, ...versions.seed.devDependencies })) {
      expect(lock, name).toContain(`version: ${version}`);
    }
  });

  test("no e-mail address or log file reaches the output", () => {
    for (const file of a.files) {
      expect(file.content.toString("utf8"), file.path).not.toMatch(/[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z][A-Za-z0-9-]*)+/);
    }
    expect(paths.filter((path) => /\.log$|\.tsbuildinfo$/.test(path))).toEqual([]);
  });
});
