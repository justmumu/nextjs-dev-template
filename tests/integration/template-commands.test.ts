import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture, scratchArea } from "../support/project.ts";
import { output, run } from "../support/rendered-app.ts";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const commands = require("../../scripts/template/commands.cjs") as typeof import("../../scripts/template/commands.cjs");
const scratch = scratchArea("template-commands-");

describe("template:create", () => {
  test("requires every answer, and leaves a non-empty destination alone", async () => {
    const cwd = scratch.project({ "out/keep.txt": "mine" });
    const io = capture().io;
    expect(() => commands.templateCreate(["--name=made-app", "--owner=o"], { root, cwd, io })).toThrow(/--dest is required/);
    expect(await commands.templateCreate(["--name=made-app", "--owner=o", "--dest=out"], { root, cwd, io })).toBe(2);
    expect(readFileSync(join(cwd, "out/keep.txt"), "utf8")).toBe("mine");
  });
});

describe("template:seed:refresh", () => {
  test("refuses a seed manifest that drifted from the reviewed pins before running any package manager", () => {
    const copy = scratch.project();
    mkdirSync(join(copy, "template"), { recursive: true });
    cpSync(join(root, "template/app"), join(copy, "template/app"), { recursive: true });
    cpSync(join(root, "tooling"), join(copy, "tooling"), { recursive: true });
    const seedManifest = join(copy, "template/app/package.json");
    const parsed = JSON.parse(readFileSync(seedManifest, "utf8")) as { dependencies: Record<string, string> };
    parsed.dependencies["react"] = "0.0.1";
    writeFileSync(seedManifest, JSON.stringify(parsed));
    const lock = readFileSync(join(copy, "template/app/pnpm-lock.yaml"), "utf8");
    const sink = capture();
    expect(commands.seedRefresh([], { root: copy, cwd: copy, io: sink.io })).toBe(1);
    expect(sink.err()).toMatch(/does not match the reviewed pins/);
    expect(readFileSync(join(copy, "template/app/pnpm-lock.yaml"), "utf8")).toBe(lock);
    expect(existsSync(join(copy, "node_modules"))).toBe(false);
  });

  test("takes no arguments", () => {
    expect(() => commands.seedRefresh(["--force=1"], { root, cwd: root, io: capture().io })).toThrow(/unknown|unexpected/);
  });
});

describe("template:create as a process", () => {
  test("refuses a non-empty destination with a usage status, before staging or writing anything", () => {
    const dest = scratch.project({ "keep.txt": "mine" });
    const result = run(root, process.execPath, [
      join(root, "scripts/development.cjs"),
      "template:create",
      "--name=first-app",
      "--owner=first-owner",
      `--dest=${dest}`,
    ]);
    expect(result.status, output(result)).toBe(2);
    expect(result.stderr).toMatch(/not empty/);
    expect(readFileSync(join(dest, "keep.txt"), "utf8")).toBe("mine");
  });
});
