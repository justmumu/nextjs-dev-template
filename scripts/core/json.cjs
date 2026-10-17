// @ts-check
"use strict";
// JSON.parse yields `any`; every JSON file the Node core reads goes through here so callers receive
// `unknown` members they must narrow.
const { readFileSync } = require("node:fs");

/** @typedef {Record<string, unknown>} JsonObject */

/** @param {unknown} value @returns {value is JsonObject} */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} text @returns {JsonObject} the parsed top-level object; anything else throws */
function parseObject(text) {
  /** @type {unknown} */
  const value = JSON.parse(text);
  if (!isObject(value)) throw new Error("expected a JSON object");
  return value;
}

/** @param {string} path @returns {JsonObject} */
function readObject(path) {
  return parseObject(readFileSync(path, "utf8"));
}

module.exports = { isObject, parseObject, readObject };
