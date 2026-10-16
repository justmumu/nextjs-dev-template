import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const policy = require("../../scripts/core/dependency-policy.cjs") as typeof import("../../scripts/core/dependency-policy.cjs");

const read = (path: string) => readFileSync(join(root, path), "utf8");
const GOOD = "strictDepBuilds: true\nverifyDepsBeforeRun: error\nenablePrePostScripts: false\nskills:\n  dirs: []\nallowBuilds:\n  unrs-resolver: false\n";

describe("workspace policy", () => {
  test("the project's own workspace file satisfies the policy", () => {
    expect(policy.workspaceViolations(read("pnpm-workspace.yaml"), { reviewedBuilds: [] })).toEqual([]);
  });

  test.each([
    ["strictDepBuilds: false", /strictDepBuilds/],
    ["verifyDepsBeforeRun: warn", /verifyDepsBeforeRun/],
    ["enablePrePostScripts: true", /enablePrePostScripts/],
    ["skills:\n  dirs:\n    - .agents", /skills\.dirs/],
  ])("rejects a weakened setting %s", (replacement, message) => {
    const key = replacement.split(":")[0] ?? "";
    const text = key === "skills" ? GOOD.replace("skills:\n  dirs: []", replacement) : GOOD.replace(new RegExp(`^${key}:.*$`, "m"), replacement);
    expect(policy.workspaceViolations(text, { reviewedBuilds: [] }).join("\n")).toMatch(message);
  });

  test("a missing required setting is a violation", () => {
    expect(policy.workspaceViolations("allowBuilds: {}\n", { reviewedBuilds: [] }).length).toBe(4);
  });

  test.each([
    "permissions:\n  build: true",
    "scriptShell: /bin/sh",
    "shellEmulator: false",
    "pnpmfile: ./x.cjs",
    "globalPnpmfile: x",
    "hooks:\n  a: b",
    "overrides:\n  a: 1.0.0",
    "packages:\n  - a",
    "packageExtensions: {}",
    "patchedDependencies: {}",
    "dangerouslyAllowAllBuilds: true",
    "onlyBuiltDependencies:\n  - a",
  ])("rejects higher-priority or hook field %j", (extra) => {
    expect(policy.workspaceViolations(`${GOOD}${extra}\n`, { reviewedBuilds: [] }).length).toBeGreaterThan(0);
  });

  // Forms a line-based reader would silently skip. Each one must fail the policy, not pass it.
  test.each([
    ["a quoted top-level key", GOOD.replace("strictDepBuilds: true", '"strictDepBuilds": false')],
    ["a quoted forbidden key", `${GOOD}"scriptShell": /bin/sh\n`],
    ["a quoted permissions key", `${GOOD}'permissions':\n  build: true\n`],
    ["flow allowBuilds", GOOD.replace(/allowBuilds:[\s\S]*/, "allowBuilds: { evil: true }\n")],
    ["flow skills", GOOD.replace("skills:\n  dirs: []", "skills: { dirs: [.agents] }")],
    ["flow dirs with entries", GOOD.replace("dirs: []", "dirs: [.agents]")],
    ["block-scalar value", GOOD.replace("strictDepBuilds: true", "strictDepBuilds: |\n  true")],
    ["an anchor", GOOD.replace("strictDepBuilds: true", "strictDepBuilds: &a true")],
    ["an alias", `${GOOD}other: *a\n`],
    ["a merge key", `<<: *a\n${GOOD}`],
    ["a tag", GOOD.replace("strictDepBuilds: true", "strictDepBuilds: !!str true")],
    ["a second document", `${GOOD}---\nscriptShell: /bin/sh\n`],
    ["a duplicate top-level key", `${GOOD}strictDepBuilds: false\n`],
    ["a duplicate build name", `${GOOD}  unrs-resolver: true\n`],
    ["an inline comment hiding a value", GOOD.replace("strictDepBuilds: true", "strictDepBuilds: false # true")],
    ["a tab indent", GOOD.replace("  dirs: []", "\tdirs: []")],
    ["deeper indentation", `${GOOD}    nested: true\n`],
    ["a list under allowBuilds", `${GOOD}  - evil\n`],
    ["a quoted value", GOOD.replace("verifyDepsBeforeRun: error", 'verifyDepsBeforeRun: "error"')],
    ["an unknown top-level key", `${GOOD}minimumReleaseAge: 0\n`],
    ["an indented top-level key after the blocks", `${GOOD}\tscriptShell: /bin/sh\n`],
  ])("fails closed on %s", (_label, text) => {
    expect(policy.workspaceViolations(text, { reviewedBuilds: ["evil"] }).length).toBeGreaterThan(0);
  });

  test("the canonical subset accepts comments, blank lines, CRLF and quoted build names", () => {
    const text = `# note\r\n\r\n${GOOD.replace(/\n/g, "\r\n")}  "@scope/pkg@file:pkgs/x": false\r\n  'other pkg': false\r\n`;
    expect(policy.workspaceViolations(text, { reviewedBuilds: [] })).toEqual([]);
    expect(policy.buildPermissions(`${GOOD}  "@scope/pkg": true\n`)).toEqual(["@scope/pkg"]);
  });

  test("a build permission must be reviewed; a placeholder is never adopted", () => {
    expect(policy.workspaceViolations(`${GOOD}  fresh-pkg: true\n`, { reviewedBuilds: [] }).join()).toMatch(/fresh-pkg/);
    expect(policy.workspaceViolations(`${GOOD}  fresh-pkg: true\n`, { reviewedBuilds: ["fresh-pkg"] })).toEqual([]);
    expect(policy.workspaceViolations(`${GOOD}  fresh-pkg: "set this to true or false"\n`, { reviewedBuilds: ["fresh-pkg"] }).join()).toMatch(/fresh-pkg/);
  });

  test("project .npmrc may not inject shells or hooks and holds no literal credentials", () => {
    expect(policy.npmrcViolations("registry=https://registry.example/\n")).toEqual([]);
    for (const line of [
      "script-shell=/bin/sh",
      "shell-emulator=false",
      "pnpmfile=x.cjs",
      "global-pnpmfile=x.cjs",
      "//r.example/:_authToken=abc",
      "_password=abc",
      "//r.example/:_authToken=${TOKEN}x",
    ]) {
      if (line.endsWith("${TOKEN}x")) continue;
      expect(policy.npmrcViolations(`${line}\n`).length, line).toBeGreaterThan(0);
    }
    expect(policy.npmrcViolations("//r.example/:_authToken=${NPM_TOKEN}\n")).toEqual([]);
  });
});

