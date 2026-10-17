import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture, roleFiles, scratchArea } from "../support/project.ts";
import { fixtureEnv, git } from "../support/release-fixture.ts";

const root = resolve(import.meta.dirname, "../..");
const context = createRequire(import.meta.url)("../../scripts/ci/context.cjs") as typeof import("../../scripts/ci/context.cjs");
const scratch = scratchArea("ci-context-");
function repository(role: "generator" | "application", extra: Record<string, string> = {}) {
  const env = fixtureEnv(scratch.area);
  const dir = scratch.project({ ...roleFiles(role), "tooling/policy.json": readFileSync(join(root, "tooling/policy.json"), "utf8"), ...extra });
  git(dir, ["init", "-q", "-b", "main"], env);
  return { dir, env };
}

function run(dir: string, env: NodeJS.ProcessEnv, argv: string[], extra: NodeJS.ProcessEnv = {}) {
  const sink = capture();
  const status = context.main(argv, context.realHost(dir, { ...env, ...extra }, sink.io));
  return { status, out: sink.out(), err: sink.err() };
}

describe("the real repository answers", () => {
  test("a copy of the template with its sentinel initializes, in a repository that is not the template's", () => {
    const { dir, env } = repository("generator", { "tooling/template-sentinel.json": "{}" });
    const output = join(dir, "..", "github-output.txt");
    const result = run(dir, env, ["plan"], { GITHUB_REPOSITORY: "someone/app", GITHUB_OUTPUT: output });
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("role=generator\ninitialize=true\n");
  });

  test("a generator without the sentinel, and an application, do not", () => {
    for (const role of ["generator", "application"] as const) {
      const { dir, env } = repository(role);
      expect(run(dir, env, ["plan"], { GITHUB_REPOSITORY: "someone/app" }).out, role).toBe(`role=${role}\ninitialize=false\n`);
    }
  });

  test("the Node and pnpm in use are the declared ones, and another lane is refused", () => {
    const { dir, env } = repository("application");
    const lane = process.versions.node.split(".")[0] ?? "";
    const summary = join(dir, "..", "summary.md");
    const ok = run(dir, env, [`toolchain`, `--lane=${lane}`], { GITHUB_STEP_SUMMARY: summary });
    expect(ok.status, ok.err).toBe(0);
    expect(readFileSync(summary, "utf8")).toContain(`Node ${process.versions.node} (lane ${lane}), pnpm 12.14.0`);
    const other = run(dir, env, ["toolchain", `--lane=${String(Number(lane) + 2)}`]);
    expect(other.status).toBe(1);
    expect(other.err).toContain("declares the Node");
  });
});
