import { defineConfig } from "vitest/config";

// Selection only: the suites are described in scripts/core/testing.cjs. Coverage is measured per
// suite by the unit gate (`pnpm run check`), because Vitest applies coverage to the whole process,
// not to a project.
export default defineConfig({
  test: { projects: ["vitest.infrastructure.config.ts", "vitest.app.config.ts", "vitest.integration.config.ts"] },
});
