// @ts-check
"use strict";
// `.template-state.json`: what a later update needs to know about where a project came from. It
// lives in the enrollment commit and in the merge commits of later updates, never in a pristine tree
// (it names the pristine commit, so it cannot be part of it).
const { createHash } = require("node:crypto");
const { PROTOCOL, SCHEMA, RenderError, isRecord } = require("./manifest.cjs");

const STATE_FILE = ".template-state.json";
const STATE_SCHEMA = "nextjs-dev-template/state";
const STATE_VERSION = 1;
/** The message of every pristine snapshot commit, the first one and each update's. */
const PRISTINE_MESSAGE = "chore(template): pristine render";
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * `local-generator`: rendered from a checkout of the generator, whose commit is `revision`.
 * `github-template-copy`: a repository GitHub made from the template; `copiedCommit` is that
 * repository's own first commit. It exists nowhere else and is not a revision of the template.
 * @typedef {{ kind: "local-generator", revision: string } | { kind: "github-template-copy", copiedCommit: string }} Source
 * @typedef {{ url: string, sha: string }} Upstream the template revision the latest update took; absent until a first update
 * @typedef {{
 *   schema: typeof STATE_SCHEMA, stateVersion: number, manifestSchema: string, manifestProtocol: number,
 *   baseline: { commit: string, tree: string }, source: Source, answersDigest: string, renderDigest: string,
 *   upstream?: Upstream,
 * }} TemplateState
 */

/** @param {{ name: string, description: string, owner: string | null, version: string }} answers @returns {string} a digest of the validated answers */
function answersDigest(answers) {
  const { name, description, owner, version } = answers;
  return createHash("sha256").update(JSON.stringify({ name, description, owner, version })).digest("hex");
}

/**
 * @param {{ baseline: { commit: string, tree: string }, source: Source, answers: Parameters<typeof answersDigest>[0], renderDigest: string }} input
 * @returns {TemplateState}
 */
function buildState({ baseline, source, answers, renderDigest }) {
  return {
    schema: STATE_SCHEMA,
    stateVersion: STATE_VERSION,
    manifestSchema: SCHEMA,
    manifestProtocol: PROTOCOL,
    baseline: { commit: baseline.commit, tree: baseline.tree },
    source,
    answersDigest: answersDigest(answers),
    renderDigest,
  };
}

/**
 * The state an update commits: the same enrollment (source, answers) with the baseline moved to the
 * new pristine snapshot and the chosen template revision recorded. Earlier states stay in history.
 * @param {TemplateState} state
 * @param {{ next: { commit: string, tree: string, renderDigest: string }, upstream: Upstream }} update
 * @returns {TemplateState}
 */
function advanceState(state, { next, upstream }) {
  return {
    schema: state.schema,
    stateVersion: state.stateVersion,
    manifestSchema: state.manifestSchema,
    manifestProtocol: state.manifestProtocol,
    baseline: { commit: next.commit, tree: next.tree },
    source: state.source,
    answersDigest: state.answersDigest,
    renderDigest: next.renderDigest,
    upstream: { url: upstream.url, sha: upstream.sha },
  };
}

/** @param {TemplateState} state @returns {string} */
const serializeState = (state) => `${JSON.stringify(state, null, 2)}\n`;

/** @param {Record<string, unknown>} value @param {string[]} keys @param {string} label @param {string[]} [optional] */
function exactKeys(value, keys, label, optional = []) {
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) throw new RenderError(`${label} has an unknown key: ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new RenderError(`${label} is missing ${key}`);
}

/** @param {unknown} value @param {string} label @returns {string} */
function objectId(value, label) {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) throw new RenderError(`${label} must be a full lowercase object id`);
  return value;
}

/**
 * @param {unknown} source
 * @returns {Source}
 */
function parseSource(source) {
  if (!isRecord(source)) throw new RenderError("state source must be an object");
  if (source.kind === "local-generator") {
    exactKeys(source, ["kind", "revision"], "state source");
    return { kind: "local-generator", revision: objectId(source.revision, "state source revision") };
  }
  if (source.kind === "github-template-copy") {
    exactKeys(source, ["kind", "copiedCommit"], "state source");
    return { kind: "github-template-copy", copiedCommit: objectId(source.copiedCommit, "state copied commit") };
  }
  throw new RenderError(`unsupported state source kind: ${JSON.stringify(source.kind)}`);
}

/** @param {unknown} upstream @returns {Upstream} */
function parseUpstream(upstream) {
  if (!isRecord(upstream)) throw new RenderError("state upstream must be an object");
  exactKeys(upstream, ["url", "sha"], "state upstream");
  if (typeof upstream.url !== "string" || !/^\S+$/.test(upstream.url)) throw new RenderError("state upstream url is not valid");
  return { url: upstream.url, sha: objectId(upstream.sha, "state upstream revision") };
}

/**
 * Reads a state file strictly: an unknown version or key is refused rather than guessed at.
 * @param {string} text
 * @returns {TemplateState}
 */
function parseState(text) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new RenderError(`${STATE_FILE} is not valid JSON: ${/** @type {Error} */ (error).message}`);
  }
  if (!isRecord(raw)) throw new RenderError(`${STATE_FILE} must be an object`);
  if (raw.schema !== STATE_SCHEMA) throw new RenderError(`unsupported state schema: ${JSON.stringify(raw.schema)}`);
  if (raw.stateVersion !== STATE_VERSION) throw new RenderError(`unsupported state version: ${JSON.stringify(raw.stateVersion)}`);
  exactKeys(raw, ["schema", "stateVersion", "manifestSchema", "manifestProtocol", "baseline", "source", "answersDigest", "renderDigest"], STATE_FILE, [
    "upstream",
  ]);
  if (raw.manifestSchema !== SCHEMA || raw.manifestProtocol !== PROTOCOL)
    throw new RenderError("the state names a manifest protocol this engine does not support");
  const baseline = raw.baseline;
  if (!isRecord(baseline)) throw new RenderError("state baseline must be an object");
  exactKeys(baseline, ["commit", "tree"], "state baseline");
  for (const key of ["answersDigest", "renderDigest"]) {
    if (typeof raw[key] !== "string" || !DIGEST.test(raw[key])) throw new RenderError(`state ${key} must be a sha-256 digest`);
  }
  return {
    schema: STATE_SCHEMA,
    stateVersion: STATE_VERSION,
    manifestSchema: SCHEMA,
    manifestProtocol: PROTOCOL,
    baseline: { commit: objectId(baseline.commit, "state baseline commit"), tree: objectId(baseline.tree, "state baseline tree") },
    source: parseSource(raw.source),
    answersDigest: String(raw.answersDigest),
    renderDigest: String(raw.renderDigest),
    ...(Object.hasOwn(raw, "upstream") ? { upstream: parseUpstream(raw.upstream) } : {}),
  };
}

module.exports = { PRISTINE_MESSAGE, STATE_FILE, STATE_SCHEMA, STATE_VERSION, advanceState, answersDigest, buildState, parseState, serializeState };
