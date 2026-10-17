import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { parseJson, type Manifest } from "../support/json.ts";
import { jobValue, jobsOf, type Job } from "../support/workflow.ts";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const render = require("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");
const initialize = require("../../scripts/template/initialize.cjs") as typeof import("../../scripts/template/initialize.cjs");
const context = require("../../scripts/ci/context.cjs") as typeof import("../../scripts/ci/context.cjs");
const testing = require("../../scripts/core/testing.cjs") as typeof import("../../scripts/core/testing.cjs");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const NAMES = ["ci", "dependency-audit", "release", "template-ci", "template-initialize"];
const text = Object.fromEntries(NAMES.map((name) => [name, read(`.github/workflows/${name}.yml`)]));
const jobs = Object.fromEntries(NAMES.map((name) => [name, jobsOf(text[name] as string)]));
const allJobs: { workflow: string; job: Job }[] = NAMES.flatMap((workflow) => (jobs[workflow] as Job[]).map((job) => ({ workflow, job })));
const everything = Object.values(text).join("\n");
/** The file without its comment lines: assertions about what a file does must not be satisfied or broken by prose about it. */
const code = (source: string) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
const job = (workflow: string, id: string) => (jobs[workflow] as Job[]).find((candidate) => candidate.id === id) as Job;
const stepRuns = (target: Job) => target.steps.map((step) => step.run ?? "");

// The actions that were read from their official sources and reviewed; a new one is a reviewed change to this table.
const REVIEWED = new Map([
  ["actions/checkout", ["3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"]],
  ["actions/setup-node", ["949feb2413d6458794dcd2491c4babbbce0c15c1", "v7.1.0"]],
  ["pnpm/action-setup", ["ea17c68df8912ef543352723c149a84f56e3d413", "v6.1.0"]],
  ["actions/upload-artifact", ["cf430e030ddbb5b0abf93d22962f4752f3646cd9", "v7.0.2"]],
  ["actions/download-artifact", ["9000827ccba6bdab643e8b6fd33ac0654aef8333", "v8.0.2"]],
]);

describe("the workflow set", () => {
  test("is exactly the five reviewed workflows", () => {
    expect(readdirSync(join(root, ".github/workflows")).sort()).toEqual(NAMES.map((name) => `${name}.yml`));
  });

  test("template integration runs on pull requests and manual dispatch, while shared CI also runs on main pushes", () => {
    const triggers =
      code(text["template-ci"] as string)
        .split("\non:\n")[1]
        ?.split("\npermissions:")[0] ?? "";
    expect([...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1])).toEqual(["pull_request", "workflow_dispatch"]);
    expect(code(text["ci"] as string)).toMatch(/\n {2}push:\n {4}branches: \[main\]/);
  });

  test("workflow files are regular, non-executable files rendered byte for byte into applications", () => {
    const { manifest, bases } = render.defaultInputs();
    const { files } = render.renderTree({ manifest, bases, answers: { name: "rendered-app", owner: "someone" } });
    const rendered = files.filter((file) => file.path.startsWith(".github/workflows/"));
    expect(rendered.map((file) => file.path).sort()).toEqual(NAMES.map((name) => `.github/workflows/${name}.yml`));
    for (const file of rendered) {
      expect(file.content.toString("utf8"), file.path).toBe(read(file.path));
      expect(file.mode & 0o111, file.path).toBe(statSync(join(root, file.path)).mode & 0o111);
      expect(file.mode & 0o111, file.path).toBe(0);
    }
  });

  test("the pull request template and the dependabot files are rendered, and the application's has no seed entry", () => {
    const { manifest, bases } = render.defaultInputs();
    const { files } = render.renderTree({ manifest, bases, answers: { name: "rendered-app", owner: "someone" } });
    const byPath = new Map(files.map((file) => [file.path, file.content.toString("utf8")]));
    expect(byPath.get(".github/pull_request_template.md")).toBe(read(".github/pull_request_template.md"));
    expect(read(".github/dependabot.yml")).toContain("directory: /template/app");
    expect(byPath.get(".github/dependabot.yml")).not.toContain("/template/app");
    expect(byPath.get(".github/dependabot.yml")).toBe(read("template/app/.github/dependabot.yml"));
  });
});

