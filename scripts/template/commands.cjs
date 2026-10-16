// @ts-check
"use strict";
// The generator-only development commands. Applications do not receive this directory.
const nodePath = require("node:path");
const { parseArgs } = require("../core/args.cjs");

/** @typedef {import("../development.cjs").Handler} Handler */

/** @type {Handler} */
function templateCreate(args, { cwd, io }) {
  const flags = parseArgs(args, { name: { required: true }, owner: { required: true }, dest: { required: true } });
  const render = require("./render.cjs");
  const { manifest, bases } = render.defaultInputs();
  const { files, digest } = render.renderTree({ manifest, bases, answers: { name: flags.name, owner: flags.owner } });
  render.writeTree(files, nodePath.resolve(cwd, flags.dest));
  io.stdout(`${JSON.stringify({ files: files.length, digest })}\n`);
  return 0;
}

/** @type {Handler} */
function seedRefresh(args, { root, io }) {
  parseArgs(args, {});
  return require("./seed.cjs").refreshSeed({ root, io });
}

module.exports = { seedRefresh, templateCreate };