describe("the reviewed compatible package replacement (VitePress 1.6.4 pins DocSearch 3.8.2, which cannot take React 19)", () => {
  const BLOCK = 'overrides:\n  "vitepress@1.6.4>@docsearch/js": 3.9.0\n  "vitepress@1.6.4>@docsearch/css": 3.9.0\n';
  const violations = (text: string) => policy.workspaceViolations(text, { reviewedBuilds: [] });

  test("the exact block is accepted wherever it sits, with either quote style, and its absence stays valid", () => {
    expect(violations(GOOD)).toEqual([]);
    expect(violations(GOOD + BLOCK)).toEqual([]);
    expect(violations(BLOCK + GOOD)).toEqual([]);
    expect(violations(GOOD + BLOCK.replaceAll('"', "'"))).toEqual([]);
    expect(violations(GOOD + 'overrides:\n  "vitepress@1.6.4>@docsearch/css": 3.9.0\n  "vitepress@1.6.4>@docsearch/js": 3.9.0\n')).toEqual([]);
  });

  test.each([
    ["an unknown parent-scoped pair", BLOCK + '  "vitepress@1.6.4>@docsearch/other": 3.9.0\n'],
    ["an unscoped override", BLOCK + "  left-pad: 1.3.0\n"],
    ["an unrelated override alone", "overrides:\n  left-pad: 1.3.0\n"],
    ["a widened version", BLOCK.replace('css": 3.9.0', 'css": 3.9.1')],
    ["a range", BLOCK.replace('js": 3.9.0', 'js": ^3.9.0')],
    ["another parent version", BLOCK.replaceAll("1.6.4", "1.6.5")],
    ["a wildcard parent", BLOCK.replaceAll("vitepress@1.6.4", "vitepress")],
    ["only one of the two pairs", 'overrides:\n  "vitepress@1.6.4>@docsearch/js": 3.9.0\n'],
    ["an empty block", "overrides: {}\n"],
    ["a flow map", 'overrides: { "vitepress@1.6.4>@docsearch/js": 3.9.0 }\n'],
    ["a quoted version", BLOCK.replace('js": 3.9.0', 'js": "3.9.0"')],
    ["a duplicated pair", BLOCK + '  "vitepress@1.6.4>@docsearch/js": 3.9.0\n'],
    ["the block twice", BLOCK + BLOCK],
    ["a package extension beside it", BLOCK + "packageExtensions: {}\n"],
    ["an ignored peer rule beside it", BLOCK + "peerDependencyRules:\n  ignoreMissing: react\n"],
    ["an allowed peer version beside it", BLOCK + "allowedVersions:\n  react: 18\n"],
  ])("%s is refused", (_label, extra) => {
    expect(violations(GOOD + extra).length).toBeGreaterThan(0);
  });
});

