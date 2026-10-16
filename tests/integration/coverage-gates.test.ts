import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installRenderedApp, output, removeDir, run, runUnitGate, scratchDir, writeProjectFile } from "../support/rendered-app.ts";

// A really installed rendered application runs its canonical gates. Coverage thresholds belong to
// each suite on its own: a shortfall in one suite fails the gate although the other is above the bar.

const scratch = scratchDir("coverage-gates-");
afterAll(() => {
  removeDir(scratch);
});

let app = "";
beforeAll(() => {
  app = installRenderedApp(scratch, "coverage-app");
}, 240_000);

const pnpm = (...args: string[]) => run(app, "pnpm", ["run", ...args]);
const summary = (suite: string) => JSON.parse(readFileSync(join(app, "coverage", suite, "coverage-summary.json"), "utf8")) as Record<string, unknown>;
const METRICS = ["lines", "branches", "functions", "statements"] as const;
/** The measured percentage of one metric of a suite's report. */
const measured = (suite: string, metric: (typeof METRICS)[number]) => (summary(suite)["total"] as Record<string, { pct: number }>)[metric]?.pct ?? Number.NaN;
/** The metrics Vitest reported below the threshold, with the percentage it printed. */
function belowThreshold(text: string): Record<string, number> {
  return Object.fromEntries(
    [...text.matchAll(/ERROR: Coverage for (\w+) \((\d+(?:\.\d+)?)%\) does not meet global threshold \(80%\)/g)].map((match) => [
      match[1] ?? "",
      Number(match[2]),
    ]),
  );
}
/** The suite whose coverage the failure messages describe: each suite's own measured percentages must equal them. */
function failingSuites(text: string): string[] {
  const reported = belowThreshold(text);
  return ["infrastructure", "app"].filter(
    (suite) =>
      Object.entries(reported).length > 0 && Object.entries(reported).every(([metric, pct]) => measured(suite, metric as (typeof METRICS)[number]) === pct),
  );
}

const BRANCHY = `export function describeNumber(value: number): string {
  if (value < 0) {
    return "negative";
  }
  if (value === 0) {
    return "zero";
  }
  if (value < 10) {
    return "small";
  }
  return "large";
}
`;

// Two hundred unimported functions: far more uncovered code than the retained infrastructure has margin for.
const BRANCHY_SCRIPT = `"use strict";\n${Array.from({ length: 200 }, (_, index) => `function f${String(index)}(value) {\n  if (value) {\n    return ${String(index)};\n  }\n  return 0;\n}\n`).join("")}module.exports = {};\n`;

