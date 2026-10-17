// @ts-check
"use strict";
// Starts the guard without Node's module resolver. The resolver reads the nearest package.json for
// every require() of a local file, so a malformed manifest would stop the guard before it could
// protect anything. This loader reads the guard's own .cjs files itself and lets them load only
// `node:` modules and other .cjs files below this project's scripts directory.
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeVm = require("node:vm");

/**
 * @param {{ scripts: string, readFile: (path: string) => string, builtin: (name: string) => unknown, compile?: typeof nodeVm.compileFunction }} host
 * @returns {(file: string) => unknown} loads a local module and returns its exports
 */
function createLoader({ scripts, readFile, builtin, compile = nodeVm.compileFunction }) {
  /** @type {Map<string, { exports: unknown }>} */
  const loaded = new Map();

  /** @param {string} file @returns {unknown} */
  function load(file) {
    const known = loaded.get(file);
    if (known) return known.exports;
    const record = { exports: /** @type {unknown} */ ({}) };
    loaded.set(file, record);
    const directory = nodePath.dirname(file);
    const run = compile(readFile(file), ["exports", "require", "module", "__filename", "__dirname"], { filename: file });
    /** @param {string} request */
    const requireLocal = (request) => {
      if (request.startsWith("node:")) return builtin(request);
      const target = nodePath.resolve(directory, request);
      const inside = target.startsWith(scripts + nodePath.sep) && target.endsWith(".cjs");
      if (!(request.startsWith("./") || request.startsWith("../")) || !inside)
        throw new Error(`the guard loads only node: modules and .cjs files below its scripts directory, not ${request}`);
      return load(target);
    };
    // A module started by this loader is never "the main module", so it only exports.
    const localRequire = Object.assign(requireLocal, { main: undefined });
    run.call(record.exports, record.exports, localRequire, record, file, directory);
    return record.exports;
  }
  return load;
}

module.exports = { createLoader };

if (require.main === module) {
  const scripts = nodePath.resolve(__dirname, "..");
  const load = createLoader({ scripts, readFile: (path) => nodeFs.readFileSync(path, "utf8"), builtin: (name) => /** @type {unknown} */ (require(name)) });
  const guard = /** @type {{ main: (argv: string[]) => number }} */ (load(nodePath.join(__dirname, "guard.cjs")));
  process.exitCode = guard.main(process.argv.slice(2));
}
