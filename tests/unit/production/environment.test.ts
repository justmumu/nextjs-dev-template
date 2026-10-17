import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const { cleanEnv } = createRequire(import.meta.url)("../../../scripts/testing/environment.cjs") as typeof import("../../../scripts/testing/environment.cjs");

describe("the environment of a production child", () => {
  const caller = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    NODE_ENV: "test",
    NODE_PATH: "/somewhere/node_modules",
    npm_config_user_agent: "pnpm/12",
    pnpm_config_verify_deps_before_run: "false",
    PNPM_SCRIPT_SRC_DIR: "/x",
    npm_lifecycle_event: "test:e2e",
    NEXT_PUBLIC_API: "https://api.example",
    NEXT_RUNTIME: "edge",
    PORT: "3000",
    HOSTNAME: "somewhere",
    FIXTURE_SERVER_ONLY: "caller value",
    E2E_NONCE: "stale",
    PLAYWRIGHT_HTML_OPEN: "always",
    pnpm_config_store_dir: "/stores/ci",
    PLAYWRIGHT_BROWSERS_PATH: "/browsers",
    E2E_BROWSERS: "chromium-desktop",
  };

  test("is production: no test mode, no module path, no application or framework variable of the caller", () => {
    const env = cleanEnv(caller);
    for (const name of [
      "NODE_ENV",
      "NODE_PATH",
      "NEXT_PUBLIC_API",
      "NEXT_RUNTIME",
      "PORT",
      "HOSTNAME",
      "FIXTURE_SERVER_ONLY",
      "E2E_NONCE",
      "PLAYWRIGHT_HTML_OPEN",
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  test("carries no override injected by the invoking package manager", () => {
    const env = cleanEnv(caller);
    for (const name of ["npm_config_user_agent", "pnpm_config_verify_deps_before_run", "PNPM_SCRIPT_SRC_DIR", "npm_lifecycle_event"]) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  test("keeps the caller's tools, store and browsers, and turns telemetry off", () => {
    expect(cleanEnv(caller)).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      pnpm_config_store_dir: "/stores/ci",
      PLAYWRIGHT_BROWSERS_PATH: "/browsers",
      NEXT_TELEMETRY_DISABLED: "1",
    });
  });

  test("never carries a choice of browser lanes: the required set cannot be narrowed from outside", () => {
    expect(cleanEnv(caller)).not.toHaveProperty("E2E_BROWSERS");
    expect(cleanEnv({ E2E_BROWSERS: "chromium-desktop,webkit-smoke" })).not.toHaveProperty("E2E_BROWSERS");
  });

  test("the harness's own values come last", () => {
    expect(cleanEnv(caller, { E2E_NONCE: "mine", NEXT_TELEMETRY_DISABLED: "0" })).toMatchObject({ E2E_NONCE: "mine", NEXT_TELEMETRY_DISABLED: "0" });
  });

  test("does not read an unset variable as a value", () => {
    expect(cleanEnv({ KEEP: "1", GONE: undefined })).not.toHaveProperty("GONE");
  });
});