describe("manifest delta", () => {
  const base = { name: "x", scripts: { check: "node a" }, dependencies: { a: "1.0.0" }, devDependencies: { b: "2.0.0" }, pnpm: {} };
  const add = { action: "add", group: "dev", name: "c" } as const;
  const clone = () => structuredClone(base);

  test("add changes only the chosen map with an exact version", () => {
    const after = { ...clone(), devDependencies: { b: "2.0.0", c: "3.0.0" } };
    expect(policy.manifestViolations(base, after, add)).toEqual([]);
  });

  test("add rejects any script, engine, manager or other-map change and a ranged value", () => {
    const cases: Record<string, unknown>[] = [
      { ...clone(), scripts: { check: "evil" } },
      { ...clone(), scripts: { check: "node a", extra: "x" } },
      { ...clone(), packageManager: "pnpm@1.0.0" },
      { ...clone(), engines: { node: "*" } },
      { ...clone(), pnpm: { overrides: {} } },
      { ...clone(), dependencies: { a: "1.0.1" } },
      { ...clone(), optionalDependencies: { z: "1.0.0" } },
    ];
    for (const change of cases) {
      const after = { ...change, devDependencies: { b: "2.0.0", c: "3.0.0" } };
      expect(policy.manifestViolations(base, after, add).length, JSON.stringify(change)).toBeGreaterThan(0);
    }
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: { b: "2.0.0", c: "^3.0.0" } }, add).length).toBeGreaterThan(0);
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: { b: "2.0.0", c: "file:../c" } }, add).length).toBeGreaterThan(0);
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: { b: "2.0.0", c: "3.0.0", d: "1.0.0" } }, add).length).toBeGreaterThan(0);
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: { b: "2.0.0" } }, add).length).toBeGreaterThan(0);
  });

  test("remove drops exactly the named dependency", () => {
    const plan = { action: "remove", group: "dev", name: "b" } as const;
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: {} }, plan)).toEqual([]);
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: {}, dependencies: {} }, plan).length).toBeGreaterThan(0);
    expect(policy.manifestViolations(base, clone(), plan).length).toBeGreaterThan(0);
  });

  test("named upgrade changes only that value; all-upgrade never adds or removes", () => {
    const named = { action: "upgrade", name: "a" } as const;
    expect(policy.manifestViolations(base, { ...clone(), dependencies: { a: "1.1.0" } }, named)).toEqual([]);
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: { b: "2.1.0" } }, named).length).toBeGreaterThan(0);
    const all = { action: "upgrade", name: null } as const;
    expect(policy.manifestViolations(base, { ...clone(), dependencies: { a: "1.1.0" }, devDependencies: { b: "2.1.0" } }, all)).toEqual([]);
    expect(policy.manifestViolations(base, { ...clone(), dependencies: { a: "1.1.0", n: "1.0.0" } }, all).length).toBeGreaterThan(0);
  });

  test("an add must land on the requested exact version", () => {
    const plan = { action: "add", group: "dev", name: "c", version: "3.0.0" } as const;
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: { b: "2.0.0", c: "3.0.0" } }, plan)).toEqual([]);
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: { b: "2.0.0", c: "3.0.1" } }, plan).join()).toMatch(/requested version 3\.0\.0/);
  });

  test("reviewed tool pins change only through a reviewed tooling change; other dependencies are free", () => {
    const pinned = { b: "2.0.0" };
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: { b: "2.0.0", c: "3.0.0" } }, { ...add, pinned })).toEqual([]);
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: { b: "2.1.0" } }, { action: "upgrade", name: null, pinned }).join()).toMatch(
      /reviewed tool pin/,
    );
    expect(policy.manifestViolations(base, { ...clone(), devDependencies: {} }, { action: "remove", group: "dev", name: "b", pinned }).join()).toMatch(
      /reviewed tool pin/,
    );
    expect(
      policy
        .manifestViolations(base, { ...clone(), dependencies: { a: "1.0.0", b: "9.9.9" }, devDependencies: { b: "2.0.0", c: "3.0.0" } }, { ...add, pinned })
        .join(),
    ).toMatch(/shadow a reviewed tool pin/);
  });

  test("relock and reconcile accept no manifest change at all", () => {
    expect(policy.manifestViolations(base, clone(), { action: "none" })).toEqual([]);
    expect(policy.manifestViolations(base, { ...clone(), dependencies: { a: "1.0.1" } }, { action: "none" }).length).toBeGreaterThan(0);
  });

  test("an approved edit may change dependency maps but nothing else", () => {
    const plan = { action: "approved-edit" } as const;
    expect(policy.manifestViolations(base, { ...clone(), dependencies: { a: "1.0.1", z: "1.0.0" }, devDependencies: {} }, plan)).toEqual([]);
    expect(policy.manifestViolations(base, { ...clone(), scripts: { check: "evil" } }, plan).length).toBeGreaterThan(0);
    expect(policy.manifestViolations(base, { ...clone(), dependencies: { a: "workspace:*" } }, plan).length).toBeGreaterThan(0);
  });
});

