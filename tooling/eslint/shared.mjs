import globals from "globals";

import suppressionPolicy from "./suppression-policy.mjs";

// Rules every project role shares, so the generator and a generated application cannot drift.

/** @typedef {import("eslint").Linter.Config} FlatConfig */

/**
 * Suppression and typing discipline (KTD9): narrow, justified, and never stale.
 * @type {FlatConfig}
 */
export const policy = {
  linterOptions: { reportUnusedDisableDirectives: "error" },
  rules: {
    "@typescript-eslint/ban-ts-comment": [
      "error",
      { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true, "ts-check": false, minimumDescriptionLength: 20 },
    ],
    "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
  },
};

/**
 * The suppression enforcement runs as a processor on every linted source file, so no inline comment
 * can switch it off (see suppression-policy.mjs).
 * @type {FlatConfig}
 */
export const suppressionEnforcement = {
  files: ["**/*.{js,cjs,mjs,jsx,ts,mts,cts,tsx}"],
  plugins: { "suppression-policy": suppressionPolicy },
  processor: "suppression-policy/enforce",
};

/**
 * Node core modules are CommonJS by contract: they run before any dependency exists, in hooks and
 * in setup, and are loaded with require(). Destructuring require("node:*") functions is the idiom
 * of that contract. Only that rule is relaxed: unbound-method stays on, so a method detached from its
 * object is still an error.
 * @type {FlatConfig}
 */
export const nodeCoreModules = {
  files: ["**/*.cjs"],
  languageOptions: { sourceType: "commonjs", globals: globals.node },
  rules: { "@typescript-eslint/no-require-imports": "off" },
};
