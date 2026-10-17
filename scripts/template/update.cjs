// @ts-check
"use strict";
// Taking a template update, by a person at a terminal: `template:apply --preview=<file>` applies a
// preview that is proven again to be what it claims, and `node scripts/template/update.cjs
// inspect|abort|resume` are the three ways to look at, undo or go on with an update that is in
// progress. The recovery commands must work when the project is broken (a conflicted package.json,
// no node_modules), so this file loads nothing through Node's resolver when it is the entry: it
// reads the installed modules itself with the guard's own loader, and only the installed ones.
// The source's code is never loaded; the source's manifest is data.
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeVm = require("node:vm");

const RECOVERY_COMMANDS = new Set(["inspect", "abort", "resume"]);
const USAGE = "usage: node scripts/template/update.cjs inspect|abort|resume\n";
const REFUSALS = new Set(["JournalError", "Refusal", "GitError", "RenderError"]);
const OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply"];

/** @param {unknown} value @returns {string} the JSON of a value with its keys in a fixed order, so equal data gives equal text */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The guard's loader, taken from the installed engine's own file and run without Node's resolver.
 * @param {string} scripts the installed scripts directory
 * @returns {(file: string) => unknown} loads one installed .cjs file below `scripts` and returns its exports
 */
function installedLoader(scripts) {
  const file = nodePath.join(scripts, "hooks", "entry.cjs");
  const record = { exports: /** @type {{ createLoader?: (host: unknown) => (file: string) => unknown }} */ ({}) };
  const builtin = (/** @type {string} */ name) => /** @type {unknown} */ (require(name));
  const run = nodeVm.compileFunction(nodeFs.readFileSync(file, "utf8"), ["exports", "require", "module", "__filename", "__dirname"], { filename: file });
  run.call(record.exports, record.exports, Object.assign(builtin, { main: undefined }), record, file, nodePath.dirname(file));
  if (typeof record.exports.createLoader !== "function") throw new Error("the installed loader is missing");
  return record.exports.createLoader({ scripts, readFile: (/** @type {string} */ path) => nodeFs.readFileSync(path, "utf8"), builtin });
}

/**
 * `inspect`, `abort` or `resume` for the project this file belongs to. Nothing is read from the
 * project's package.json, and no package manager runs.
 * @param {readonly string[]} argv
 * @param {{ io: { stdout: (text: string) => unknown, stderr: (text: string) => unknown }, load?: (relative: string) => unknown, scripts?: string }} [context]
 * @returns {number}
 */
