import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type ClaudeSettings, type CodexHooks, declarations, read } from "../support/agent-declarations.ts";
import { guardArea, denial } from "../support/guard-fixture.ts";
import { parseJson } from "../support/json.ts";

// The registered hook commands are run exactly as the hosts run them: through a shell, from the
// directory the host chooses, with the real launcher and an accepted baseline. The unavailable-host
// part (live prompts, hook trust) is not proven here; it needs the real hosts.

const claude = parseJson<ClaudeSettings>(read(declarations, ".claude/settings.json"));
const codex = parseJson<CodexHooks>(read(declarations, ".codex/hooks.json"));
const area = guardArea("host-declarations-");

const declared = (hooks: ClaudeSettings["hooks"], event: string): string => hooks[event]?.[0]?.hooks[0]?.command ?? "";
const files = { ".claude/settings.json": read(declarations, ".claude/settings.json"), ".codex/hooks.json": read(declarations, ".codex/hooks.json") };

function host(command: string, cwd: string, input: unknown, env: NodeJS.ProcessEnv) {
  const result = spawnSync("sh", ["-c", command], { cwd, env, input: JSON.stringify(input), encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: result.stdout.trim() ? parseJson(result.stdout) : {} };
}

describe("Claude Code registered commands", () => {
  const fixture = area.createFixture(files);
  expect(fixture.accept()).toBe(0);
  const run = (event: string, payload: Record<string, unknown>) =>
    host(declared(claude.hooks, event), fixture.root, { cwd: fixture.root, ...payload }, { ...fixture.env, CLAUDE_PROJECT_DIR: fixture.root });

  test("an ordinary source edit and a routine command pass; a Git hook bypass is refused before it runs", () => {
    expect(
      run("PreToolUse", { tool_name: "Write", tool_input: { file_path: join(fixture.root, "src/app.ts"), content: "x" }, tool_use_id: "w1" }),
    ).toMatchObject({
      status: 0,
      stdout: "",
    });
    expect(run("PreToolUse", { tool_name: "Bash", tool_input: { command: "pnpm run check" }, tool_use_id: "b1" })).toMatchObject({ status: 0, stdout: "" });
    const refused = run("PreToolUse", { tool_name: "Bash", tool_input: { command: "git commit --no-verify -m x" }, tool_use_id: "b2" });
    expect(denial(refused.json)).toMatch(/--no-verify/);
  });

  test("a shell write to a protected file is restored after the call; the file tool is the user-approved route and keeps its change", () => {
    const shell = { tool_name: "Bash", tool_input: { command: "echo '# changed' > AGENTS.md" }, tool_use_id: "s1" };
    expect(run("PreToolUse", shell).status).toBe(0);
    fixture.write("AGENTS.md", "# changed\n");
    const post = run("PostToolUse", shell);
    expect(post.status).toBe(0);
    expect(String(post.json["reason"])).toMatch(/restored|forbidden/);
    expect(fixture.read("AGENTS.md")).toBe("# Rules\n");

    const edit = { tool_name: "Write", tool_input: { file_path: join(fixture.root, "AGENTS.md"), content: "# approved\n" }, tool_use_id: "e1" };
    expect(run("PreToolUse", edit).status).toBe(0);
    fixture.write("AGENTS.md", "# approved\n");
    expect(run("PostToolUse", edit).json).toEqual({});
    expect(fixture.read("AGENTS.md")).toBe("# approved\n");
    fixture.write("AGENTS.md", "# Rules\n");
  });

  test("a failed call, the end of a turn and a settings change reach the guard", () => {
    expect(run("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "true" }, tool_use_id: "f1" }).status).toBe(0);
    expect(run("Stop", {}).status).toBe(0);
    const withoutHooks = JSON.stringify({ ...JSON.parse(files[".claude/settings.json"]), hooks: {} });
    fixture.write(".claude/settings.json", withoutHooks);
    const change = run("ConfigChange", { source: "project_settings", file_path: join(fixture.root, ".claude/settings.json") });
    expect(change.json["decision"]).toBe("block");
    fixture.write(".claude/settings.json", files[".claude/settings.json"]);
  });

  test("a checkout whose launcher has no machine-bound Node refuses to run, and the end of a turn only reports it", () => {
    const unbound = area.createFixture(files, { bind: false });
    const env = { ...unbound.env, CLAUDE_PROJECT_DIR: unbound.root };
    const pre = host(declared(claude.hooks, "PreToolUse"), unbound.root, { tool_name: "Bash", tool_input: { command: "true" } }, env);
    expect(pre.status).toBe(2);
    expect(pre.stderr).toMatch(/no Node binary is bound/);
    expect(host(declared(claude.hooks, "Stop"), unbound.root, {}, env).status).toBe(1);
  });

  test("a checkout without the launcher is refused in every shell, and the end of a turn only reports it", () => {
    const old = area.createFixture(files);
    rmSync(join(old.root, "scripts/hooks/launch.sh"));
    const result = host(
      declared(claude.hooks, "PreToolUse"),
      old.root,
      { tool_name: "Bash", tool_input: { command: "true" } },
      { ...old.env, CLAUDE_PROJECT_DIR: old.root },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/launcher is missing/);
    expect(host(declared(claude.hooks, "Stop"), old.root, {}, { ...old.env, CLAUDE_PROJECT_DIR: old.root }).status).toBe(1);
  });
});

describe("Codex registered commands", () => {
  const fixture = area.createFixture(files);
  expect(fixture.accept()).toBe(0);
  const command = (event: string) => codex.hooks[event]?.[0]?.hooks[0]?.command ?? "";
  const run = (event: string, cwd: string, payload: Record<string, unknown>) => host(command(event), cwd, { cwd, ...payload }, fixture.env);

  test("a direct patch of a protected file is refused, also when the host runs the hook from a subdirectory", () => {
    mkdirSync(join(fixture.root, "src/nested"), { recursive: true });
    const patch = `*** Begin Patch\n*** Delete File: ${join(fixture.root, "pnpm-lock.yaml")}\n*** End Patch`;
    for (const cwd of [fixture.root, join(fixture.root, "src/nested")]) {
      const result = run("PreToolUse", cwd, {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: patch },
        tool_use_id: `p-${cwd}`,
      });
      expect(result.status).toBe(0);
      expect(denial(result.json), cwd).toMatch(/protected|forbidden/i);
    }
  });

  test("an ordinary patch passes, and the shell route refuses a hook bypass", () => {
    const patch = `*** Begin Patch\n*** Update File: ${join(fixture.root, "src/app.ts")}\n@@\n-export const app = 1;\n+export const app = 2;\n*** End Patch`;
    expect(run("PreToolUse", fixture.root, { tool_name: "apply_patch", tool_input: { command: patch }, tool_use_id: "ok" })).toMatchObject({
      status: 0,
      stdout: "",
    });
    const refused = run("PreToolUse", fixture.root, { tool_name: "Bash", tool_input: { command: "HUSKY=0 git commit -m x" }, tool_use_id: "bypass" });
    expect(denial(refused.json)).toMatch(/skip the Git hooks/);
  });

  test("the post and stop events reach the guard", () => {
    expect(run("PostToolUse", fixture.root, { tool_name: "Bash", tool_input: { command: "true" }, tool_use_id: "post" }).status).toBe(0);
    expect(run("Stop", fixture.root, {}).status).toBe(0);
  });
});
