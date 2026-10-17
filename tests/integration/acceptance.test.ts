import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { type ClaudeSettings, type CodexHooks, prefixRules, ruleMatches } from "../support/agent-declarations.ts";
import { denial } from "../support/guard-fixture.ts";
import { parseJson } from "../support/json.ts";
import { capture, scratchArea } from "../support/project.ts";
import { create, fixtureEnv, generatorCopy, git, hostFor, inputsOf, passing, root } from "../support/template-fixture.ts";

// The final adoption of the activated candidate. The creation, update, recovery and release scenarios
// have their own files; this file owns what only the final declarations and setup can show.
// A real host's trust approval and prompts are not exercised here, only the commands the hosts
// are told to run and the data they read.

const scratch = scratchArea("acceptance-");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** A PATH with the exact Node and pnpm and the system tools, and no agent CLI: plugins are optional. */
function pluginFreePath(): string {
  const pnpm = spawnSync("sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).stdout.trim();
  return [dirname(process.execPath), dirname(pnpm), "/usr/bin", "/bin"].join(":");
}

function host(command: string, cwd: string, input: unknown, env: NodeJS.ProcessEnv) {
  const result = spawnSync("sh", ["-c", command], { cwd, env, input: JSON.stringify(input), encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, json: result.stdout.trim() ? parseJson(result.stdout) : {} };
}

describe("adopting the activated candidate without any agent CLI", () => {
  test("a created project is set up from its committed baseline, the guard admits ordinary edits and restores protected ones", async () => {
    const env = { ...fixtureEnv(scratch.area), PATH: pluginFreePath() };
    for (const cli of ["claude", "codex"]) expect(spawnSync("sh", ["-c", `command -v ${cli}`], { env }).status, cli).not.toBe(0);

    const gen = generatorCopy(scratch.area, "generator", env);
    expect(parseJson(readFileSync(join(gen, "tooling/capabilities.json"), "utf8"))).toEqual({ guard: true, hooks: true });
    // The validation in staging has its own scenario (template-create); here creation only has to succeed.
    const tooling = hostFor(env, { run: passing });
    const real = hostFor(env);
    const dest = join(scratch.area, "adopted");
    const sink = capture();
    const status = await create.createLocal({
      host: tooling,
      io: sink.io,
      isCancelled: () => false,
      inputs: inputsOf(gen),
      answers: { name: "adopted-app", owner: "adopter" },
      dest,
      source: () => create.generatorSource({ git: tooling.git, root: gen, manifest: inputsOf(gen).manifest }),
    });
    expect(status, sink.err()).toBe(0);

    const claude = parseJson<ClaudeSettings>(readFileSync(join(dest, ".claude/settings.json"), "utf8"));
    const claudeHook = (event: string) => claude.hooks[event]?.[0]?.hooks[0]?.command ?? "";
    const run = (event: string, payload: Record<string, unknown>) =>
      host(claudeHook(event), dest, { cwd: dest, ...payload }, { ...env, CLAUDE_PROJECT_DIR: dest });
    const bash = (command: string, id: string) => ({ tool_name: "Bash", tool_input: { command }, tool_use_id: id });

    // Before setup nothing is bound, and the refusal names the way out.
    const unbound = run("PreToolUse", bash("true", "u1"));
    expect(unbound.status).toBe(2);
    expect(unbound.stderr).toMatch(/no Node binary is bound; run node scripts\/bootstrap\.cjs setup/);

    // Setup uses the pinned Node and pnpm only, binds the launcher and installs the three declared hooks.
    const setup = await real.run(process.execPath, ["scripts/bootstrap.cjs", "setup"], { cwd: dest, env: { ...real.env, PATH: env["PATH"] } });
    expect(setup).toBe(0);
    for (const hook of ["pre-commit", "commit-msg", "pre-push"]) expect(existsSync(join(dest, ".git/hooks", hook)), hook).toBe(true);
    expect(git(dest, ["status", "--porcelain"], env)).toBe("");

    // A dirty protected tree is not a baseline: it asks for a person's reconciliation.
    appendFileSync(join(dest, "AGENTS.md"), "\nlocal edit\n");
    const dirty = run("PreToolUse", bash("true", "d1"));
    expect(dirty.status === 0 ? denial(dirty.json) : dirty.stderr).toMatch(/protected|baseline|ask the user|HEAD/i);
    expect(existsSync(join(dest, ".git/protected-baseline/state.json"))).toBe(false);
    git(dest, ["checkout", "--", "AGENTS.md"], env);

    // From the clean committed baseline an ordinary source edit and a routine command pass.
    const write = (file: string, content: string, id: string) => ({
      tool_name: "Write",
      tool_input: { file_path: join(dest, file), content },
      tool_use_id: id,
    });
    expect(run("PreToolUse", write("src/app/page.tsx", "export default function Page() { return null; }\n", "w1"))).toMatchObject({ status: 0, stdout: "" });
    expect(run("PreToolUse", bash("pnpm run check", "c1"))).toMatchObject({ status: 0, stdout: "" });
    expect(readdirSync(join(dest, ".git/protected-baseline")).length).toBeGreaterThan(0);

    // A shell write to a protected file is restored and explained; a hook bypass is refused before it runs.
    const original = readFileSync(join(dest, "AGENTS.md"), "utf8");
    const shell = bash("echo changed > AGENTS.md", "s1");
    expect(run("PreToolUse", shell).status).toBe(0);
    writeFileSync(join(dest, "AGENTS.md"), "changed\n");
    const post = run("PostToolUse", shell);
    expect(String(post.json["reason"])).toMatch(/restored|forbidden/);
    expect(readFileSync(join(dest, "AGENTS.md"), "utf8")).toBe(original);
    expect(denial(run("PreToolUse", bash("git commit --no-verify -m x", "n1")).json)).toMatch(/--no-verify/);

    // Publishing asks in both hosts, every time, from the project's own files.
    for (const rule of [
      "Bash(git push)",
      "Bash(gh pr create)",
      "Bash(gh pr merge)",
      "Bash(pnpm run release:tag)",
      "Bash(node scripts/bootstrap.cjs guard-accept)",
    ]) {
      expect(claude.permissions.ask, rule).toContain(rule);
      expect(claude.permissions.allow, rule).not.toContain(rule);
    }
    const rules = prefixRules(readFileSync(join(dest, ".codex/rules/publishing.rules"), "utf8"));
    for (const argv of [
      ["git", "push"],
      ["gh", "pr", "merge", "7"],
      ["pnpm", "run", "release:bump", "minor"],
      ["node", "scripts/bootstrap.cjs", "guard-accept"],
    ]) {
      expect(
        rules.some((rule) => ruleMatches(rule, argv) && rule.decision === "prompt"),
        argv.join(" "),
      ).toBe(true);
    }
    const codex = parseJson<CodexHooks>(readFileSync(join(dest, ".codex/hooks.json"), "utf8"));
    const patch = `*** Begin Patch\n*** Update File: ${join(dest, "AGENTS.md")}\n@@\n-x\n+y\n*** End Patch`;
    const refused = host(
      codex.hooks["PreToolUse"]?.[0]?.hooks[0]?.command ?? "",
      dest,
      { cwd: dest, tool_name: "apply_patch", tool_input: { command: patch }, tool_use_id: "p1" },
      env,
    );
    expect(denial(refused.json)).toMatch(/protected|forbidden/i);

    // A changed hook registration is visible at once; a lost binding is refused with the way out.
    const registered = readFileSync(join(dest, ".claude/settings.json"), "utf8");
    writeFileSync(join(dest, ".claude/settings.json"), JSON.stringify({ ...JSON.parse(registered), hooks: {} }));
    const change = run("ConfigChange", { source: "project_settings", file_path: join(dest, ".claude/settings.json") });
    expect(change.json["decision"]).toBe("block");
    writeFileSync(join(dest, ".claude/settings.json"), registered);
    rmSync(join(dest, ".git/protected-baseline-node"));
    expect(run("PreToolUse", bash("true", "u2")).stderr).toMatch(/run node scripts\/bootstrap\.cjs setup/);
  }, 900_000);
});

describe("the acceptance chain", () => {
  const workflow = (name: string) => read(`.github/workflows/${name}.yml`);

  test("the production browser proof and the standalone proof run in CI, and release validation has its own trusted workflow", () => {
    expect(workflow("ci")).toMatch(/run: pnpm run test:e2e/);
    expect(workflow("ci")).toMatch(/run: pnpm run test:artifact/);
    expect(workflow("release")).toMatch(/pnpm run release:validate/);
  });
});
