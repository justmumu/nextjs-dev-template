// @ts-check
"use strict";
const nodePath = require("node:path");
const { isObject } = require("./json.cjs");

// Vitest measures coverage once per process, not per project, so every scope runs as its own
// invocation with its own configuration and its own thresholds. A scope's surplus cannot cover
// another scope's shortfall.
const THRESHOLD = 80;
const METRICS = /** @type {const} */ (["lines", "branches", "functions", "statements"]);
// A scope without a single branch (straight-line components) is legitimate; one without lines or statements measured nothing.
const MEASURED = /** @type {const} */ (["lines", "statements"]);

const NOT_PRODUCT = ["**/*.d.ts", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/__tests__/**", "**/.next/**", "**/coverage/**", "**/node_modules/**"];

/**
 * @typedef {{ file: string, reason: string, proof: string }} Exclusion a file that cannot be measured by Vitest, and the browser/build test that proves it instead
 * @typedef {{
 *   environment: "node" | "jsdom",
 *   roles: ("generator" | "application")[],
 *   tests: { dir: string, extensions: string[] }[],
 *   timeout: number,
 *   coverage: { include: string[], exclusions: Exclusion[] } | null,
 * }} Suite
 */

/** @type {Record<string, Suite>} */
const SUITES = {
  infrastructure: {
    environment: "node",
    roles: ["generator", "application"],
    tests: [
      { dir: "tests/unit", extensions: [".test.ts"] },
      { dir: "tests/contracts", extensions: [".test.ts"] },
    ],
    timeout: 30_000,
    // Shipped executable scripts, whether or not a test imports them, and the lint processor.
    coverage: { include: ["scripts/**/*.cjs", "tooling/eslint/suppression-policy.mjs"], exclusions: [] },
  },
  app: {
    environment: "jsdom",
    roles: ["application"],
    tests: [{ dir: "tests/app", extensions: [".test.ts", ".test.tsx"] }],
    timeout: 30_000,
    coverage: { include: ["src/**/*.{ts,tsx}"], exclusions: [] },
  },
  integration: {
    environment: "node",
    roles: ["generator", "application"],
    tests: [{ dir: "tests/integration", extensions: [".test.ts"] }],
    timeout: 180_000,
    coverage: null,
  },
};

/** @param {string} role @returns {string[]} the suite names a project of this role has */
function suitesFor(role) {
  return Object.entries(SUITES)
    .filter(([, suite]) => suite.roles.includes(/** @type {"generator" | "application"} */ (role)))
    .map(([name]) => name);
}

/** @param {string} role @returns {string[]} the suites that are measured for coverage, in run order */
function coverageSuitesFor(role) {
  return suitesFor(role).filter((name) => SUITES[name]?.coverage != null);
}

/** @param {Suite} suite @returns {string[]} the Vitest include globs of the suite */
function includeGlobs(suite) {
  return suite.tests.flatMap(({ dir, extensions }) => extensions.map((extension) => `${dir}/**/*${extension}`));
}

/**
 * The suite a test file belongs to. `path` is relative to the project root with forward slashes.
 * @param {string} role @param {string} path @returns {string | null}
 */
function suiteOf(role, path) {
  for (const name of suitesFor(role)) {
    const suite = SUITES[name];
    if (suite?.tests.some(({ dir, extensions }) => path.startsWith(`${dir}/`) && extensions.some((extension) => path.endsWith(extension)))) return name;
  }
  return null;
}

/**
 * A framework file Vitest cannot measure may be excluded only by exact path, with a reason, and with
 * the existing browser or build test that proves it instead; a directory or pattern is never
 * accepted, because that would hide ordinary code.
 * @param {Suite} suite
 * @param {(path: string) => boolean} exists whether a project-relative file exists
 * @returns {string[]}
 */
function exclusionErrors(suite, exists) {
  const errors = [];
  for (const { file, reason, proof } of suite.coverage?.exclusions ?? []) {
    if (/[*?{}[\]!]/.test(file) || !/\.[cm]?[jt]sx?$/.test(file) || !exists(file))
      errors.push(`coverage exclusion ${JSON.stringify(file)} must name one existing source file, not a directory or pattern`);
    if (reason.trim().length < 20) errors.push(`coverage exclusion ${file} needs a reason of at least 20 characters`);
    if (!/^tests\/(?:e2e|integration)\/.+\.test\.tsx?$|^tests\/e2e\/.+\.spec\.ts$/.test(proof) || !exists(proof))
      errors.push(`coverage exclusion ${file} must name an existing end-to-end or build test as its proof (got ${JSON.stringify(proof)})`);
  }
  return errors;
}

/**
 * Judges the json-summary of one scope. Vitest's thresholds are the gate; this refuses the cases in
 * which a threshold over nothing would pass: no summary, no files, or no statements measured.
 * @param {unknown} summary the parsed coverage-summary.json
 * @returns {string[]}
 */
function summaryErrors(summary) {
  if (!isObject(summary)) return ["the coverage summary is missing or unreadable"];
  if (Object.keys(summary).length < 2) return ["the coverage scope matched no source files"];
  for (const metric of MEASURED) {
    const measured = isObject(summary.total) ? summary.total[metric] : undefined;
    if (!isObject(measured) || typeof measured.total !== "number" || measured.total === 0) return [`the coverage scope measured no ${metric}`];
  }
  return [];
}

/** @param {string} scope @returns {string} the project-relative directory a scope's coverage report is written to */
function reportDirectory(scope) {
  return nodePath.posix.join("coverage", scope);
}

module.exports = {
  METRICS,
  NOT_PRODUCT,
  SUITES,
  THRESHOLD,
  coverageSuitesFor,
  exclusionErrors,
  includeGlobs,
  reportDirectory,
  suiteOf,
  suitesFor,
  summaryErrors,
};
