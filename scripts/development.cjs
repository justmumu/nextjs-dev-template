// @ts-check
"use strict";
// Routine development commands behind `pnpm run <script>`. The definitions below are the single
// source of the package.json scripts of both the generator and generated applications.
const { existsSync, readdirSync } = require("node:fs");
const nodePath = require("node:path");
const { UsageError, parseArgs } = require("./core/args.cjs");
const { runLogged } = require("./core/process.cjs");
const { gateErrors, readRole } = require("./core/toolchain.cjs");
const { FORMAT_GLOBS, managedAgentBlockErrors } = require("./core/quality.cjs");
const { isObject, readObject } = require("./core/json.cjs");
const { checkLock } = require("./core/transaction.cjs");

/**
 * @typedef {"generator" | "application"} Role
 * @typedef {{ stdout: (text: string) => unknown, stderr: (text: string) => unknown }} Io
 * @typedef {{ root: string, cwd: string, io: Io }} Context
 * @typedef {(args: readonly string[], context: Context) => number} Handler
 */

const INTEGRATION_SCENARIOS = /** @type {Record<string, string>} */ ({
  dependencies: "tests/integration/dependencies.test.ts",
  toolchain: "tests/integration/toolchain.test.ts",
  "rendered-app-install": "tests/integration/rendered-app-install.test.ts",
  "no-python": "tests/integration/no-python.test.ts",
  "static-policy": "tests/integration/static-policy.test.ts",
});

/** @param {string} owner @param {string} what @returns {Handler} */
function unavailable(owner, what) {
  return (_args, { io }) => {
    io.stderr(`${what} is not available yet: ${owner} implements it. This is a failure, not a pass.\n`);
    return 1;
  };
}

/** @param {readonly string[]} args */
function noArgs(args) {
  parseArgs(args, {});
}

/** @param {string} root @param {string} pkg @param {string} bin @returns {string} */
function packageBin(root, pkg, bin) {
  const dir = nodePath.join(root, "node_modules", pkg);
  const { bin: bins } = readObject(nodePath.join(dir, "package.json"));
  const rel = typeof bins === "string" ? bins : isObject(bins) ? bins[bin] : undefined;
  if (typeof rel !== "string") throw new Error(`${pkg} does not provide the ${bin} executable`);
  return nodePath.join(dir, rel);
}

/** @param {Context} context @param {string} pkg @param {string} bin @param {string[]} args */
function runNodeTool({ root, io }, pkg, bin, args) {
  const result = runLogged(process.execPath, [packageBin(root, pkg, bin), ...args], { cwd: root, stdout: io.stdout, stderr: io.stderr });
  return result.status ?? 1;
}

/**
 * Arguments for `vitest` for the focused one-test command: one existing test file under tests/,
 * and optionally a literal test name (escaped; never a pattern).
 * @param {readonly string[]} args
 * @param {string} root
 * @returns {string[]}
 */
function testOneArgs(args, root) {
  const flags = parseArgs(args, { test: { required: true }, name: {} });
  const path = nodePath.resolve(root, flags.test);
  const rel = nodePath.relative(root, path);
  if (rel.startsWith("..") || !rel.startsWith(`tests${nodePath.sep}`) || !/\.test\.ts$/.test(rel) || !existsSync(path)) {
    throw new UsageError(`--test must name an existing *.test.ts file under tests/ (got ${flags.test})`);
  }
  const selected = ["run", rel.split(nodePath.sep).join("/")];
  if (flags.name !== undefined) selected.push("-t", flags.name.replace(/[.*+?^${}()|[\]\\\-/]/g, "\\$&"));
  return selected;
}

/** @type {Handler} */
function testOne(args, context) {
  return runNodeTool(context, "vitest", "vitest", testOneArgs(args, context.root));
}

/** @type {Handler} */
function testIntegration(args, context) {
  const { scenario } = parseArgs(args, { scenario: { values: Object.keys(INTEGRATION_SCENARIOS) } });
  const files =
    scenario === undefined
      ? readdirSync(nodePath.join(context.root, "tests", "integration"))
          .filter((name) => name.endsWith(".test.ts"))
          .sort()
          .map((name) => `tests/integration/${name}`)
      : [INTEGRATION_SCENARIOS[scenario] ?? ""];
  return runNodeTool(context, "vitest", "vitest", ["run", ...files]);
}

/**
 * Runs the tools in order and stops at the first failure.
 * @param {Context} context
 * @param {[pkg: string, bin: string, args: string[]][]} steps
 * @returns {number}
 */
function runSteps(context, steps) {
  for (const [pkg, bin, args] of steps) {
    const status = runNodeTool(context, pkg, bin, args);
    if (status !== 0) return status;
  }
  return 0;
}

/** @type {Handler} */
function typecheckGenerator(args, context) {
  noArgs(args);
  return runSteps(context, [["typescript", "tsc", ["--noEmit", "-p", "tsconfig.json"]]]);
}

/** @type {Handler} */
function typecheckApplication(args, context) {
  noArgs(args);
  const blocks = managedAgentBlockErrors(context.root);
  if (blocks.length > 0) {
    context.io.stderr(`${blocks.join("\n")}\n`);
    return 1;
  }
  // Route types are generated first so a checkout without .next or next-env.d.ts type-checks.
  return runSteps(context, [
    ["next", "next", ["typegen"]],
    ["typescript", "tsc", ["--noEmit", "-p", "tsconfig.json"]],
    ["typescript", "tsc", ["--noEmit", "-p", "tsconfig.tooling.json"]],
  ]);
}

/** @type {Handler} */
function format(args, context) {
  noArgs(args);
  return runSteps(context, [["prettier", "prettier", ["--write", "--log-level=warn", ...FORMAT_GLOBS]]]);
}

