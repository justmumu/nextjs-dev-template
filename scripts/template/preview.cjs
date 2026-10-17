// @ts-check
"use strict";
// `template:preview --ref=<ref>`: what taking a template revision would do to this project, found
// by a native Git three-way merge in a disposable full clone and written as a file bound to the
// exact HEAD, state, answers, installed engine, source commit and merge result it was made from.
// The project's own HEAD, index, refs and files are only read.
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const nodePath = require("node:path");
const { parseArgs } = require("../core/args.cjs");
const { createGit, indexKey } = require("./git.cjs");
const { PROTOCOL, SCHEMA, isRecord } = require("./manifest.cjs");
const { Refusal, sha256, verifyLineage } = require("./provenance.cjs");
const { SOURCE_URL, fetchSource, nextPristine, readSourceManifest, validateRef } = require("./pristine.cjs");
const render = require("./render.cjs");

const PREVIEW_SCHEMA = "nextjs-dev-template/preview";
const PREVIEW_VERSION = 1;
/** Where the latest preview of a project is kept: inside its Git directory, which is not tracked content. */
const PREVIEW_DIR = "template-update";
const PREVIEW_FILE = "preview.json";
/**
 * Every file of the installed engine: the ones that read fetched data or build the result, those that carry out and
 * undo an update, and the loader the recovery entry starts them with. A change to any of them stales a preview, and
 * an update never carries one: the engine is replaced by a reviewed change of its own.
 */
const ENGINE_FILES = Object.freeze([
  "core/args.cjs",
  "core/json.cjs",
  "core/process.cjs",
  "hooks/entry.cjs",
  "template/git.cjs",
  "template/inputs.cjs",
  "template/journal.cjs",
  "template/manifest.cjs",
  "template/preview.cjs",
  "template/pristine.cjs",
  "template/provenance.cjs",
  "template/recovery.cjs",
  "template/render.cjs",
  "template/state.cjs",
  "template/update.cjs",
]);
const DIGEST = /^[0-9a-f]{64}$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** What Git calls a conflict when the unmerged entries alone cannot tell, by which stages are present (1 base, 2 ours, 3 theirs). */
const KIND_BY_STAGES = new Map([
  ["123", "content"],
  ["23", "add/add"],
  ["12", "modify/delete"],
  ["13", "modify/delete"],
  ["2", "file/directory"],
  ["3", "file/directory"],
]);

/**
 * @typedef {{ mode: string, sha: string } | null} Stage
 * @typedef {{ path: string, kind: string, stages: { base: Stage, ours: Stage, theirs: Stage } }} Conflict
 * @typedef {{ status: string, path: string }} Change
 * @typedef {{
 *   head: string, stateDigest: string, answersDigest: string, engineDigest: string, sourceSha: string,
 * }} Current what a preview is bound to, as the project and the source are now
 * @typedef {{
 *   schema: typeof PREVIEW_SCHEMA, previewVersion: number,
 *   source: { url: string, ref: string, sha: string },
 *   bindings: Current & { manifestSchema: string, manifestProtocol: number },
 *   baseline: { commit: string, tree: string },
 *   next: { commit: string, tree: string, renderDigest: string },
 *   result: { status: "clean" | "conflicted" | "current", outputDigest: string, changes: Change[], conflicts: Conflict[] },
 * }} Preview
 * @typedef {{
 *   git: ReturnType<typeof createGit>,
 *   fs: typeof fs,
 *   scratch: (prefix: string) => string,
 *   remove: (dir: string) => void,
 * }} Host
 */

/** @param {string} scriptsRoot the directory holding core/ and template/ @returns {string} a digest of every engine file */
function engineDigest(scriptsRoot) {
  const hash = createHash("sha256");
  for (const file of ENGINE_FILES) hash.update(`${file} ${sha256(fs.readFileSync(nodePath.join(scriptsRoot, file)))}\n`);
  return hash.digest("hex");
}

/** @param {string} text NUL-terminated `status path` pairs @returns {Change[]} */
function parseChanges(text) {
  const parts = text.split("\0").filter((part) => part !== "");
  /** @type {Change[]} */
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i] ?? "", path: parts[i + 1] ?? "" });
  return changes;
}

/** @param {string} line @param {string} path @returns {boolean} whether the path stands in the line as a whole word */
const mentions = (line, path) => {
  for (let at = line.indexOf(path); at >= 0; at = line.indexOf(path, at + 1)) {
    const before = line[at - 1];
    const after = line[at + path.length];
    if ((before === undefined || before === " ") && (after === undefined || /[\s.,;:]/.test(after))) return true;
  }
  return false;
};

