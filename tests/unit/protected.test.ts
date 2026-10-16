import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const guarded = createRequire(import.meta.url)("../../scripts/core/protected.cjs") as typeof import("../../scripts/core/protected.cjs");

describe("protected files", () => {
  test.each([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "AGENTS.md",
    "tsconfig.json",
    "tsconfig.tooling.json",
    "next.config.ts",
    "eslint.config.mjs",
    ".prettierrc.json",
    "vitest.config.ts",
    "vitest.app.config.ts",
    "vitest.infrastructure.config.mts",
    "playwright.config.ts",
    "scripts/anything/deep.cjs",
    "tooling/vitest/suite.ts",
    ".claude/settings.json",
    "docs/vitepress.config.ts",
    "docs/.vitepress/config.ts",
    "docs/.vitepress/config/nav.ts",
    "template/app/package.json",
    "template/app/vitest.config.ts",
  ])("%s defines rules or tooling", (path) => {
    expect(guarded.isProtectedFile(path)).toBe(true);
  });

  test.each([
    "README.md",
    "src/app/page.tsx",
    "tests/unit/x.test.ts",
    "tests/app/page.test.tsx",
    "docs/guide.md",
    "docs/.vitepress/theme/index.ts",
    "docs/sub/site.config.ts",
    "template/app/src/app/page.tsx",
    "vitest.setup.ts",
    "vitest.Bad.config.ts",
  ])("%s is ordinary source", (path) => {
    expect(guarded.isProtectedFile(path)).toBe(false);
  });

  test("a configuration copy below the root is a shadow override, except in the seed and fixtures", () => {
    expect(guarded.isShadowOverride("src/eslint.config.mjs")).toBe(true);
    expect(guarded.isShadowOverride("packages/a/vitest.app.config.ts")).toBe(true);
    expect(guarded.isShadowOverride("src/.npmrc")).toBe(true);
    expect(guarded.isShadowOverride("eslint.config.mjs")).toBe(false);
    expect(guarded.isShadowOverride("template/app/eslint.config.mjs")).toBe(false);
    expect(guarded.isShadowOverride("tests/fixtures/x/vitest.config.ts")).toBe(false);
    expect(guarded.isShadowOverride("src/app/page.tsx")).toBe(false);
  });

  test("dependency trees and build output are never scanned", () => {
    for (const name of ["node_modules", ".git", ".next", "coverage", "playwright-report"]) expect(guarded.isSkippedDir(name)).toBe(true);
    for (const name of ["src", "tests", "scripts"]) expect(guarded.isSkippedDir(name)).toBe(false);
    expect(guarded.isSkippedDir("dist", "scripts")).toBe(false);
    expect(guarded.isSkippedDir("dist", "src")).toBe(true);
    expect(guarded.DIRS).toContain("tooling");
    expect(guarded.FILES).toContain("package.json");
  });
});
