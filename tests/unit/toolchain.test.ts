import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { roleFiles, scratchArea } from "../support/project.ts";

const toolchain = createRequire(import.meta.url)("../../scripts/core/toolchain.cjs") as typeof import("../../scripts/core/toolchain.cjs");
const scratch = scratchArea("toolchain-unit-");

describe("project facts", () => {
  test("reads the exact Node and pnpm a project pins", () => {
    const root = scratch.project(roleFiles("application", "12.14.0", "24.21.0"));
    expect(toolchain.readExpected(root)).toEqual({ node: "24.21.0", pnpm: "12.14.0" });
  });

  test.each(["pnpm@^12.0.0", "pnpm@12", "npm@10.0.0", "12.14.0"])("%s is not an exact pnpm version", (packageManager) => {
    const root = scratch.project({ ...roleFiles("application"), "package.json": JSON.stringify({ packageManager }) });
    expect(() => toolchain.readExpected(root)).toThrow(/exact pnpm version/);
  });

  test("a project without packageManager has no exact pnpm version either", () => {
    const root = scratch.project({ ...roleFiles("application"), "package.json": "{}" });
    expect(() => toolchain.readExpected(root)).toThrow(/exact pnpm version/);
  });

  test("the role is explicit, and an unknown one is an error", () => {
    expect(toolchain.readRole(scratch.project(roleFiles("generator")))).toBe("generator");
    expect(toolchain.readRole(scratch.project(roleFiles("application")))).toBe("application");
    expect(() => toolchain.readRole(scratch.project({ "tooling/project-role.json": '{"role":"library"}' }))).toThrow(/unknown role/);
    expect(() => toolchain.readRole(scratch.project())).toThrow();
  });

  test("the policy file is read as written", () => {
    const root = scratch.project({ "tooling/policy.json": JSON.stringify({ forbiddenTools: ["x"] }) });
    expect(toolchain.readPolicy(root)).toEqual({ forbiddenTools: ["x"] });
    expect(toolchain.readJson(join(root, "tooling/policy.json"))).toEqual({ forbiddenTools: ["x"] });
  });
});

describe("environment judgement", () => {
  const expected = { node: "24.21.0", pnpm: "12.14.0" };

  test("a missing pnpm says why it could not be run", () => {
    expect(toolchain.checkEnvironment({ node: "24.21.0", pnpm: null }, expected, "spawn pnpm ENOENT")[0]).toMatch(/found none: spawn pnpm ENOENT/);
  });

  test("manager switching and downloads are switched off for the probe only", () => {
    expect(toolchain.NO_MANAGER_SWITCH).toMatchObject({ COREPACK_ENABLE_NETWORK: "0", pnpm_config_pm_on_fail: "ignore" });
  });
});
