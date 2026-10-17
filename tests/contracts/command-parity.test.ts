import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { parseJson, type Manifest } from "../support/json.ts";

const root = resolve(import.meta.dirname, "../..");
const development = createRequire(import.meta.url)("../../scripts/development.cjs") as typeof import("../../scripts/development.cjs");

describe("generator and seed command parity", () => {
  for (const [role, path] of [
    ["generator", "package.json"],
    ["application", "template/app/package.json"],
  ] as const) {
    test(`${role} package scripts are exactly the projected command scripts`, () => {
      expect(parseJson<Manifest>(readFileSync(join(root, path), "utf8")).scripts).toEqual(development.scriptsFor(role));
    });
  }
});