/**
 * What the unmerged index entries are. The entries decide which paths are in conflict and what each
 * side holds; Git's own report of the merge only names the kind where stages cannot tell (a rename
 * conflict looks like a modification conflict at the new path).
 * @param {readonly import("./git.cjs").IndexEntry[]} entries all index entries
 * @param {string} mergeOutput what the merge printed
 * @param {(sha: string) => boolean} isBinary
 * @returns {Conflict[]}
 */
function classifyConflicts(entries, mergeOutput, isBinary) {
  /** @type {Map<string, Map<string, import("./git.cjs").IndexEntry>>} */
  const byPath = new Map();
  for (const entry of entries) {
    if (entry.stage === "0") continue;
    const stages = byPath.get(entry.path) ?? /** @type {Map<string, import("./git.cjs").IndexEntry>} */ (new Map());
    stages.set(entry.stage, entry);
    byPath.set(entry.path, stages);
  }
  const reported = mergeOutput.split("\n").flatMap((line) => {
    const match = /^CONFLICT \(([^)]+)\)/.exec(line);
    return match ? [{ kind: match[1] ?? "", line }] : [];
  });
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, held]) => {
      const stage = (/** @type {string} */ n) => {
        const entry = held.get(n);
        return entry ? { mode: entry.mode, sha: entry.sha } : null;
      };
      const stages = { base: stage("1"), ours: stage("2"), theirs: stage("3") };
      const named = reported.find((item) => mentions(item.line, path))?.kind;
      let kind = named ?? KIND_BY_STAGES.get([...held.keys()].sort().join("")) ?? "unmerged";
      if (kind === "content" && [stages.ours, stages.theirs].some((side) => side !== null && isBinary(side.sha))) kind = "binary";
      return { path, kind, stages };
    });
}

/** @param {Buffer} content @returns {boolean} Git's own test for binary content: a NUL byte in the first 8000 */
const looksBinary = (content) => content.subarray(0, 8000).includes(0);

/** @param {Host["git"]} git @param {string} root @returns {string} what two readings of the project's HEAD and index must share */
const activeKey = (git, root) => `${git.head(root) ?? ""}\n${indexKey(git.inventory(root))}`;

/**
 * Builds the preview in a disposable full clone. Writes nothing in the project.
 * @param {{ host: Host, root: string, ref: string, url?: string, scriptsRoot?: string, checkpoint?: () => Promise<void> }} input
 * @returns {Promise<Preview>}
 */
async function createPreview({ host, root, ref, url = SOURCE_URL, scriptsRoot = nodePath.resolve(__dirname, ".."), checkpoint = () => Promise.resolve() }) {
  validateRef(ref);
  const { git } = host;
  const before = activeKey(git, root);
  const lineage = verifyLineage({ git, root });
  const { baseline } = lineage.state;
  const work = host.scratch("template-preview-");
  try {
    const sourceDir = nodePath.join(work, "source");
    host.fs.mkdirSync(sourceDir);
    const source = fetchSource({ git, dir: sourceDir, url, ref });
    await checkpoint();
    const manifest = readSourceManifest({ git, dir: sourceDir, sha: source.sha });

    const clone = nodePath.join(work, "clone");
    git.out(work, ["clone", "--quiet", "--no-local", "--no-tags", "--no-checkout", "--template=", "--", root, clone], true);
    git.out(clone, ["checkout", "--quiet", "--detach", lineage.head], true);
    await checkpoint();

    const workspace = nodePath.join(work, "next");
    host.fs.mkdirSync(workspace);
    const next = nextPristine({
      git,
      sourceDir,
      source,
      manifest,
      answers: lineage.answers,
      parent: baseline.commit,
      gitDir: nodePath.join(clone, ".git"),
      workspace,
      disk: host.fs,
      write: render.writeTree,
    });
    await checkpoint();

    /** @type {Preview["result"]["status"]} */
    let status = "current";
    let output = "";
    if (next.tree !== baseline.tree) {
      const merged = git.mergeNoCommit(clone, next.commit);
      output = `${merged.stdout}\n${merged.stderr}`;
      if (merged.status !== 0 && merged.status !== 1)
        throw new Refusal("merge-failed", `the merge could not run: ${merged.stderr.trim() || `exit ${String(merged.status)}`}`);
      status = merged.status === 0 ? "clean" : "conflicted";
    }
    const entries = git.inventory(clone, true);
    const unmerged = entries.some((entry) => entry.stage !== "0");
    if (unmerged !== (status === "conflicted")) throw new Refusal("merge-failed", "the merge status and the index of the merge disagree");
    const conflicts = classifyConflicts(entries, output, (sha) => looksBinary(git.blob(clone, sha)));
    const changes = parseChanges(git.out(clone, ["diff", "--cached", "--name-status", "-z", "--no-renames", "HEAD"], true));

    if (activeKey(git, root) !== before)
      throw new Refusal("project-changed", "HEAD or the index of the project changed while the preview was made; run it again");
    return {
      schema: PREVIEW_SCHEMA,
      previewVersion: PREVIEW_VERSION,
      source: { url, ref, sha: source.sha },
      bindings: {
        head: lineage.head,
        stateDigest: lineage.stateDigest,
        answersDigest: lineage.state.answersDigest,
        engineDigest: engineDigest(scriptsRoot),
        sourceSha: source.sha,
        manifestSchema: SCHEMA,
        manifestProtocol: PROTOCOL,
      },
      baseline: { commit: baseline.commit, tree: baseline.tree },
      next: { commit: next.commit, tree: next.tree, renderDigest: next.digest },
      result: { status, outputDigest: sha256(indexKey(entries)), changes, conflicts },
    };
  } finally {
    host.remove(work);
  }
}