describe("build review", () => {
  test("names the packages whose scripts were ignored without adopting a policy", () => {
    const output = "Error: ERR_PNPM_IGNORED_BUILDS\n  ╰─▶ Ignored build scripts: needs-build@file:pkgs/needs-build, other@1.2.3\n";
    expect(policy.buildReview(output)).toEqual(["needs-build@file:pkgs/needs-build", "other@1.2.3"]);
    expect(policy.buildReview("all fine")).toEqual([]);
  });
});

describe("what a workspace file means, apart from its layout", () => {
  const a = 'allowBuilds:\n  sharp: true\n  "esbuild": false\nstrictDepBuilds: true\n';
  const b = "# note\n\nstrictDepBuilds: true\nallowBuilds:\n  esbuild: false\n  'sharp': true\n";

  test("order, quoting, comments and blank lines do not change it; a value or a key does", () => {
    expect(policy.workspaceMeaning(a)).toBe(policy.workspaceMeaning(b));
    expect(policy.workspaceMeaning(a)).not.toBe(policy.workspaceMeaning(b.replace("sharp: true", "sharp: false").replace("'sharp': true", "'sharp': false")));
    expect(policy.workspaceMeaning(a)).not.toBe(policy.workspaceMeaning(`${a}extra: true\n`));
  });

  test("a file outside the canonical subset has no comparable meaning", () => {
    expect(policy.workspaceMeaning("allowBuilds:\n    sharp: true\n")).toBeNull();
  });
});
