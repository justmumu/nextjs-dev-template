import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

import { nodeCoreModules, policy, suppressionEnforcement } from "./tooling/eslint/shared.mjs";

export default defineConfig(
  globalIgnores(["node_modules/", "template/", "tests/fixtures/", ".compound-engineering/", ".private/", "coverage/", "docs/.vitepress/.temp/"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  policy,
  suppressionEnforcement,
  nodeCoreModules,
);
