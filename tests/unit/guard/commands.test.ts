import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { guardPolicy } from "../../support/guard-repo.ts";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../../..");
const bootstrap = readFileSync(resolve(root, "scripts/bootstrap.cjs"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
const declared = JSON.parse(readFileSync(resolve(root, "tooling/policy.json"), "utf8")) as { protected: Record<string, unknown> };
const protectedFiles = require("../../../scripts/core/protected.cjs") as typeof import("../../../scripts/core/protected.cjs");

// Commands the policy already names whose scripts belong to units that are not built yet (release
// automation). They are routes by declaration only; the parity check below must not pass them silently.
const NOT_BUILT_YET = new Set(["release:bump", "release:tag"]);

describe("the command routes are the public command contract", () => {
  const rules = guardPolicy.commands;

  test("every route names a command that exists, or one that is explicitly not built yet", () => {
    for (const rule of rules) {
      const [tool, ...rest] = rule.argv;
      if (tool === "pnpm") {
        expect(rest[0], rule.id).toBe("run");
        const script = rest[1] ?? "";
        if (NOT_BUILT_YET.has(script)) expect(manifest.scripts[script], `${script} is built; remove it from the pending list`).toBeUndefined();
        else expect(manifest.scripts[script], `${rule.id}: package.json has no script ${script}`).toBeDefined();
      } else {
        expect(tool).toBe("node");
        expect(rest[0]).toBe("scripts/bootstrap.cjs");
        expect(bootstrap, rule.id).toContain(`"${rest[1] ?? ""}"`);
      }
    }
  });

  test("route ids are unique and every route carries one of the known allowances", () => {
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
    const known = ["format", "lint-fix", "dependencies", "setup", "repair", "accept", "version", "none"];
    for (const rule of rules) expect(known, rule.id).toContain(rule.allowance);
  });

  test("the goals the user approves each time are declared as such, and nothing else is", () => {
    expect(rules.filter((rule) => rule.userApproved).map((rule) => rule.id)).toEqual(["guard-accept", "release-bump", "release-tag"]);
  });

  test("no route is a prefix of another, so one command is never two routes", () => {
    for (const a of rules)
      for (const b of rules)
        if (a !== b) expect(b.argv.join(" ").startsWith(`${a.argv.join(" ")} `) && !a.flags && !a.positional, `${a.id} / ${b.id}`).toBe(false);
  });

  test("no route runs a forbidden tool", () => {
    const forbidden = (JSON.parse(readFileSync(resolve(root, "tooling/policy.json"), "utf8")) as { forbiddenTools: string[] }).forbiddenTools;
    for (const rule of rules) expect(forbidden, rule.id).not.toContain(rule.argv[0]);
  });
});

describe("one protected inventory", () => {
  test("the shared module reads it from tooling/policy.json and the guard reuses that module", () => {
    expect(protectedFiles.createInventory(declared.protected).FILES).toEqual(protectedFiles.FILES);
    for (const file of ["scripts/hooks/guard.cjs", "scripts/hooks/repo.cjs"]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source, file).toMatch(/core\/protected\.cjs/);
      expect(source, file).not.toMatch(/"pnpm-workspace\.yaml"|"\.npmrc"/);
    }
  });

  test("a malformed declaration fails loudly instead of protecting less", () => {
    for (const bad of [
      null,
      {},
      { ...declared.protected, files: [] },
      { ...declared.protected, dirs: "scripts" },
      { ...declared.protected, seedPrefix: "" },
      { ...declared.protected, configNames: [1] },
    ])
      expect(() => protectedFiles.createInventory(bad)).toThrow(/tooling\/policy\.json/);
  });

  test("a protected directory keeps content that carries a build-output name, while real build output is skipped", () => {
    const inventory = protectedFiles.createInventory(declared.protected);
    expect(inventory.isSkippedDir("dist", "scripts")).toBe(false);
    expect(inventory.isSkippedDir("build", "tooling/vitest")).toBe(false);
    expect(inventory.isSkippedDir("dist", "")).toBe(true);
    expect(inventory.isSkippedDir("coverage", "src")).toBe(true);
    expect(inventory.isSkippedDir("node_modules", "scripts")).toBe(true);
    expect(inventory.isSkippedDir(".git", "")).toBe(true);
    expect(inventory.isProtectedFile("scripts/dist/new.cjs")).toBe(true);
  });
});
