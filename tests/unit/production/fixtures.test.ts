import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const { fixtureFiles, standaloneConfig } = createRequire(import.meta.url)(
  "../../../scripts/testing/fixtures.cjs",
) as typeof import("../../../scripts/testing/fixtures.cjs");

describe("fixture routes", () => {
  test("every fixture serves the readiness nonce; only the production fixture has the boundary routes", () => {
    expect(Object.keys(fixtureFiles("artifact"))).toEqual(["src/app/e2e-ready/route.ts"]);
    expect(Object.keys(fixtureFiles("production")).sort()).toEqual([
      "src/app/e2e-ready/route.ts",
      "src/app/fixture/async/page.tsx",
      "src/app/fixture/env/page.tsx",
      "src/app/fixture/env/public-value.tsx",
      "src/app/fixture/error/page.tsx",
    ]);
    expect(fixtureFiles("artifact")["src/app/e2e-ready/route.ts"]).toContain("process.env.E2E_NONCE");
  });

  test("the standalone variant keeps the application's configuration and adds only the output", () => {
    const config = "const c = {\n  agentRules: false,\n  typedRoutes: true,\n};\n";
    expect(standaloneConfig(config)).toBe('const c = {\n  agentRules: false,\n  typedRoutes: true,\n  output: "standalone",\n};\n');
  });

  test.each([
    ["an option that moved", "const c = {};\n"],
    ["an option stated twice", "typedRoutes: true,\ntypedRoutes: true,\n"],
  ])("refuses %s instead of guessing", (_name, config) => {
    expect(() => standaloneConfig(config)).toThrow(/update the standalone fixture/);
  });
});
