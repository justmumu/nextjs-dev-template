import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { capture, scratchArea } from "../support/project.ts";
import { create, fixtureEnv, git, hostFor, inputsOf } from "../support/template-fixture.ts";
import { accept, commitAll, lineage, runIn } from "../support/template-lineage.ts";
import { parseJson } from "../support/json.ts";

const scratch = scratchArea("template-update-relock-");
const { source, previewFile, applyPreview } = lineage(scratch.area);
type Package = { dependencies: Record<string, string>; keywords?: string[] };
const packageOf = (dir: string) => parseJson<Package>(readFileSync(join(dir, "package.json"), "utf8"));
const savePackage = (dir: string, value: Package) => {
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(value, null, 2)}\n`);
};

test("a fresh clone resolves divergent dependencies, relocks its accepted template merge, and commits through installed hooks", async () => {
  const env = { ...fixtureEnv(scratch.area), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, NEXT_TELEMETRY_DISABLED: "1" };
  const command = (cwd: string, executable: string, args: string[]) => {
    const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const pass = (cwd: string, executable: string, args: string[]) => {
    const result = command(cwd, executable, args);
    expect(result.status, result.output).toBe(0);
    return result;
  };
  const bootstrap = (cwd: string, operation: string) => pass(cwd, process.execPath, ["scripts/bootstrap.cjs", operation]);
  const gen = source(env);
  const original = join(scratch.area, "original");
  const host = hostFor(env);
  const inputs = inputsOf(gen);
  const sink = capture();
  expect(
    await create.createLocal({
      host,
      io: sink.io,
      isCancelled: () => false,
      inputs,
      answers: { name: "relock-app", owner: "fixture" },
      dest: original,
      source: () => create.generatorSource({ git: host.git, root: gen, manifest: inputs.manifest }),
    }),
    sink.err(),
  ).toBe(0);
  const app = join(scratch.area, "cloned");
  git(scratch.area, ["clone", "-q", original, app], env);
  bootstrap(app, "setup");
  for (const hook of ["pre-commit", "commit-msg", "pre-push"]) expect(statSync(join(app, ".git/hooks", hook)).mode & 0o111).not.toBe(0);
  expect(accept(app).status).toBe(0);
  const custom = packageOf(app);
  custom.dependencies["left-pad"] = "1.3.0";
  savePackage(app, custom);
  expect(accept(app).status).toBe(0);
  bootstrap(app, "deps-lock");
  expect(accept(app).status).toBe(0);
  commitAll(app, env, "feat: add application dependency");
  expect(git(app, ["status", "--porcelain"], env)).toBe("");

  const seed = join(gen, "template/app");
  const incoming = packageOf(seed);
  incoming.dependencies["left-pad"] = "1.2.0";
  incoming.keywords = ["reviewed-upstream-metadata"];
  savePackage(seed, incoming);
  pass(seed, "pnpm", ["install", "--lockfile-only", "--no-frozen-lockfile"]);
  commitAll(gen, env, "feat: update dependency and metadata");
  const { path } = await previewFile(app, env, gen);
  const applied = await applyPreview(app, env, gen, path);
  expect(applied.status, applied.err).toBe(0);
  expect(git(app, ["ls-files", "-u"], env)).toContain("package.json");
  const resolved = { ...custom, keywords: incoming.keywords };
  savePackage(app, resolved);
  // Resolve the lock to the upstream side first: syntactically valid, but stale for our chosen 1.3.0.
  writeFileSync(join(app, "pnpm-lock.yaml"), git(app, ["show", "MERGE_HEAD:pnpm-lock.yaml"], env));
  git(app, ["add", "package.json", "pnpm-lock.yaml"], env);
  expect(git(app, ["ls-files", "-u"], env)).toBe("");
  const unaccepted = command(app, process.execPath, ["scripts/bootstrap.cjs", "deps-lock"]);
  expect(unaccepted.status, unaccepted.output).toBe(1);
  expect(accept(app).status).toBe(0);
  const stale = command(app, process.execPath, ["scripts/bootstrap.cjs", "repair"]);
  expect(stale.status).toBe(1);
  expect(stale.output).toMatch(/does not match package.json/);
  bootstrap(app, "deps-lock");
  bootstrap(app, "repair");
  expect(packageOf(app)).toEqual(resolved);
  expect(readFileSync(join(app, "pnpm-lock.yaml"), "utf8")).toContain("left-pad@1.3.0");
  git(app, ["add", "package.json", "pnpm-lock.yaml"], env);
  // Human-terminal commands do not emit agent completion events: accept their reviewed output.
  expect(accept(app).status).toBe(0);
  git(app, ["commit", "-q", "--no-edit"], env);
  expect(git(app, ["rev-list", "--parents", "-n", "1", "HEAD"], env).trim().split(" ")).toHaveLength(3);
  expect(runIn(app, "resume").status).toBe(0);
  expect(existsSync(join(app, ".git/template-update/journal.json"))).toBe(false);
  expect(git(app, ["status", "--porcelain"], env)).toBe("");
}, 600_000);
