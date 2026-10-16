// @ts-check
"use strict";
// Dependency commands: pnpm run deps:add | deps:remove | deps:upgrade (KTD11).
// Only the requested dependency-map change and the lock may change; the transaction enforces it.
const { existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { UsageError, parseArgs } = require("./core/args.cjs");
const { buildReview, isExactVersion } = require("./core/dependency-policy.cjs");
const { guardRefusal } = require("./core/install-state.cjs");
const { redact } = require("./core/process.cjs");
const { gateErrors, readRole } = require("./core/toolchain.cjs");
const { runTransaction } = require("./core/transaction.cjs");

const NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SELECTOR = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[a-z][a-z0-9-]*)$/;
const GROUP_FLAGS = { prod: "--save-prod", dev: "--save-dev" };

/**
 * One literal package: `name` or `name@<exact version | dist-tag>`. URLs, aliases, ranges and
 * anything shell-like are not specifiers.
 * @param {string} spec
 * @returns {{ name: string, selector: string | null }}
 */
function parseSpec(spec) {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const selector = at > 0 ? spec.slice(at + 1) : null;
  if (!NAME.test(name) || name.length > 214) throw new UsageError(`unsupported package name: ${JSON.stringify(spec)}`);
  if (selector !== null && !SELECTOR.test(selector)) throw new UsageError(`unsupported version selector (use an exact version or a dist-tag): ${JSON.stringify(spec)}`);
  return { name, selector };
}

/**
 * @typedef {{ action: "add", group: "prod" | "dev", name: string, spec: string }
 *   | { action: "remove", group: "prod" | "dev", name: string }
 *   | { action: "upgrade", name: string | null }} Request
 */

/**
 * @param {string} action
 * @param {readonly string[]} argv
 * @returns {Request}
 */
function requestFromArgv(action, argv) {
  if (action === "upgrade") {
    const { package: name } = parseArgs(argv, { package: {} });
    return { action, name: name === undefined ? null : parseSpecName(name) };
  }
  if (action !== "add" && action !== "remove") throw new UsageError(`unknown dependency command: ${action}`);
  const flags = parseArgs(argv, { package: { required: true }, group: { required: true, values: ["prod", "dev"] } });
  const group = /** @type {"prod" | "dev"} */ (flags.group);
  if (action === "remove") return { action, group, name: parseSpecName(flags.package) };
  return { action, group, name: parseSpec(flags.package).name, spec: flags.package };
}

/** @param {string} value @returns {string} a bare package name */
function parseSpecName(value) {
  const { name, selector } = parseSpec(value);
  if (selector !== null) throw new UsageError(`expected a package name without a version: ${JSON.stringify(value)}`);
  return name;
}

/**
 * @param {Request} request
 * @returns {string[]}
 */
function pnpmArgsFor(request) {
  if (request.action === "add") return ["add", GROUP_FLAGS[request.group], "--save-exact", request.spec];
  if (request.action === "remove") return ["remove", GROUP_FLAGS[request.group], request.name];
  return ["update", "--latest", "--save-exact", ...(request.name === null ? [] : [request.name])];
}

/**
 * The exact version a request pins, when it names one; a dist-tag or bare name resolves to whatever
 * the registry says, and the transaction only demands that it is an exact registry version.
 * @param {Request} request
 * @param {Record<string, string>} pinned
 * @returns {import("./core/transaction.cjs").Plan}
 */
function planFor(request, pinned = {}) {
  if (request.action === "upgrade") return { action: "upgrade", name: request.name, pinned };
  if (request.action === "add") {
    const selector = parseSpec(request.spec).selector;
    return { action: "add", group: request.group, name: request.name, version: selector !== null && isExactVersion(selector) ? selector : null, pinned };
  }
  return { action: "remove", group: request.group, name: request.name, pinned };
}

/**
 * Reviewed tool pins of the generator itself (tooling/versions.json). They change only through a
 * reviewed tooling change, never through the dependency commands; an application has none.
 * @param {string} root
 * @returns {Record<string, string>}
 */
