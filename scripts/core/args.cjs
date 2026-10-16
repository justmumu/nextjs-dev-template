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
 * A flag declared `required` is always a string in the result; any other flag may be absent.
 * @template {Record<string, FlagSpec>} const Schema
 * @param {readonly string[]} argv
 * @param {Schema} schema
 * @returns {{ [Name in keyof Schema]: Schema[Name] extends { required: true } ? string : string | undefined }}
 */
function parseArgs(argv, schema) {
  /** @type {Record<string, string>} */
  const parsed = {};
  for (const arg of argv) {
    const match = /^--([a-z][a-z-]*)=([\s\S]*)$/.exec(arg);
    if (!match) throw new UsageError(`unexpected argument: ${JSON.stringify(arg)} (flags are written --name=value)`);
    const [, name, value] = /** @type {RegExpExecArray & [string, string, string]} */ (match);
    const spec = Object.hasOwn(schema, name) ? schema[name] : undefined;
    if (spec === undefined) throw new UsageError(`unknown flag: --${name}`);
    if (Object.hasOwn(parsed, name)) throw new UsageError(`duplicate flag: --${name}`);
    if (value === "") throw new UsageError(`--${name} must not be empty`);
    // eslint-disable-next-line no-control-regex -- rejecting control characters in untrusted input is the purpose of this pattern
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new UsageError(`--${name} contains a control character`);
    if (spec.values && !spec.values.includes(value)) throw new UsageError(`--${name} must be one of: ${spec.values.join(", ")}`);
    if (spec.pattern && !spec.pattern.test(value)) throw new UsageError(`--${name} has an unsupported value: ${JSON.stringify(value)}`);
    parsed[name] = value;
  }
  for (const [name, spec] of Object.entries(schema)) {
    if (spec.required && !Object.hasOwn(parsed, name)) throw new UsageError(`--${name} is required`);
  }
  return /** @type {never} */ (parsed);
}

module.exports = { UsageError, parseArgs };
