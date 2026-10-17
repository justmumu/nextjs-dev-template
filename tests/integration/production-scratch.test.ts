import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { scratchArea } from "../support/project.ts";

const require = createRequire(import.meta.url);
const harness = require("../../scripts/testing/harness.cjs") as typeof import("../../scripts/testing/harness.cjs");
const { stage } = require("../../scripts/testing/stage.cjs") as typeof import("../../scripts/testing/stage.cjs");
const { fixtureFiles, standaloneConfig } = require("../../scripts/testing/fixtures.cjs") as typeof import("../../scripts/testing/fixtures.cjs");

const scratch = scratchArea("production-stage-");

describe("scratch space", () => {
  test("a scratch directory is new, below the temporary directory, and removable", () => {
    const first = harness.scratchDirectory("harness-scratch-");
    const second = harness.scratchDirectory("harness-scratch-");
    try {
      expect(first).not.toBe(second);
      expect(dirname(first)).toBe(dirname(second));
      expect(basename(first)).toMatch(/^harness-scratch-/);
      expect(existsSync(first)).toBe(true);
    } finally {
      harness.removeDirectory(first);
      harness.removeDirectory(second);
    }
    expect(existsSync(first)).toBe(false);
    expect(() => {
      harness.removeDirectory(first);
    }).not.toThrow();
  });
});

const application = {
  "package.json": '{"name":"x"}',
  "pnpm-lock.yaml": "lock",
  "pnpm-workspace.yaml": "workspace",
  "tsconfig.json": "{}",
  ".node-version": "24.21.0\n",
  "next.config.ts": "const nextConfig = {\n  agentRules: false,\n  typedRoutes: true,\n};\n",
  "src/app/page.tsx": "page",
  "src/app/nested/deeper/file.css": "css",
  "public/favicon.svg": "<svg/>",
  // None of these may reach a fixture.
  ".env": "A=1",
  ".env.local": "NEXT_PUBLIC_LOCAL=sentinel",
  ".env.production.local": "B=2",
  ".next/cache/x": "build output",
  "node_modules/next/index.js": "dependency",
  "tests/app/home.test.tsx": "test",
  "coverage/lcov.info": "report",
  "next-env.d.ts": "generated",
};

function tree(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? tree(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

describe("staging a fixture", () => {
  const source = scratch.project(application);

  test("copies the application's own files and none of the checkout's local state", () => {
    const dest = scratch.project();
    stage({ source, dest, files: {} });
    expect(tree(dest).sort()).toEqual([
      ".node-version",
      "next.config.ts",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "public/favicon.svg",
      "src/app/nested/deeper/file.css",
      "src/app/page.tsx",
      "tsconfig.json",
    ]);
    expect(existsSync(join(dest, ".env.local"))).toBe(false);
  });

  test("writes fixture files after the copy and rewrites copied files by path", () => {
    const dest = scratch.project();
    stage({ source, dest, files: fixtureFiles("production"), transform: { "next.config.ts": standaloneConfig } });
    expect(readFileSync(join(dest, "next.config.ts"), "utf8")).toBe(
      'const nextConfig = {\n  agentRules: false,\n  typedRoutes: true,\n  output: "standalone",\n};\n',
    );
    expect(readFileSync(join(dest, "src/app/fixture/async/page.tsx"), "utf8")).toContain("Async server content");
    expect(readFileSync(join(source, "next.config.ts"), "utf8")).not.toContain("standalone");
    expect(existsSync(join(dest, ".env.local"))).toBe(false);
  });

  test("an application without optional files stages without them", () => {
    const small = scratch.project({ "package.json": "{}" });
    const dest = scratch.project();
    stage({ source: small, dest, files: {} });
    expect(tree(dest)).toEqual(["package.json"]);
  });

  test("keeps the mode of a copied executable", () => {
    const executable = scratch.project();
    writeFileSync(join(executable, "package.json"), "{}");
    chmodSync(join(executable, "package.json"), 0o755);
    const dest = scratch.project();
    stage({ source: executable, dest, files: {} });
    expect(readFileSync(join(dest, "package.json"), "utf8")).toBe("{}");
    expect(statSync(join(dest, "package.json")).mode & 0o777).toBe(0o755);
  });
});