function reviewedPins(root) {
  const file = join(root, "tooling", "versions.json");
  if (!existsSync(file) || readRole(root) !== "generator") return {};
  const { root: pins } = JSON.parse(readFileSync(file, "utf8"));
  return { ...pins.dependencies, ...pins.devDependencies };
}

/**
 * An all-dependency upgrade is the whole set or nothing: reviewed tool pins change only through a
 * reviewed tooling change, so while any of them is a dependency the request is refused instead of
 * quietly upgrading a subset.
 * @param {string} root @param {Record<string, string>} pins
 * @returns {string[]} the pinned names that are dependencies of the project
 */
function pinnedDependencies(root, pins) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})])].filter((name) => Object.hasOwn(pins, name)).sort();
}

/**
 * @param {readonly string[]} argv `[action, ...flags]`
 * @param {{ root?: string, io?: { stdout: (text: string) => unknown, stderr: (text: string) => unknown }, runner?: import("./core/transaction.cjs").Runner }} [options]
 * @returns {number}
 */
function main(argv, options = {}) {
  const root = options.root ?? resolve(__dirname, "..");
  const io = options.io ?? { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
  let request;
  try {
    request = requestFromArgv(argv[0] ?? "", argv.slice(1));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${error.message}\nusage: pnpm run deps:add --package=<name[@version]> --group=<prod|dev> | deps:remove --package=<name> --group=<prod|dev> | deps:upgrade [--package=<name>]\n`);
    return 2;
  }
  const refusals = [...gateErrors(root), ...[guardRefusal(root)].filter((message) => message !== null)];
  if (refusals.length > 0) {
    io.stderr(`${refusals.join("\n")}\n`);
    return 1;
  }
  const pins = reviewedPins(root);
  if (request.action !== "upgrade" && Object.hasOwn(pins, request.name)) {
    io.stderr(`${request.name} is a reviewed tool pin (${pins[request.name]}); changing it is a reviewed tooling change, not a dependency change. Nothing was changed.\n`);
    return 1;
  }
  if (request.action === "upgrade" && request.name !== null && Object.hasOwn(pins, request.name)) {
    io.stderr(`${request.name} is a reviewed tool pin (${pins[request.name]}); upgrading it is a reviewed tooling change, not a dependency change. Nothing was changed.\n`);
    return 1;
  }
  if (request.action === "upgrade" && request.name === null) {
    const pinned = pinnedDependencies(root, pins);
    if (pinned.length > 0) {
      io.stderr(`An all-dependency upgrade cannot run: these are reviewed tool pins (${pinned.map((name) => `${name}@${pins[name]}`).join(", ")}) and change only through a reviewed tooling change (tooling/versions.json, then the matching manifest edit and node scripts/bootstrap.cjs deps-lock). Upgrade other dependencies one at a time with deps:upgrade --package=<name>. Nothing was changed.\n`);
      return 1;
    }
  }
  const result = runTransaction({ root, steps: [pnpmArgsFor(request)], plan: planFor(request, pins), runner: options.runner });
  io.stdout(redact(result.output));
  if (!result.ok) {
    const review = buildReview(result.output);
    io.stderr(`dependency change rejected; package.json, the lock and protected files were restored and the install is marked incomplete.\n${result.violations.map((line) => `- ${line}\n`).join("")}`);
    if (review.length > 0) io.stderr(`These packages need a reviewed build decision (not adopted automatically): ${review.join(", ")}\n`);
    io.stderr("Run: node scripts/bootstrap.cjs repair\n");
    return 1;
  }
  io.stdout("Dependency change applied. Review package.json and pnpm-lock.yaml before committing.\n");
  return 0;
}

module.exports = { main, parseSpec, planFor, pnpmArgsFor, requestFromArgv, reviewedPins };

if (require.main === module) process.exitCode = main(process.argv.slice(2), { root: join(__dirname, "..") });
