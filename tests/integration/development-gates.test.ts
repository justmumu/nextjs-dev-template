import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture, roleFiles, scratchArea } from "../support/project.ts";

const development = createRequire(import.meta.url)("../../scripts/development.cjs") as typeof import("../../scripts/development.cjs");
const scratch = scratchArea("gates-");

// A project whose tool packages are tiny executables that record their arguments in tool.log. What is
// under test is the dispatcher: which tools run, in which order, with what, and what it makes of
// their results. The tools themselves are exercised for real by the integration suites.
const TOOL = `const fs = require("node:fs");
const [, , ...args] = process.argv;
const name = process.env.U5_TOOL ?? "";
const suite = /vitest\\.(\\w+)\\.config\\.ts/.exec(args.join(" "))?.[1] ?? "";
fs.appendFileSync("tool.log", name + (suite ? "[" + suite + "]" : "") + " " + args.join(" ") + "\\n");
if (fs.existsSync("summary-" + suite + ".json") && args.includes("--coverage")) {
  fs.mkdirSync("coverage/" + suite, { recursive: true });
  fs.copyFileSync("summary-" + suite + ".json", "coverage/" + suite + "/coverage-summary.json");
}
process.exitCode = fs.existsSync("fail-" + name + suite) ? 1 : 0;
`;

function toolProject(role: "generator" | "application", extra: Record<string, string> = {}) {
  const files: Record<string, string> = { ...roleFiles(role), "tool.cjs": TOOL, ...extra };
  for (const [pkg, bin] of [
    ["vitest", "vitest"],
    ["prettier", "prettier"],
    ["eslint", "eslint"],
    ["typescript", "tsc"],
    ["next", "next"],
  ] as const) {
    files[`node_modules/${pkg}/package.json`] = JSON.stringify({ name: pkg, bin: { [bin]: "bin.cjs" } });
    files[`node_modules/${pkg}/bin.cjs`] = `process.env.U5_TOOL = ${JSON.stringify(bin)}; process.chdir("__ROOT__"); require("__ROOT__/tool.cjs");`;
  }
  const root = scratch.project(files);
  for (const pkg of ["vitest", "prettier", "eslint", "typescript", "next"]) {
    const bin = join(root, "node_modules", pkg, "bin.cjs");
    writeFileSync(bin, readFileSync(bin, "utf8").replaceAll("__ROOT__", root));
  }
  return root;
}

const run = (root: string, argv: string[]) => {
  const sink = capture();
  const status = development.main(argv, { root, io: sink.io, skipPreflight: true });
  const log = existsSync(join(root, "tool.log")) ? readFileSync(join(root, "tool.log"), "utf8").trim().split("\n") : [];
  return { status, log, out: sink.out(), err: sink.err() };
};

const metric = { total: 10, covered: 9, skipped: 0, pct: 90 };
const totals = { lines: metric, branches: metric, functions: metric, statements: metric };
const summary = JSON.stringify({ total: totals, "/p/a.cjs": {} });

describe("static-quality commands", () => {
  test("the generator type-checks once, and the application generates route types first and checks both programs", () => {
    expect(run(toolProject("generator"), ["typecheck"]).log).toEqual(["tsc --noEmit -p tsconfig.json"]);
    expect(run(toolProject("application"), ["typecheck"]).log).toEqual([
      "next typegen",
      "tsc --noEmit -p tsconfig.json",
      "tsc --noEmit -p tsconfig.tooling.json",
    ]);
  });

  test("a failing step stops the rest and fails the command with the tool's status", () => {
    const root = toolProject("application", { "fail-next": "" });
    const result = run(root, ["typecheck"]);
    expect(result.status).toBe(1);
    expect(result.log).toEqual(["next typegen"]);
  });

  test("an application whose instruction file holds a Next.js managed block is not type-checked", () => {
    const root = toolProject("application", { "AGENTS.md": "<!-- BEGIN:nextjs-agent-rules -->\nrules\n" });
    const result = run(root, ["typecheck"]);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/Next\.js agent rules block/);
    expect(result.log).toEqual([]);
  });

  test("format, lint and their modes call Prettier and ESLint over the whole project", () => {
    const logs = Object.fromEntries(
      ["format", "format:check", "lint", "lint:fix"].map((command) => {
        const result = run(toolProject("generator"), [command]);
        expect(result.status, command).toBe(0);
        return [command, result.log];
      }),
    );
    expect(logs["format"]).toEqual(["prettier --write --log-level=warn **/*.{js,cjs,mjs,ts,tsx,json,css,md,yml,yaml,html}"]);
    expect(logs["format:check"]).toEqual(["prettier --check --log-level=warn **/*.{js,cjs,mjs,ts,tsx,json,css,md,yml,yaml,html}"]);
    expect(logs["lint"]).toEqual(["eslint --max-warnings=0 ."]);
    expect(logs["lint:fix"]).toEqual(["eslint --max-warnings=0 --fix ."]);
  });

  test("a project that lacks the tool package reports it instead of passing", () => {
    const root = scratch.project(roleFiles("generator"));
    expect(() => development.main(["lint"], { root, io: capture().io, skipPreflight: true })).toThrow(/node_modules/);
  });

  test("a package that provides no such executable is an error", () => {
    const root = toolProject("generator");
    writeFileSync(join(root, "node_modules/eslint/package.json"), JSON.stringify({ name: "eslint" }));
    expect(() => run(root, ["lint"])).toThrow(/does not provide the eslint executable/);
  });
});