/**
 * Why a preview no longer describes what an update would do; empty when it still does.
 * @param {Preview} preview
 * @param {Current} current
 * @returns {string[]}
 */
function staleReasons(preview, current) {
  const labels = /** @type {const} */ ({
    head: "HEAD moved",
    stateDigest: "the committed template state changed",
    answersDigest: "the answers changed",
    engineDigest: "the installed engine changed",
    sourceSha: "the source ref points to another commit",
  });
  return Object.entries(labels)
    .filter(([key]) => preview.bindings[/** @type {keyof typeof labels} */ (key)] !== current[/** @type {keyof typeof labels} */ (key)])
    .map(([, label]) => label);
}

/**
 * The bindings as the project and the installed engine are now. The source commit is whatever the caller resolved its ref to.
 * @param {{ git: Host["git"], root: string, sourceSha: string, scriptsRoot?: string }} input
 * @returns {Current}
 */
function currentBindings({ git, root, sourceSha, scriptsRoot = nodePath.resolve(__dirname, "..") }) {
  const lineage = verifyLineage({ git, root });
  return {
    head: lineage.head,
    stateDigest: lineage.stateDigest,
    answersDigest: lineage.state.answersDigest,
    engineDigest: engineDigest(scriptsRoot),
    sourceSha,
  };
}

/** @param {unknown} value @param {RegExp} pattern @param {string} label @returns {string} */
function pattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Refusal("invalid-preview", `preview ${label} is not valid`);
  return value;
}

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function record(value, label) {
  if (!isRecord(value)) throw new Refusal("invalid-preview", `preview ${label} must be an object`);
  return value;
}

/** @param {unknown} value @returns {Stage} */
function parseStage(value) {
  if (value === null) return null;
  const stage = record(value, "stage");
  return { mode: pattern(stage.mode, /^\d{6}$/, "stage mode"), sha: pattern(stage.sha, OBJECT_ID, "stage object") };
}

/**
 * Reads a preview file strictly, so that a changed or foreign file is refused rather than guessed at.
 * @param {string} text
 * @returns {Preview}
 */