/** @type {Handler} */
function formatCheck(args, context) {
  noArgs(args);
  return runSteps(context, [["prettier", "prettier", ["--check", "--log-level=warn", ...FORMAT_GLOBS]]]);
}

/** @type {Handler} */
function lint(args, context) {
  noArgs(args);
  return runSteps(context, [["eslint", "eslint", ["--max-warnings=0", "."]]]);
}

/** @type {Handler} */
function lintFix(args, context) {
  noArgs(args);
  return runSteps(context, [["eslint", "eslint", ["--max-warnings=0", "--fix", "."]]]);
}

/** @type {Handler} */
function check(args, context) {
  noArgs(args);
  const failures = [];
  const lock = checkLock(context.root);
  if (lock.ok) context.io.stdout("lock: ok\n");
  else {
    context.io.stderr(`lock: pnpm-lock.yaml does not match package.json\n${lock.output}`);
    failures.push("lock");
  }
  const gates = /** @type {[string, Handler][]} */ ([
    ["format", formatCheck],
    ["lint", lint],
    ["typecheck", readRole(context.root) === "application" ? typecheckApplication : typecheckGenerator],
    ["unit", unavailable("U5", "unit tests with coverage")],
  ]);
  for (const [name, gate] of gates) {
    if (gate([], context) === 0) context.io.stdout(`${name}: ok\n`);
    else failures.push(name);
  }
  if (failures.length > 0) context.io.stderr(`check failed: ${failures.join(", ")}\n`);
  return failures.length > 0 ? 1 : 0;
}

/**
 * Generator-only commands live under scripts/template, which generated applications do not receive,
 * so the module is loaded by a computed path only when the command runs.
 * @param {"templateCreate" | "seedRefresh"} name
 * @returns {Handler}
 */
function generatorCommand(name) {
  return (args, context) => {
    /** @type {unknown} */
    const commands = require(nodePath.join(__dirname, "template", "commands.cjs"));
    return /** @type {Record<typeof name, Handler>} */ (commands)[name](args, context);
  };
}

/**
 * `handlers` is absent for commands owned by another dispatcher. A role without a handler does not
 * receive the script at all.
 * @type {Record<string, { script: string, handlers: Partial<Record<Role, Handler>> }>}
 */
const COMMANDS = {
  check: { script: "node scripts/development.cjs check", handlers: { generator: check, application: check } },
  typecheck: { script: "node scripts/development.cjs typecheck", handlers: { generator: typecheckGenerator, application: typecheckApplication } },
  format: { script: "node scripts/development.cjs format", handlers: { generator: format, application: format } },
  "format:check": { script: "node scripts/development.cjs format:check", handlers: { generator: formatCheck, application: formatCheck } },
  lint: { script: "node scripts/development.cjs lint", handlers: { generator: lint, application: lint } },
  "lint:fix": { script: "node scripts/development.cjs lint:fix", handlers: { generator: lintFix, application: lintFix } },
  "test:one": { script: "node scripts/development.cjs test:one", handlers: { generator: testOne, application: testOne } },
  "test:integration": { script: "node scripts/development.cjs test:integration", handlers: { generator: testIntegration } },
  "test:permissions": {
    script: "node scripts/development.cjs test:permissions",
    handlers: { generator: unavailable("U6", "test:permissions"), application: unavailable("U6", "test:permissions") },
  },
  "deps:add": { script: "node scripts/dependencies.cjs add", handlers: {} },
  "deps:remove": { script: "node scripts/dependencies.cjs remove", handlers: {} },
  "deps:upgrade": { script: "node scripts/dependencies.cjs upgrade", handlers: {} },
  "template:create": { script: "node scripts/development.cjs template:create", handlers: { generator: generatorCommand("templateCreate") } },
  "template:seed:refresh": { script: "node scripts/development.cjs template:seed:refresh", handlers: { generator: generatorCommand("seedRefresh") } },
};
const EXTERNAL = new Set(["deps:add", "deps:remove", "deps:upgrade"]);

/**
 * The package.json `scripts` a project of this role carries.
 * @param {Role} role
 * @returns {Record<string, string>}
 */
function scriptsFor(role) {
  const scripts = /** @type {Record<string, string>} */ ({});
  for (const [name, { script, handlers }] of Object.entries(COMMANDS).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (EXTERNAL.has(name) || handlers[role]) scripts[name] = script;
  }
  return scripts;
}

/**
 * @param {readonly string[]} argv
 * @param {{ root?: string, io?: Io, skipPreflight?: boolean }} [options]
 * @returns {number}
 */
function main(argv, options = {}) {
  const root = options.root ?? nodePath.resolve(__dirname, "..");
  const io = options.io ?? { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
  const [name, ...args] = argv;
  const command = name !== undefined && Object.hasOwn(COMMANDS, name) && !EXTERNAL.has(name) ? COMMANDS[name] : null;
  if (!command) {
    io.stderr(`unknown command: ${name ?? ""}\n`);
    return 2;
  }
  const role = readRole(root);
  const handler = command.handlers[role];
  if (!handler) {
    io.stderr(`${name ?? ""} is not part of ${role} projects\n`);
    return 2;
  }
  try {
    if (!options.skipPreflight) {
      const errors = gateErrors(root);
      if (errors.length > 0) {
        io.stderr(`${errors.join("\n")}\n`);
        return 1;
      }
    }
    return handler(args, { root, cwd: process.env.INIT_CWD ?? root, io });
  } catch (error) {
    if (error instanceof UsageError || /** @type {Error} */ (error).name === "RenderError") {
      io.stderr(`${/** @type {Error} */ (error).message}\n`);
      return 2;
    }
    throw error;
  }
}

module.exports = { COMMANDS, main, scriptsFor, testOneArgs };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
