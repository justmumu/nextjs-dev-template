import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, test } from "vitest";
import { output, removeDir, root, run, scratchDir, writeProjectFile } from "../support/rendered-app.ts";

// Real Vitest and the real dispatcher on the generator: what each suite actually selects, and what
// the focused-test command accepts and refuses.

const testing = createRequire(import.meta.url)("../../scripts/core/testing.cjs") as typeof import("../../scripts/core/testing.cjs");
const vitest = join(root, "node_modules/vitest/vitest.mjs");

/** The files Vitest itself selects for one project of the root configuration. */
function selected(project: string): string[] {
  const result = run(root, process.execPath, [vitest, "list", "--filesOnly", "--project", project]);
  expect(result.status, output(result)).toBe(0);
  return result.stdout
    .split("\n")
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter((line) => line.endsWith(".test.ts") || line.endsWith(".test.tsx"))
    .sort();
}

const tracked = (prefix: string) =>
  run(root, "git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", prefix])
    .stdout.split("\n")
    .filter((path) => /\.test\.tsx?$/.test(path))
    .sort();

describe("default unit selection", () => {
  const infrastructure = selected("infrastructure");
  const integration = selected("integration");

  test("selects the unit and contract tests and no integration test", () => {
    expect(infrastructure.length).toBeGreaterThan(10);
    expect(infrastructure.filter((path) => path.startsWith("tests/integration/"))).toEqual([]);
    expect(infrastructure).toEqual([...tracked("tests/unit"), ...tracked("tests/contracts")].sort());
  });

  test("the integration project selects exactly the integration tests", () => {
    expect(integration).toEqual(tracked("tests/integration"));
    expect(integration.filter((path) => infrastructure.includes(path))).toEqual([]);
  });

  test("every integration test file is a scenario of test:integration, and nothing else is", () => {
    const result = run(root, "pnpm", ["run", "test:integration", "--scenario=nope"]);
    expect(result.status).toBe(2);
    const offered = /--scenario must be one of: (.+)/.exec(output(result))?.[1]?.split(", ").sort();
    expect(offered).toEqual(integration.map((path) => path.replace(/^tests\/integration\/|\.test\.ts$/g, "")).sort());
  });
});

describe("focused test command on the generator", () => {
  const pnpm = (...args: string[]) => run(root, "pnpm", ["run", "test:one", ...args]);

  test("runs exactly the named file in its own suite", () => {
    const result = pnpm("--test=tests/unit/testing.test.ts");
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain("tests/unit/testing.test.ts");
    expect(output(result)).toMatch(/Test Files\s+1 passed \(1\)/);
  });

  test("a literal test name selects only that test, with its metacharacters taken literally", () => {
    const result = pnpm("--test=tests/unit/testing.test.ts", "--name=a scope without any branch is still a measured scope");
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toMatch(/Tests\s+1 passed \| \d+ skipped/);
    const regexLike = pnpm("--test=tests/unit/testing.test.ts", "--name=.*");
    expect(output(regexLike)).not.toMatch(/Tests\s+\d+ passed/);
  });

  test.each([
    ["a path that does not exist", ["--test=tests/unit/missing.test.ts"]],
    ["a tsx test in a project that has no tsx suite", ["--test=tests/app/home.test.tsx"]],
    ["a file outside every suite", ["--test=tests/support/json.ts"]],
    ["a file outside tests/", ["--test=package.json"]],
    ["a suite that does not exist", ["--test=tests/unit/testing.test.ts", "--suite=nope"]],
    ["a suite the file does not belong to", ["--test=tests/unit/testing.test.ts", "--suite=integration"]],
    ["a runner flag", ["--test=tests/unit/testing.test.ts", "--coverage=true"]],
  ])("refuses %s without starting Vitest", (_label, args) => {
    const result = pnpm(...args);
    expect(result.status).toBe(2);
    expect(output(result)).not.toMatch(/RUN\s+v\d|Test Files/);
  });

  test("an integration file is run through its own suite", () => {
    expect(testing.suiteOf("generator", "tests/integration/no-python.test.ts")).toBe("integration");
    const result = pnpm("--test=tests/integration/no-python.test.ts", "--suite=integration");
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toMatch(/Test Files\s+1 passed \(1\)/);
  });
});

