import { resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

const development = createRequire(import.meta.url)("../../scripts/development.cjs") as typeof import("../../scripts/development.cjs");
const present =
  (...files: string[]) =>
  (file: string) =>
    files.includes(file);
const focusedRun = createRequire(import.meta.url)("../../scripts/core/focused-run.cjs") as typeof import("../../scripts/core/focused-run.cjs");
const FILES = ["tests/unit/a.test.ts", "tests/app/page.test.tsx", "tests/integration/x.test.ts"];

describe("the focused test", () => {
  const focus = (args: string[], role: "generator" | "application" = "application") => development.focusOf(args, role, "/p", present(...FILES));

  test("a file is run in the suite whose directory and extension select it", () => {
    expect(focus(["--test=tests/unit/a.test.ts"])).toEqual({ suite: "infrastructure", file: "tests/unit/a.test.ts", name: null });
    expect(focus(["--test=tests/app/page.test.tsx"])).toEqual({ suite: "app", file: "tests/app/page.test.tsx", name: null });
    expect(focus(["--test=tests/integration/x.test.ts", "--suite=integration", "--name=a b"])).toEqual({
      suite: "integration",
      file: "tests/integration/x.test.ts",
      name: "a b",
    });
  });

  test("a path is taken relative to the project, however it is written", () => {
    expect(focus(["--test=./tests/../tests/unit/a.test.ts"]).file).toBe("tests/unit/a.test.ts");
    expect(focus(["--test=/p/tests/unit/a.test.ts"]).file).toBe("tests/unit/a.test.ts");
  });

  test.each([
    ["a path that does not exist", "--test=tests/unit/missing.test.ts"],
    ["a tsx file in a suite that selects none", "--test=tests/unit/a.test.tsx"],
    ["a file outside every suite", "--test=tests/support/json.ts"],
    ["a file above the project", "--test=../package.json"],
    ["an absolute path elsewhere", "--test=/etc/passwd"],
    ["the project manifest", "--test=package.json"],
    ["a directory", "--test=tests"],
  ])("refuses %s", (_label, flag) => {
    expect(() => focus([flag])).toThrow(/registered suite/);
  });

  test("refuses a suite that does not exist, or that the file does not belong to, or an unavailable one", () => {
    expect(() => focus(["--test=tests/unit/a.test.ts", "--suite=nope"])).toThrow(/--suite must be one of/);
    expect(() => focus(["--test=tests/unit/a.test.ts", "--suite=integration"])).toThrow(/belongs to the infrastructure suite, not integration/);
    expect(() => development.focusOf(["--test=tests/app/page.test.tsx"], "generator", "/p", present(...FILES))).toThrow(/registered suite/);
  });

  test("refuses runner flags, a repeated flag and a missing file", () => {
    expect(() => focus(["--test=tests/unit/a.test.ts", "--coverage=true"])).toThrow(/unknown flag/);
    expect(() => focus(["--test=tests/unit/a.test.ts", "--test=tests/unit/a.test.ts"])).toThrow(/duplicate/);
    expect(() => focus([])).toThrow(/--test is required/);
  });
});

describe("exactly one file of the suite", () => {
  const specification = (moduleId: string) => ({ moduleId });
  const testModule = (states: string[], state = "passed") => ({
    state: () => state,
    children: { allTests: () => states.map((result) => ({ result: () => ({ state: result }) })) },
  });

  test("only the specification of the absolute module id is kept, however many files contain its path", () => {
    const all = ["/p/tests/app/a.test.ts", "/p/tests/app/a.test.tsx", "/p/tests/app/sub/p/tests/app/a.test.ts", "/p/tests/app/xa.test.ts"].map(specification);
    expect(focusedRun.exactSpecifications(all, "/p/tests/app/a.test.ts")).toEqual([specification("/p/tests/app/a.test.ts")]);
    expect(focusedRun.exactSpecifications(all, "/p/tests/app/missing.test.ts")).toEqual([]);
  });

  test("a name is a literal pattern", () => {
    const pattern = new RegExp(focusedRun.literalPattern("a (b) [c] .* | \\d-e/f"));
    expect(pattern.test("a (b) [c] .* | \\d-e/f")).toBe(true);
    expect(pattern.test("a b c")).toBe(false);
  });

  test("a failed test, a failed module or an unhandled error fails the run", () => {
    expect(focusedRun.judge([testModule(["passed", "failed"])], [], null).status).toBe(1);
    expect(focusedRun.judge([testModule(["passed"], "failed")], [], null).status).toBe(1);
    expect(focusedRun.judge([testModule(["passed"])], [new Error("late")], null).status).toBe(1);
  });

  test("passing tests pass, and a name that left every test skipped is not a pass", () => {
    expect(focusedRun.judge([testModule(["passed", "skipped"])], [], null)).toEqual({ status: 0, message: null });
    expect(focusedRun.judge([testModule(["passed", "skipped"])], [], "one")).toEqual({ status: 0, message: null });
    expect(focusedRun.judge([testModule(["skipped", "skipped"])], [], "none")).toEqual({ status: 2, message: 'no test has the name "none"' });
    expect(focusedRun.judge([testModule(["skipped"])], [], null).status).toBe(0);
  });
});

describe("the check gate", () => {
  const gate = (name: string, status: number, ran: string[]): [string, () => number] => [
    name,
    () => {
      ran.push(name);
      return status;
    },
  ];

  test("every gate runs, in order, and a clean run says so", () => {
    const sink = capture();
    const ran: string[] = [];
    expect(development.runGates({ ok: true, output: "" }, [gate("format", 0, ran), gate("unit", 0, ran)], sink.io)).toBe(0);
    expect(ran).toEqual(["format", "unit"]);
    expect(sink.out()).toBe("lock: ok\nformat: ok\nunit: ok\n");
    expect(sink.err()).toBe("");
  });

  test("one failing gate does not hide the others, and every failure is named", () => {
    const sink = capture();
    const ran: string[] = [];
    const status = development.runGates(
      { ok: false, output: "ERR_PNPM_OUTDATED_LOCKFILE\n" },
      [gate("lint", 1, ran), gate("typecheck", 0, ran), gate("unit", 2, ran)],
      sink.io,
    );
    expect(status).toBe(1);
    expect(ran).toEqual(["lint", "typecheck", "unit"]);
    expect(sink.out()).toBe("typecheck: ok\n");
    expect(sink.err()).toMatch(/does not match package\.json\nERR_PNPM_OUTDATED_LOCKFILE/);
    expect(sink.err()).toMatch(/check failed: lock, lint, unit\n$/);
  });
});

describe("the unit gate", () => {
  const goodSummary = { total: { lines: { total: 10 }, statements: { total: 10 } }, "/p/a.cjs": {} };

  function host(options: { statuses?: Record<string, number>; summaries?: Record<string, unknown> } = {}) {
    const sink = capture();
    const events: string[] = [];
    return {
      sink,
      events,
      host: {
        io: sink.io,
        clear: (suite: string) => events.push(`clear ${suite}`),
        measure: (suite: string) => {
          events.push(`measure ${suite}`);
          return options.statuses?.[suite] ?? 0;
        },
        summary: (suite: string) => (options.summaries && suite in options.summaries ? options.summaries[suite] : goodSummary),
      },
    };
  }

  test("each suite is measured on its own, after its stale report is gone", () => {
    const { host: h, events, sink } = host();
    expect(development.unitGate(["infrastructure", "app"], h)).toBe(0);
    expect(events).toEqual(["clear infrastructure", "measure infrastructure", "clear app", "measure app"]);
    expect(sink.out()).toBe("unit: infrastructure\nunit: app\n");
  });

  test("a suite that fails its thresholds fails the gate without hiding the next suite's run", () => {
    const { host: h, events } = host({ statuses: { infrastructure: 1 } });
    expect(development.unitGate(["infrastructure", "app"], h)).toBe(1);
    expect(events).toContain("measure app");
  });

  test("a suite that passes while measuring nothing fails the gate, whatever its status says", () => {
    const missing = host({ summaries: { app: null } });
    expect(development.unitGate(["app"], missing.host)).toBe(1);
    expect(missing.sink.err()).toMatch(/unit: app: the coverage summary is missing/);
    const empty = host({ summaries: { app: { total: goodSummary.total } } });
    expect(development.unitGate(["app"], empty.host)).toBe(1);
    expect(empty.sink.err()).toMatch(/matched no source files/);
  });

  test("a failed run is not also judged by the report it left", () => {
    const { host: h, sink } = host({ statuses: { app: 1 }, summaries: { app: null } });
    expect(development.unitGate(["app"], h)).toBe(1);
    expect(sink.err()).toBe("");
  });

  test("a project with no measured suite measures nothing and passes nothing silently", () => {
    expect(development.unitGate([], host().host)).toBe(0);
  });
});

describe("commands that start the installed tools", () => {
  type Tools = import("../../scripts/development.cjs").Tools;
  const root = resolve(import.meta.dirname, "../..");

  /** Tools that record what is started and answer with scripted statuses. */
  function tools(options: { statuses?: Record<string, number> } = {}) {
    const started: string[] = [];
    const fake: Tools = {
      launch: (pkg, bin, args) => {
        started.push(`${pkg}/${bin} ${args.join(" ")}`);
        return options.statuses?.[bin] ?? 0;
      },
      focus: ({ suite, file, name }) => {
        started.push(`focus ${suite} ${file} ${name ?? ""}`.trimEnd());
        return options.statuses?.focus ?? 0;
      },
    };
    return { fake, started };
  }

  const handler = (name: string, role: "generator" | "application") => {
    const found = development.COMMANDS[name]?.handlers[role];
    if (!found) throw new Error(`${name} has no ${role} handler`);
    return found;
  };
  const call = (name: string, role: "generator" | "application", args: string[], fake: Tools) => {
    const sink = capture();
    const status = handler(name, role)(args, { root, cwd: root, io: sink.io, tools: fake });
    return { status, err: sink.err(), out: sink.out() };
  };

  test.each(["format", "format:check", "lint", "lint:fix", "typecheck"])("%s takes no arguments and starts nothing when given one", (name) => {
    const { fake, started } = tools();
    expect(() => call(name, "generator", ["--fast=1"], fake)).toThrow(/unknown flag/);
    expect(started).toEqual([]);
  });

  test("a static gate reports the status of its tool", () => {
    for (const [name, bin] of [
      ["format:check", "prettier"],
      ["lint", "eslint"],
      ["typecheck", "tsc"],
    ] as const) {
      expect(call(name, "generator", [], tools({ statuses: { [bin]: 0 } }).fake).status, name).toBe(0);
      expect(call(name, "generator", [], tools({ statuses: { [bin]: 3 } }).fake).status, name).toBe(3);
    }
  });

  test("the application generates route types before checking, and a failing step stops the rest", () => {
    const clean = tools();
    expect(call("typecheck", "application", [], clean.fake).status).toBe(0);
    expect(clean.started.map((line) => line.split(" ")[0])).toEqual(["next/next", "typescript/tsc", "typescript/tsc"]);
    const failing = tools({ statuses: { next: 1 } });
    expect(call("typecheck", "application", [], failing.fake).status).toBe(1);
    expect(failing.started).toHaveLength(1);
  });

  test("the unit gate and the integration project are separate runs", () => {
    const { fake, started } = tools();
    expect(call("test:integration", "generator", [], fake).status).toBe(0);
    expect(started).toEqual(["vitest/vitest run --project integration"]);
    expect(call("test:integration", "generator", ["--scenario=process"], fake).status).toBe(0);
    expect(started.at(-1)).toBe("vitest/vitest run --project integration tests/integration/process.test.ts");
    expect(() => call("test:integration", "generator", ["--scenario=nope"], fake)).toThrow(/--scenario must be one of/);
    expect(() => call("test:integration", "generator", ["--scenario=../unit/gates"], fake)).toThrow(/--scenario must be one of/);
  });

  describe("test:one", () => {
    const file = "tests/unit/gates.test.ts";

    test("hands the one named file and its suite to the focused runner, not to a substring filter", () => {
      const { fake, started } = tools();
      expect(call("test:one", "generator", [`--test=${file}`], fake).status).toBe(0);
      expect(started).toEqual([`focus infrastructure ${file}`]);
    });

    test("passes a name on as it was written, and the runner's status back", () => {
      const { fake, started } = tools({ statuses: { focus: 2 } });
      expect(call("test:one", "generator", [`--test=${file}`, "--name=a (b)"], fake).status).toBe(2);
      expect(started).toEqual([`focus infrastructure ${file} a (b)`]);
    });

    test("a refused request never reaches Vitest", () => {
      const { fake, started } = tools();
      expect(() => call("test:one", "generator", ["--test=package.json"], fake)).toThrow(/registered suite/);
      expect(started).toEqual([]);
    });
  });
});

describe("what a package provides", () => {
  test("a single bin entry is the executable whatever it is asked for, a bin map is looked up by name", () => {
    expect(development.binOf({ bin: "bin/tool.js" }, "tool", "tool")).toBe("bin/tool.js");
    expect(development.binOf({ bin: { tsc: "bin/tsc", tsserver: "bin/tsserver" } }, "typescript", "tsserver")).toBe("bin/tsserver");
  });

  test("a package without that executable is an error, not an empty path", () => {
    expect(() => development.binOf({}, "eslint", "eslint")).toThrow(/eslint does not provide the eslint executable/);
    expect(() => development.binOf({ bin: { other: "x" } }, "eslint", "eslint")).toThrow(/does not provide/);
    expect(() => development.binOf({ bin: 3 }, "eslint", "eslint")).toThrow(/does not provide/);
  });

  test("a coverage summary that is not JSON is no summary", () => {
    expect(development.parseSummary('{"total":{}}')).toEqual({ total: {} });
    expect(development.parseSummary("")).toBeNull();
    expect(development.parseSummary("<html>")).toBeNull();
  });
});
