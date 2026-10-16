import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const args = require("../../scripts/core/args.cjs") as typeof import("../../scripts/core/args.cjs");
const development = require("../../scripts/development.cjs") as typeof import("../../scripts/development.cjs");
const dependencies = require("../../scripts/dependencies.cjs") as typeof import("../../scripts/dependencies.cjs");
const processes = require("../../scripts/core/process.cjs") as typeof import("../../scripts/core/process.cjs");

const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

describe("argument grammar", () => {
  const schema = { package: { required: true, pattern: /^[a-z]+$/ }, group: { required: true, values: ["prod", "dev"] } };

  test("accepts each flag once as --name=value", () => {
    expect(args.parseArgs(["--package=abc", "--group=dev"], schema)).toEqual({ package: "abc", group: "dev" });
  });

  test.each([
    [["--package=abc", "--package=abd", "--group=dev"], /duplicate/],
    [["--package=abc", "--group=dev", "--force=1"], /unknown/],
    [["--package=abc", "--group=dev", "extra"], /unexpected/],
    [["--", "--package=abc", "--group=dev"], /unexpected|unknown/],
    [["--package", "abc", "--group=dev"], /unknown|unexpected/],
    [["--package=abc"], /--group is required/],
    [["--package=a$b", "--group=dev"], /--package/],
    [["--package=abc", "--group=admin"], /--group must be one of/],
    [["--package=", "--group=dev"], /empty/],
  ])("rejects %j", (argv, message) => {
    expect(() => args.parseArgs(argv, schema)).toThrow(message);
  });
});

describe("package specifier", () => {
  test.each([
    ["left-pad", { name: "left-pad", selector: null }],
    ["@scope/pkg", { name: "@scope/pkg", selector: null }],
    ["@scope/pkg@1.2.3", { name: "@scope/pkg", selector: "1.2.3" }],
    ["next@16.4.1", { name: "next", selector: "16.4.1" }],
    ["react@canary", { name: "react", selector: "canary" }],
  ])("%s is one literal name and selector", (spec, expected) => {
    expect(dependencies.parseSpec(spec)).toEqual(expected);
  });

  test.each(["", "-D", "left pad", "pkg@^1.0.0", "pkg@npm:other@1", "https://example.com/x.tgz", "file:../x", "git+ssh://x/y", "github:a/b", "workspace:*", "$(id)", "a;b", "a|b", "`id`", "pkg@1.2.3@4", "@scope", "../x", "UPPER", "pkg@"])("rejects %j", (spec) => {
    expect(() => dependencies.parseSpec(spec)).toThrow();
  });

  test("builds the pnpm argv for add, remove and upgrade without a shell", () => {
    expect(dependencies.pnpmArgsFor({ action: "add", group: "dev", name: "@scope/pkg", spec: "@scope/pkg@1.2.3" })).toEqual(["add", "--save-dev", "--save-exact", "@scope/pkg@1.2.3"]);
    expect(dependencies.pnpmArgsFor({ action: "add", group: "prod", name: "left-pad", spec: "left-pad" })).toEqual(["add", "--save-prod", "--save-exact", "left-pad"]);
    expect(dependencies.pnpmArgsFor({ action: "remove", group: "dev", name: "left-pad" })).toEqual(["remove", "--save-dev", "left-pad"]);
    expect(dependencies.pnpmArgsFor({ action: "upgrade", name: "left-pad" })).toEqual(["update", "--latest", "--save-exact", "left-pad"]);
    expect(dependencies.pnpmArgsFor({ action: "upgrade", name: null })).toEqual(["update", "--latest", "--save-exact"]);
  });

  test("the CLI grammar maps one validated request to one plan", () => {
    expect(dependencies.requestFromArgv("add", ["--package=@scope/pkg@1.2.3", "--group=dev"])).toMatchObject({ action: "add", group: "dev", name: "@scope/pkg", spec: "@scope/pkg@1.2.3" });
    expect(() => dependencies.requestFromArgv("add", ["--package=a", "--group=dev", "--group=prod"])).toThrow(/duplicate/);
    expect(() => dependencies.requestFromArgv("remove", ["--package=pkg@1.0.0", "--group=dev"])).toThrow();
    expect(() => dependencies.requestFromArgv("upgrade", ["--group=dev"])).toThrow(/unknown/);
    expect(() => dependencies.requestFromArgv("install", [])).toThrow(/unknown dependency command/);
  });
});

