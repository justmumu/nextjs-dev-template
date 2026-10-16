// @ts-check
"use strict";
// Regenerates the application seed lock in a disposable standalone directory, never in the root
// workspace, so the generator and the seed keep independent dependency graphs.
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { run } = require("../core/process.cjs");
const { same } = require("../core/dependency-policy.cjs");

/**
 * @param {{ root: string, io: { stdout: (text: string) => unknown, stderr: (text: string) => unknown } }} options
 * @returns {number}
 */
function refreshSeed({ root, io }) {
  const seed = join(root, "template", "app");
  const versions = JSON.parse(fs.readFileSync(join(root, "tooling", "versions.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(join(seed, "package.json"), "utf8"));
  if (!same(manifest.dependencies, versions.seed.dependencies) || !same(manifest.devDependencies, versions.seed.devDependencies)) {
    io.stderr("template/app/package.json does not match the reviewed pins in tooling/versions.json; align them (reviewed edit) before refreshing the lock.\n");
    return 1;
  }
  const copy = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "seed-refresh-")));
  try {
    for (const name of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) fs.writeFileSync(join(copy, name), fs.readFileSync(join(seed, name)));
    fs.writeFileSync(join(copy, ".node-version"), fs.readFileSync(join(root, ".node-version")));
    const result = run("pnpm", ["install", "--lockfile-only", "--no-frozen-lockfile"], { cwd: copy });
    if (result.status !== 0) {
      io.stderr(`pnpm could not resolve the seed lock:\n${result.stderr}${result.stdout}`);
      return 1;
    }
    const lock = fs.readFileSync(join(copy, "pnpm-lock.yaml"));
    const target = join(seed, "pnpm-lock.yaml");
    const changed = !fs.readFileSync(target).equals(lock);
    if (changed) fs.writeFileSync(target, lock);
    io.stdout(changed ? "template/app/pnpm-lock.yaml updated; review the diff.\n" : "template/app/pnpm-lock.yaml is already current.\n");
    return 0;
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

module.exports = { refreshSeed };
