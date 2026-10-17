// @ts-check
"use strict";
// Maintainer-only test harness of the generator's CI, never emitted into an application: the acceptance
// run of the template in an image that has Node, pnpm and Git but no Python, uv or Make, and the seccomp
// profile that lets that image create the unprivileged user and network namespaces the offline build
// proof needs. The image is a test environment, not a deployment recipe.
const nodeCrypto = require("node:crypto");
const nodePath = require("node:path");
const { UsageError, parseArgs } = require("../core/args.cjs");
const { isObject } = require("../core/json.cjs");

/**
 * The Moby default seccomp profile at a pinned revision (Apache-2.0, https://github.com/moby/profiles).
 * It is downloaded and checked against this digest at the time of use and is not copied into this repository.
 */
const UPSTREAM = Object.freeze({
  revision: "4b8214fc4971e06172938a1f1554ccff6647ee80",
  url: "https://raw.githubusercontent.com/moby/profiles/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json",
  sha256: "6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6",
});
/** `unshare` whose flags are exactly CLONE_NEWUSER | CLONE_NEWNET (0x10000000 | 0x40000000): nothing else is added to the profile. */
const NAMESPACE_RULE = Object.freeze({
  names: ["unshare"],
  action: "SCMP_ACT_ALLOW",
  args: [{ index: 0, value: 1342177280, op: "SCMP_CMP_EQ" }],
});
/** Tools whose presence would make the acceptance prove nothing about a machine without Python. */
const FORBIDDEN = Object.freeze(["python", "python3", "pip", "pip3", "uv", "make", "copier"]);
/** The scenarios of the integration suite that exercise creation routes, update, recovery and release with real Git and real tools. */
const SCENARIOS = Object.freeze([
  "template-create",
  "template-initialize",
  "template-preview",
  "template-update",
  "template-recovery",
  "release",
  "release-lineage",
]);

/**
 * The upstream profile plus the one namespace rule. A profile that is not the pinned bytes, or that
 * already decides the rule, is refused rather than adapted.
 * @param {string} upstream the downloaded profile
 * @param {string} [sha256] the expected digest of `upstream`
 * @returns {string} the profile to run the image with
 */
function deriveProfile(upstream, sha256 = UPSTREAM.sha256) {
  const actual = nodeCrypto.createHash("sha256").update(upstream).digest("hex");
  if (actual !== sha256) throw new Error(`the seccomp profile is not the pinned one (revision ${UPSTREAM.revision}): its digest is ${actual}`);
  /** @type {unknown} */
  const profile = JSON.parse(upstream);
  if (!isObject(profile) || !Array.isArray(profile.syscalls)) throw new Error("the seccomp profile has no syscall rules");
  /** @type {unknown[]} */
  const rules = profile.syscalls;
  if (rules.some((rule) => JSON.stringify(rule) === JSON.stringify(NAMESPACE_RULE))) throw new Error("the seccomp profile already carries the namespace rule");
  return `${JSON.stringify({ ...profile, syscalls: [...rules, NAMESPACE_RULE] }, null, "\t")}\n`;
}

/**
 * @typedef {{ name: string, command: string, args: string[], cwd: string }} Step
 * @typedef {{
 *   which: (name: string) => string | null,
 *   run: (command: string, args: readonly string[], options: { cwd: string }) => number | null,
 *   io: { stdout: (text: string) => unknown, stderr: (text: string) => unknown },
 * }} Host the tools on the machine and the way to start one attached to the output
 */

/**
 * The acceptance chain: a noreply Git identity for the commits it makes and a committed clone of the source, then, in order, the installation from its
 * frozen lock, the root's own gates, the creation of an application (which validates it in a staging
 * copy, build and start included), that application's setup and gates, and the creation, update,
 * recovery and release scenarios with real Git.
 * @param {{ source: string, work: string }} dirs
 * @returns {Step[]}
 */
