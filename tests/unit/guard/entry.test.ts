import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const entry = createRequire(import.meta.url)("../../../scripts/hooks/entry.cjs") as typeof import("../../../scripts/hooks/entry.cjs");

const SOURCES: Record<string, string> = {
  "/p/scripts/hooks/guard.cjs":
    '"use strict";\nconst helper = require("./helper.cjs");\nconst shared = require("../core/shared.cjs");\nconst os = require("node:os");\nexports.answer = [helper.value, shared.value, os, typeof require.main, __filename, __dirname];\n',
  "/p/scripts/hooks/helper.cjs": 'exports.value = "helper";\nexports.again = require("./guard.cjs");\n',
  "/p/scripts/core/shared.cjs": 'module.exports = { value: "shared" };\n',
  "/p/scripts/hooks/bare.cjs": 'require("left-pad");\n',
  "/p/scripts/hooks/outside.cjs": 'require("../../src/app.cjs");\n',
  "/p/scripts/hooks/json.cjs": 'require("./data.json");\n',
  "/p/scripts/hooks/absolute.cjs": 'require("/p/scripts/core/shared.cjs");\n',
  "/p/src/app.cjs": "exports.x = 1;\n",
};

const loader = () => entry.createLoader({ scripts: "/p/scripts", readFile: (path) => SOURCES[path] ?? "", builtin: (name) => `builtin:${name}` });

describe("loading the guard without Node's module resolver", () => {
  test("local modules load each other, node: modules come from the host, and no module is the main module", () => {
    const guard = loader()("/p/scripts/hooks/guard.cjs") as { answer: unknown[] };
    expect(guard.answer).toEqual(["helper", "shared", "builtin:node:os", "undefined", "/p/scripts/hooks/guard.cjs", "/p/scripts/hooks"]);
  });

  test("a module is loaded once, and a cycle sees the exports so far", () => {
    const load = loader();
    expect(load("/p/scripts/hooks/guard.cjs")).toBe(load("/p/scripts/hooks/guard.cjs"));
    expect((load("/p/scripts/hooks/helper.cjs") as { again: unknown }).again).toBeDefined();
  });

  test.each(["bare", "outside", "json", "absolute"])("%s is refused: only node: modules and .cjs files below scripts are loadable", (name) => {
    expect(() => loader()(`/p/scripts/hooks/${name}.cjs`)).toThrow(/loads only node: modules and \.cjs files below its scripts directory/);
  });
});