function parsePreview(text) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Refusal("invalid-preview", "the preview is not valid JSON");
  }
  const top = record(raw, "file");
  if (top.schema !== PREVIEW_SCHEMA || top.previewVersion !== PREVIEW_VERSION)
    throw new Refusal("invalid-preview", "this is not a preview this engine understands");
  const keys = Object.keys(top).sort().join();
  if (keys !== "baseline,bindings,next,previewVersion,result,schema,source") throw new Refusal("invalid-preview", "the preview has unexpected keys");
  const source = record(top.source, "source");
  const bindings = record(top.bindings, "bindings");
  const baseline = record(top.baseline, "baseline");
  const next = record(top.next, "next");
  const result = record(top.result, "result");
  if (bindings.manifestSchema !== SCHEMA || bindings.manifestProtocol !== PROTOCOL) {
    throw new Refusal("engine-upgrade-required", "the preview was made for a manifest protocol this engine does not support");
  }
  if (result.status !== "clean" && result.status !== "conflicted" && result.status !== "current")
    throw new Refusal("invalid-preview", "preview status is not valid");
  if (!Array.isArray(result.changes) || !Array.isArray(result.conflicts)) throw new Refusal("invalid-preview", "preview result lists are not valid");
  return {
    schema: PREVIEW_SCHEMA,
    previewVersion: PREVIEW_VERSION,
    source: { url: pattern(source.url, /^\S+$/, "source url"), ref: validateRef(source.ref), sha: pattern(source.sha, OBJECT_ID, "source sha") },
    bindings: {
      head: pattern(bindings.head, OBJECT_ID, "head"),
      stateDigest: pattern(bindings.stateDigest, DIGEST, "state digest"),
      answersDigest: pattern(bindings.answersDigest, DIGEST, "answers digest"),
      engineDigest: pattern(bindings.engineDigest, DIGEST, "engine digest"),
      sourceSha: pattern(bindings.sourceSha, OBJECT_ID, "source binding"),
      manifestSchema: SCHEMA,
      manifestProtocol: PROTOCOL,
    },
    baseline: { commit: pattern(baseline.commit, OBJECT_ID, "baseline commit"), tree: pattern(baseline.tree, OBJECT_ID, "baseline tree") },
    next: {
      commit: pattern(next.commit, OBJECT_ID, "next commit"),
      tree: pattern(next.tree, OBJECT_ID, "next tree"),
      renderDigest: pattern(next.renderDigest, DIGEST, "next digest"),
    },
    result: {
      status: result.status,
      outputDigest: pattern(result.outputDigest, DIGEST, "output digest"),
      changes: result.changes.map((item) => {
        const change = record(item, "change");
        return { status: pattern(change.status, /^[A-Z]$/, "change status"), path: pattern(change.path, /^[\s\S]+$/, "change path") };
      }),
      conflicts: result.conflicts.map((item) => {
        const conflict = record(item, "conflict");
        const stages = record(conflict.stages, "conflict stages");
        return {
          path: pattern(conflict.path, /^[\s\S]+$/, "conflict path"),
          kind: pattern(conflict.kind, /^[a-z/ -]+$/, "conflict kind"),
          stages: { base: parseStage(stages.base), ours: parseStage(stages.ours), theirs: parseStage(stages.theirs) },
        };
      }),
    },
  };
}

/**
 * Writes the preview where the project keeps its latest one: replaced whole, never half-written.
 * @param {{ host: Host, root: string, preview: Preview }} input
 * @returns {string} the path of the file
 */
function writePreview({ host, root, preview }) {
  const gitDir = nodePath.resolve(root, host.git.out(root, ["rev-parse", "--absolute-git-dir"]).trim());
  const dir = nodePath.join(gitDir, PREVIEW_DIR);
  host.fs.mkdirSync(dir, { recursive: true });
  const target = nodePath.join(dir, PREVIEW_FILE);
  const partial = nodePath.join(dir, `${PREVIEW_FILE}.${String(process.pid)}.tmp`);
  host.fs.writeFileSync(partial, `${JSON.stringify(preview, null, 2)}\n`, { mode: 0o600 });
  host.fs.renameSync(partial, target);
  return target;
}

/** @param {Preview["result"]} result @returns {string} */
function describe(result) {
  const lines = [`status: ${result.status}`, `changed paths: ${String(result.changes.length)}`];
  for (const conflict of result.conflicts) lines.push(`conflict (${conflict.kind}): ${conflict.path}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The command: `pnpm run template:preview --ref=<ref>`. The update source is the template's public
 * repository; only the ref is chosen. A refusal is a status 1, never a guess.
 * @param {readonly string[]} args
 * @param {{ root: string, io: { stdout: (text: string) => unknown, stderr: (text: string) => unknown }, host?: Host, url?: string }} context
 * @returns {Promise<number>}
 */
async function templatePreview(args, { root, io, host = realHost(), url }) {
  const flags = parseArgs(args, { ref: { required: true } });
  // An interrupt is noticed between steps, so the scratch clone is always removed.
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  const signals = /** @type {const} */ (["SIGINT", "SIGTERM"]);
  for (const signal of signals) process.on(signal, interrupt);
  const checkpoint = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    if (interrupted) throw new Refusal("interrupted", "interrupted; the project was not changed");
  };
  try {
    const preview = await createPreview({ host, root, ref: flags.ref, checkpoint, ...(url === undefined ? {} : { url }) });
    const path = writePreview({ host, root, preview });
    io.stdout(`${describe(preview.result)}source: ${preview.source.sha}\npreview: ${path}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Refusal) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    for (const signal of signals) process.off(signal, interrupt);
  }
}

/** @returns {Host} what a preview does on this machine: real Git, the real filesystem and scratch space that is removed afterwards */
function realHost() {
  return {
    git: createGit(),
    fs,
    scratch: (prefix) => fs.mkdtempSync(nodePath.join(fs.realpathSync(tmpdir()), prefix)),
    remove: (dir) => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = {
  ENGINE_FILES,
  PREVIEW_DIR,
  PREVIEW_FILE,
  classifyConflicts,
  createPreview,
  currentBindings,
  engineDigest,
  parsePreview,
  realHost,
  staleReasons,
  templatePreview,
  writePreview,
};
