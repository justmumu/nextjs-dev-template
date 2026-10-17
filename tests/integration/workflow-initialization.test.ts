import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { parseJson } from "../support/json.ts";
import { capture, scratchArea } from "../support/project.ts";
import { fixtureEnv, generatorCopy, git, hostFor, initialize, inputsOf, passing } from "../support/template-fixture.ts";
import { jobsOf } from "../support/workflow.ts";

// The first-run workflow with real Git and a real remote: its own shell steps run as written, with the
// initialization between them. Only the validation tools (install, check, docs, build, smoke) and the
// browsers are replaced; they have scenarios of their own. The copy has the guard and the hooks active
// in its capabilities, as it will once they are activated, to show that initialization never depends on
// them being off.
const root = resolve(import.meta.dirname, "../..");
const context = createRequire(import.meta.url)("../../scripts/ci/context.cjs") as typeof import("../../scripts/ci/context.cjs");
const scratch = scratchArea("workflow-init-");
const BOT = "41898282+github-actions[bot]@users.noreply.github.com";

const job = jobsOf(readFileSync(join(root, ".github/workflows/template-initialize.yml"), "utf8")).find((candidate) => candidate.id === "initialize");
const stepRun = (name: RegExp) => {
  const step = job?.steps.find((candidate) => name.test(candidate.name));
  if (step?.run == null) throw new Error(`no run step ${String(name)}`);
  return step.run;
};