describe("unit gate", () => {
  test("the generator is measured as one suite and the application as two, each by its own configuration", () => {
    const generator = toolProject("generator", { "summary-infrastructure.json": summary });
    const sink = capture();
    expect(development.unit([], { root: generator, cwd: generator, io: sink.io })).toBe(0);
    expect(readFileSync(join(generator, "tool.log"), "utf8").trim().split("\n")).toEqual([
      "vitest[infrastructure] run --config vitest.infrastructure.config.ts --coverage",
    ]);

    const application = toolProject("application", { "summary-infrastructure.json": summary, "summary-app.json": summary });
    expect(development.unit([], { root: application, cwd: application, io: sink.io })).toBe(0);
    expect(readFileSync(join(application, "tool.log"), "utf8").trim().split("\n")).toEqual([
      "vitest[infrastructure] run --config vitest.infrastructure.config.ts --coverage",
      "vitest[app] run --config vitest.app.config.ts --coverage",
    ]);
  });

  test("one failing suite fails the gate without hiding the other suite's run", () => {
    const root = toolProject("application", { "summary-infrastructure.json": summary, "summary-app.json": summary, "fail-vitestapp": "" });
    const sink = capture();
    expect(development.unit([], { root, cwd: root, io: sink.io })).toBe(1);
    expect(readFileSync(join(root, "tool.log"), "utf8").trim().split("\n")).toHaveLength(2);

    const first = toolProject("application", { "summary-infrastructure.json": summary, "summary-app.json": summary, "fail-vitestinfrastructure": "" });
    expect(development.unit([], { root: first, cwd: first, io: sink.io })).toBe(1);
    expect(readFileSync(join(first, "tool.log"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("a suite that passes while measuring nothing fails the gate", () => {
    const missing = toolProject("generator");
    const sink = capture();
    expect(development.unit([], { root: missing, cwd: missing, io: sink.io })).toBe(1);
    expect(sink.err()).toMatch(/unit: infrastructure: the coverage summary is missing/);

    const empty = toolProject("generator", { "summary-infrastructure.json": JSON.stringify({ total: totals }) });
    const sinkEmpty = capture();
    expect(development.unit([], { root: empty, cwd: empty, io: sinkEmpty.io })).toBe(1);
    expect(sinkEmpty.err()).toMatch(/matched no source files/);
  });

  test("a report left by an earlier run cannot satisfy the gate", () => {
    const root = toolProject("generator", { "coverage/infrastructure/coverage-summary.json": summary });
    const sink = capture();
    expect(development.unit([], { root, cwd: root, io: sink.io })).toBe(1);
    expect(sink.err()).toMatch(/missing or unreadable/);
  });

  test("the gate takes no arguments", () => {
    const root = toolProject("generator");
    expect(() => development.unit(["--coverage.thresholds.lines=0"], { root, cwd: root, io: capture().io })).toThrow(/unexpected|unknown/);
  });
});

describe("focused and integration runs", () => {
  test("test:one refuses a file outside its suite without starting Vitest", () => {
    const root = toolProject("application", { "tests/app/page.test.tsx": "", "tests/integration/x.test.tsx": "", "tests/unit/a.test.tsx": "" });
    for (const argv of [
      ["--test=tests/app/page.test.tsx", "--suite=infrastructure"],
      ["--test=tests/integration/x.test.tsx"],
      ["--test=tests/unit/a.test.tsx"],
      ["--test=tests/app/missing.test.tsx"],
      ["--test=tests/app/page.test.tsx", "--suite=bogus"],
    ]) {
      expect(run(root, ["test:one", ...argv]).status, argv.join(" ")).toBe(2);
    }
    expect(existsSync(join(root, "tool.log"))).toBe(false);
  });

  test("test:integration runs the integration project, optionally one scenario named after a test file of the project", () => {
    const root = toolProject("generator", { "tests/integration/coverage-gates.test.ts": "" });
    expect(run(root, ["test:integration"]).log).toEqual(["vitest run --project integration"]);
    expect(run(root, ["test:integration", "--scenario=coverage-gates"]).log.at(-1)).toBe(
      "vitest run --project integration tests/integration/coverage-gates.test.ts",
    );
    expect(run(root, ["test:integration", "--scenario=nope"]).status).toBe(2);
  });

  test("the application has the integration command too", () => {
    const root = toolProject("application", { "tests/integration/process.test.ts": "" });
    expect(run(root, ["test:integration", "--scenario=process"]).log).toEqual(["vitest run --project integration tests/integration/process.test.ts"]);
  });
});
