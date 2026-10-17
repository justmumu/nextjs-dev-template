import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { parseJson, type Manifest } from "../support/json.ts";

const root = resolve(import.meta.dirname, "../..");
const audit = createRequire(import.meta.url)("../../scripts/audit.cjs") as typeof import("../../scripts/audit.cjs");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("the reviewed audit decisions", () => {
  const { decisions, problems } = audit.decisionsOf(parseJson<unknown>(read("tooling/audit-policy.json")));

  test("are complete, current and dated", () => {
    expect(problems).toEqual([]);
    expect(decisions.length).toBeGreaterThan(0);
    for (const entry of decisions) expect(entry.reviewBy > entry.reviewed, entry.id).toBe(true);
  });

  test("no longer carry the advisories fixed by the reviewed overrides", () => {
    const fixed = new Set(["form-data", "qs"]);
    expect(decisions.filter(({ package: name }) => fixed.has(name))).toEqual([]);
  });

  // The unreachable-path decisions rest on how this repository uses the tools; a change to that use must come with a new review.
  test("rest on the way the tools are started: a production docs build, internal links only, no development server, no rootDir", () => {
    const docs = read("scripts/docs.cjs");
    expect(docs).toContain('launch("vitepress", "vitepress", ["build", "docs"])');
    expect(docs).toContain('return ["--root", webRoot, "--internal", ...inputs];');
    const scripts = Object.values(parseJson<Manifest>(read("package.json")).scripts ?? {}).join("\n");
    expect(scripts).not.toMatch(/vitepress (?:dev|serve|preview)|--fix/);
    for (const file of ["eslint.config.mjs", "template/app/eslint.config.mjs", "tooling/eslint/shared.mjs"]) expect(read(file), file).not.toMatch(/rootDir/);
  });
});

describe("the command against this repository", () => {
  test("audits the project and the seed with the committed decisions, and passes exactly when every committed advisory is the reviewed one", () => {
    const out: string[] = [];
    const err: string[] = [];
    const advisories = audit.decisionsOf(parseJson<unknown>(read("tooling/audit-policy.json"))).decisions.map((entry) => ({
      github_advisory_id: entry.id,
      module_name: entry.package,
      severity: entry.severity,
      findings: [{ version: entry.installed[0], paths: entry.paths }],
    }));
    const asked: string[] = [];
    const answer = (dir: string, args: readonly string[]) => {
      asked.push(`${dir} ${args.join(" ")}`);
      const list = args.includes("--prod") ? [] : advisories;
      return {
        status: list.length > 0 ? 1 : 0,
        stdout: JSON.stringify({ advisories: Object.fromEntries(list.map((entry, index) => [String(index), entry])), metadata: {} }),
      };
    };
    const status = audit.auditCommand([], { root, io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, host: { audit: answer } });
    expect(status, err.join("")).toBe(0);
    expect(asked).toHaveLength(6);
    expect(asked.filter((line) => line.startsWith("template/app") || line.startsWith(join("template", "app")))).toHaveLength(3);
    expect(out.join("")).toContain("reviewed, not fixed:");
  });

  test("an advisory that is not in the committed decisions fails it", () => {
    const err: string[] = [];
    const extra = {
      github_advisory_id: "GHSA-new-new-new",
      module_name: "left-pad",
      severity: "high",
      findings: [{ version: "1.0.0", paths: [".>left-pad"] }],
    };
    const status = audit.auditCommand([], {
      root,
      io: { stdout: () => undefined, stderr: (text) => err.push(text) },
      host: { audit: () => ({ status: 1, stdout: JSON.stringify({ advisories: { 0: extra }, metadata: {} }) }) },
    });
    expect(status).toBe(1);
    expect(err.join("")).toContain("GHSA-new-new-new left-pad@1.0.0 (high) has no reviewed decision");
  });
});