describe("the unmodified application", () => {
  test("passes every canonical gate, measuring the application and the infrastructure separately", () => {
    const result = pnpm("check");
    expect(result.status, output(result)).toBe(0);
    for (const gate of ["lock", "format", "lint", "typecheck", "unit"]) expect(result.stdout).toContain(`${gate}: ok`);
    expect(result.stdout).toMatch(/unit: infrastructure[\s\S]*unit: app/);
    expect(Object.keys(summary("app")).map((path) => path.replace(app, "."))).toEqual(
      expect.arrayContaining(["./src/app/page.tsx", "./src/app/layout.tsx", "./src/app/not-found.tsx", "./src/app/error.tsx"]),
    );
    expect(Object.keys(summary("infrastructure")).some((path) => path.endsWith("scripts/bootstrap.cjs"))).toBe(true);
    expect(Object.keys(summary("infrastructure")).some((path) => path.includes("/src/"))).toBe(false);
  }, 240_000);

  test("the page, not-found and error tests run in the real jsdom project through the focused command", () => {
    for (const file of ["home", "layout", "not-found", "error"]) {
      const result = pnpm("test:one", `--test=tests/app/${file}.test.tsx`);
      expect(result.status, `${file}\n${output(result)}`).toBe(0);
      expect(output(result)).toMatch(/Test Files\s+1 passed \(1\)/);
    }
    const named = pnpm("test:one", "--test=tests/app/error.test.tsx", "--suite=app", "--name=tries again exactly once per click through the reset callback");
    expect(output(named)).toMatch(/Tests\s+1 passed \| 2 skipped/);
  }, 120_000);

  test("the focused command refuses a file in the wrong suite or outside every suite", () => {
    for (const args of [
      ["--test=tests/app/home.test.tsx", "--suite=infrastructure"],
      ["--test=tests/unit/commands.test.ts", "--suite=app"],
      ["--test=tests/app/missing.test.tsx"],
      ["--test=tests/integration/no-python.test.ts"],
      ["--test=tests/setup/app.ts"],
    ]) {
      const result = pnpm("test:one", ...args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(output(result)).not.toMatch(/Test Files/);
    }
  });
});

describe("the focused command when two test files share a name", () => {
  test("a.test.ts beside a.test.tsx runs alone, whichever of the two is named, and the other is never loaded", () => {
    const passing = (name: string) => `import { expect, test } from "vitest";\n\ntest(${JSON.stringify(name)}, () => {\n  expect(1).toBe(1);\n});\n`;
    const lookalike = 'throw new Error("the lookalike was loaded");\n';
    try {
      for (const [named, other] of [
        ["tests/app/pair.test.ts", "tests/app/pair.test.tsx"],
        ["tests/app/pair.test.tsx", "tests/app/pair.test.ts"],
      ] as const) {
        writeProjectFile(app, named, passing("plain"));
        writeProjectFile(app, other, lookalike);
        const result = pnpm("test:one", `--test=${named}`);
        expect(result.status, output(result)).toBe(0);
        expect(output(result)).toMatch(/Test Files\s+1 passed \(1\)/);
        expect(output(result)).not.toMatch(/lookalike was loaded/);
        rmSync(join(app, named), { force: true });
        rmSync(join(app, other), { force: true });
      }
    } finally {
      rmSync(join(app, "tests/app/pair.test.ts"), { force: true });
      rmSync(join(app, "tests/app/pair.test.tsx"), { force: true });
    }
  });

  test("a test name that matches nothing fails instead of passing with everything skipped", () => {
    const result = pnpm("test:one", "--test=tests/app/error.test.tsx", "--name=no such test");
    expect(result.status, output(result)).toBe(2);
    expect(output(result)).toMatch(/no test has the name "no such test" in tests\/app\/error\.test\.tsx/);
  });
});

describe("coverage of a file no test imports", () => {
  const unimported = "src/lib/describe-number.ts";

  test("an eligible application file lowers the application coverage and fails the gate, although the infrastructure is above the bar", () => {
    writeProjectFile(app, unimported, BRANCHY);
    try {
      expect(pnpm("format").status).toBe(0);
      const result = pnpm("check");
      const text = output(result);
      expect(result.status).toBe(1);
      for (const gate of ["lock", "format", "lint", "typecheck"]) expect(result.stdout).toContain(`${gate}: ok`);
      expect(text).toMatch(/check failed: unit\n/);
      expect(failingSuites(text)).toEqual(["app"]);
      for (const metric of METRICS) expect(measured("infrastructure", metric)).toBeGreaterThanOrEqual(80);
      expect(Object.keys(belowThreshold(text)).length).toBeGreaterThan(0);
      const files = summary("app");
      const entry = files[join(app, unimported)] as { lines: { pct: number; total: number } } | undefined;
      expect(entry?.lines.total).toBeGreaterThan(0);
      expect(entry?.lines.pct).toBe(0);
    } finally {
      rmSync(join(app, "src/lib"), { recursive: true, force: true });
    }
  }, 240_000);

  test("an eligible shipped script lowers the infrastructure coverage and fails the gate, although the application is above the bar", () => {
    const script = "scripts/core/unimported-functions.cjs";
    writeProjectFile(app, script, BRANCHY_SCRIPT);
    try {
      const result = runUnitGate(app);
      const text = output(result);
      expect(result.status, text).toBe(1);
      expect(failingSuites(text)).toEqual(["infrastructure"]);
      for (const metric of METRICS) expect(measured("app", metric)).toBeGreaterThanOrEqual(80);
      expect(Object.keys(summary("infrastructure")).some((path) => path.endsWith(script))).toBe(true);
    } finally {
      rmSync(join(app, script), { force: true });
    }
  }, 240_000);
});

describe("files that are not product code", () => {
  const declaration = "src/types/global.d.ts";
  const colocated = "src/lib/colocated.test.tsx";

  test("a declaration file and a test beside the source neither fail the coverage contract nor enter the measured scope", () => {
    writeProjectFile(app, declaration, "declare const __BUILD_ID__: string;\nexport {};\n");
    writeProjectFile(app, colocated, 'import { expect, test } from "vitest";\n\ntest("colocated", () => {\n  expect(1).toBe(1);\n});\n');
    try {
      const contract = pnpm("test:one", "--test=tests/contracts/coverage-policy.test.ts");
      expect(contract.status, output(contract)).toBe(0);
      const result = runUnitGate(app);
      expect(result.status, output(result)).toBe(0);
      const measuredFiles = Object.keys(summary("app"));
      expect(measuredFiles.some((path) => path.endsWith("global.d.ts") || path.endsWith("colocated.test.tsx"))).toBe(false);
      expect(measuredFiles.some((path) => path.endsWith("src/app/page.tsx"))).toBe(true);
    } finally {
      rmSync(join(app, "src/types"), { recursive: true, force: true });
      rmSync(join(app, "src/lib"), { recursive: true, force: true });
    }
  }, 240_000);
});

describe("an empty coverage scope", () => {
  test("is not a silent pass: Vitest itself accepts it, the gate does not", () => {
    const registry = join(app, "scripts/core/testing.cjs");
    const original = readFileSync(registry, "utf8");
    writeProjectFile(app, "scripts/core/testing.cjs", original.replace('include: ["src/**/*.{ts,tsx}"]', 'include: ["nothing-here/**/*.ts"]'));
    try {
      const result = runUnitGate(app);
      const text = output(result);
      expect(text).toMatch(/Statements\s+: Unknown%/);
      expect(result.status).toBe(1);
      expect(text).toMatch(/unit: app: the coverage scope matched no source files/);
    } finally {
      writeProjectFile(app, "scripts/core/testing.cjs", original);
    }
    expect(existsSync(join(app, "coverage"))).toBe(true);
  }, 240_000);
});
