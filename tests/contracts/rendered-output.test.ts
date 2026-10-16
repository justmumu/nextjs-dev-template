import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterAll, describe, expect, test } from "vitest";
import { parseJson, type Manifest, type Versions } from "../support/json.ts";

const root = resolve(import.meta.dirname, "../..");
const render = createRequire(import.meta.url)("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");
const versions = parseJson<Versions>(readFileSync(join(root, "tooling/versions.json"), "utf8"));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "rendered-output-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function renderFor(answers: Record<string, unknown>) {
  const { manifest, bases } = render.defaultInputs();
  return render.renderTree({ manifest, bases, answers });
}

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
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
      "scripts/core/install-state.cjs",
      "scripts/core/json.cjs",
      "scripts/core/process.cjs",
      "scripts/core/protected.cjs",
      "scripts/core/quality.cjs",
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
      "tooling/capabilities.json",
      "tooling/eslint/shared.mjs",
      "tooling/eslint/suppression-policy.mjs",
      "tooling/policy.json",
      "tooling/project-role.json",
      "tsconfig.json",
      "tsconfig.tooling.json",
    ]);
    expect(paths).toEqual(b.files.map((file) => file.path));
    for (const forbidden of [
      /template-manifest/,
      /^scripts\/template/,
      /^tests\//,
      /^tooling\/(?!project-role\.json$|policy\.json$|capabilities\.json$|eslint\/(?:shared|suppression-policy)\.mjs$)/,
      /\.py$/,
      /pyproject|Makefile|copier|uv\.lock/i,
      /auth|prisma|drizzle|database|db\//i,
    ]) {
      for (const path of paths) expect(path, String(forbidden)).not.toMatch(forbidden);
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

  test("template:create renders the same tree as the API and refuses a non-empty destination", () => {
    const dest = join(scratch, "cli");
    const cli = (target: string) =>
      spawnSync(process.execPath, [join(root, "scripts/development.cjs"), "template:create", "--name=first-app", "--owner=first-owner", `--dest=${target}`], {
        encoding: "utf8",
      });
    const first = cli(dest);
    expect(first.status).toBe(0);
    const same = renderFor({ name: "first-app", owner: "first-owner" });
    expect(JSON.parse(first.stdout)).toEqual({ files: same.files.length, digest: same.digest });
    expect(walk(dest)).toEqual(paths);
    for (const file of same.files) {
      expect(statSync(join(dest, file.path)).mode & 0o777, file.path).toBe(file.mode);
      expect(readFileSync(join(dest, file.path)).equals(file.content), file.path).toBe(true);
    }
    const second = cli(dest);
    expect(second.status).toBe(2);
    expect(second.stderr).toMatch(/not empty/);
  });
});
