import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const testing = createRequire(import.meta.url)("../../scripts/core/testing.cjs") as typeof import("../../scripts/core/testing.cjs");

describe("suite registry", () => {
  test("each role runs the suites it owns and measures coverage for the ones with a scope", () => {
    expect(testing.suitesFor("generator")).toEqual(["infrastructure", "integration"]);
    expect(testing.suitesFor("application")).toEqual(["infrastructure", "app", "integration"]);
    expect(testing.coverageSuitesFor("generator")).toEqual(["infrastructure"]);
    expect(testing.coverageSuitesFor("application")).toEqual(["infrastructure", "app"]);
  });

  test("a test file belongs to the suite whose directory and extension select it", () => {
    expect(testing.suiteOf("generator", "tests/unit/a.test.ts")).toBe("infrastructure");
    expect(testing.suiteOf("generator", "tests/contracts/a.test.ts")).toBe("infrastructure");
    expect(testing.suiteOf("generator", "tests/integration/a.test.ts")).toBe("integration");
    expect(testing.suiteOf("application", "tests/app/a.test.tsx")).toBe("app");
    expect(testing.suiteOf("application", "tests/app/deep/a.test.ts")).toBe("app");
  });

  test("anything the suites do not select is no test file", () => {
    expect(testing.suiteOf("generator", "tests/app/a.test.tsx")).toBeNull();
    expect(testing.suiteOf("application", "tests/integration/a.test.tsx")).toBeNull();
    expect(testing.suiteOf("generator", "tests/unit/a.test.tsx")).toBeNull();
    expect(testing.suiteOf("generator", "tests/unit/helper.ts")).toBeNull();
    expect(testing.suiteOf("generator", "tests/unitx/a.test.ts")).toBeNull();
    expect(testing.suiteOf("generator", "src/a.test.ts")).toBeNull();
  });

  test("include globs are derived from the same directories and extensions", () => {
    const app = testing.SUITES.app;
    const infrastructure = testing.SUITES.infrastructure;
    expect(app && testing.includeGlobs(app)).toEqual(["tests/app/**/*.test.ts", "tests/app/**/*.test.tsx"]);
    expect(infrastructure && testing.includeGlobs(infrastructure)).toEqual(["tests/unit/**/*.test.ts", "tests/contracts/**/*.test.ts"]);
    expect(testing.reportDirectory("app")).toBe("coverage/app");
  });

  test("every measured scope has all four metrics held at the same bar", () => {
    expect(testing.METRICS).toEqual(["lines", "branches", "functions", "statements"]);
    expect(testing.THRESHOLD).toBe(80);
  });
});

describe("framework exclusions", () => {
  const suite = (exclusions: { file: string; reason: string; proof: string }[]) => ({
    environment: "jsdom" as const,
    roles: ["application" as const],
    tests: [],
    timeout: 1,
    coverage: { include: ["src/**/*.ts"], exclusions },
  });
  const present = new Set(["src/app/special.tsx", "tests/e2e/special.spec.ts", "tests/integration/build.test.ts"]);
  const exists = (path: string) => present.has(path);
  const reason = "async server component that Vitest cannot render";

  test("none is the normal case", () => {
    expect(testing.exclusionErrors(suite([]), exists)).toEqual([]);
    expect(testing.exclusionErrors({ ...suite([]), coverage: null }, exists)).toEqual([]);
  });

  test("one existing file with a reason and an end-to-end or build proof is accepted", () => {
    expect(testing.exclusionErrors(suite([{ file: "src/app/special.tsx", reason, proof: "tests/e2e/special.spec.ts" }]), exists)).toEqual([]);
    expect(testing.exclusionErrors(suite([{ file: "src/app/special.tsx", reason, proof: "tests/integration/build.test.ts" }]), exists)).toEqual([]);
  });

  test.each(["src/app/**", "src/app", "src/**/*.tsx", "src/app/{a,b}.tsx", "src/app/missing.tsx"])("%s is not one existing source file", (file) => {
    const errors = testing.exclusionErrors(suite([{ file, reason, proof: "tests/e2e/special.spec.ts" }]), exists);
    expect(errors.join()).toMatch(/must name one existing source file/);
  });

  test("a missing reason or a missing, unrelated or non-test proof is refused", () => {
    expect(testing.exclusionErrors(suite([{ file: "src/app/special.tsx", reason: "async", proof: "tests/e2e/special.spec.ts" }]), exists).join()).toMatch(
      /reason/,
    );
    for (const proof of ["", "tests/e2e/missing.spec.ts", "tests/unit/special.test.ts", "src/app/special.tsx", "README.md"]) {
      expect(testing.exclusionErrors(suite([{ file: "src/app/special.tsx", reason, proof }]), exists).join(), proof).toMatch(/proof/);
    }
  });
});

describe("coverage summary", () => {
  const metric = { total: 10, covered: 9, skipped: 0, pct: 90 };
  const total = { lines: metric, branches: metric, functions: metric, statements: metric };

  test("a summary with measured files is accepted", () => {
    expect(testing.summaryErrors({ total, "/p/scripts/a.cjs": total })).toEqual([]);
  });

  test("a scope without any branch is still a measured scope", () => {
    expect(testing.summaryErrors({ total: { ...total, branches: { ...metric, total: 0 } }, "/p/a.cjs": total })).toEqual([]);
  });

  test("a missing, empty or unmeasured scope never passes silently", () => {
    expect(testing.summaryErrors(null)).toEqual(["the coverage summary is missing or unreadable"]);
    expect(testing.summaryErrors([])).toEqual(["the coverage summary is missing or unreadable"]);
    expect(testing.summaryErrors({ total })).toEqual(["the coverage scope matched no source files"]);
    expect(testing.summaryErrors({ total: { ...total, statements: { ...metric, total: 0 } }, "/p/a.cjs": total })).toEqual([
      "the coverage scope measured no statements",
    ]);
    expect(testing.summaryErrors({ total: {}, "/p/a.cjs": total })).toEqual(["the coverage scope measured no lines"]);
  });
});
