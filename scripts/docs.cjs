// @ts-check
"use strict";
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const nodePath = require("node:path");
const { run } = require("./core/process.cjs");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BASE = /^\/(?:[A-Za-z0-9._~-]+\/)*$/;

/**
 * @typedef {{ base: string, cleanUrls: boolean, outDir: string }} Site what VitePress resolved from the site configuration
 * @typedef {{ from: string, to: string }} Copy a file of the build output and where the staged web root holds it, both relative
 * @typedef {{
 *   io: { stdout: (text: string) => unknown, stderr: (text: string) => unknown },
 *   vitepress: () => number,
 *   site: () => Site,
 *   emitted: (outDir: string) => string[],
 *   check: (outDir: string, plan: Copy[], inputs: string[]) => number,
 * }} Host the effects of the gate: the site build, the resolved configuration, the emitted files and the staged check
 */

/**
 * The version a site announces: the one in the package it documents.
 * @param {unknown} manifest the parsed package.json of the documented project
 * @returns {string}
 */
function docsVersion(manifest) {
  const version = typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : undefined;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`package.json needs a semantic "version" for the documentation (got ${JSON.stringify(version)})`);
  }
  return version;
}

/**
 * The base path a site is deployed under: `/` or `/segment/`, taken from DOCS_BASE.
 * @param {string | undefined} value
 * @returns {string}
 */
function siteBase(value) {
  if (value === undefined || value === "") return "/";
  if (!BASE.test(value) || value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`DOCS_BASE must be "/" or a path such as "/repo-name/" (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Where each emitted file sits in the web root the hosting would serve. Pages are served from
 * `<base>`; with clean URLs a page also answers without `.html`, which a static host does by
 * rewriting, not redirecting, so the staged root holds that extensionless answer next to the file.
 * @param {{ files: readonly string[], base: string, cleanUrls: boolean }} input files relative to the build output
 * @returns {Copy[]}
 */
function stagePlan({ files, base, cleanUrls }) {
  const prefix = base.slice(1);
  /** @type {Copy[]} */
  const plan = [];
  for (const file of files) {
    plan.push({ from: file, to: `${prefix}${file}` });
    if (cleanUrls && file.endsWith(".html")) plan.push({ from: file, to: `${prefix}${file.slice(0, -".html".length)}` });
  }
  return plan;
}

/**
 * The hyperlink arguments: the staged web root, internal targets only, and every emitted HTML file
 * as an input. No suppression or todo option is ever passed.
 * @param {{ webRoot: string, inputs: readonly string[] }} input
 * @returns {string[]}
 */
function checkerArgs({ webRoot, inputs }) {
  return ["--root", webRoot, "--internal", ...inputs];
}

/**
 * Every file below a directory, relative with forward slashes and sorted; the whole output is
 * enumerated, so a page nothing links to is checked too.
 * @param {string} directory
 * @param {Pick<typeof fs, "readdirSync">} [files]
 * @returns {string[]}
 */
function outputFiles(directory, files = fs) {
  return files
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => nodePath.relative(directory, nodePath.join(entry.parentPath, entry.name)).split(nodePath.sep).join("/"))
    .sort();
}

/**
 * @param {Host} host
 * @returns {number} the exit status: the build's or the checker's, never a masked success
 */
function build(host) {
  const built = host.vitepress();
  if (built !== 0) return built;
  const site = host.site();
  const files = host.emitted(site.outDir);
  const pages = files.filter((file) => file.endsWith(".html"));
  if (pages.length === 0) {
    host.io.stderr(`docs: the build emitted no HTML in ${site.outDir}\n`);
    return 1;
  }
  const inputs = pages.map((page) => `${site.base.slice(1)}${page}`);
  const status = host.check(site.outDir, stagePlan({ files, base: site.base, cleanUrls: site.cleanUrls }), inputs);
  if (status !== 0) host.io.stderr("docs: the internal link check failed\n");
  return status;
}

/**
 * @param {{
 *   root: string,
 *   io: Host["io"],
 *   launch: (pkg: string, bin: string, args: string[]) => number,
 *   start?: typeof run,
 *   disk?: Pick<typeof fs, "copyFileSync" | "mkdirSync" | "mkdtempSync" | "readdirSync" | "realpathSync" | "rmSync">,
 * }} options
 * @returns {Host}
 */
function realHost({ root, io, launch, start = run, disk = fs }) {
  return {
    io,
    vitepress: () => launch("vitepress", "vitepress", ["build", "docs"]),
    site: () => {
      const result = start(process.execPath, [__filename, "site", root], { cwd: root });
      if (result.status !== 0) throw new Error(`the site configuration could not be resolved:\n${result.stderr}`);
      /** @type {unknown} */
      const site = JSON.parse(result.stdout);
      return /** @type {Site} */ (site);
    },
    emitted: (outDir) => outputFiles(outDir, disk),
    check: (outDir, plan, inputs) => {
      const stage = disk.realpathSync(disk.mkdtempSync(nodePath.join(tmpdir(), "docs-check-")));
      try {
        for (const { from, to } of plan) {
          disk.mkdirSync(nodePath.dirname(nodePath.join(stage, to)), { recursive: true });
          disk.copyFileSync(nodePath.join(outDir, from), nodePath.join(stage, to));
        }
        return launch("hyperlink", "hyperlink", checkerArgs({ webRoot: stage, inputs: inputs.map((input) => nodePath.join(stage, input)) }));
      } finally {
        disk.rmSync(stage, { recursive: true, force: true });
      }
    },
  };
}

/**
 * The resolved site configuration, as VitePress itself sees it.
 * @param {string} root
 * @returns {Promise<Site>}
 */
async function resolveSite(root) {
  const { resolveConfig } = await import("vitepress");
  const config = await resolveConfig(nodePath.join(root, "docs"), "build", "production");
  return { base: config.site.base, cleanUrls: config.cleanUrls === true, outDir: config.outDir };
}

module.exports = { build, checkerArgs, docsVersion, outputFiles, realHost, resolveSite, siteBase, stagePlan };

if (require.main === module) {
  const [command, root] = process.argv.slice(2);
  if (command !== "site" || root === undefined) {
    process.stderr.write("usage: node scripts/docs.cjs site <root>\n");
    process.exitCode = 2;
  } else {
    resolveSite(root).then(
      (site) => process.stdout.write(`${JSON.stringify(site)}\n`),
      (/** @type {unknown} */ error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
  }
}
