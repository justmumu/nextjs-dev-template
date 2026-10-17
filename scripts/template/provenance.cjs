// @ts-check
"use strict";
// Where a project's template content came from, judged before anything is fetched: the committed
// state, the pristine baseline it names and the answers that baseline was rendered from. Every
// doubt is a refusal; a missing or rewritten baseline is never replaced by a guess.
const { createHash } = require("node:crypto");
const { PROTOCOL, RenderError, SCHEMA, isRecord } = require("./manifest.cjs");
const { validateAnswers } = require("./inputs.cjs");
const { STATE_FILE, answersDigest, parseState } = require("./state.cjs");

/** The pristine package.json carries the answers the application was created from. */
const PACKAGE_FILE = "package.json";

/** A reason the update is not safe to preview; `code` is stable and for callers to branch on. */
class Refusal extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "Refusal";
    /** @type {string} */
    this.code = code;
  }
}

/** @param {string | Buffer} data @returns {string} */
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * The enrollment answers, from the package.json of the pristine baseline (never the application's
 * current one, which holds the user's own edits) and proven by the digest the state recorded.
 * @param {string} packageText
 * @param {{ answersDigest: string }} state
 * @returns {ReturnType<typeof validateAnswers>}
 */
function recoverAnswers(packageText, state) {
  /** @type {unknown} */
  let pkg;
  try {
    pkg = JSON.parse(packageText);
  } catch {
    throw new Refusal("answers-mismatch", `the baseline ${PACKAGE_FILE} is not valid JSON, so the original answers cannot be recovered`);
  }
  if (!isRecord(pkg)) throw new Refusal("answers-mismatch", `the baseline ${PACKAGE_FILE} is not an object`);
  /** @type {ReturnType<typeof validateAnswers>} */
  let answers;
  try {
    answers = validateAnswers({
      name: pkg.name,
      version: pkg.version,
      ...(pkg.description === undefined ? {} : { description: pkg.description }),
      ...(pkg.author === undefined ? {} : { owner: pkg.author }),
    });
  } catch (error) {
    if (error instanceof RenderError) throw new Refusal("answers-mismatch", `the baseline ${PACKAGE_FILE} does not hold valid answers: ${error.message}`);
    throw error;
  }
  if (answersDigest(answers) !== state.answersDigest) {
    throw new Refusal("answers-mismatch", `the answers in the baseline ${PACKAGE_FILE} are not the ones the state recorded`);
  }
  return answers;
}

/**
 * @typedef {Pick<ReturnType<typeof import("./git.cjs").createGit>, "head" | "isShallow" | "blob" | "hasCommit" | "isAncestor" | "treeOf">} LineageGit
 * @typedef {{
 *   head: string,
 *   stateText: string,
 *   stateDigest: string,
 *   state: import("./state.cjs").TemplateState,
 *   answers: ReturnType<typeof validateAnswers>,
 * }} Lineage
 */

/**
 * Reads what HEAD records about the template and proves it against the history. Nothing is written.
 * @param {{ git: LineageGit, root: string }} input
 * @returns {Lineage}
 */
function verifyLineage({ git, root }) {
  const head = git.head(root);
  if (head === null) throw new Refusal("no-head", "the project has no commit yet");
  if (git.isShallow(root)) {
    throw new Refusal(
      "shallow-history",
      "this clone is shallow, so the template baseline may be missing; fetch the full history first (git fetch --unshallow)",
    );
  }
  /** @type {string} */
  let stateText;
  try {
    stateText = git.blob(root, `${head}:${STATE_FILE}`).toString("utf8");
  } catch {
    throw new Refusal("not-enrolled", `HEAD has no committed ${STATE_FILE}; this project is not enrolled in template updates`);
  }
  /** @type {unknown} */
  let raw = null;
  try {
    raw = JSON.parse(stateText);
  } catch {
    raw = null;
  }
  if (
    isRecord(raw) &&
    ((typeof raw.manifestProtocol === "number" && raw.manifestProtocol !== PROTOCOL) ||
      (typeof raw.manifestSchema === "string" && raw.manifestSchema !== SCHEMA))
  ) {
    throw new Refusal("engine-upgrade-required", "the state names a manifest protocol this installed engine does not support; upgrade the engine first");
  }
  /** @type {import("./state.cjs").TemplateState} */
  let state;
  try {
    state = parseState(stateText);
  } catch (error) {
    if (error instanceof RenderError) throw new Refusal("invalid-state", error.message);
    throw error;
  }
  const { commit, tree } = state.baseline;
  if (!git.hasCommit(root, commit)) {
    throw new Refusal(
      "baseline-missing",
      `the baseline commit ${commit} is not in this repository; it was removed or rewritten, and a new base is not guessed`,
    );
  }
  if (!git.isAncestor(root, commit, head)) {
    throw new Refusal(
      "baseline-unreachable",
      `the baseline commit ${commit} is not an ancestor of HEAD; history was rewritten or the baseline is from another line`,
    );
  }
  if (git.treeOf(root, commit) !== tree) {
    throw new Refusal("baseline-mismatch", `the baseline commit ${commit} does not have the tree ${tree} the state records`);
  }
  try {
    git.blob(root, `${commit}:${STATE_FILE}`);
    throw new Refusal("baseline-mismatch", `the baseline tree must not hold ${STATE_FILE}`);
  } catch (error) {
    if (error instanceof Refusal) throw error;
  }
  /** @type {string} */
  let packageText;
  try {
    packageText = git.blob(root, `${commit}:${PACKAGE_FILE}`).toString("utf8");
  } catch {
    throw new Refusal("answers-mismatch", `the baseline commit ${commit} has no ${PACKAGE_FILE}, so the original answers cannot be recovered`);
  }
  const answers = recoverAnswers(packageText, state);
  return { head, stateText, stateDigest: sha256(stateText), state, answers };
}

module.exports = { PACKAGE_FILE, Refusal, recoverAnswers, sha256, verifyLineage };
