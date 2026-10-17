// @ts-check
"use strict";
// What the workflows ask the repository instead of guessing: which role it has and whether the first-run
// initialization applies (`plan`) and which Node and pnpm the job really runs on (`toolchain`).
// The workflows are byte-identical in
// the generator and in every application, so these answers are the only thing that tells them apart.
// Decisions take plain values; the real files, Git and environment are read in `realHost`.
const nodePath = require("node:path");
const { UsageError, parseArgs } = require("../core/args.cjs");
const { checkEnvironment } = require("../core/toolchain.cjs");

/** The public repository of this template; its own checkout never initializes itself. */
const SOURCE_REPOSITORY = "justmumu/nextjs-dev-template";
const SENTINEL = "tooling/template-sentinel.json";

/**
 * @typedef {{ stdout: (text: string) => unknown, stderr: (text: string) => unknown }} Io
 * @typedef {{
 *   io: Io,
 *   env: NodeJS.ProcessEnv,
 *   role: () => "generator" | "application",
 *   exists: (path: string) => boolean,
 *   expected: () => { node: string, pnpm: string },
 *   actual: () => { node: string, pnpm: string | null, platform: string },
 *   append: (path: string, text: string) => unknown,
 * }} Host
 */

/**
 * Whether the first-run initialization applies: only the unconverted copy of the template (a generator
 * with its sentinel) in a repository that is not the template's own.
 * @param {{ role: string, sentinel: boolean, repository: string, source?: string }} input
 * @returns {{ role: string, initialize: boolean }}
 */
function plan({ role, sentinel, repository, source = SOURCE_REPOSITORY }) {
  return { role, initialize: role === "generator" && sentinel && repository !== "" && repository.toLowerCase() !== source };
}

/**
 * The Node and pnpm a job runs on, judged against what the project declares and the lane the workflow
 * declares: a different major or version is a failure, never a silent drift.
 * @param {{ node: string, pnpm: string | null, platform: string }} actual
 * @param {{ node: string, pnpm: string }} expected
 * @param {string} lane the declared Node major
 * @returns {{ summary: string, errors: string[] }}
 */
function toolchain(actual, expected, lane) {
  const errors = checkEnvironment(actual, expected);
  const major = (/** @type {string} */ version) => version.split(".")[0];
  if (major(actual.node) !== lane) errors.push(`this job declares the Node ${lane} lane but runs Node ${actual.node}`);
  if (major(expected.node) !== lane) errors.push(`this job declares the Node ${lane} lane but the project requires Node ${expected.node}`);
  return { summary: `Node ${actual.node} (lane ${lane}), pnpm ${actual.pnpm ?? "missing"}, ${actual.platform}`, errors };
}

/** @param {readonly string[]} argv @param {Host} host @returns {number} */
function main(argv, host) {
  const [command, ...rest] = argv;
  const { io } = host;
  if (command === "plan") {
    parseArgs(rest, {});
    const role = host.role();
    const answer = plan({ role, sentinel: host.exists(SENTINEL), repository: host.env.GITHUB_REPOSITORY ?? "" });
    const lines = `role=${answer.role}\ninitialize=${String(answer.initialize)}\n`;
    if (host.env.GITHUB_OUTPUT) host.append(host.env.GITHUB_OUTPUT, lines);
    io.stdout(lines);
    return 0;
  }
  if (command === "toolchain") {
    const { lane } = parseArgs(rest, { lane: { required: true, pattern: /^\d+$/ } });
    const { summary, errors } = toolchain(host.actual(), host.expected(), lane);
    if (host.env.GITHUB_STEP_SUMMARY) host.append(host.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    io.stdout(`${summary}\n`);
    for (const error of errors) io.stderr(`${error}\n`);
    return errors.length > 0 ? 1 : 0;
  }
  throw new UsageError("usage: node scripts/ci/context.cjs plan | toolchain --lane=<node major>");
}

/**
 * @typedef {{
 *   fs: Pick<typeof import("node:fs"), "existsSync" | "appendFileSync">,
 *   toolchain: Pick<typeof import("../core/toolchain.cjs"), "readRole" | "readExpected" | "pnpmVersion">,
 * }} Deps what the real project is read with: its files and toolchain facts
 */

/** @returns {Deps} */
function loadDeps() {
  return {
    fs: require("node:fs"),
    toolchain: require("../core/toolchain.cjs"),
  };
}

/**
 * The real project: the files of `root` and the Node and pnpm that run it.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 * @param {Io} io
 * @param {Deps} [deps]
 * @returns {Host}
 */
function realHost(root, env, io, deps = loadDeps()) {
  const { fs, toolchain: facts } = deps;
  return {
    io,
    env,
    role: () => facts.readRole(root),
    exists: (path) => fs.existsSync(nodePath.join(root, path)),
    expected: () => facts.readExpected(root),
    actual: () => ({ node: process.versions.node, pnpm: facts.pnpmVersion(root), platform: `${process.platform}-${process.arch}` }),
    append: (path, text) => {
      fs.appendFileSync(path, text);
    },
  };
}

module.exports = { SENTINEL, SOURCE_REPOSITORY, loadDeps, main, plan, realHost, toolchain };

if (require.main === module) {
  const io = { stdout: (/** @type {string} */ text) => process.stdout.write(text), stderr: (/** @type {string} */ text) => process.stderr.write(text) };
  try {
    process.exitCode = main(process.argv.slice(2), realHost(nodePath.resolve(__dirname, "..", ".."), process.env, io));
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