function acceptanceSteps({ source, work }) {
  const repo = nodePath.join(work, "repo");
  const app = nodePath.join(work, "app");
  /** @param {string} name @param {string} command @param {string[]} args @param {string} cwd @returns {Step} */
  const step = (name, command, args, cwd) => ({ name, command, args, cwd });
  return [
    step("git name", "git", ["config", "--global", "user.name", "github-actions[bot]"], work),
    step("git email", "git", ["config", "--global", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], work),
    step("git trust", "git", ["config", "--global", "--add", "safe.directory", nodePath.join(source, ".git")], work),
    step("clone", "git", ["clone", "--quiet", "--no-hardlinks", source, repo], work),
    step("install", "pnpm", ["install", "--frozen-lockfile"], repo),
    step("check", "pnpm", ["run", "check"], repo),
    step("docs", "pnpm", ["run", "docs:build"], repo),
    step("create", "pnpm", ["run", "template:create", "--name=acceptance-app", "--owner=acceptance", `--dest=${app}`], repo),
    step("app setup", process.execPath, ["scripts/bootstrap.cjs", "setup"], app),
    step("app check", "pnpm", ["run", "check"], app),
    step("app docs", "pnpm", ["run", "docs:build"], app),
    step("app build", "pnpm", ["run", "build"], app),
    ...SCENARIOS.map((scenario) => step(`scenario ${scenario}`, "pnpm", ["run", "test:integration", `--scenario=${scenario}`], repo)),
  ];
}

/** @param {Host} host @returns {string[]} the forbidden tools that are on the machine */
function forbiddenFound(host) {
  return FORBIDDEN.filter((name) => host.which(name) !== null);
}

/**
 * Runs the chain once, to its first failure. The absence of Python, uv and Make is asserted before
 * and after everything else, so nothing the chain installed can have made them available unseen.
 * @param {Host} host
 * @param {{ source: string, work: string }} dirs
 * @returns {number} 0 only when every step passed and the forbidden tools were absent throughout
 */
function accept(host, dirs) {
  const { io } = host;
  /** @param {string} when @returns {boolean} */
  const absent = (when) => {
    const found = forbiddenFound(host);
    if (found.length > 0) io.stderr(`acceptance: ${found.join(", ")} present ${when}; this environment cannot show the template works without them\n`);
    return found.length === 0;
  };
  if (!absent("before the run")) return 1;
  for (const { name, command, args, cwd } of acceptanceSteps(dirs)) {
    io.stdout(`acceptance: ${name}\n`);
    const status = host.run(command, args, { cwd });
    if (status !== 0) {
      io.stderr(`acceptance: ${name} failed with status ${String(status)}\n`);
      return 1;
    }
  }
  if (!absent("after the run")) return 1;
  io.stdout("acceptance: passed\n");
  return 0;
}

/**
 * @typedef {{
 *   fetchText: (url: string) => Promise<string>,
 *   writeFile: (path: string, text: string) => unknown,
 *   makeDirectory: (path: string) => unknown,
 *   pin?: { url: string, sha256: string },
 * } & Host} Deps the command line's machine: the download, the files it writes and what the acceptance needs
 */

/**
 * @param {readonly string[]} argv
 * @param {Deps} deps
 * @returns {Promise<number>}
 */
async function cli(argv, deps) {
  const [command, ...rest] = argv;
  if (command === "profile") {
    const { out } = parseArgs(rest, { out: { required: true } });
    const pin = deps.pin ?? UPSTREAM;
    deps.writeFile(out, deriveProfile(await deps.fetchText(pin.url), pin.sha256));
    return 0;
  }
  if (command === "accept") {
    const { source, work } = parseArgs(rest, { source: { required: true }, work: { required: true } });
    deps.makeDirectory(work);
    return accept(deps, { source, work });
  }
  throw new UsageError("usage: node scripts/ci/no-python.cjs profile --out=<file> | accept --source=<dir> --work=<dir>");
}

module.exports = { FORBIDDEN, NAMESPACE_RULE, SCENARIOS, UPSTREAM, accept, acceptanceSteps, cli, deriveProfile, forbiddenFound };

if (require.main === module) {
  const fs = require("node:fs");
  const { resolveOnPath } = require("../core/toolchain.cjs");
  const { runInherited } = require("../core/process.cjs");
  const io = { stdout: (/** @type {string} */ text) => process.stdout.write(text), stderr: (/** @type {string} */ text) => process.stderr.write(text) };
  cli(process.argv.slice(2), {
    fetchText: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`the seccomp profile could not be downloaded (HTTP ${String(response.status)})`);
      return response.text();
    },
    writeFile: (path, text) => {
      fs.writeFileSync(path, text);
    },
    makeDirectory: (path) => {
      fs.mkdirSync(path, { recursive: true });
    },
    which: (name) => resolveOnPath(name, process.env.PATH ?? ""),
    run: (file, args, options) => runInherited(file, args, options).status,
    io,
  }).then(
    (status) => {
      process.exitCode = status;
    },
    (/** @type {unknown} */ error) => {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}
