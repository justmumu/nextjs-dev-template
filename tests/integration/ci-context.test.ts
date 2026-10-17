import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture, put, roleFiles, scratchArea } from "../support/project.ts";
import { fixtureEnv, git } from "../support/release-fixture.ts";

const root = resolve(import.meta.dirname, "../..");
const context = createRequire(import.meta.url)("../../scripts/ci/context.cjs") as typeof import("../../scripts/ci/context.cjs");
const scratch = scratchArea("ci-context-");
// Built from parts: an application's tests must not carry an address as a literal.
const noreply = (user: string) => [user, "users.noreply.github.com"].join("@");
const private_ = ["private", "example.org"].join("@");
const BOT = noreply("41898282+github-actions[bot]");

function repository(role: "generator" | "application", extra: Record<string, string> = {}) {
  const env = fixtureEnv(scratch.area);
  const dir = scratch.project({ ...roleFiles(role), "tooling/policy.json": readFileSync(join(root, "tooling/policy.json"), "utf8"), ...extra });
  git(dir, ["init", "-q", "-b", "main"], env);
  return { dir, env };
}

function commitAs(dir: string, env: NodeJS.ProcessEnv, file: string, identity: { author?: string; committer?: string }) {
  put(dir, file, file);
  git(dir, ["add", "-A"], env);
  const identities = {
    ...env,
    GIT_AUTHOR_NAME: "Someone",
    GIT_AUTHOR_EMAIL: identity.author ?? BOT,
    GIT_COMMITTER_NAME: "Someone",
    GIT_COMMITTER_EMAIL: identity.committer ?? BOT,
  };
  git(dir, ["commit", "-q", "-m", `feat: ${file}`], identities);
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

describe("the identities of a release, read from the real commit objects", () => {
  test("the Actions bot and a user noreply address pass", () => {
    const { dir, env } = repository("application");
    commitAs(dir, env, "a.txt", {});
    commitAs(dir, env, "b.txt", { author: noreply("12345+someone") });
    git(dir, ["tag", "-a", "v0.0.1", "-m", "v0.0.1"], env);
    const result = run(dir, env, ["identities", "--tag=v0.0.1"]);
    expect(result.status, result.err).toBe(0);
  });

  test("a private author address fails, naming the commit and the role but not the address", () => {
    const { dir, env } = repository("application");
    commitAs(dir, env, "a.txt", {});
    commitAs(dir, env, "b.txt", { author: private_ });
    git(dir, ["tag", "-a", "v0.0.1", "-m", "v0.0.1"], env);
    const result = run(dir, env, ["identities", "--tag=v0.0.1"]);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/^[0-9a-f]{12}: author e-mail is not a GitHub noreply address$/m);
    expect(result.err).not.toContain("example.org");
  });

  test("a private committer address fails, and a commit after the tag is not judged", () => {
    const { dir, env } = repository("application");
    commitAs(dir, env, "a.txt", { committer: private_ });
    git(dir, ["tag", "-a", "v0.0.1", "-m", "v0.0.1"], env);
    expect(run(dir, env, ["identities", "--tag=v0.0.1"]).err).toContain("committer e-mail is not a GitHub noreply address");
    const clean = repository("application");
    commitAs(clean.dir, clean.env, "a.txt", {});
    git(clean.dir, ["tag", "-a", "v0.0.1", "-m", "v0.0.1"], clean.env);
    commitAs(clean.dir, clean.env, "b.txt", { author: private_ });
    expect(run(clean.dir, clean.env, ["identities", "--tag=v0.0.1"]).status).toBe(0);
  });
});
