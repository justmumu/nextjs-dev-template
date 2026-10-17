import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, test } from "vitest";
import { parseJson } from "../support/json.ts";
import { capture, roleFiles, scratchArea } from "../support/project.ts";

const root = resolve(import.meta.dirname, "../..");
const development = createRequire(import.meta.url)("../../scripts/development.cjs") as typeof import("../../scripts/development.cjs");
const scratch = scratchArea("audit-");

// A `pnpm` that answers audits from files, so what is judged is the real command, the real policy and the real
// process boundary, without the registry.
const STUB = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AUDIT_LOG, process.cwd() + " " + args.join(" ") + "\\n");
if (args[0] === "--version") { console.log("12.14.0"); process.exit(0); }
const graph = args.includes("--prod") ? "runtime" : args.includes("--dev") ? "development" : "tools";
const answer = process.env.AUDIT_ANSWERS + "/" + graph + ".json";
if (!fs.existsSync(answer)) { console.error("ENOTFOUND registry"); process.exit(1); }
const { status, stdout } = JSON.parse(fs.readFileSync(answer, "utf8"));
process.stdout.write(stdout);
process.exit(status);
`;

type Policy = { advisories: { id: string; package: string; severity: string; installed: string[]; paths: string[] }[] };
const policyText = readFileSync(join(root, "tooling/audit-policy.json"), "utf8");
const policy = parseJson<Policy>(policyText);

const advisoryOf = (id: string, name: string, severity: string, version: string, paths = [`.>${name}`]) => ({
  github_advisory_id: id,
  module_name: name,
  severity,
  findings: [{ version, paths }],
});
const report = (advisories: ReturnType<typeof advisoryOf>[]) => ({
  status: advisories.length > 0 ? 1 : 0,
  stdout: JSON.stringify({ advisories: Object.fromEntries(advisories.map((entry, index) => [String(index), entry])), metadata: {} }),
});

const previous = process.env.PATH;
afterEach(() => {
  process.env.PATH = previous;
  delete process.env.AUDIT_LOG;
  delete process.env.AUDIT_ANSWERS;
});

function project(role: "generator" | "application", answers: Record<string, unknown>) {
  const dir = scratch.project({ ...roleFiles(role), "tooling/audit-policy.json": policyText });
  mkdirSync(join(dir, "template", "app"), { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), STUB);
  chmodSync(join(bin, "pnpm"), 0o755);
  const folder = join(dir, "answers");
  mkdirSync(folder);
  for (const [graph, value] of Object.entries(answers)) writeFileSync(join(folder, `${graph}.json`), JSON.stringify(value));
  process.env.PATH = `${bin}:${previous ?? ""}`;
  process.env.AUDIT_LOG = join(dir, "pnpm.log");
  process.env.AUDIT_ANSWERS = folder;
  return dir;
}

function audit(dir: string) {
  const sink = capture();
  const status = development.main(["audit:dependencies"], { root: dir, io: sink.io });
  const log = readFileSync(join(dir, "pnpm.log"), "utf8").trim().split("\n");
  return { status, out: sink.out(), err: sink.err(), calls: log.filter((line) => line.includes(" audit ")) };
}

const reviewed = policy.advisories.map((entry) => advisoryOf(entry.id, entry.package, entry.severity, entry.installed[0] ?? "", entry.paths));
const clean = report([]);

describe("audit:dependencies", () => {
  test("an application with a clean report passes after auditing its three graphs through the package manager", () => {
    const dir = project("application", { runtime: clean, development: clean, tools: clean });
    const result = audit(dir);
    expect(result.status, result.err).toBe(0);
    expect(result.calls).toEqual([`${dir} audit --json --prod`, `${dir} audit --json --dev`, `${dir} audit --json`]);
  });

  test("the generator audits the seed too, and the committed decisions cover every reviewed advisory without an automatic fix", () => {
    const dir = project("generator", { runtime: clean, development: report(reviewed), tools: report(reviewed) });
    const result = audit(dir);
    expect(result.status, result.err).toBe(0);
    expect(result.calls).toHaveLength(6);
    expect(result.calls.filter((line) => line.startsWith(join(dir, "template", "app")))).toHaveLength(3);
    expect(result.calls.join("\n")).not.toMatch(/--fix|override|update/);
    expect(result.out.match(/reviewed, not fixed:/g)).toHaveLength(policy.advisories.length);
  });

  test("an advisory without a reviewed decision fails the command", () => {
    const dir = project("application", { runtime: clean, development: report([advisoryOf("GHSA-new-new-new", "left-pad", "high", "1.0.0")]), tools: clean });
    const result = audit(dir);
    expect(result.status).toBe(1);
    expect(result.err).toContain("GHSA-new-new-new left-pad@1.0.0 (high) has no reviewed decision");
  });

  test("an audit the registry could not answer fails instead of reporting a clean graph", () => {
    const dir = project("application", { runtime: clean, development: clean });
    const result = audit(dir);
    expect(result.status).toBe(1);
    expect(result.err).toContain("project tools: pnpm audit did not answer with a JSON report");
  });
});
