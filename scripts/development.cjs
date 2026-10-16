// @ts-check
"use strict";
// Routine development commands behind `pnpm run <script>`. The definitions below are the single
// source of the package.json scripts of both the generator and generated applications.
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join, relative, resolve, sep } = require("node:path");
const { UsageError, parseArgs } = require("./core/args.cjs");
const { runLogged } = require("./core/process.cjs");
const { gateErrors, readRole } = require("./core/toolchain.cjs");
const { checkLock } = require("./core/transaction.cjs");

/**
 * @typedef {"generator" | "application"} Role
 * @typedef {{ stdout: (text: string) => unknown, stderr: (text: string) => unknown }} Io
 * @typedef {{ root: string, cwd: string, io: Io }} Context
 * @typedef {(args: readonly string[], context: Context) => number} Handler
 */

const ROLES = /** @type {const} */ (["generator", "application"]);
const INTEGRATION_SCENARIOS = /** @type {Record<string, string>} */ ({
  dependencies: "tests/integration/dependencies.test.ts",
  toolchain: "tests/integration/toolchain.test.ts",
  "rendered-app-install": "tests/integration/rendered-app-install.test.ts",
  "no-python": "tests/integration/no-python.test.ts",
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
  const dir = join(root, "node_modules", pkg);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin[bin];
  return join(dir, rel);
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
  const path = resolve(root, flags.test);
  const rel = relative(root, path);
  if (rel.startsWith("..") || !rel.startsWith(`tests${sep}`) || !/\.test\.ts$/.test(rel) || !existsSync(path)) {
    throw new UsageError(`--test must name an existing *.test.ts file under tests/ (got ${flags.test})`);
  }
  const selected = ["run", rel.split(sep).join("/")];
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
  const files = scenario === undefined
    ? readdirSync(join(context.root, "tests", "integration")).filter((name) => name.endsWith(".test.ts")).sort().map((name) => `tests/integration/${name}`)
    : [INTEGRATION_SCENARIOS[scenario]];
  return runNodeTool(context, "vitest", "vitest", ["run", ...files]);
}

/** @type {Handler} */
function typecheckGenerator(args, context) {
  noArgs(args);
  return runNodeTool(context, "typescript", "tsc", ["--noEmit", "-p", "tsconfig.json"]);
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
    ["format", unavailable("U4", "format check")],
    ["lint", unavailable("U4", "lint")],
    ["typecheck", COMMANDS.typecheck.handlers[readRole(context.root)] ?? unavailable("U4", "typecheck")],
    ["unit", unavailable("U5", "unit tests with coverage")],
  ]);
  for (const [name, gate] of gates) {
    if (gate([], context) === 0) context.io.stdout(`${name}: ok\n`);
    else failures.push(name);
  }
  if (failures.length > 0) context.io.stderr(`check failed: ${failures.join(", ")}\n`);
  return failures.length > 0 ? 1 : 0;
}

/** @type {Handler} */
function templateCreate(args, { cwd, io }) {
  const flags = parseArgs(args, { name: { required: true }, owner: { required: true }, dest: { required: true } });
  const render = require("./template/render.cjs");
  const { manifest, bases } = render.defaultInputs();
  const { files, digest } = render.renderTree({ manifest, bases, answers: { name: flags.name, owner: flags.owner } });
  render.writeTree(files, resolve(cwd, flags.dest));
  io.stdout(`${JSON.stringify({ files: files.length, digest })}\n`);
  return 0;
}

/** @type {Handler} */
function seedRefresh(args, { root, io }) {
  noArgs(args);
  return require("./template/seed.cjs").refreshSeed({ root, io });
}

/**
 * `handlers` is absent for commands owned by another dispatcher. A role without a handler does not
 * receive the script at all.
 * @type {Record<string, { script: string, handlers: Partial<Record<Role, Handler>> }>}
 */
const COMMANDS = {
  check: { script: "node scripts/development.cjs check", handlers: { generator: check, application: check } },
  typecheck: { script: "node scripts/development.cjs typecheck", handlers: { generator: typecheckGenerator, application: unavailable("U4", "application typecheck") } },
  format: { script: "node scripts/development.cjs format", handlers: { generator: unavailable("U4", "format"), application: unavailable("U4", "format") } },
  "lint:fix": { script: "node scripts/development.cjs lint:fix", handlers: { generator: unavailable("U4", "lint:fix"), application: unavailable("U4", "lint:fix") } },
  "test:one": { script: "node scripts/development.cjs test:one", handlers: { generator: testOne, application: testOne } },
  "test:integration": { script: "node scripts/development.cjs test:integration", handlers: { generator: testIntegration } },
  "test:permissions": { script: "node scripts/development.cjs test:permissions", handlers: { generator: unavailable("U6", "test:permissions"), application: unavailable("U6", "test:permissions") } },
  "deps:add": { script: "node scripts/dependencies.cjs add", handlers: {} },
  "deps:remove": { script: "node scripts/dependencies.cjs remove", handlers: {} },
  "deps:upgrade": { script: "node scripts/dependencies.cjs upgrade", handlers: {} },
  "template:create": { script: "node scripts/development.cjs template:create", handlers: { generator: templateCreate } },
  "template:seed:refresh": { script: "node scripts/development.cjs template:seed:refresh", handlers: { generator: seedRefresh } },
};
const EXTERNAL = new Set(["deps:add", "deps:remove", "deps:upgrade"]);

/**
 * The package.json `scripts` a project of this role carries.
 * @param {Role} role
 * @returns {Record<string, string>}
 */
function scriptsFor(role) {
  const scripts = /** @type {Record<string, string>} */ ({});
  for (const name of Object.keys(COMMANDS).sort()) {
    const { script, handlers } = COMMANDS[name];
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
  const root = options.root ?? resolve(__dirname, "..");
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
    io.stderr(`${name} is not part of ${role} projects\n`);
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
