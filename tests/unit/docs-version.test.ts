import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const docs = createRequire(import.meta.url)("../../scripts/docs.cjs") as typeof import("../../scripts/docs.cjs");

describe("the documented version", () => {
  test("is the version of the package the site documents", () => {
    expect(docs.docsVersion({ name: "my-app", version: "1.2.3" })).toBe("1.2.3");
    expect(docs.docsVersion({ version: "0.4.0-rc.1+build.5" })).toBe("0.4.0-rc.1+build.5");
  });

  test.each([undefined, null, "not a manifest", {}, { version: 3 }, { version: "1.2" }, { version: "latest" }])("refuses %j", (manifest) => {
    expect(() => docs.docsVersion(manifest)).toThrow(/semantic "version"/);
  });
});

describe("the base path", () => {
  test("defaults to the root and accepts deployment paths", () => {
    expect(docs.siteBase(undefined)).toBe("/");
    expect(docs.siteBase("")).toBe("/");
    expect(docs.siteBase("/")).toBe("/");
    expect(docs.siteBase("/repo-name/")).toBe("/repo-name/");
    expect(docs.siteBase("/org/repo.name/")).toBe("/org/repo.name/");
  });

  test.each(["repo-name", "/repo-name", "//", "/a//b/", "/../x/", "/./", "/a/../", "https://example.com/", "/a b/", "/a\\b/"])("refuses %j", (value) => {
    expect(() => docs.siteBase(value)).toThrow(/DOCS_BASE/);
  });
});

describe("the staged web root", () => {
  const files = ["404.html", "a.html", "assets/app.js", "index.html", "nested/index.html", "nested/page.html"];

  test("places every file below the base and answers clean URLs without a redirect", () => {
    const plan = docs.stagePlan({ files, base: "/repo-name/", cleanUrls: true });
    expect(plan.map(({ to }) => to)).toEqual([
      "repo-name/404.html",
      "repo-name/404",
      "repo-name/a.html",
      "repo-name/a",
      "repo-name/assets/app.js",
      "repo-name/index.html",
      "repo-name/index",
      "repo-name/nested/index.html",
      "repo-name/nested/index",
      "repo-name/nested/page.html",
      "repo-name/nested/page",
    ]);
  });

  test("keeps the .html names when clean URLs are off and has no prefix at the root", () => {
    expect(docs.stagePlan({ files, base: "/", cleanUrls: false }).map(({ to }) => to)).toEqual(files);
  });
});

describe("the checker arguments", () => {
  test("name the web root, internal targets and every input, and nothing that suppresses a failure", () => {
    const args = docs.checkerArgs({ webRoot: "/stage", inputs: ["/stage/a.html", "/stage/orphan.html"] });
    expect(args).toEqual(["--root", "/stage", "--internal", "/stage/a.html", "/stage/orphan.html"]);
    expect(args.join(" ")).not.toMatch(/--(?:skip|todo|exclude)/);
  });
});

describe("enumerating the output", () => {
  const entry = (parentPath: string, name: string, file = true) => ({ parentPath, name, isFile: () => file });

  test("lists every file relative to the output, sorted, and no directory", () => {
    const files = {
      readdirSync: () => [entry("/out/nested", "b.html"), entry("/out", "a.html"), entry("/out", "nested", false), entry("/out/assets", "x.js")],
    };
    expect(docs.outputFiles("/out", files as never)).toEqual(["a.html", "assets/x.js", "nested/b.html"]);
  });
});

