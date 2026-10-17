import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { declarations, isGenerator, repositoryRoot } from "../support/agent-declarations.ts";
import { parseJson } from "../support/json.ts";

// The real Codex CLI evaluates the publishing rules. Without a Codex CLI the checks are skipped and
// reported as such: an unavailable CLI is never a pass.

const toolchain = createRequire(import.meta.url)("../../scripts/core/toolchain.cjs") as typeof import("../../scripts/core/toolchain.cjs");
const hookPolicy = createRequire(import.meta.url)("../../scripts/hooks/policy.cjs") as typeof import("../../scripts/hooks/policy.cjs");
const codex = toolchain.resolveOnPath("codex", process.env["PATH"] ?? "");

interface Decision {
  decision?: string;
  matchedRules: unknown[];
}

function evaluate(rules: string, command: string[]): Decision {
  const result = spawnSync(codex ?? "codex", ["execpolicy", "check", "--rules", rules, "--", ...command], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`codex execpolicy failed (${String(result.status)}): ${result.stderr}`);
  return parseJson<Decision>(result.stdout);
}

const PROMPTED = [
  ["git", "switch"],
  ["git", "checkout"],
  ["git", "pull"],
  ["git", "merge"],
  ["git", "rebase"],
  ["git", "reset"],
  ["git", "restore"],
  ["git", "stash"],
  ["git", "cherry-pick"],
  ["gh", "pr", "checkout", "1"],
  ["git", "push"],
  ["git", "push", "origin", "feature"],
  ["gh", "pr", "create", "--fill"],
  ["gh", "pr", "merge", "52", "--merge"],
  ["pnpm", "run", "release:bump", "patch"],
  ["pnpm", "run", "release:tag"],
  ["node", "scripts/bootstrap.cjs", "guard-accept"],
];
const UNTOUCHED = [
  ["git", "status"],
  ["pnpm", "run", "check"],
  ["gh", "pr", "view"],
  ["pnpm", "run", "template:apply"],
  ["node", "scripts/template/update.cjs", "abort"],
  ["node", "scripts/bootstrap.cjs", "setup"],
];

// A todo is reported as neither passed nor failed, so an unavailable CLI cannot look like a pass.
if (codex === null) test.todo("the real Codex execpolicy check is UNAVAILABLE on this machine: no Codex CLI was found, so nothing below ran");

describe
  .skipIf(codex === null)
  .each([
    ...(isGenerator ? [["the repository rules", join(repositoryRoot, ".codex/rules/publishing.rules")] as const] : []),
    ["the project rules", join(declarations, ".codex/rules/publishing.rules")] as const,
  ])("real Codex execpolicy on %s", (_label, rules) => {
  test.each(PROMPTED)("prompts before %s", (...command) => {
    expect(evaluate(rules, command).decision).toBe("prompt");
  });

  test.each([
    ["git", "-C", "/tmp/project", "push", "origin", "HEAD"],
    ["gh", "--repo", "owner/repo", "pr", "create", "--fill"],
    ["gh", "--repo", "owner/repo", "pr", "merge", "1", "--merge"],
  ])("an unprompted publication prefix is refused by the guard: %s", (...command) => {
    expect(evaluate(rules, command).matchedRules).toEqual([]);
    const text = command.join(" ");
    const words = hookPolicy.simpleWords(text);
    expect(hookPolicy.switchOffReason(text, { words, route: null, kind: words ? hookPolicy.gitKind(words) : null })).toMatch(/standalone.*user is asked/);
  });

  test.each(UNTOUCHED)("leaves %s alone", (...command) => {
    expect(evaluate(rules, command).matchedRules).toEqual([]);
  });
});
