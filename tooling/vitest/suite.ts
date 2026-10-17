import { createRequire } from "node:module";
import { resolve } from "node:path";
import { coverageConfigDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

const testing = createRequire(import.meta.url)("../../scripts/core/testing.cjs") as typeof import("../../scripts/core/testing.cjs");

const projectRoot = resolve(import.meta.dirname, "../..");

/**
 * The Vitest configuration of one suite described in scripts/core/testing.cjs. As a project of
 * vitest.config.ts it selects and runs the suite's tests; as the configuration of a coverage run it
 * also measures the suite's explicit coverage scope against its own thresholds. Coverage is a
 * process-wide Vitest setting, so each measured suite is run on its own.
 */
export function suiteConfig(name: string, extra: { setupFiles?: string[]; oxc?: ViteUserConfig["oxc"] } = {}): ViteUserConfig {
  const suite = testing.SUITES[name];
  if (!suite) throw new Error(`unknown suite: ${name}`);
  const thresholds = Object.fromEntries(testing.METRICS.map((metric) => [metric, testing.THRESHOLD]));
  return defineConfig({
    root: projectRoot,
    ...(extra.oxc ? { oxc: extra.oxc } : {}),
    test: {
      name,
      environment: suite.environment,
      include: testing.includeGlobs(suite),
      testTimeout: suite.timeout,
      ...(extra.setupFiles ? { setupFiles: extra.setupFiles } : {}),
      ...(suite.coverage
        ? {
            coverage: {
              provider: "v8",
              include: suite.coverage.include,
              exclude: [...coverageConfigDefaults.exclude, ...testing.NOT_PRODUCT, ...suite.coverage.exclusions.map(({ file }) => file)],
              reporter: ["text", "json-summary"],
              reportsDirectory: testing.reportDirectory(name),
              thresholds,
            },
          }
        : {}),
    },
  });
}
