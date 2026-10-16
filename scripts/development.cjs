"use strict";
// Minimal development command entry (U1). U3 replaces this with the full facade.
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join, relative, resolve, sep } = require("node:path");

const root = resolve(__dirname, "..");

function testTargets(args) {
  const targets = [];
  for (const arg of args) {
    const match = /^--test=(.+)$/.exec(arg);
    if (!match) throw new Error(`test:one accepts only --test=<path> (got ${arg})`);
    const path = resolve(root, match[1]);
    const rel = relative(root, path);
    if (rel.startsWith("..") || !rel.startsWith(`tests${sep}`) || !existsSync(path)) {
      throw new Error(`--test must name an existing file under tests/ (got ${match[1]})`);
    }
    targets.push(rel);
  }
  if (targets.length === 0) throw new Error("test:one requires at least one --test=<path>");
  return targets;
}

function main(argv) {
  const [command, ...args] = argv;
  if (command !== "test:one") throw new Error(`unknown command: ${command ?? ""}`);
  const vitestDir = join(root, "node_modules", "vitest");
  const vitest = join(vitestDir, JSON.parse(readFileSync(join(vitestDir, "package.json"), "utf8")).bin.vitest);
  const result = spawnSync(process.execPath, [vitest, "run", ...testTargets(args)], { cwd: root, stdio: "inherit" });
  return result.status ?? 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
