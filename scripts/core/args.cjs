// @ts-check
"use strict";
// Literal `--name=value` grammar. No shell expansion, no `--` separator, no positionals.

class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * @typedef {{ required?: boolean, pattern?: RegExp, values?: readonly string[] }} FlagSpec
 */

/**
 * @param {readonly string[]} argv
 * @param {Record<string, FlagSpec>} schema
 * @returns {Record<string, string>}
 */
function parseArgs(argv, schema) {
  /** @type {Record<string, string>} */
  const parsed = {};
  for (const arg of argv) {
    const match = /^--([a-z][a-z-]*)=([\s\S]*)$/.exec(arg);
    if (!match) throw new UsageError(`unexpected argument: ${JSON.stringify(arg)} (flags are written --name=value)`);
    const [, name, value] = match;
    if (!Object.hasOwn(schema, name)) throw new UsageError(`unknown flag: --${name}`);
    if (Object.hasOwn(parsed, name)) throw new UsageError(`duplicate flag: --${name}`);
    if (value === "") throw new UsageError(`--${name} must not be empty`);
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new UsageError(`--${name} contains a control character`);
    const spec = schema[name];
    if (spec.values && !spec.values.includes(value)) throw new UsageError(`--${name} must be one of: ${spec.values.join(", ")}`);
    if (spec.pattern && !spec.pattern.test(value)) throw new UsageError(`--${name} has an unsupported value: ${JSON.stringify(value)}`);
    parsed[name] = value;
  }
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.required && !Object.hasOwn(parsed, name)) throw new UsageError(`--${name} is required`);
  }
  return parsed;
}

module.exports = { UsageError, parseArgs };
