import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { parseJson, type Manifest, type Versions } from "../support/json.ts";

const root = resolve(import.meta.dirname, "../..");
const render = createRequire(import.meta.url)("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");
const versions = parseJson<Versions>(readFileSync(join(root, "tooling/versions.json"), "utf8"));
const seed = parseJson<Manifest>(readFileSync(join(root, "template/app/package.json"), "utf8"));

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
      ".claude/settings.json",
      ".codex/config.toml",
      ".codex/hooks.json",
      ".codex/rules/publishing.rules",
      ".compound-engineering/config.example.yaml",
      ".compound-engineering/config.yaml",
      ".env.example",
      ".github/dependabot.yml",
      ".github/pull_request_template.md",
      ".github/workflows/ci.yml",
      ".github/workflows/dependency-audit.yml",
      ".github/workflows/release.yml",
      ".github/workflows/template-ci.yml",
      ".github/workflows/template-initialize.yml",
      ".gitignore",
      ".node-version",
      ".prettierignore",
      ".prettierrc.json",
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "compound-packs/README.md",
      "docs/.vitepress/config.ts",
      "docs/.vitepress/site.json",
      "docs/contributing/agents.md",
      "docs/contributing/ci.md",
      "docs/contributing/git-hooks.md",
      "docs/contributing/pr-checklist.md",
      "docs/contributing/production-tests.md",
      "docs/contributing/release-process.md",
      "docs/contributing/static-quality.md",
      "docs/contributing/testing.md",
      "docs/contributing/toolchain.md",
      "docs/getting-started.md",
      "docs/guides/first-use.md",
      "docs/guides/platforms.md",
      "docs/guides/recovery.md",
      "docs/index.md",
      "docs/updating.md",
      "eslint.config.mjs",
      "next.config.ts",
      "package.json",
      "playwright.config.ts",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "public/favicon.svg",
      "scripts/audit.cjs",
      "scripts/bootstrap.cjs",
      "scripts/ci/context.cjs",
      "scripts/core/args.cjs",
      "scripts/core/dependency-policy.cjs",
      "scripts/core/focused-run.cjs",
      "scripts/core/install-state.cjs",
      "scripts/core/json.cjs",
      "scripts/core/plugins.cjs",
      "scripts/core/process.cjs",
      "scripts/core/protected.cjs",
      "scripts/core/quality.cjs",
      "scripts/core/testing.cjs",
      "scripts/core/toolchain.cjs",
      "scripts/core/transaction.cjs",
      "scripts/dependencies.cjs",
      "scripts/development.cjs",
      "scripts/docs.cjs",
      "scripts/hooks/commit-msg.cjs",
      "scripts/hooks/completion.cjs",
      "scripts/hooks/entry.cjs",
      "scripts/hooks/guard.cjs",
      "scripts/hooks/install.cjs",
      "scripts/hooks/launch.sh",
      "scripts/hooks/mutex.cjs",
      "scripts/hooks/policy.cjs",
      "scripts/hooks/pre-commit.cjs",
      "scripts/hooks/pre-push.cjs",
      "scripts/hooks/recover-lock.cjs",
      "scripts/hooks/repo.cjs",
      "scripts/hooks/state.cjs",
      "scripts/release.cjs",
      "scripts/release/changelog.cjs",
      "scripts/release/metadata.cjs",
      "scripts/release/validate.cjs",
      "scripts/template/git.cjs",
      "scripts/template/inputs.cjs",
      "scripts/template/journal.cjs",
      "scripts/template/manifest.cjs",
      "scripts/template/preview.cjs",
      "scripts/template/pristine.cjs",
      "scripts/template/provenance.cjs",
      "scripts/template/recovery.cjs",
      "scripts/template/render.cjs",
      "scripts/template/state.cjs",
      "scripts/template/update.cjs",
      "scripts/testing/artifact.cjs",
      "scripts/testing/environment.cjs",
      "scripts/testing/fixtures.cjs",
      "scripts/testing/harness.cjs",
      "scripts/testing/network.cjs",
      "scripts/testing/owned.cjs",
      "scripts/testing/production.cjs",
      "scripts/testing/stage.cjs",
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
      "tests/contracts/agent-permissions.test.ts",
      "tests/contracts/coverage-policy.test.ts",
      "tests/contracts/documented-commands.test.ts",
      "tests/contracts/suite-classification.test.ts",
      "tests/e2e/boundaries.spec.ts",
      "tests/e2e/environment.spec.ts",
      "tests/e2e/pages.spec.ts",
      "tests/e2e/support.ts",
      "tests/fixtures/render/manifest.json",
      "tests/fixtures/render/root/.node-version",
      "tests/fixtures/render/template/dir/data.txt",
      "tests/fixtures/render/template/package.json",
      "tests/fixtures/render/template/run.sh",
      "tests/integration/artifact-compose.test.ts",
      "tests/integration/artifact-run.test.ts",
      "tests/integration/audit.test.ts",
      "tests/integration/bootstrap.test.ts",
      "tests/integration/ci-context.test.ts",
      "tests/integration/dependencies-cli.test.ts",
      "tests/integration/development-gates.test.ts",
      "tests/integration/executable-lookup.test.ts",
      "tests/integration/install-state.test.ts",
      "tests/integration/interruption.test.ts",
      "tests/integration/owned-process.test.ts",
      "tests/integration/permissions.test.ts",
      "tests/integration/process.test.ts",
      "tests/integration/production-scratch.test.ts",
      "tests/integration/release.test.ts",
      "tests/integration/transaction.test.ts",
      "tests/setup/app.ts",
      "tests/support/agent-declarations.ts",
      "tests/support/guard-repo.ts",
      "tests/support/json.ts",
      "tests/support/memory-disk.ts",
      "tests/support/memory-fs.ts",
      "tests/support/owned-processes.ts",
      "tests/support/production-host.ts",
      "tests/support/project.ts",
      "tests/support/release-fixture.ts",
      "tests/support/rollout.ts",
      "tests/support/update-model.ts",
      "tests/unit/audit.test.ts",
      "tests/unit/bootstrap.test.ts",
      "tests/unit/ci-context.test.ts",
      "tests/unit/commands.test.ts",
      "tests/unit/dependencies.test.ts",
      "tests/unit/dependency-policy.test.ts",
      "tests/unit/docs-version.test.ts",
      "tests/unit/gates.test.ts",
      "tests/unit/guard/commands.test.ts",
      "tests/unit/guard/completion-engine.test.ts",
      "tests/unit/guard/completion.test.ts",
      "tests/unit/guard/engine.test.ts",
      "tests/unit/guard/entry.test.ts",
      "tests/unit/guard/events.test.ts",
      "tests/unit/guard/mutex.test.ts",
      "tests/unit/guard/policy.test.ts",
      "tests/unit/guard/repo.test.ts",
      "tests/unit/guard/state.test.ts",
      "tests/unit/hooks/hooks.test.ts",
      "tests/unit/hooks/install.test.ts",
      "tests/unit/install-state.test.ts",
      "tests/unit/plugins.test.ts",
      "tests/unit/process.test.ts",
      "tests/unit/production/artifact.test.ts",
      "tests/unit/production/environment.test.ts",
      "tests/unit/production/fixtures.test.ts",
      "tests/unit/production/harness.test.ts",
      "tests/unit/production/network.test.ts",
      "tests/unit/production/owned.test.ts",
      "tests/unit/production/production.test.ts",
      "tests/unit/protected.test.ts",
      "tests/unit/quality.test.ts",
      "tests/unit/release.test.ts",
      "tests/unit/renderer.test.ts",
      "tests/unit/suppression-policy.test.ts",
      "tests/unit/template-git.test.ts",
      "tests/unit/template-journal.test.ts",
      "tests/unit/template-recovery.test.ts",
      "tests/unit/template-state.test.ts",
      "tests/unit/template-update.test.ts",
      "tests/unit/testing.test.ts",
      "tests/unit/toolchain.test.ts",
      "tests/unit/transaction.test.ts",
      "tooling/LICENSE",
      "tooling/NOTICE.md",
      "tooling/audit-policy.json",
      "tooling/capabilities.json",
      "tooling/eslint/shared.mjs",
      "tooling/eslint/suppression-policy.mjs",
      "tooling/hooks/commit-message.mjs",
      "tooling/hooks/staged.mjs",
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
      /^scripts\/template\/(?!(?:git|inputs|journal|manifest|preview|pristine|provenance|recovery|render|state|update)\.cjs$)/,
      /^tests\/(?:fixtures\/(?!render\/)|generator\/)|^tests\/integration\/(?!(?:artifact-compose|artifact-run|audit|bootstrap|ci-context|dependencies-cli|development-gates|executable-lookup|install-state|interruption|owned-process|permissions|process|production-scratch|release|transaction)\.test\.ts$)/,
      /^tests\/(?:unit\/generator-commands|contracts\/(?:rendered-output|toolchain|command-parity|agent-staging)|support\/rendered-app)/,
      /^tooling\/(?!project-role\.json$|policy\.json$|audit-policy\.json$|capabilities\.json$|LICENSE$|NOTICE\.md$|eslint\/(?:shared|suppression-policy)\.mjs$|hooks\/(?:staged|commit-message)\.mjs$|vitest\/suite\.ts$)/,
      /\.py$/,
      /pyproject|Makefile|copier|uv\.lock/i,
      /auth|prisma|drizzle|database|db\//i,
    ]) {
      for (const path of paths) expect(path, String(forbidden)).not.toMatch(forbidden);
    }
  });

  test("the guard runtime, host declarations and permission checks are in the render itself, not only in the generator seed", () => {
    const required = [
      ...["entry.cjs", "launch.sh", "guard.cjs", "completion.cjs", "recover-lock.cjs", "mutex.cjs", "policy.cjs", "repo.cjs", "state.cjs"].map(
        (file) => `scripts/hooks/${file}`,
      ),
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/settings.json",
      ".codex/config.toml",
      ".codex/hooks.json",
      ".codex/rules/publishing.rules",
      ".compound-engineering/config.yaml",
      ".compound-engineering/config.example.yaml",
      "compound-packs/README.md",
      "tests/contracts/agent-permissions.test.ts",
      "tests/integration/permissions.test.ts",
      "tests/support/agent-declarations.ts",
      "tests/support/guard-repo.ts",
      "tests/unit/guard/engine.test.ts",
    ];
    for (const path of required) expect(paths, path).toContain(path);
    // The settings are the application declarations, not the generator's own.
    expect(byPath(a, ".claude/settings.json")).toContain("scripts/hooks/launch.sh");
    expect(byPath(a, ".compound-engineering/config.yaml")).toBe(readFileSync(join(root, ".compound-engineering/config.yaml"), "utf8"));
    expect(byPath(a, ".compound-engineering/config.example.yaml")).toBe(readFileSync(join(root, ".compound-engineering/config.example.yaml"), "utf8"));
    expect(byPath(a, "compound-packs/README.md")).toBe(readFileSync(join(root, "compound-packs/README.md"), "utf8"));
    expect(JSON.parse(byPath(a, "tooling/capabilities.json"))).toEqual({ guard: true, hooks: true });
    expect(a.files.find((file) => file.path === "scripts/hooks/launch.sh")?.mode).toBe(0o755);
  });

  test("every application carries the full license notice and the source attribution of its derived tooling, whatever the answers", () => {
    const license = readFileSync(join(root, "LICENSE"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 justmumu");
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    const policy = parseJson<{ source: { revision: string; repository: string } }>(readFileSync(join(root, "tooling/upstream-policy.json"), "utf8"));
    for (const result of [a, b]) {
      expect(byPath(result, "tooling/LICENSE")).toBe(license);
      const notice = byPath(result, "tooling/NOTICE.md");
      expect(notice).toContain(policy.source.revision);
      expect(notice).toContain(policy.source.repository);
      expect(notice).toContain("Copyright (c) 2026 justmumu");
      expect(notice).not.toMatch(/first-owner|second-owner|first-app|second-app/);
    }
    expect(byPath(a, "README.md")).toContain("tooling/LICENSE");
  });

  test("emitted tests assume nothing the generator alone provides", () => {
    const tests = a.files.filter((file) => file.path.startsWith("tests/"));
    expect(tests.length).toBeGreaterThan(10);
    for (const file of tests) {
      expect(file.content.toString("utf8"), file.path).not.toMatch(
        /join\(root, "tooling\/versions|template-manifest|scripts\/template\/(?:create|initialize|transaction|seed|smoke|commands)\.cjs/,
      );
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
    expect(manifest.dependencies).toEqual(seed.dependencies);
    expect(manifest.devDependencies).toEqual(seed.devDependencies);
    expect(JSON.stringify(manifest)).not.toMatch(/workspace:|link:|file:|\.\.\//);
  });

  test("workspace file makes the app its own root and denies the reviewed builds only", () => {
    const workspace = byPath(a, "pnpm-workspace.yaml");
    expect(workspace).not.toMatch(/^packages:/m);
    expect(workspace).toContain(
      'overrides:\n  "vitepress@1.6.4>@docsearch/js": 3.9.0\n  "vitepress@1.6.4>@docsearch/css": 3.9.0\n  "form-data@<2.5.0": 2.5.6\n  "qs@<6.6.0": 6.16.1\n',
    );
    expect(workspace.match(/^overrides:/gm)).toHaveLength(1);
    expect(workspace.match(/^ {2}\S.*>.*$/gm)).toHaveLength(2);
    for (const name of versions.seed.deniedBuilds) expect(workspace).toContain(`${name}: false`);
    expect(workspace).not.toMatch(/allowBuilds:[\s\S]*: true|dangerouslyAllowAllBuilds/);
    expect(byPath(a, ".node-version")).toBe(readFileSync(join(root, ".node-version"), "utf8"));
    expect(byPath(a, ".node-version").trim()).toBe(versions.node);
  });

  test("lock is independent of the generator and of the personalization", () => {
    const lock = byPath(a, "pnpm-lock.yaml");
    expect(lock).toBe(byPath(b, "pnpm-lock.yaml"));
    expect(lock).not.toMatch(/workspace:|\blink:|first-app|second-app/);
    expect(lock).not.toMatch(/\/(?:home|tmp|Users)\//);
    expect(lock).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(lock).toBe(readFileSync(join(root, "template/app/pnpm-lock.yaml"), "utf8"));
  });

  test("no e-mail address or log file reaches the output", () => {
    for (const file of a.files) {
      // pnpm copies the maintainers' deprecation notices of third-party packages into the lock; they are not owner data.
      const text = file.path === "pnpm-lock.yaml" ? file.content.toString("utf8").replace(/^ +deprecated: .*$/gm, "") : file.content.toString("utf8");
      // The addresses the output may name: the generator's noreply identity for the pristine commits it makes, and the renderer test's rejected owner.
      const named = ["nextjs-dev-template@users.noreply.github.com", "me@example.com"].reduce((left, address) => left.replaceAll(address, ""), text);
      expect(named, file.path).not.toMatch(/[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z][A-Za-z0-9-]*)+/);
    }
    expect(paths.filter((path) => /\.log$|\.tsbuildinfo$/.test(path))).toEqual([]);
  });
});
