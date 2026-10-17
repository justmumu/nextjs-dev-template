import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

const require = createRequire(import.meta.url);
const context = require("../../scripts/ci/context.cjs") as typeof import("../../scripts/ci/context.cjs");

const expected = { node: "24.21.0", pnpm: "12.14.0" };

function hostFor(over: Partial<Parameters<typeof context.main>[1]> = {}) {
  const sink = capture();
  const appended: [string, string][] = [];
  const host: Parameters<typeof context.main>[1] = {
    io: sink.io,
    env: {},
    role: () => "generator",
    exists: () => true,
    expected: () => expected,
    actual: () => ({ ...expected, platform: "linux-x64" }),
    append: (path, text) => appended.push([path, text]),
    ...over,
  };
  return { host, sink, appended };
}

describe("which repository the workflows are in", () => {
  test("the unconverted copy of the template initializes", () => {
    expect(context.plan({ role: "generator", sentinel: true, repository: "someone/app" })).toEqual({ role: "generator", initialize: true });
  });

  test.each([
    ["an application", { role: "application", sentinel: false, repository: "someone/app" }],
    ["a generator without the sentinel", { role: "generator", sentinel: false, repository: "someone/app" }],
    ["the template itself", { role: "generator", sentinel: true, repository: "JustMumu/Nextjs-Dev-Template" }],
    ["an unknown repository", { role: "generator", sentinel: true, repository: "" }],
  ])("%s does not", (_name, input) => {
    expect(context.plan(input).initialize).toBe(false);
  });

  test("writes the answer to the job output and to the log", () => {
    const { host, sink, appended } = hostFor({ env: { GITHUB_OUTPUT: "/out", GITHUB_REPOSITORY: "someone/app" } });
    expect(context.main(["plan"], host)).toBe(0);
    expect(appended).toEqual([["/out", "role=generator\ninitialize=true\n"]]);
    expect(sink.out()).toBe("role=generator\ninitialize=true\n");
  });

  test("an application is never initialized, and no output file is needed", () => {
    const { host, sink, appended } = hostFor({ role: () => "application", exists: () => false, env: { GITHUB_REPOSITORY: "someone/app" } });
    expect(context.main(["plan"], host)).toBe(0);
    expect(appended).toEqual([]);
    expect(sink.out()).toBe("role=application\ninitialize=false\n");
  });
});

describe("the toolchain a job runs on", () => {
  const actual = { ...expected, platform: "linux-x64" };

  test("matches the declared lane and the project", () => {
    expect(context.toolchain(actual, expected, "24")).toEqual({ summary: "Node 24.21.0 (lane 24), pnpm 12.14.0, linux-x64", errors: [] });
  });

  test.each([
    ["another Node major than the lane", { ...actual, node: "22.20.0" }, expected, "Node 24.21.0 is required (found 22.20.0)"],
    ["another Node version of the same major", { ...actual, node: "24.20.0" }, expected, "Node 24.21.0 is required (found 24.20.0)"],
    ["another pnpm", { ...actual, pnpm: "12.13.0" }, expected, "pnpm 12.14.0 is required (found 12.13.0)"],
    ["no pnpm", { ...actual, pnpm: null }, expected, "found none"],
    ["a project of another major than the lane", actual, { ...expected, node: "26.0.0" }, "the project requires Node 26.0.0"],
  ])("fails for %s", (_name, running, declared, message) => {
    expect(context.toolchain(running, declared, "24").errors.join("\n")).toContain(message);
  });

  test("the lane is judged against the running major as well as the declared one", () => {
    const { errors } = context.toolchain({ ...actual, node: "22.20.0" }, { ...expected, node: "22.20.0" }, "24");
    expect(errors).toEqual([
      "this job declares the Node 24 lane but runs Node 22.20.0",
      "this job declares the Node 24 lane but the project requires Node 22.20.0",
    ]);
  });

  test("is recorded in the step summary and passes", () => {
    const { host, sink, appended } = hostFor({ env: { GITHUB_STEP_SUMMARY: "/summary" } });
    expect(context.main(["toolchain", "--lane=24"], host)).toBe(0);
    expect(appended).toEqual([["/summary", "Node 24.21.0 (lane 24), pnpm 12.14.0, linux-x64\n"]]);
    expect(sink.out()).toContain("lane 24");
  });

  test("fails the job and still records what it ran on", () => {
    const { host, sink, appended } = hostFor({ actual: () => ({ ...actual, node: "22.20.0" }), env: { GITHUB_STEP_SUMMARY: "/summary" } });
    expect(context.main(["toolchain", "--lane=24"], host)).toBe(1);
    expect(appended[0]?.[1]).toContain("Node 22.20.0");
    expect(sink.err()).toContain("Node 24.21.0 is required");
  });

  test("needs a numeric lane", () => {
    expect(() => context.main(["toolchain"], hostFor().host)).toThrow(/--lane is required/);
    expect(() => context.main(["toolchain", "--lane=latest"], hostFor().host)).toThrow(/unsupported value/);
  });
});

test("an unknown command is a usage error", () => {
  expect(() => context.main(["deploy"], hostFor().host)).toThrow(/usage: node scripts\/ci\/context.cjs/);
});

describe("the real host reads the project through what it is given", () => {
  function depsFor() {
    const seen: string[] = [];
    const deps: Parameters<typeof context.realHost>[3] = {
      fs: {
        existsSync: (path) => {
          seen.push(`exists ${String(path)}`);
          return String(path).endsWith("template-sentinel.json");
        },
        appendFileSync: (path, text) => {
          seen.push(`append ${String(path)} ${String(text).trim()}`);
        },
      },
      toolchain: {
        readRole: (dir) => (seen.push(`role ${dir}`), "generator"),
        readExpected: () => expected,
        pnpmVersion: () => "12.14.0",
      },
    };
    return { deps, seen };
  }

  test("answers about the files and toolchain of the root it was made for", () => {
    const { deps, seen } = depsFor();
    const host = context.realHost("/project", { A: "1" }, capture().io, deps);
    expect(host.role()).toBe("generator");
    expect(host.exists("tooling/template-sentinel.json")).toBe(true);
    expect(host.exists("tooling/other.json")).toBe(false);
    expect(host.expected()).toEqual(expected);
    expect(host.actual()).toEqual({ node: process.versions.node, pnpm: "12.14.0", platform: `${process.platform}-${process.arch}` });
    host.append("/summary", "text\n");
    expect(seen).toContain("exists /project/tooling/template-sentinel.json");
    expect(seen).toContain("append /summary text");
  });

  test("runs the commands through it", () => {
    const { deps } = depsFor();
    const sink = capture();
    expect(context.main(["plan"], context.realHost("/project", { GITHUB_REPOSITORY: "someone/app" }, sink.io, deps))).toBe(0);
    expect(sink.out()).toBe("role=generator\ninitialize=true\n");
  });
});