describe("the documentation gate", () => {
  function host(overrides: Partial<import("../../scripts/docs.cjs").Host> = {}) {
    const errors: string[] = [];
    const calls: { plan?: unknown; inputs?: unknown } = {};
    const value: import("../../scripts/docs.cjs").Host = {
      io: { stdout: () => undefined, stderr: (text) => errors.push(text) },
      vitepress: () => 0,
      site: () => ({ base: "/repo-name/", cleanUrls: true, outDir: "/out" }),
      emitted: () => ["index.html", "orphan.html", "assets/app.js"],
      check: (_outDir, plan, inputs) => {
        calls.plan = plan;
        calls.inputs = inputs;
        return 0;
      },
      ...overrides,
    };
    return { value, errors, calls };
  }

  test("checks every emitted page, the orphan included, at its place below the base", () => {
    const { value, calls, errors } = host();
    expect(docs.build(value)).toBe(0);
    expect(calls.inputs).toEqual(["repo-name/index.html", "repo-name/orphan.html"]);
    expect(errors).toEqual([]);
  });

  test("a failing site build is the result and nothing is checked", () => {
    const { value, calls } = host({ vitepress: () => 1 });
    expect(docs.build(value)).toBe(1);
    expect(calls.inputs).toBeUndefined();
  });

  test("a failing checker is never turned into success", () => {
    const { value, errors } = host({ check: () => 1 });
    expect(docs.build(value)).toBe(1);
    expect(errors.join("")).toMatch(/internal link check failed/);
  });

  test("a build that emitted no page fails", () => {
    const { value, errors } = host({ emitted: () => ["assets/app.js"] });
    expect(docs.build(value)).toBe(1);
    expect(errors.join("")).toMatch(/emitted no HTML/);
  });
});

describe("the effects around the gate", () => {
  type Options = Parameters<typeof docs.realHost>[0];
  const noIo = { stdout: () => undefined, stderr: () => undefined };
  const entry = (parentPath: string, name: string) => ({ parentPath, name, isFile: () => true });

  function disk() {
    const log: string[] = [];
    const value = {
      readdirSync: () => [entry("/out", "index.html")],
      realpathSync: (path: string) => path,
      mkdtempSync: (prefix: string) => `${prefix}XYZ`,
      mkdirSync: (path: string) => log.push(`mkdir ${path.replace(/^.*docs-check-XYZ/, "")}`),
      copyFileSync: (from: string, to: string) => log.push(`copy ${from} ${to.replace(/^.*docs-check-XYZ/, "")}`),
      rmSync: () => log.push("remove"),
    };
    return { value: value as unknown as NonNullable<Options["disk"]>, log };
  }

  test("launches the site build and lists the emitted files", () => {
    const launched: string[][] = [];
    const host = docs.realHost({ root: "/p", io: noIo, launch: (pkg, bin, args) => (launched.push([pkg, bin, ...args]), 0), disk: disk().value });
    expect(host.vitepress()).toBe(0);
    expect(launched).toEqual([["vitepress", "vitepress", "build", "docs"]]);
    expect(host.emitted("/out")).toEqual(["index.html"]);
  });

  test("reads the site configuration VitePress resolved, and refuses when it cannot", () => {
    const answer = (status: number, stdout: string) => () => ({ status, stdout, stderr: "boom" });
    const site = { base: "/x/", cleanUrls: true, outDir: "/out" };
    const ok = docs.realHost({ root: "/p", io: noIo, launch: () => 0, start: answer(0, JSON.stringify(site)) });
    expect(ok.site()).toEqual(site);
    const failing = docs.realHost({ root: "/p", io: noIo, launch: () => 0, start: answer(1, "") });
    expect(() => failing.site()).toThrow(/could not be resolved:\nboom/);
  });

  test("stages the plan, runs the checker on the staged inputs and removes the stage", () => {
    const { value, log } = disk();
    const launched: string[][] = [];
    const host = docs.realHost({ root: "/p", io: noIo, launch: (pkg, bin, args) => (launched.push([pkg, bin, ...args]), 3), disk: value });
    const status = host.check("/out", [{ from: "index.html", to: "repo/index.html" }], ["repo/index.html"]);
    expect(status).toBe(3);
    expect(log).toEqual(["mkdir /repo", "copy /out/index.html /repo/index.html", "remove"]);
    expect(launched[0]?.slice(0, 2)).toEqual(["hyperlink", "hyperlink"]);
    expect(launched[0]?.at(-1)).toMatch(/docs-check-XYZ\/repo\/index\.html$/);
  });

  test("removes the stage when the checker cannot start", () => {
    const { value, log } = disk();
    const host = docs.realHost({
      root: "/p",
      io: noIo,
      launch: () => {
        throw new Error("no hyperlink");
      },
      disk: value,
    });
    expect(() => host.check("/out", [], [])).toThrow(/no hyperlink/);
    expect(log).toEqual(["remove"]);
  });
});
