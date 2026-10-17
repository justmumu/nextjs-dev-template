// @ts-check
"use strict";
// Regenerates the application seed lock in a disposable standalone directory, never in the root
// workspace, so the generator and the seed keep independent dependency graphs.
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const nodePath = require("node:path");
const { run } = require("../core/process.cjs");
const { same } = require("../core/dependency-policy.cjs");
const { isObject, readObject } = require("../core/json.cjs");

/**
 * @param {{ root: string, io: { stdout: (text: string) => unknown, stderr: (text: string) => unknown } }} options
 * @returns {number}
 */
function refreshSeed({ root, io }) {
  const seed = nodePath.join(root, "template", "app");
  const versions = readObject(nodePath.join(root, "tooling", "versions.json"));
  const pins = isObject(versions.seed) ? versions.seed : {};
  const manifest = readObject(nodePath.join(seed, "package.json"));
  if (!same(manifest.dependencies, pins.dependencies) || !same(manifest.devDependencies, pins.devDependencies)) {
    io.stderr("template/app/package.json does not match the reviewed pins in tooling/versions.json; align them (reviewed edit) before refreshing the lock.\n");
    return 1;
  }
  const copy = fs.realpathSync(fs.mkdtempSync(nodePath.join(tmpdir(), "seed-refresh-")));
  try {
    for (const name of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"])
      fs.writeFileSync(nodePath.join(copy, name), fs.readFileSync(nodePath.join(seed, name)));
    fs.writeFileSync(nodePath.join(copy, ".node-version"), fs.readFileSync(nodePath.join(root, ".node-version")));
    const result = run("pnpm", ["install", "--lockfile-only", "--no-frozen-lockfile"], { cwd: copy });
    if (result.status !== 0) {
      io.stderr(`pnpm could not resolve the seed lock:\n${result.stderr}${result.stdout}`);
      return 1;
    }
    const lock = fs.readFileSync(nodePath.join(copy, "pnpm-lock.yaml"));
    const target = nodePath.join(seed, "pnpm-lock.yaml");
    const changed = !fs.readFileSync(target).equals(lock);
    if (changed) fs.writeFileSync(target, lock);
    io.stdout(changed ? "template/app/pnpm-lock.yaml updated; review the diff.\n" : "template/app/pnpm-lock.yaml is already current.\n");
    return 0;
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

module.exports = { refreshSeed };
