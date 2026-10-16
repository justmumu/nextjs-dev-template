// @ts-check
"use strict";
// Routine development commands behind `pnpm run <script>`. The definitions below are the single
// source of the package.json scripts of both the generator and generated applications.
const { existsSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const nodePath = require("node:path");
const { UsageError, parseArgs } = require("./core/args.cjs");
const { runLogged } = require("./core/process.cjs");
const { gateErrors, readRole } = require("./core/toolchain.cjs");
const { FORMAT_GLOBS, managedAgentBlockErrors } = require("./core/quality.cjs");
const { isObject, readObject } = require("./core/json.cjs");
const { checkLock } = require("./core/transaction.cjs");
const testing = require("./core/testing.cjs");

/**
 * @typedef {"generator" | "application"} Role
 * @typedef {{ stdout: (text: string) => unknown, stderr: (text: string) => unknown }} Io
 * @typedef {{ launch: (pkg: string, bin: string, args: string[]) => number, focus: (focus: Focus) => number }} Tools how the installed packages are started: an executable with its output passed on, or the one focused test file
 * @typedef {{ root: string, cwd: string, io: Io, tools?: Tools }} Context
 * @typedef {(args: readonly string[], context: Context) => number} Handler
 */

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

/**
 * The executable a package provides under a name: its single `bin` entry, or the named one.
 * @param {import("./core/json.cjs").JsonObject} manifest the package's package.json
 * @param {string} pkg @param {string} bin
 * @returns {string} the path of the executable relative to the package
 */
function binOf(manifest, pkg, bin) {
  const bins = manifest.bin;
  const rel = typeof bins === "string" ? bins : isObject(bins) ? bins[bin] : undefined;
  if (typeof rel !== "string") throw new Error(`${pkg} does not provide the ${bin} executable`);
  return rel;
}

/** @param {string} root @param {string} pkg @param {string} bin @returns {string} */
function packageBin(root, pkg, bin) {
  const dir = nodePath.join(root, "node_modules", pkg);
  return nodePath.join(dir, binOf(readObject(nodePath.join(dir, "package.json")), pkg, bin));
}

/** @param {Context} context @returns {Tools} the executables of the packages installed under the project root, run with Node and no shell */
function installedTools({ root, io }) {
  return {
    launch: (pkg, bin, args) => {
      const result = runLogged(process.execPath, [packageBin(root, pkg, bin), ...args], { cwd: root, stdout: io.stdout, stderr: io.stderr });
      return result.status ?? 1;
    },
    focus: ({ suite, file, name }) => {
      const result = runLogged(process.execPath, [nodePath.join(__dirname, "core", "focused-run.cjs"), suite, file, ...(name === null ? [] : [name])], {
        cwd: root,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      return result.status ?? 1;
    },
  };
}

/** @param {Context} context @param {string} pkg @param {string} bin @param {string[]} args */
function runNodeTool(context, pkg, bin, args) {
  return (context.tools ?? installedTools(context)).launch(pkg, bin, args);
}

/**
 * The one test file of a registered suite that the focused-test command runs, and optionally a
 * literal test name. `--suite` names the suite and must agree with the file. The suite is always
 * passed to Vitest, so a file outside every suite's selection can never be run by accident or
 * reported as passing.
 * @typedef {{ suite: string, file: string, name: string | null }} Focus
 * @param {readonly string[]} args
 * @param {Role} role
 * @param {string} root
 * @param {(file: string) => boolean} exists whether a project-relative file exists
 * @returns {Focus}
 */
function focusOf(args, role, root, exists) {
  const suites = testing.suitesFor(role);
  const flags = parseArgs(args, { test: { required: true }, suite: { values: suites }, name: {} });
  const file = nodePath.relative(root, nodePath.resolve(root, flags.test)).split(nodePath.sep).join("/");
  const suite = file.startsWith("..") ? null : testing.suiteOf(role, file);
  if (suite === null || !exists(file)) {
    throw new UsageError(`--test must name an existing test file of a registered suite (${suites.join(", ")}) (got ${flags.test})`);
  }
  if (flags.suite !== undefined && flags.suite !== suite) throw new UsageError(`--test belongs to the ${suite} suite, not ${flags.suite}`);
  return { suite, file, name: flags.name ?? null };
}

/** @type {Handler} */
function testOne(args, context) {
  const focus = focusOf(args, readRole(context.root), context.root, (file) => existsSync(nodePath.join(context.root, file)));
  return (context.tools ?? installedTools(context)).focus(focus);
}

/** @returns {string[]} the scenario names: the integration test files a project carries */
function scenariosOf(/** @type {string} */ root) {
  const directory = nodePath.join(root, "tests", "integration");
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(".test.ts"))
        .map((name) => name.slice(0, -".test.ts".length))
        .sort()
    : [];
}

/** @type {Handler} */
function testIntegration(args, context) {
  const { scenario } = parseArgs(args, { scenario: { values: scenariosOf(context.root) } });
  return runNodeTool(context, "vitest", "vitest", [
    "run",
    "--project",
    "integration",
    ...(scenario === undefined ? [] : [`tests/integration/${scenario}.test.ts`]),
  ]);
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

/**
 * @typedef {{
 *   clear: (suite: string) => void,
 *   measure: (suite: string) => number,
 *   summary: (suite: string) => unknown,
 *   io: Io,
 * }} UnitHost what the unit gate needs from the outside: the stale report, one Vitest coverage run, and the report it wrote
 */

/**
 * Runs every coverage-measured suite as its own Vitest invocation, so each suite is held to its own
 * thresholds, then refuses a scope that measured nothing. All suites run even when one fails, and a
 * report left by an earlier run never counts.
 * @param {readonly string[]} suites
 * @param {UnitHost} host
 * @returns {number}
 */
function unitGate(suites, host) {
  let failed = false;
  for (const suite of suites) {
    host.clear(suite);
    host.io.stdout(`unit: ${suite}\n`);
    const status = host.measure(suite);
    const errors = status === 0 ? testing.summaryErrors(host.summary(suite)) : [];
    for (const error of errors) host.io.stderr(`unit: ${suite}: ${error}\n`);
    if (status !== 0 || errors.length > 0) failed = true;
  }
  return failed ? 1 : 0;
}

/** @type {Handler} */
function unit(args, context) {
  noArgs(args);
  const report = (/** @type {string} */ suite) => nodePath.join(context.root, testing.reportDirectory(suite));
  return unitGate(testing.coverageSuitesFor(readRole(context.root)), {
    io: context.io,
    clear: (suite) => {
      rmSync(report(suite), { recursive: true, force: true });
    },
    measure: (suite) => runNodeTool(context, "vitest", "vitest", ["run", "--config", `vitest.${suite}.config.ts`, "--coverage"]),
    summary: (suite) => readSummary(report(suite)),
  });
}

/** @param {string} text @returns {unknown} the parsed coverage summary, or null when it is not JSON */
function parseSummary(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {string} report @returns {unknown} the parsed coverage summary, or null when there is none */
function readSummary(report) {
  try {
    return parseSummary(readFileSync(nodePath.join(report, "coverage-summary.json"), "utf8"));
  } catch {
    return null;
  }
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

/**
 * Every gate runs even when an earlier one failed, so one run reports everything that is wrong.
 * @param {{ ok: boolean, output: string }} lock the frozen-lock check
 * @param {[name: string, gate: () => number][]} gates
 * @param {Io} io
 * @returns {number}
 */
function runGates(lock, gates, io) {
  const failures = [];
  if (lock.ok) io.stdout("lock: ok\n");
  else {
    io.stderr(`lock: pnpm-lock.yaml does not match package.json\n${lock.output}`);
    failures.push("lock");
  }
  for (const [name, gate] of gates) {
    if (gate() === 0) io.stdout(`${name}: ok\n`);
    else failures.push(name);
  }
  if (failures.length > 0) io.stderr(`check failed: ${failures.join(", ")}\n`);
  return failures.length > 0 ? 1 : 0;
}

/** @type {Handler} */
function check(args, context) {
  noArgs(args);
  /** @type {[string, Handler][]} */
  const gates = [
    ["format", formatCheck],
    ["lint", lint],
    ["typecheck", readRole(context.root) === "application" ? typecheckApplication : typecheckGenerator],
    ["unit", unit],
  ];
  return runGates(
    checkLock(context.root),
    gates.map(([name, gate]) => [name, () => gate([], context)]),
    context.io,
  );
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
  "test:integration": {
    script: "node scripts/development.cjs test:integration",
    handlers: { generator: testIntegration, application: testIntegration },
  },
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

module.exports = { COMMANDS, binOf, focusOf, main, parseSummary, runGates, scriptsFor, unit, unitGate };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