describe("focused test command with lookalikes", () => {
  const scratch = scratchDir("focused-");
  afterAll(() => {
    removeDir(scratch);
  });

  /** A generator-shaped project with the real dispatcher and Vitest configuration, and trivial tests. */
  function project(files: Record<string, string>): string {
    const dir = join(scratch, `p${String(readdirSync(scratch).length)}`);
    mkdirSync(dir);
    cpSync(join(root, "node_modules"), join(dir, "node_modules"), { recursive: true, verbatimSymlinks: true });
    for (const path of [
      "package.json",
      "tsconfig.json",
      "vitest.config.ts",
      "vitest.infrastructure.config.ts",
      "vitest.integration.config.ts",
      "scripts",
      "tooling",
    ]) {
      cpSync(join(root, path), join(dir, path), { recursive: true });
    }
    for (const [path, content] of Object.entries(files)) writeProjectFile(dir, path, content);
    return dir;
  }
  const passing = (name: string) => `import { test } from "vitest";\ntest(${JSON.stringify(name)}, () => undefined);\n`;
  const focused = (dir: string, ...args: string[]) =>
    run(dir, process.execPath, [
      "-e",
      'process.exitCode = require("./scripts/development.cjs").main(["test:one", ...process.argv.slice(1)], { skipPreflight: true });',
      "--",
      ...args,
    ]);

  const lookalikeLoaded = 'import { writeFileSync } from "node:fs";\nwriteFileSync("lookalike-loaded", "");\nthrow new Error("the lookalike was loaded");\n';

  test("a file whose path another file contains runs alone: the lookalike is neither run nor loaded", () => {
    const dir = project({
      "tests/unit/a.test.ts": passing("the named file"),
      "tests/unit/nested/tests/unit/a.test.ts": lookalikeLoaded,
      "tests/unit/nested/deeper/tests/unit/a.test.ts": lookalikeLoaded,
    });
    const result = focused(dir, "--test=tests/unit/a.test.ts");
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toMatch(/Test Files\s+1 passed \(1\)/);
    expect(existsSync(join(dir, "lookalike-loaded"))).toBe(false);
  });

  test("the nested lookalike can itself be named, and then runs alone", () => {
    const dir = project({
      "tests/unit/a.test.ts": lookalikeLoaded,
      "tests/unit/nested/tests/unit/a.test.ts": passing("the nested file"),
    });
    const result = focused(dir, "--test=tests/unit/nested/tests/unit/a.test.ts");
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toMatch(/Test Files\s+1 passed \(1\)/);
    expect(existsSync(join(dir, "lookalike-loaded"))).toBe(false);
  });

  test("a path with spaces and glob or regular-expression characters is taken literally", () => {
    const awkward = "tests/unit/we ird [x] (1) +.test.ts";
    const dir = project({ [awkward]: passing("the awkward file"), "tests/unit/we ird x 1.test.ts": lookalikeLoaded });
    const result = focused(dir, `--test=${awkward}`);
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toMatch(/Test Files\s+1 passed \(1\)/);
    expect(existsSync(join(dir, "lookalike-loaded"))).toBe(false);
  });

  test("a failing test in the named file fails the command", () => {
    const failing = 'import { expect, test } from "vitest";\ntest("broken", () => {\n  expect(1).toBe(2);\n});\n';
    const dir = project({ "tests/unit/a.test.ts": failing });
    const result = focused(dir, "--test=tests/unit/a.test.ts");
    expect(result.status, output(result)).toBe(1);
    expect(output(result)).toMatch(/Tests\s+1 failed/);
  });

  test("the same file runs without its siblings", () => {
    const dir = project({ "tests/unit/a.test.ts": passing("the named file"), "tests/unit/b.test.ts": passing("another file") });
    const result = focused(dir, "--test=tests/unit/a.test.ts");
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toMatch(/Test Files\s+1 passed \(1\)/);
    expect(output(result)).not.toMatch(/another file/);
  });

  test("a test name that matches nothing is not reported as a pass with every test skipped", () => {
    const dir = project({ "tests/unit/a.test.ts": passing("the named file") });
    const unmatched = focused(dir, "--test=tests/unit/a.test.ts", "--name=no such test");
    expect(unmatched.status, output(unmatched)).toBe(2);
    expect(output(unmatched)).toMatch(/no test has the name "no such test" in tests\/unit\/a\.test\.ts/);
    const matched = focused(dir, "--test=tests/unit/a.test.ts", "--name=the named file");
    expect(matched.status, output(matched)).toBe(0);
    expect(output(matched)).toMatch(/Tests\s+1 passed \(1\)/);
  });
});
