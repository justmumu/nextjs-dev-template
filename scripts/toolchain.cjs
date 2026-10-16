"use strict";
// Dependency-free toolchain preflight and U1 verification entrypoint.
// It must keep working when node_modules is missing or broken.
const { spawnSync } = require("node:child_process");
const { accessSync, constants, readFileSync, statSync } = require("node:fs");
const { delimiter, join, resolve } = require("node:path");

const root = resolve(__dirname, "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readExpected(dir) {
  const manifest = readJson(join(dir, "package.json"));
  const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "");
  if (!match) throw new Error("package.json packageManager must be an exact pnpm@x.y.z");
  return { node: readFileSync(join(dir, ".node-version"), "utf8").trim(), pnpm: match[1] };
}

function readPolicy(dir) {
  return readJson(join(dir, "tooling", "policy.json"));
}

function checkEnvironment(actual, expected) {
  const errors = [];
  if (actual.node !== expected.node) {
    errors.push(`Node ${expected.node} is required (found ${actual.node}). Install exactly that version.`);
  }
  if (actual.pnpm === null) {
    errors.push(`pnpm ${expected.pnpm} is required but was not found on PATH.`);
  } else if (actual.pnpm !== expected.pnpm) {
    errors.push(`pnpm ${expected.pnpm} is required (found ${actual.pnpm}). Install exactly that version.`);
  }
  return errors;
}

function commitIdentityErrors(entries, emailPattern) {
  const pattern = new RegExp(emailPattern);
  const errors = [];
  for (const entry of entries) {
    for (const role of ["author", "committer"]) {
      if (!pattern.test(entry[role])) errors.push(`${entry.rev}: ${role} e-mail is not a GitHub noreply address`);
    }
  }
  return errors;
}

function resolveOnPath(name, pathValue) {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

function pnpmVersion() {
  const result = spawnSync("pnpm", ["--version"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function step(args) {
  const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function verify() {
  const errors = checkEnvironment({ node: process.versions.node, pnpm: pnpmVersion() }, readExpected(root));
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exit(1);
  }
  step(["install", "--frozen-lockfile"]);
  step(["run", "test:one", "--test=tests/contracts/toolchain.test.ts", "--test=tests/integration/no-python.test.ts"]);
}

if (require.main === module) {
  if (process.argv[2] !== "verify") {
    process.stderr.write("usage: node scripts/toolchain.cjs verify\n");
    process.exit(2);
  }
  verify();
}

module.exports = { checkEnvironment, commitIdentityErrors, readExpected, readPolicy, resolveOnPath };
