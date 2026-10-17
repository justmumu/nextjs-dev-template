import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

import { nodeCoreModules, policy, suppressionEnforcement } from "./tooling/eslint/shared.mjs";

export default defineConfig(
  globalIgnores(["node_modules/", ".next/", "out/", "coverage/", "playwright-report/", "test-results/", "next-env.d.ts", "docs/.vitepress/.temp/"]),
  js.configs.recommended,
  nextVitals,
  tseslint.configs.strictTypeChecked,
  { languageOptions: { parserOptions: { project: ["./tsconfig.json", "./tsconfig.tooling.json"], tsconfigRootDir: import.meta.dirname } } },
  policy,
  suppressionEnforcement,
  nodeCoreModules,
);