describe("authority and untrusted input", () => {
  test("every action is an immutable SHA of a reviewed release, written with its release in a comment", () => {
    const uses = allJobs.flatMap(({ job: target }) => target.steps.map((step) => step.uses)).filter((value): value is string => value !== null);
    expect(uses.length).toBeGreaterThan(0);
    for (const value of uses) {
      const match = /^([\w-]+\/[\w-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(value);
      expect(match, value).not.toBeNull();
      expect(REVIEWED.get(match?.[1] ?? ""), value).toEqual([match?.[2], match?.[3]]);
    }
    expect(everything).not.toMatch(/uses:\s*(?:\.|docker:)/);
  });

  test("no workflow uses pull_request_target, a secret, a personal token or an unsafe checkout", () => {
    expect(everything).not.toMatch(/pull_request_target|secrets\.|allow-unsafe-pr-checkout|PERSONAL|\bPAT\b/);
  });

  test("permissions are closed at the top and explicit in every job; write exists only to initialize and to publish", () => {
    for (const name of NAMES) expect(text[name], name).toMatch(/\npermissions: \{\}\n/);
    for (const { workflow, job: target } of allJobs) {
      expect(target.text, `${workflow}/${target.id}`).toMatch(/\n {4}permissions: \{\}\n| {4}permissions:\n {6}contents: (?:read|write)\n/);
    }
    const writers = allJobs.filter(({ job: target }) => /contents: write/.test(target.text)).map(({ workflow, job: target }) => `${workflow}/${target.id}`);
    expect(writers).toEqual(["release/publish", "template-initialize/initialize"]);
    expect(everything).not.toMatch(/(?:pull-requests|actions|checks|id-token|packages|statuses|issues|deployments): write/);
  });

  test("every job has a timeout, every workflow a concurrency group, and credentials persist only where a push needs them", () => {
    for (const { workflow, job: target } of allJobs) expect(jobValue(target, "timeout-minutes"), `${workflow}/${target.id}`).toMatch(/^\d+$/);
    for (const name of NAMES) expect(text[name], name).toMatch(/\nconcurrency:\n {2}group: [^\n]+\n {2}cancel-in-progress: /);
    const persisting = allJobs
      .filter(({ job: target }) => /persist-credentials: true/.test(target.text))
      .map(({ workflow, job: target }) => `${workflow}/${target.id}`);
    expect(persisting).toEqual(["template-initialize/initialize"]);
    for (const { workflow, job: target } of allJobs) {
      for (const step of target.steps.filter((candidate) => candidate.uses?.startsWith("actions/checkout@"))) {
        expect(step.text, `${workflow}/${target.id}`).toMatch(/persist-credentials: (?:true|false)/);
      }
    }
  });

  test("untrusted event data reaches scripts only through environment variables, never through the script text", () => {
    for (const { workflow, job: target } of allJobs) {
      for (const run of stepRuns(target)) {
        expect(run, `${workflow}/${target.id}`).not.toMatch(/\$\{\{[^}]*(?:github\.event|github\.head_ref|inputs\.|github\.ref_name)/);
      }
    }
    expect(job("template-initialize", "initialize").text).toMatch(/REPOSITORY_DESCRIPTION: \$\{\{ github\.event\.repository\.description \}\}/);
    expect(job("release", "validate").text).toMatch(/RELEASE_TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  });

  test("nothing forces, fetches an unpinned tool or fixes automatically", () => {
    expect(everything).not.toMatch(/--force|force-with-lease|git push -f|\+refs|\bnpx\b|\bdlx\b|@latest|--fix\b|auto-merge|automerge|gh pr merge/);
  });
});

describe("required checks and lane ownership", () => {
  test("each result job always runs, depends on every other job and fails on failure or cancellation, with a stable name", () => {
    for (const [workflow, id, name] of [
      ["ci", "ci-result", "CI result"],
      ["template-ci", "template-ci-result", "Template CI result"],
    ] as const) {
      const result = job(workflow, id);
      const others = (jobs[workflow] as Job[]).filter((candidate) => candidate.id !== id).map((candidate) => candidate.id);
      expect(result.name).toBe(name);
      expect(jobValue(result, "if")).toBe("always()");
      expect(jobValue(result, "needs")).toBe(`[${others.join(", ")}]`);
      expect(result.text).toContain("contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')");
    }
  });

  test("no path filter, no matrix and no continue-on-error can make a required check disappear or pass", () => {
    expect(everything).not.toMatch(/\bpaths(?:-ignore)?:|\bmatrix:|continue-on-error/);
  });

  test("the role decides which jobs run: shared jobs always, generator jobs only for a generator", () => {
    expect(jobValue(job("ci", "static"), "needs")).toBe("plan");
    expect(jobValue(job("ci", "static"), "if")).toBeNull();
    expect(jobValue(job("ci", "production"), "if")).toBeNull();
    expect(jobValue(job("template-ci", "generator-integration"), "if")).toBe("needs.plan.outputs.role == 'generator'");
    expect(job("ci", "plan").steps.some((step) => step.run === "node scripts/ci/context.cjs plan")).toBe(true);
  });

  test("the static gates run once; browsers and the production proof run in one lane", () => {
    const runs = allJobs.flatMap(({ workflow, job: target }) => stepRuns(target).map((run) => ({ workflow, id: target.id, run })));
    const count = (command: string) => runs.filter(({ run }) => run.split("\n").some((line) => line.trim() === command));
    expect(count("pnpm run check").map(({ id }) => id)).toEqual(["static"]);
    expect(count("pnpm run docs:build").map(({ id }) => id)).toEqual(["static"]);
    expect(count("pnpm run test:e2e").map(({ workflow, id }) => `${workflow}/${id}`)).toEqual(["ci/production", "template-initialize/initialize"]);
    expect(count("pnpm run test:artifact").map(({ workflow, id }) => `${workflow}/${id}`)).toEqual(["ci/production", "template-initialize/initialize"]);
    expect(count("pnpm run audit:dependencies").map(({ id }) => id)).toEqual(["audit"]);
    expect(count("pnpm run build")).toEqual([]);
    expect(everything.match(/install --with-deps chromium webkit/g)).toHaveLength(2);
    expect(everything).not.toMatch(/firefox|msedge|\bchrome\b/i);
  });

  test("runners use Ubuntu 24.04", () => {
    for (const { workflow, job: target } of allJobs) {
      expect(jobValue(target, "runs-on"), `${workflow}/${target.id}`).toBe("ubuntu-24.04");
    }
  });

  test("browser integration belongs to the provisioned production job, while other integration stays independent", () => {
    expect(testing.suiteOf("generator", "tests/browser-integration/production.test.ts")).toBe("browser-integration");
    const production = job("ci", "production");
    const browserStep = production.steps.findIndex((step) => step.run === "pnpm run test:integration --suite=browser-integration");
    const installed = production.steps.findIndex((step) => step.run?.includes("install --with-deps chromium webkit"));
    expect(installed).toBeGreaterThanOrEqual(0);
    expect(browserStep).toBeGreaterThan(installed);
    for (const { job: target } of allJobs.filter(({ job: target }) => target !== production))
      expect(stepRuns(target).join("\n")).not.toContain("--suite=browser-integration");
  });

  test("the generator integration lane runs the non-browser integration suite", () => {
    expect(stepRuns(job("template-ci", "generator-integration"))).toContain("pnpm run test:integration");
  });

  test("applications retain an integration lane for their hooks, dependencies and releases", () => {
    const application = job("ci", "application-integration");
    expect(application).toBeDefined();
    expect(jobValue(application, "if")).toBe("needs.plan.outputs.role == 'application'");
    expect(stepRuns(application)).toContain("pnpm run test:integration");
  });

  test("the commands the workflows run are commands of the contract", () => {
    const scripts = parseJson<Manifest>(read("package.json")).scripts ?? {};
    for (const { job: target } of allJobs) {
      for (const run of stepRuns(target)) {
        for (const match of run.matchAll(/pnpm run ([a-z0-9:]+)/g)) expect(Object.hasOwn(scripts, match[1] ?? ""), match[1]).toBe(true);
      }
    }
  });
});

describe("the toolchain of the jobs", () => {
  const lane = read(".node-version").trim().split(".")[0];

  test("Node comes from .node-version, pnpm from the manifest, and the store has one cache owner", () => {
    const steps = allJobs.flatMap(({ job: target }) => target.steps);
    const setups = steps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(setups.length).toBeGreaterThan(0);
    for (const step of setups) {
      expect(step.text).toContain("node-version-file: .node-version");
      expect(step.text).toContain("package-manager-cache: false");
      expect(step.text).not.toMatch(/node-version: /);
    }
    for (const step of steps.filter((candidate) => candidate.uses?.startsWith("pnpm/action-setup@")))
      expect(step.text).not.toMatch(/cache:|version:|run_install/);
  });

  test("every job that installs records its effective Node and pnpm against the declared lane", () => {
    expect(lane).toBe("24");
    const installing = allJobs.filter(({ job: target }) => target.steps.some((step) => step.uses?.startsWith("pnpm/action-setup@")));
    expect(installing.length).toBeGreaterThan(0);
    for (const { workflow, job: target } of installing) {
      expect(target.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.text).toContain("cache: pnpm");
      expect(stepRuns(target), `${workflow}/${target.id}`).toContain(`node scripts/ci/context.cjs toolchain --lane=${lane}`);
    }
    expect(everything).not.toMatch(/node-version: ['"]?\d|matrix\.node/);
  });

  test("project Node helpers always run after the pinned Node setup, including planning and profile jobs", () => {
    for (const { workflow, job: target } of allJobs) {
      const helper = target.steps.findIndex((step) => /(?:^|\n)node scripts\//.test(step.run ?? ""));
      if (helper < 0) continue;
      const setup = target.steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
      expect(setup, `${workflow}/${target.id}`).toBeGreaterThanOrEqual(0);
      expect(setup, `${workflow}/${target.id}`).toBeLessThan(helper);
    }
  });

  test("every install is frozen", () => {
    for (const { workflow, job: target } of allJobs) {
      for (const run of stepRuns(target)) {
        for (const line of run.split("\n").filter((candidate) => /pnpm install/.test(candidate)))
          expect(line, `${workflow}/${target.id}`).toContain("--frozen-lockfile");
      }
    }
  });
});

describe("first-run initialization", () => {
  const init = job("template-initialize", "initialize");
  const runs = stepRuns(init);
  const at = (pattern: RegExp) => runs.findIndex((run) => pattern.test(run));

  test("applies only to an unconverted copy, on the default branch, and the source repository never initializes itself", () => {
    expect(jobValue(init, "if")).toBe("needs.plan.outputs.initialize == 'true' && github.ref_name == github.event.repository.default_branch");
    expect(jobValue(job("template-initialize", "plan"), "if")).toBe("github.ref_name == github.event.repository.default_branch");
    expect(context.SOURCE_REPOSITORY).toBe(initialize.SOURCE_REPOSITORY);
    expect(context.SENTINEL).toBe(initialize.SENTINEL);
  });

  test("installs the copy without hooks or guard, then initializes, then proves the result, then publishes once", () => {
    const steps = [
      at(/^pnpm install --frozen-lockfile$/),
      at(/initialize\.cjs/),
      at(/rm -rf node_modules/),
      at(/test:e2e/),
      at(/test:artifact/),
      at(/git push/),
    ];
    expect(steps.every((index) => index >= 0)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    const before = runs.slice(0, at(/initialize\.cjs/)).join("\n");
    expect(before).not.toMatch(/bootstrap|hooks|guard|core\.hooksPath|husky/);
    expect(runs.filter((run) => /git push/.test(run))).toHaveLength(1);
  });

  test("only the two browser lanes keep reports, only after a failure, only from test-results and only briefly", () => {
    const uploads = allJobs.flatMap(({ workflow, job: target }) =>
      target.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@")).map((step) => ({ id: `${workflow}/${target.id}`, step })),
    );
    expect(uploads.map(({ id }) => id)).toEqual(["ci/production", "release/validate", "template-initialize/initialize"]);
    for (const { id, step } of uploads.filter(({ id: lane }) => lane !== "release/validate")) {
      expect(step.text, id).toMatch(/\n\s+if: failure\(\)\n/);
      expect(step.text, id).toMatch(/\n\s+path: test-results\n/);
      expect(step.text, id).toMatch(/\n\s+retention-days: [1-9]\s*$/);
      expect(step.text, id).toContain("if-no-files-found: ignore");
    }
    // A later step must not be able to hide the failure, and the push stays the last step of initialization.
    expect(init.steps.at(-1)?.run).toMatch(/git push/);
  });

  test("the history is made by the Actions bot's real noreply address, which the commit identity policy accepts", () => {
    const email = "41898282+github-actions[bot]@users.noreply.github.com";
    expect(init.text).toContain(`git config user.email "${email}"`);
    expect(init.text).toContain('git config user.name "github-actions[bot]"');
    const policy = parseJson<{ commitIdentity: { emailPattern: string } }>(read("tooling/policy.json"));
    expect(new RegExp(policy.commitIdentity.emailPattern).test(email)).toBe(true);
  });

  test("publishes once with a plain push of HEAD to the default branch: a rejection fails, it never forces", () => {
    const push = runs.find((run) => /git push/.test(run));
    expect(push).toBe('git push origin "HEAD:refs/heads/$DEFAULT_BRANCH"');
    expect(init.text).toMatch(/DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  });

  test("passes the repository's own name, owner and description as literal arguments, and the description only when it has one", () => {
    const run = runs.find((candidate) => /initialize\.cjs/.test(candidate)) ?? "";
    expect(run).toContain('args=(--name="${REPOSITORY_NAME,,}" --owner="$REPOSITORY_OWNER")');
    expect(run).toContain('if [ -n "$REPOSITORY_DESCRIPTION" ]; then args+=(--description="$REPOSITORY_DESCRIPTION"); fi');
    expect(run).toContain('node scripts/template/initialize.cjs "${args[@]}"');
  });
});

describe("release validation and publication", () => {
  const validate = job("release", "validate");
  const publish = job("release", "publish");

  test("a tag push validates read-only with the code of the default branch, never the tag's", () => {
    expect(text.release).toMatch(/on:\n {2}push:\n {4}tags: \["v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"\]\n {2}workflow_dispatch:/);
    expect(validate.text).toMatch(/permissions:\n {6}contents: read/);
    expect(validate.text).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(validate.text).toContain("fetch-depth: 0");
    expect(validate.text).not.toMatch(/ref: \$\{\{ github\.(?:ref|sha)|github\.event\.ref/);
    expect(stepRuns(validate)).toContain('pnpm run release:validate --tag="$RELEASE_TAG" --notes="$RUNNER_TEMP/release-notes.md"');
  });

  test("audits the identities of the release before anything is published", () => {
    const runs = stepRuns(validate);
    expect(runs).toContain('node scripts/ci/context.cjs identities --tag="$RELEASE_TAG"');
    expect(runs.indexOf('node scripts/ci/context.cjs identities --tag="$RELEASE_TAG"')).toBeGreaterThan(
      runs.findIndex((run) => run.includes("release:validate")),
    );
  });

  test("publication is a separate job that needs validation, runs only from a manual start on the default branch, and takes the notes as a file", () => {
    expect(jobValue(publish, "needs")).toBe("validate");
    expect(jobValue(publish, "if")).toBe("github.event_name == 'workflow_dispatch' && github.ref_name == github.event.repository.default_branch");
    expect(publish.text).not.toContain("actions/checkout");
    expect(stepRuns(publish)).toEqual([
      "",
      'gh release create "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --verify-tag --title "$RELEASE_TAG" --notes-file "$RUNNER_TEMP/notes/release-notes.md"',
    ]);
    expect(publish.text).toMatch(/RELEASE_TAG: \$\{\{ inputs\.tag \}\}/);
  });
});

describe("the dependency audit workflow and Dependabot", () => {
  test("the audit is scheduled and manual, read-only, and only reports", () => {
    expect(text["dependency-audit"]).toMatch(/schedule:\n {4}- cron: "\d+ \d+ \* \* \d"\n {2}workflow_dispatch:/);
    const audit = job("dependency-audit", "audit");
    expect(audit.text).toMatch(/permissions:\n {6}contents: read/);
    expect(stepRuns(audit)).toContain("pnpm run audit:dependencies");
  });

  test("Dependabot groups npm and Actions updates, covers the seed in the generator, and never merges", () => {
    const dependabot = read(".github/dependabot.yml");
    expect(dependabot.match(/package-ecosystem: (\S+)/g)).toEqual(["package-ecosystem: github-actions", "package-ecosystem: npm", "package-ecosystem: npm"]);
    expect(dependabot.match(/directory: (\S+)/g)).toEqual(["directory: /", "directory: /", "directory: /template/app"]);
    expect(dependabot.match(/groups:/g)).toHaveLength(3);
    expect(code(dependabot)).not.toMatch(/merge|auto/i);
  });
});
