import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { docsSite, buildDocs, siteDir } from "../support/docs-site.ts";
import { installRenderedApp, output, removeDir, root, run, scratchDir } from "../support/rendered-app.ts";

const scratch = scratchDir("docs-");
afterAll(() => {
  removeDir(scratch);
});

const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

describe("valid sites pass the strict link gate", () => {
  for (const [label, env] of [
    ["at the root", {}],
    ["below /repo-name/", { DOCS_BASE: "/repo-name/" }],
  ] as const) {
    test(`headings, same-page, Unicode and duplicate-heading anchors, nested pages and assets ${label}`, () => {
      const dir = docsSite(scratch, `valid-${label.replace(/\W/g, "")}`, "valid");
      const result = buildDocs(dir, env);
      expect(output(result)).toMatch(/# pass\s+\d+/);
      expect(output(result)).not.toMatch(/not ok/);
      expect(result.status).toBe(0);
      const html = readFileSync(join(siteDir(dir), "index.html"), "utf8");
      const base = "DOCS_BASE" in env ? env.DOCS_BASE : "/";
      expect(html).toContain(`href="${base}assets/`);
      expect(html).toContain(">v1.2.3<");
    });
  }
});

describe("broken internal links fail the gate", () => {
  // VitePress itself refuses a missing page in Markdown; every other failure is hyperlink's.
  for (const [fixture, expected, by] of [
    ["missing-page", /dead link .*gone/, "vitepress"],
    ["missing-page-html", /not ok .*gone/, "hyperlink"],
    ["missing-asset", /not ok .*report\.pdf/, "hyperlink"],
    ["missing-fragment", /not ok .*no-such-heading/, "hyperlink"],
    ["orphan-fragment", /not ok .*#absent/, "hyperlink"],
  ] as const) {
    for (const env of [{}, { DOCS_BASE: "/repo-name/" }]) {
      test(`${fixture} exits nonzero and keeps the report (${JSON.stringify(env)})`, () => {
        const dir = docsSite(scratch, `${fixture}-${"DOCS_BASE" in env ? "base" : "root"}`, fixture);
        const result = buildDocs(dir, env);
        expect(result.status).not.toBe(0);
        expect(output(result)).toMatch(expected);
        if (by === "hyperlink") expect(output(result)).toMatch(/internal link check failed/);
      });
    }
  }

  test("a missing anchor in a page that exists is caught after a vitepress build that accepts it", () => {
    const dir = docsSite(scratch, "anchor-added", "valid");
    expect(buildDocs(dir).status).toBe(0);
    writeFileSync(join(dir, "docs/nested/page.md"), "# Nested\n\n[Broken](../guide#not-a-heading)\n");
    const result = buildDocs(dir);
    expect(result.status).not.toBe(0);
    expect(output(result)).toMatch(/not ok .*not-a-heading/);
  });
});

describe("what the site contains", () => {
  test("private notes and secret environment values never reach the output", () => {
    const dir = docsSite(scratch, "private", "private-notes", {
      extra: { "docs/.private/notes.md": "# Private research\n", "docs/.compound-engineering/plan.md": "# Plan\n" },
    });
    const result = buildDocs(dir, { DOCS_SECRET_TOKEN: "s3cr3t-value-123", DOCS_BASE: "/repo-name/" });
    expect(result.status, output(result)).toBe(0);
    const built = files(siteDir(dir));
    const relative = built.map((file) => file.slice(siteDir(dir).length));
    expect(relative.filter((file) => /private|plan|compound/i.test(file))).toEqual([]);
    for (const file of built) expect(readFileSync(file, "utf8"), file).not.toContain("s3cr3t-value-123");
    expect(built.some((file) => file.endsWith("index.html"))).toBe(true);
  });

  test("the version is the one of the package that owns the docs", () => {
    const dir = docsSite(scratch, "versioned", "private-notes", { version: "7.8.9" });
    expect(buildDocs(dir).status).toBe(0);
    expect(readFileSync(join(siteDir(dir), "index.html"), "utf8")).toContain(">v7.8.9<");
  });

  test("a package without a semantic version stops the build", () => {
    const dir = docsSite(scratch, "unversioned", "private-notes", { version: "next" });
    const result = buildDocs(dir);
    expect(result.status).not.toBe(0);
    expect(output(result)).toMatch(/semantic "version"/);
  });
});

describe("the generator's own and a generated application's documentation", () => {
  test("the generator's site builds with the real command", () => {
    const result = run(root, "pnpm", ["run", "docs:build"]);
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toMatch(/# pass\s+\d+/);
  });

  test("a rendered application builds its own tailored site, without generator content", () => {
    const app = installRenderedApp(scratch, "docs-app");
    const result = run(app, "pnpm", ["run", "docs:build"], 170_000, { DOCS_BASE: "/docs-app/" });
    expect(result.status, output(result)).toBe(0);
    const built = siteDir(app);
    const html = readFileSync(join(built, "index.html"), "utf8");
    expect(html).toContain(">v0.0.0<");
    expect(readdirSync(join(built, "contributing")).sort()).toEqual(["pr-checklist.html", "static-quality.html", "testing.html", "toolchain.html"]);
    for (const file of files(built).filter((name) => name.endsWith(".html"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/template:create|template:seed|versions\.json|renderer/);
    }
  }, 175_000);
});
