import { describe, expect, test } from "vitest";
import { declarations, isGenerator, prefixRules, read, repositoryRoot } from "../support/agent-declarations.ts";
import { parseJson } from "../support/json.ts";

// Generator only (the file keeps the name of the U9 staging contract): the repository's own, activated, host declarations and the ones it emits to applications.
// Activation is data here; a real host's trust approval and prompts are not proven by these files.

describe("the generator and the declarations it emits to applications", () => {
  test("the application declarations are kept below the application seed, apart from the repository's own", () => {
    expect(isGenerator).toBe(true);
    expect(declarations).not.toBe(repositoryRoot);
  });

  test("the repository registers the guard in both hosts exactly as the applications do", () => {
    for (const path of [".claude/settings.json", ".codex/hooks.json", ".codex/config.toml", ".codex/rules/publishing.rules"]) {
      expect(read(repositoryRoot, path), path).toBe(read(declarations, path));
    }
  });

  test("Compound Engineering is configured exactly as in the repository's own settings", () => {
    const own = parseJson(read(repositoryRoot, ".claude/settings.json"));
    const claude = parseJson(read(declarations, ".claude/settings.json"));
    for (const key of ["extraKnownMarketplaces", "enabledPlugins", "attribution"]) expect(claude[key], key).toEqual(own[key]);
    const tables = (text: string) => text.slice(text.indexOf("[marketplaces."));
    expect(tables(read(declarations, ".codex/config.toml"))).toBe(tables(read(repositoryRoot, ".codex/config.toml")));
  });

  test("the repository's own publishing rules prompt exactly as the emitted ones do", () => {
    expect(prefixRules(read(repositoryRoot, ".codex/rules/publishing.rules"))).toEqual(prefixRules(read(declarations, ".codex/rules/publishing.rules")));
  });

  test("the guard and the hooks are active for the repository and for every application it emits", () => {
    expect(parseJson(read(repositoryRoot, "tooling/capabilities.json"))).toEqual({ guard: true, hooks: true });
  });

  test("the project policy files are the shared ones: one AGENTS import, one inventory", () => {
    expect(read(repositoryRoot, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(read(declarations, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(read(repositoryRoot, "AGENTS.md")).not.toMatch(/BEGIN:nextjs-agent|NEXT-AGENTS-MD/);
  });
});