function shell(cwd: string, script: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync("bash", ["-e", "-c", script], { cwd, env, encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

/** A copy of the template as GitHub makes it, a bare remote behind its `origin`, and the environment the workflow's steps see. */
function repository() {
  const env = fixtureEnv(scratch.area);
  const copy = generatorCopy(scratch.area, `copy-${String(Math.random()).slice(2, 8)}`, env, {
    "tooling/capabilities.json": '{"guard":true,"hooks":true}\n',
  });
  const remote = join(scratch.area, `remote-${String(Math.random()).slice(2, 8)}.git`);
  git(scratch.area, ["init", "-q", "--bare", "-b", "main", remote], env);
  git(copy, ["push", "-q", remote, "main"], env);
  const hooks = join(remote, "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    join(hooks, "pre-receive"),
    `#!/bin/sh\necho push >> "${remote}/pushes.log"\nwhile read old new ref; do echo "$ref" >> "${remote}/refs.log"; done\n`,
  );
  chmodSync(join(hooks, "pre-receive"), 0o755);
  // The URL the workflow's checkout leaves behind, served by the bare repository.
  git(copy, ["remote", "add", "origin", "https://github.com/made-owner/made-app"], env);
  git(copy, ["config", `url.${remote}.insteadOf`, "https://github.com/made-owner/made-app"], env);
  return { env, copy, remote, inputs: inputsOf(copy) };
}

const answers = { name: "made-app", owner: "made-owner" };

async function runWorkflow({ env, copy, inputs }: Pick<ReturnType<typeof repository>, "env" | "copy" | "inputs">, description: string) {
  const identity = shell(copy, stepRun(/bot identity/), env);
  expect(identity.status, identity.err).toBe(0);
  // The initialization step as written, up to the command it starts: its arguments are what the script builds.
  const script = stepRun(/Convert the copy/).replace('node scripts/template/initialize.cjs "${args[@]}"', 'printf "%s\\n" "${args[@]}"');
  const built = shell(copy, script, { ...env, REPOSITORY_NAME: answers.name, REPOSITORY_OWNER: answers.owner, REPOSITORY_DESCRIPTION: description });
  expect(built.status, built.err).toBe(0);
  const args = built.out.split("\n").filter(Boolean);
  const flags = Object.fromEntries(args.map((arg) => [/^--([a-z]+)=/.exec(arg)?.[1] ?? arg, arg.slice(arg.indexOf("=") + 1)]));
  const sink = capture();
  const status = await initialize.initializeCopy({
    host: hostFor(env, { run: passing }),
    io: sink.io,
    isCancelled: () => false,
    root: copy,
    inputs,
    answers: { name: flags.name, owner: flags.owner, ...(flags.description === undefined ? {} : { description: flags.description }) },
  });
  return { args, status, err: sink.err() };
}

const publish = (env: NodeJS.ProcessEnv, copy: string) => shell(copy, stepRun(/Publish the converted history/), { ...env, DEFAULT_BRANCH: "main" });

describe("the first-run workflow, step by step", () => {
  test("converts the copy under the bot identity with the guard and hooks active, and publishes the history with one push", async () => {
    const repo = repository();
    const { env, copy, remote } = repo;
    const original = git(copy, ["rev-parse", "HEAD"], env).trim();

    const result = await runWorkflow(repo, "A literal description with $(touch injected) and 'quotes'");
    expect(result.status, result.err).toBe(0);
    expect(result.args).toEqual(["--name=made-app", "--owner=made-owner", "--description=A literal description with $(touch injected) and 'quotes'"]);
    expect(existsSync(join(copy, "injected"))).toBe(false);

    // O, then B0 by the provenance identity, then E0 by the bot; every identity is a noreply address.
    const log = git(copy, ["log", "--format=%H|%ae|%ce"], env).trim().split("\n");
    expect(log).toHaveLength(3);
    expect(log[0]?.split("|").slice(1)).toEqual([BOT, BOT]);
    expect(git(copy, ["merge-base", "--is-ancestor", original, "HEAD"], env)).toBe("");
    const policy = parseJson<{ commitIdentity: { emailPattern: string } }>(readFileSync(join(root, "tooling/policy.json"), "utf8"));
    for (const email of log.flatMap((line) => line.split("|").slice(1))) {
      if (email !== "fixture@users.noreply.github.com") expect(new RegExp(policy.commitIdentity.emailPattern).test(email), email).toBe(true);
    }
    // Neither the hooks nor the guard of the copy were installed by getting there.
    expect(existsSync(join(copy, ".git/hooks/pre-commit"))).toBe(false);
    expect(spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: copy, env, encoding: "utf8" }).status).toBe(1);

    const pushed = publish(env, copy);
    expect(pushed.status, pushed.err).toBe(0);
    expect(git(remote, ["rev-parse", "main"], env)).toBe(git(copy, ["rev-parse", "HEAD"], env));
    // The remote saw exactly one push, of the default branch alone.
    expect(readFileSync(join(remote, "pushes.log"), "utf8")).toBe("push\n");
    expect(readFileSync(join(remote, "refs.log"), "utf8")).toBe("refs/heads/main\n");
  }, 300_000);

  test("without a description the flag is not passed", async () => {
    const result = await runWorkflow(repository(), "");
    expect(result.args).toEqual(["--name=made-app", "--owner=made-owner"]);
    expect(result.status, result.err).toBe(0);
  }, 300_000);

  test("a rejected push fails the job and never becomes a force push: the remote keeps what it has", async () => {
    const repo = repository();
    const { env, copy, remote } = repo;
    expect((await runWorkflow(repo, "")).status).toBe(0);
    // Someone else committed to the default branch while the workflow was running.
    const other = join(scratch.area, `other-${String(Math.random()).slice(2, 8)}`);
    git(scratch.area, ["clone", "-q", remote, other], env);
    writeFileSync(join(other, "someone-else.txt"), "their work\n");
    git(other, ["add", "-A"], env);
    git(other, ["commit", "-q", "-m", "feat: their work"], env);
    git(other, ["push", "-q", "origin", "main"], env);
    const theirs = git(remote, ["rev-parse", "main"], env);

    const pushed = publish(env, copy);
    expect(pushed.status).not.toBe(0);
    expect(pushed.err).toMatch(/rejected|non-fast-forward|fetch first/);
    expect(git(remote, ["rev-parse", "main"], env)).toBe(theirs);
  }, 300_000);

  test("once converted, the repository is an application whose initialization is a no-op", async () => {
    const repo = repository();
    const { env, copy } = repo;
    expect((await runWorkflow(repo, "")).status).toBe(0);
    const head = git(copy, ["rev-parse", "HEAD"], env);
    expect(
      context.plan({
        role: parseJson<{ role: string }>(readFileSync(join(copy, "tooling/project-role.json"), "utf8")).role,
        sentinel: existsSync(join(copy, "tooling/template-sentinel.json")),
        repository: "made-owner/made-app",
      }),
    ).toEqual({
      role: "application",
      initialize: false,
    });
    const again = await runWorkflow(repo, "");
    expect(again.status).toBe(0);
    expect(git(copy, ["rev-parse", "HEAD"], env)).toBe(head);
  }, 300_000);
});
