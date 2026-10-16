import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

import { nodeCoreModules, policy, suppressionEnforcement } from "./tooling/eslint/shared.mjs";

// The generator's own tooling. The application seed under template/ is real application code and is
// linted by the rendered application's own configuration, not here.
export default defineConfig(
  globalIgnores(["node_modules/", "template/", "tests/fixtures/", ".compound-engineering/", ".private/", "coverage/"]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  policy,
  suppressionEnforcement,
  nodeCoreModules,
);