function main(argv, context = { io: { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) } }) {
  const [name, ...rest] = argv;
  if (name === undefined || !RECOVERY_COMMANDS.has(name) || rest.length > 0) {
    context.io.stderr(USAGE);
    return 2;
  }
  const scripts = context.scripts ?? nodePath.resolve(__dirname, "..");
  try {
    const load =
      context.load ??
      (
        (/** @type {(file: string) => unknown} */ installed) => (/** @type {string} */ relative) =>
          installed(nodePath.join(scripts, relative))
      )(installedLoader(scripts));
    const recovery = /** @type {typeof import("./recovery.cjs")} */ (load("template/recovery.cjs"));
    const git = /** @type {typeof import("./git.cjs")} */ (load("template/git.cjs")).createGit();
    const root = nodePath.resolve(scripts, "..");
    const gitDir = nodePath.resolve(root, git.out(root, ["rev-parse", "--absolute-git-dir"]).trim());
    const host = { git, fs: nodeFs, root, gitDir, io: context.io };
    return recovery[/** @type {"inspect" | "abort" | "resume"} */ (name)](host);
  } catch (error) {
    if (error instanceof Error && REFUSALS.has(error.name)) {
      context.io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/**
 * @typedef {{
 *   root: string, cwd?: string, io: { stdout: (text: string) => unknown, stderr: (text: string) => unknown },
 *   host?: import("./preview.cjs").Host, url?: string, scriptsRoot?: string,
 * }} ApplyContext `url` and `host` are the fixture boundary of tests; the command has neither
 */

/**
 * Applies a preview. The preview file is only a claim: the source is fetched again and the whole
 * preview is built again from the project as it is now, and the update goes ahead only if the two are
 * the same, byte for byte in meaning. Everything the claim says about the source, the result and the
 * engine is thereby recomputed, never believed.
 * @param {readonly string[]} args
 * @param {ApplyContext} context
 * @returns {Promise<number>}
 */
async function apply(args, context) {
  const { parseArgs } = require("../core/args.cjs");
  const preview = require("./preview.cjs");
  const { Refusal, sha256, verifyLineage } = require("./provenance.cjs");
  const recovery = require("./recovery.cjs");
  const journals = require("./journal.cjs");
  const gitModule = require("./git.cjs");
  const pristine = require("./pristine.cjs");
  const { STATE_FILE, advanceState, parseState, serializeState } = require("./state.cjs");
  const render = require("./render.cjs");
  // The guard's state module is not part of the engine (a guard update is an ordinary protected update), so it is loaded by a computed path.
  /** @type {unknown} */
  const guardState = require(nodePath.join(__dirname, "..", "hooks", "state.cjs"));
  const hookState = /** @type {typeof import("../hooks/state.cjs")} */ (guardState);

  const { io, root } = context;
  const scriptsRoot = context.scriptsRoot ?? nodePath.resolve(__dirname, "..");
  const host = context.host ?? preview.realHost();
  const { git } = host;
  try {
    const flags = parseArgs(args, { preview: { required: true } });
    const url = context.url ?? pristine.SOURCE_URL;
    /** @type {string} */
    let text;
    try {
      text = nodeFs.readFileSync(nodePath.resolve(context.cwd ?? root, flags.preview), "utf8");
    } catch {
      throw new Refusal("invalid-preview", `the preview file ${flags.preview} could not be read`);
    }
    const claimed = preview.parsePreview(text);
    if (claimed.source.url !== url) throw new Refusal("source-mismatch", "the preview names another source than the template's public repository");

    const gitDir = nodePath.resolve(root, git.out(root, ["rev-parse", "--absolute-git-dir"]).trim());
    const recoveryHost = { git, fs: nodeFs, root, gitDir, io };
    if (nodeFs.existsSync(journals.journalPaths(gitDir).journal)) {
      if (!recovery.settle(recoveryHost))
        throw new Refusal("update-in-progress", "a template update is in progress; run node scripts/template/update.cjs inspect, resume or abort");
    }
    const operation = OPERATION_MARKERS.find((marker) => nodeFs.existsSync(nodePath.join(gitDir, marker)));
    if (operation !== undefined)
      throw new Refusal("operation-in-progress", `${operation} exists: finish or abort that merge, rebase, cherry-pick or revert first`);
    const changed = recovery.trackedChanges(recoveryHost);
    if (changed.length > 0) throw new Refusal("project-dirty", `commit or stash the tracked changes first: ${changed.slice(0, 5).join(", ")}`);
    const hidden = git.hiddenFlags(root);
    if (hidden.length > 0) throw new Refusal("project-dirty", `Git is told to ignore changes to tracked files: ${hidden.slice(0, 5).join(", ")}`);
    try {
      const reserved = hookState.readState(nodePath.join(gitDir, hookState.STATE_DIR_NAME), nodeFs);
      if (reserved !== null && Object.keys(reserved.inflight).length > 0)
        throw new Refusal("agent-running", "an agent call that may change protected files has not finished; stop the agent sessions first");
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw new Refusal(
        "agent-running",
        `the guard state cannot be read (${error instanceof Error ? error.message : String(error)}); stop the agent sessions and inspect it`,
      );
    }

    const fresh = await preview.createPreview({ host, root, ref: claimed.source.ref, url, scriptsRoot });
    if (canonical(fresh) !== canonical(claimed)) {
      const reasons = preview.staleReasons(claimed, fresh.bindings);
      throw new Refusal(
        "preview-mismatch",
        `the preview is not what updating now would do (${reasons.length > 0 ? reasons.join("; ") : "its contents differ from a new one"}); run template:preview again`,
      );
    }
    if (fresh.result.status === "current") {
      io.stdout("the project already has this template revision; nothing was changed\n");
      return 0;
    }
    const engine = new Set(preview.ENGINE_FILES.map((file) => `scripts/${file}`));
    const touched = [...fresh.result.changes.map((change) => change.path), ...fresh.result.conflicts.map((conflict) => conflict.path)].filter((path) =>
      engine.has(path),
    );
    if (touched.length > 0) {
      throw new Refusal(
        "engine-upgrade-required",
        `this update changes the installed update engine (${touched.join(", ")}). The engine is replaced by its own reviewed protected change, never by an update that runs it; see docs/updating.md, then preview again`,
      );
    }

    const lineage = verifyLineage({ git, root });
    const scratch = host.scratch("template-apply-");
    try {
      const sourceDir = nodePath.join(scratch, "source");
      nodeFs.mkdirSync(sourceDir);
      const source = pristine.fetchSource({ git, dir: sourceDir, url, ref: claimed.source.ref });
      if (source.sha !== fresh.source.sha) throw new Refusal("source-moved", "the source ref moved while the update started; run template:preview again");
      const manifest = pristine.readSourceManifest({ git, dir: sourceDir, sha: source.sha });
      const workspace = nodePath.join(scratch, "next");
      nodeFs.mkdirSync(workspace);
      const next = pristine.nextPristine({
        git,
        sourceDir,
        source,
        manifest,
        answers: lineage.answers,
        parent: lineage.state.baseline.commit,
        gitDir,
        workspace,
        disk: nodeFs,
        write: render.writeTree,
      });
      if (next.commit !== fresh.next.commit || next.tree !== fresh.next.tree || next.digest !== fresh.next.renderDigest)
        throw new Refusal("preview-mismatch", "the pristine snapshot built for the project is not the one that was previewed");

      const before = git.blob(root, `${lineage.head}:${STATE_FILE}`);
      const after = Buffer.from(
        serializeState(
          advanceState(parseState(before.toString("utf8")), {
            next: { commit: next.commit, tree: next.tree, renderDigest: next.digest },
            upstream: { url, sha: source.sha },
          }),
        ),
      );
      /** @type {import("./journal.cjs").Journal} */
      const journal = {
        schema: journals.JOURNAL_SCHEMA,
        journalVersion: journals.JOURNAL_VERSION,
        phase: "prepared",
        source: { url, ref: claimed.source.ref, sha: source.sha },
        start: { head: lineage.head, baseline: { commit: lineage.state.baseline.commit, tree: lineage.state.baseline.tree } },
        next: { commit: next.commit, tree: next.tree, renderDigest: next.digest },
        outputDigest: fresh.result.outputDigest,
        conflicted: fresh.result.status === "conflicted",
        owned: [
          {
            path: STATE_FILE,
            before: { digest: sha256(before), blob: gitModule.blobId(before) },
            after: { digest: sha256(after), blob: gitModule.blobId(after) },
          },
        ],
        pendingRef: journals.PENDING_REF,
      };
      const done = recovery.exclusively(recoveryHost, () => {
        git.out(root, ["update-ref", journals.PENDING_REF, next.commit, "0".repeat(next.commit.length)]);
        try {
          recovery.createJournal(recoveryHost, journal);
        } catch (error) {
          git.out(root, ["update-ref", "-d", journals.PENDING_REF, next.commit]);
          throw error;
        }
        return recovery.conduct(recoveryHost, journal);
      });
      io.stdout(
        `${done.conflicted ? "the merge stopped on conflicts" : "the merge is clean and not committed"}; source ${source.sha}\n` +
          `next: ${done.conflicted ? "resolve the conflicts and git add them; " : ""}review the diff, then node scripts/bootstrap.cjs guard-accept, node scripts/bootstrap.cjs deps-lock if the resolved lock is stale, node scripts/bootstrap.cjs repair, and a normal git commit\n` +
          "to undo it: node scripts/template/update.cjs abort\n",
      );
      return 0;
    } finally {
      host.remove(scratch);
    }
  } catch (error) {
    if (error instanceof Error && REFUSALS.has(error.name)) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

module.exports = { apply, canonical, installedLoader, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
