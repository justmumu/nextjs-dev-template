import { existsSync, globSync, readFileSync } from "node:fs";
import { join, matchesGlob, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { suiteConfig } from "../../tooling/vitest/suite.ts";
import { parseJson, type Manifest } from "../support/json.ts";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const testing = require("../../scripts/core/testing.cjs") as typeof import("../../scripts/core/testing.cjs");
const toolchain = require("../../scripts/core/toolchain.cjs") as typeof import("../../scripts/core/toolchain.cjs");

const role = toolchain.readRole(root);
const suites = testing.suitesFor(role);
const measured = testing.coverageSuitesFor(role);
const files = (patterns: string[]) => patterns.flatMap((pattern) => globSync(pattern, { cwd: root })).sort();
/** The files of a measured suite's scope as Vitest counts them: its include globs, less its configured exclusions. */
const eligibleFiles = (name: string) => {
  const exclude = suiteConfig(name).test?.coverage?.exclude ?? [];
  return files(testing.SUITES[name]?.coverage?.include ?? []).filter((path) => !exclude.some((pattern) => matchesGlob(path, pattern)));
};

describe("every suite of the project has its configuration", () => {
  test.each(suites)("%s is a project of vitest.config.ts with a configuration of its own", (name) => {
    expect(existsSync(join(root, `vitest.${name}.config.ts`))).toBe(true);
    expect(readFileSync(join(root, "vitest.config.ts"), "utf8")).toContain(`"vitest.${name}.config.ts"`);
  });

  test("nothing is configured that the project does not run", () => {
    const projects = [...readFileSync(join(root, "vitest.config.ts"), "utf8").matchAll(/"(vitest\.[a-z]+\.config\.ts)"/g)].map((match) => match[1]);
    expect(projects.sort()).toEqual(suites.map((name) => `vitest.${name}.config.ts`).sort());
  });

  test("the browser-like suite runs in jsdom and every other suite in Node", () => {
    for (const name of suites) expect(suiteConfig(name).test?.environment, name).toBe(name === "app" ? "jsdom" : "node");
  });
});

describe("every measured suite is held to its own bar", () => {
  test.each(measured)("%s requires 80% of lines, branches, functions and statements, each on its own", (name) => {
    const coverage = suiteConfig(name).test?.coverage;
    expect(coverage?.provider).toBe("v8");
    expect(coverage?.thresholds).toEqual({ lines: 80, branches: 80, functions: 80, statements: 80 });
    expect(coverage?.reporter).toEqual(expect.arrayContaining(["text", "json-summary"]));
    expect(coverage?.reportsDirectory).toBe(`coverage/${name}`);
  });

  test("the reports of different suites never share a directory", () => {
    const directories = measured.map((name) => suiteConfig(name).test?.coverage?.reportsDirectory);
    expect(new Set(directories).size).toBe(measured.length);
  });

  test("the coverage provider and the runner are the same release", () => {
    const manifest = parseJson<Manifest>(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.devDependencies?.["@vitest/coverage-v8"]).toBe(manifest.devDependencies?.["vitest"]);
  });
});

describe("coverage scopes are explicit, non-empty and disjoint", () => {
  test.each(measured)("%s counts every eligible file whether or not a test imports it", (name) => {
    const scope = testing.SUITES[name]?.coverage;
    const eligible = eligibleFiles(name);
    expect(eligible.length).toBeGreaterThan(0);
    expect(suiteConfig(name).test?.coverage?.include).toEqual(scope?.include);
    if (name === "infrastructure")
      expect(eligible).toEqual(expect.arrayContaining(globSync("scripts/*.cjs", { cwd: root }).concat(globSync("scripts/core/*.cjs", { cwd: root }))));
    if (name === "app")
      expect(eligible).toEqual(expect.arrayContaining(["src/app/page.tsx", "src/app/layout.tsx", "src/app/not-found.tsx", "src/app/error.tsx"]));
  });

  test("no file is measured by two suites, and no test, declaration or generated file is measured", () => {
    const all = measured.flatMap(eligibleFiles);
    expect(new Set(all).size).toBe(all.length);
    for (const file of all) expect(file, file).not.toMatch(/\.test\.tsx?$|\.spec\.tsx?$|\.d\.ts$|^tests\/|^\.next\/|^coverage\//);
  });

  test.each(measured)("%s leaves out a test, a declaration and generated output wherever they sit", (name) => {
    const exclude = suiteConfig(name).test?.coverage?.exclude ?? [];
    for (const path of [
      "src/a.test.ts",
      "src/deep/b.test.tsx",
      "src/c.spec.ts",
      "src/types/env.d.ts",
      "src/__tests__/d.ts",
      ".next/types/x.ts",
      "coverage/app/lcov.ts",
    ]) {
      expect(
        exclude.some((pattern) => matchesGlob(path, pattern)),
        path,
      ).toBe(true);
    }
    for (const path of ["src/app/page.tsx", "src/lib/util.ts", "scripts/core/args.cjs"]) {
      expect(
        exclude.some((pattern) => matchesGlob(path, pattern)),
        path,
      ).toBe(false);
    }
  });

  test("exclusions are exact files backed by a build or end-to-end proof, never a directory", () => {
    for (const name of measured) {
      const suite = testing.SUITES[name];
      expect(suite && testing.exclusionErrors(suite, (path) => existsSync(join(root, path))), name).toEqual([]);
      const exclude = suiteConfig(name).test?.coverage?.exclude ?? [];
      for (const pattern of exclude) {
        if (pattern === "src/app" || /^src\/(?:app\/)?\*\*/.test(pattern)) throw new Error(`${name} excludes the whole application: ${pattern}`);
      }
    }
  });
});

describe("test selection", () => {
  const tests = globSync("tests/**/*.test.{ts,tsx}", { cwd: root })
    .filter((path) => !path.startsWith("tests/fixtures/"))
    .sort();

  test("every test file belongs to exactly one suite of the project, so none is silently unrun", () => {
    expect(tests.length).toBeGreaterThan(0);
    for (const path of tests) expect(testing.suiteOf(role, path), path).not.toBeNull();
  });

  test("the default unit suites select no integration test", () => {
    for (const name of measured) {
      const suite = testing.SUITES[name];
      const selected = files(suite ? testing.includeGlobs(suite) : []);
      expect(selected.length, name).toBeGreaterThan(0);
      expect(
        selected.filter((path) => path.startsWith("tests/integration/")),
        name,
      ).toEqual([]);
      expect(selected.every((path) => testing.suiteOf(role, path) === name)).toBe(true);
    }
  });

  test("the configured include globs are the registry's", () => {
    for (const name of suites) {
      const suite = testing.SUITES[name];
      expect(suiteConfig(name).test?.include).toEqual(suite && testing.includeGlobs(suite));
    }
  });
});
