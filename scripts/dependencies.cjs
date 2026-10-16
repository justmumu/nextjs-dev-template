// @ts-check
"use strict";
// Dependency commands: pnpm run deps:add | deps:remove | deps:upgrade (KTD11).
// Only the requested dependency-map change and the lock may change; the transaction enforces it.
const { existsSync } = require("node:fs");
const nodePath = require("node:path");
const { UsageError, parseArgs } = require("./core/args.cjs");
const { buildReview, isExactVersion } = require("./core/dependency-policy.cjs");
const { guardRefusal } = require("./core/install-state.cjs");
const { isObject, readObject } = require("./core/json.cjs");
const { redact } = require("./core/process.cjs");
const { gateErrors, readRole } = require("./core/toolchain.cjs");
const { runTransaction } = require("./core/transaction.cjs");

// An unscoped name never starts with a hyphen, so a value can never be read by pnpm as an option (`--global`).
const NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;
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
  if (selector !== null && !SELECTOR.test(selector))
    throw new UsageError(`unsupported version selector (use an exact version or a dist-tag): ${JSON.stringify(spec)}`);
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
  const file = nodePath.join(root, "tooling", "versions.json");
  return !existsSync(file) || readRole(root) !== "generator" ? {} : rootPins(readObject(file));
}

/** @param {import("./core/json.cjs").JsonObject} versions the parsed tooling/versions.json @returns {Record<string, string>} the pins of the generator's own dependencies */
function rootPins(versions) {
  const pins = isObject(versions.root) ? versions.root : {};
  return { ...stringMap(pins.dependencies), ...stringMap(pins.devDependencies) };
}

/** @param {unknown} value @returns {Record<string, string>} the string entries of an object, or none */
function stringMap(value) {
  return isObject(value)
    ? /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === "string")))
    : {};
}

/** @param {import("./core/json.cjs").JsonObject} manifest @returns {string[]} the names in its dependencies and devDependencies */
function namesOf(manifest) {
  return [
    ...new Set([
      ...Object.keys(isObject(manifest.dependencies) ? manifest.dependencies : {}),
      ...Object.keys(isObject(manifest.devDependencies) ? manifest.devDependencies : {}),
    ]),
  ];
}

/** @param {string} root @returns {string[]} the names of the dependencies and devDependencies of the project */
function dependencyNames(root) {
  return namesOf(readObject(nodePath.join(root, "package.json")));
}

/**
 * Reviewed tool pins change only through a reviewed tooling change. A named pin is refused, and an
 * all-dependency upgrade is the whole set or nothing: while any pin is a dependency the request is
 * refused instead of quietly upgrading a subset.
 * @param {Request} request @param {Record<string, string>} pins @param {readonly string[]} dependencies the names the project depends on
 * @returns {string | null} why the request cannot run, or null
 */
function pinRefusal(request, pins, dependencies) {
  if (request.action !== "upgrade" && Object.hasOwn(pins, request.name)) {
    return `${request.name} is a reviewed tool pin (${pins[request.name] ?? ""}); changing it is a reviewed tooling change, not a dependency change. Nothing was changed.`;
  }
  if (request.action === "upgrade" && request.name !== null && Object.hasOwn(pins, request.name)) {
    return `${request.name} is a reviewed tool pin (${pins[request.name] ?? ""}); upgrading it is a reviewed tooling change, not a dependency change. Nothing was changed.`;
  }
  if (request.action === "upgrade" && request.name === null) {
    const pinned = dependencies.filter((name) => Object.hasOwn(pins, name)).sort();
    if (pinned.length > 0) {
      return `An all-dependency upgrade cannot run: these are reviewed tool pins (${pinned.map((name) => `${name}@${pins[name] ?? ""}`).join(", ")}) and change only through a reviewed tooling change (tooling/versions.json, then the matching manifest edit and node scripts/bootstrap.cjs deps-lock). Upgrade other dependencies one at a time with deps:upgrade --package=<name>. Nothing was changed.`;
    }
  }
  return null;
}

/**
 * @typedef {{
 *   gateErrors: (root: string) => string[],
 *   guardRefusal: (root: string) => string | null,
 *   pins: (root: string) => Record<string, string>,
 *   dependencies: (root: string) => string[],
 *   transact: (options: Parameters<typeof runTransaction>[0]) => ReturnType<typeof runTransaction>,
 * }} Host what the command needs from the project and the package manager
 */

/** @type {Host} */
const HOST = {
  gateErrors,
  guardRefusal,
  pins: reviewedPins,
  dependencies: dependencyNames,
  transact: runTransaction,
};

/**
 * @param {readonly string[]} argv `[action, ...flags]`
 * @param {{ root?: string, io?: { stdout: (text: string) => unknown, stderr: (text: string) => unknown }, runner?: import("./core/transaction.cjs").Runner, host?: Host }} [options]
 * @returns {number}
 */
function main(argv, options = {}) {
  const root = options.root ?? nodePath.resolve(__dirname, "..");
  const io = options.io ?? { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
  const host = options.host ?? HOST;
  let request;
  try {
    request = requestFromArgv(argv[0] ?? "", argv.slice(1));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(
      `${error.message}\nusage: pnpm run deps:add --package=<name[@version]> --group=<prod|dev> | deps:remove --package=<name> --group=<prod|dev> | deps:upgrade [--package=<name>]\n`,
    );
    return 2;
  }
  const refusals = [...host.gateErrors(root), ...[host.guardRefusal(root)].filter((message) => message !== null)];
  if (refusals.length > 0) {
    io.stderr(`${refusals.join("\n")}\n`);
    return 1;
  }
  const pins = host.pins(root);
  const refusal = pinRefusal(request, pins, request.action === "upgrade" && request.name === null ? host.dependencies(root) : []);
  if (refusal !== null) {
    io.stderr(`${refusal}\n`);
    return 1;
  }
  const result = host.transact({ root, steps: [pnpmArgsFor(request)], plan: planFor(request, pins), runner: options.runner });
  io.stdout(redact(result.output));
  if (!result.ok) {
    const review = buildReview(result.output);
    io.stderr(
      `dependency change rejected; package.json, the lock and protected files were restored and the install is marked incomplete.\n${result.violations.map((line) => `- ${line}\n`).join("")}`,
    );
    if (review.length > 0) io.stderr(`These packages need a reviewed build decision (not adopted automatically): ${review.join(", ")}\n`);
    io.stderr("Run: node scripts/bootstrap.cjs repair\n");
    return 1;
  }
  io.stdout("Dependency change applied. Review package.json and pnpm-lock.yaml before committing.\n");
  return 0;
}

module.exports = { main, namesOf, parseSpec, pinRefusal, planFor, pnpmArgsFor, requestFromArgv, reviewedPins, rootPins };

if (require.main === module) process.exitCode = main(process.argv.slice(2), { root: nodePath.join(__dirname, "..") });
