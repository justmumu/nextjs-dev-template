import { describe, expect, test } from "vitest";
import { declarations, isGenerator, present, prefixRules, read, repositoryRoot } from "../support/agent-declarations.ts";
import { parseJson } from "../support/json.ts";

// Generator only: the staged host declarations next to the repository's own, not yet activated, settings.

describe("the generator and the declarations it stages for applications", () => {
  test("the declarations are staged below the application seed", () => {
    expect(isGenerator).toBe(true);
    expect(declarations).not.toBe(repositoryRoot);
  });

  test("Compound Engineering is configured exactly as in the repository's own settings", () => {
    const own = parseJson(read(repositoryRoot, ".claude/settings.json"));
    const claude = parseJson(read(declarations, ".claude/settings.json"));
    for (const key of ["extraKnownMarketplaces", "enabledPlugins", "attribution"]) expect(claude[key], key).toEqual(own[key]);
    const tables = (text: string) => text.slice(text.indexOf("[marketplaces."));
    expect(tables(read(declarations, ".codex/config.toml"))).toBe(tables(read(repositoryRoot, ".codex/config.toml")));
  });

  test("the repository's own publishing rules prompt exactly as the staged ones do", () => {
    expect(prefixRules(read(repositoryRoot, ".codex/rules/publishing.rules"))).toEqual(prefixRules(read(declarations, ".codex/rules/publishing.rules")));
  });

  test("the repository itself stays unregistered until the coherent activation", () => {
    expect(present(repositoryRoot, ".codex/hooks.json")).toBe(false);
    expect(parseJson(read(repositoryRoot, ".claude/settings.json"))).not.toHaveProperty("hooks");
    expect(parseJson(read(repositoryRoot, "tooling/capabilities.json"))).toEqual({ guard: false, hooks: false });
    expect(present(declarations, "tooling/capabilities.json")).toBe(false);
  });
});