describe("credentials never reach output", () => {
  test("redacts registry tokens, passwords and URL userinfo", () => {
    const text = "//registry.example/:_authToken=abc123\n_password=c2VjcmV0\nhttps://user:pw@registry.example/x\nnpm_config_//r/:_authToken=zzz\nplain line";
    const out = processes.redact(text);
    for (const secret of ["abc123", "c2VjcmV0", "user:pw", "zzz"]) expect(out).not.toContain(secret);
    expect(out).toContain("plain line");
  });
});

describe("command definitions", () => {
  for (const [role, path] of [["generator", "package.json"], ["application", "template/app/package.json"]] as const) {
    test(`${role} package scripts are exactly the projected command scripts`, () => {
      expect(readJson(path).scripts).toEqual(development.scriptsFor(role));
    });
  }

  test("every script is a literal Node dispatcher call with no shell syntax", () => {
    for (const role of ["generator", "application"] as const) {
      for (const [name, script] of Object.entries(development.scriptsFor(role))) {
        expect(script, name).toMatch(/^node scripts\/(development|dependencies)\.cjs [a-z:-]+$/);
      }
    }
  });

  test("no pre/post hooks, no latest/npx/dlx, no Python or Make in any projected script", () => {
    for (const role of ["generator", "application"] as const) {
      for (const [name, script] of Object.entries(development.scriptsFor(role))) {
        expect(name).not.toMatch(/^(pre|post)/);
        expect(script).not.toMatch(/npx|dlx|latest|python|make/);
      }
    }
  });

  test("generator-only commands are absent from the application role", () => {
    const app = Object.keys(development.scriptsFor("application"));
    for (const name of ["template:create", "template:seed:refresh", "test:integration"]) {
      expect(Object.keys(development.scriptsFor("generator"))).toContain(name);
      expect(app).not.toContain(name);
    }
    for (const name of ["deps:add", "deps:remove", "deps:upgrade", "check", "test:one"]) expect(app).toContain(name);
  });
});

describe("dispatcher", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) }, out, err };
  }

  test("unavailable gates fail clearly instead of passing", () => {
    for (const command of ["format", "lint:fix", "test:permissions"]) {
      const sink = capture();
      expect(development.main([command], { root, io: sink.io })).not.toBe(0);
      expect(sink.err.join("")).toMatch(/not available yet|unavailable/);
    }
  });

  test("unknown commands, extra arguments and wrong-role commands are refused", () => {
    for (const argv of [["nope"], ["check", "--fast"], ["test:one"], ["test:one", "--test=tests/unit/x.test.ts", "--test=tests/unit/y.test.ts"]]) {
      const sink = capture();
      expect(development.main(argv, { root, io: sink.io, skipPreflight: true }), argv.join(" ")).toBe(2);
    }
  });

  test("test:one takes one existing test file and a literal name", () => {
    expect(development.testOneArgs(["--test=tests/unit/commands.test.ts"], root)).toEqual(["run", "tests/unit/commands.test.ts"]);
    expect(development.testOneArgs(["--test=tests/unit/commands.test.ts", "--name=a (b) [c]*"], root)).toEqual(["run", "tests/unit/commands.test.ts", "-t", "a \\(b\\) \\[c\\]\\*"]);
    for (const bad of ["--test=../package.json", "--test=/etc/passwd", "--test=tests/unit/missing.test.ts", "--test=package.json", "--test=tests"]) {
      expect(() => development.testOneArgs([bad], root), bad).toThrow();
    }
  });
});
