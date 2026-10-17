// @ts-check
"use strict";
// The pristine side of an update: the template at one explicit source revision, read as data and
// rendered with the project's original answers into the next pristine snapshot B1, whose only
// parent is the current baseline B0. Nothing from the fetched source is ever required or run: its
// manifest is JSON, its files are bytes, and the installed engine does the rest.
const nodePath = require("node:path");
const render = require("./render.cjs");
const { PROTOCOL, RenderError, SCHEMA, isRecord, parseManifest } = require("./manifest.cjs");
const { Refusal } = require("./provenance.cjs");
const { PRISTINE_MESSAGE } = require("./state.cjs");

/** Where a source revision keeps its declarative manifest, and the directory its template base lives in. */
const MANIFEST_PATH = "tooling/template-manifest.json";
const TEMPLATE_BASE = "template/app";
/** The public repository updates come from. A ref is chosen per preview; the repository is not. */
const SOURCE_URL = "https://github.com/justmumu/nextjs-dev-template.git";
const REF = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MODES = new Map([
  ["100644", 0o644],
  ["100755", 0o755],
]);
const CHUNK = 100;

/**
 * @typedef {Pick<ReturnType<typeof import("./git.cjs").createGit>, "blob" | "init" | "out" | "fetchRef" | "commitSnapshot">} UpdateGit
 * @typedef {{ mkdirSync: (path: string, options: { recursive: true }) => unknown, writeFileSync: (path: string, content: Buffer, options: { mode: number }) => void, chmodSync: (path: string, mode: number) => void }} Disk
 * @typedef {{ sha: string, tree: string, committedAt: number }} Source
 */

/** @param {unknown} ref @returns {string} the ref, if it is a plain ref name or a full object id and cannot be read as an option */
function validateRef(ref) {
  if (
    typeof ref !== "string" ||
    ref.length > 200 ||
    !REF.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock")
  ) {
    throw new Refusal("invalid-ref", `not a usable ref: ${JSON.stringify(ref)}`);
  }
  return ref;
}

/**
 * Resolves one explicit ref of the source repository to a full commit, in a repository of its own
 * that holds that commit and nothing else: no tags, no other branches.
 * @param {{ git: UpdateGit, dir: string, url: string, ref: string }} input `dir` is an empty directory
 * @returns {Source}
 */
function fetchSource({ git, dir, url, ref }) {
  validateRef(ref);
  git.init(dir);
  try {
    git.fetchRef(dir, url, ref);
  } catch (error) {
    throw new Refusal("source-unreachable", `the ref ${ref} could not be fetched: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sha = git.out(dir, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], true).trim();
  if (!OBJECT_ID.test(sha)) throw new Refusal("source-unreachable", `the ref ${ref} did not resolve to a commit`);
  const committedAt = Number(git.out(dir, ["show", "-s", "--format=%ct", sha], true).trim());
  if (!Number.isSafeInteger(committedAt) || committedAt < 0) throw new Refusal("source-invalid", `the commit ${sha} has no usable date`);
  return { sha, tree: git.out(dir, ["rev-parse", "--verify", `${sha}^{tree}`], true).trim(), committedAt };
}

/**
 * @param {{ git: UpdateGit, dir: string, sha: string }} input
 * @returns {unknown} the source's manifest as data, once its schema and protocol are ones this engine supports
 */
function readSourceManifest({ git, dir, sha }) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(git.blob(dir, `${sha}:${MANIFEST_PATH}`).toString("utf8"));
  } catch {
    throw new Refusal("source-invalid", `the source ${sha} has no readable ${MANIFEST_PATH}`);
  }
  if (!isRecord(raw) || raw.schema !== SCHEMA || raw.protocol !== PROTOCOL) {
    throw new Refusal(
      "engine-upgrade-required",
      `the source ${sha} uses a manifest schema or protocol this installed engine does not support; upgrade the engine, nothing was run`,
    );
  }
  return raw;
}

/**
 * Writes the files a manifest reads from the source revision into two base directories, exactly as
 * stored. Only regular files are accepted; the source is never checked out.
 * @param {{ git: UpdateGit, dir: string, sha: string, manifest: unknown, into: string, disk: Disk }} input
 * @returns {import("./render.cjs").Bases}
 */
function materialize({ git, dir, sha, manifest, into, disk }) {
  /** @type {ReturnType<typeof parseManifest>} */
  let parsed;
  try {
    parsed = parseManifest(manifest);
  } catch (error) {
    if (error instanceof RenderError) throw new Refusal("source-invalid", error.message);
    throw error;
  }
  const bases = { template: nodePath.join(into, "template"), root: nodePath.join(into, "root") };
  const wanted = new Map(parsed.entries.map((entry) => [entry.base === "template" ? `${TEMPLATE_BASE}/${entry.source}` : entry.source, entry]));
  const paths = [...wanted.keys()];
  /** @type {Map<string, number>} */
  const modes = new Map();
  for (let i = 0; i < paths.length; i += CHUNK) {
    const listing = git.out(dir, ["ls-tree", "-z", sha, "--", ...paths.slice(i, i + CHUNK)], true);
    for (const line of listing.split("\0").filter((entry) => entry !== "")) {
      const match = /^(\d+) (\w+) [0-9a-f]+\t([\s\S]+)$/.exec(line);
      const mode = match && match[2] === "blob" ? MODES.get(match[1] ?? "") : undefined;
      if (!match || mode === undefined) throw new Refusal("source-invalid", `${line.split("\t")[1] ?? line} in the source is not a regular file`);
      modes.set(match[3] ?? "", mode);
    }
  }
  for (const [path, entry] of wanted) {
    const mode = modes.get(path);
    if (mode === undefined) throw new Refusal("source-invalid", `${path} is declared by the manifest but absent from the source ${sha}`);
    const target = nodePath.join(bases[entry.base], ...entry.source.split("/"));
    disk.mkdirSync(nodePath.dirname(target), { recursive: true });
    disk.writeFileSync(target, git.blob(dir, `${sha}:${path}`), { mode });
    disk.chmodSync(target, mode);
  }
  return bases;
}

/**
 * Renders the source with the project's original answers and records the result as a commit whose
 * only parent is `parent`, in the repository `gitDir`. The date is the source commit's, so the same
 * source and answers always give the same commit.
 * @param {{
 *   git: UpdateGit,
 *   sourceDir: string,
 *   source: Source,
 *   manifest: unknown,
 *   answers: unknown,
 *   parent: string,
 *   gitDir: string,
 *   workspace: string,
 *   disk: Disk,
 *   write: (files: readonly import("./render.cjs").RenderedFile[], dir: string) => unknown,
 * }} input `workspace` is an empty directory for the materialized source and the rendered files
 * @returns {{ commit: string, tree: string, digest: string, files: number }}
 */
function nextPristine({ git, sourceDir, source, manifest, answers, parent, gitDir, workspace, disk, write }) {
  const bases = materialize({ git, dir: sourceDir, sha: source.sha, manifest, into: nodePath.join(workspace, "source"), disk });
  const { files, digest } = render.renderTree({ manifest, bases, answers });
  const rendered = nodePath.join(workspace, "render");
  write(files, rendered);
  const date = `@${String(source.committedAt)} +0000`;
  const { commit, tree } = git.commitSnapshot(gitDir, rendered, files, { parent, message: PRISTINE_MESSAGE, date });
  return { commit, tree, digest, files: files.length };
}

module.exports = { MANIFEST_PATH, SOURCE_URL, fetchSource, materialize, nextPristine, readSourceManifest, validateRef };
