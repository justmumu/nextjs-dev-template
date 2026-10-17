// @ts-check
"use strict";
const { RenderError, isRecord } = require("./manifest.cjs");

const ANSWER_KEYS = new Set(["name", "description", "owner", "version"]);
const NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DEFAULT_VERSION = "0.0.0";

/** @param {unknown} value @param {string} label @param {number} maxLength @returns {string} */
function text(value, label, maxLength) {
  if (typeof value !== "string") throw new RenderError(`answer ${label} must be a string`);
  if (value.length > maxLength) throw new RenderError(`answer ${label} is longer than ${String(maxLength)} characters`);
  if (!value.isWellFormed()) throw new RenderError(`answer ${label} is not well-formed Unicode`);
  // eslint-disable-next-line no-control-regex -- rejecting control characters in untrusted input is the purpose of this pattern
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new RenderError(`answer ${label} contains a control character`);
  return value;
}

/**
 * @param {unknown} raw
 * @returns {{ name: string, description: string, owner: string | null, version: string }}
 */
function validateAnswers(raw) {
  if (!isRecord(raw)) throw new RenderError("answers must be an object");
  for (const key of Object.keys(raw)) {
    if (!ANSWER_KEYS.has(key)) throw new RenderError(`unknown answer: ${key}`);
  }
  if (raw.name === undefined) throw new RenderError("answer name is required");
  const name = text(raw.name, "name", 214);
  if (!NAME.test(name)) throw new RenderError("answer name must be a valid lowercase npm package name");
  const description = raw.description === undefined ? "" : text(raw.description, "description", 300);
  let owner = null;
  if (raw.owner !== undefined && raw.owner !== null) {
    owner = text(raw.owner, "owner", 39);
    if (!OWNER.test(owner)) throw new RenderError("answer owner must be a GitHub login, not an e-mail address or name");
  }
  const version = raw.version === undefined ? DEFAULT_VERSION : text(raw.version, "version", 64);
  if (!SEMVER.test(version)) throw new RenderError("answer version must be a semantic version");
  return { name, description, owner, version };
}

module.exports = { validateAnswers, DEFAULT_VERSION };
