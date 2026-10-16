import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  test("renders the application into a new directory and reports its digest", () => {
    const sink = capture();
    const cwd = scratch.project();
    expect(commands.templateCreate(["--name=made-app", "--owner=made-owner", "--dest=out"], { root, cwd, io: sink.io })).toBe(0);
    const report = JSON.parse(sink.out()) as { files: number; digest: string };
    expect(report.files).toBeGreaterThan(10);
    expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((JSON.parse(readFileSync(join(cwd, "out/package.json"), "utf8")) as { name: string }).name).toBe("made-app");
  });

  test("requires every answer, and leaves a non-empty destination alone", () => {
    const cwd = scratch.project({ "out/keep.txt": "mine" });
    const io = capture().io;
    expect(() => commands.templateCreate(["--name=made-app", "--owner=o"], { root, cwd, io })).toThrow(/--dest is required/);
    expect(() => commands.templateCreate(["--name=made-app", "--owner=o", "--dest=out"], { root, cwd, io })).toThrow(/not empty/);
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
  const render = require("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");
  const walk = (dir: string, prefix = ""): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    );

  test("renders the same tree, bytes and modes as the API and refuses a non-empty destination", () => {
    const dest = join(scratch.project(), "cli");
    const cli = (target: string) =>
      run(root, process.execPath, [join(root, "scripts/development.cjs"), "template:create", "--name=first-app", "--owner=first-owner", `--dest=${target}`]);
    const first = cli(dest);
    expect(first.status, output(first)).toBe(0);
    const { manifest, bases } = render.defaultInputs();
    const same = render.renderTree({ manifest, bases, answers: { name: "first-app", owner: "first-owner" } });
    expect(JSON.parse(first.stdout)).toEqual({ files: same.files.length, digest: same.digest });
    expect(walk(dest)).toEqual(same.files.map((file) => file.path));
    for (const file of same.files) {
      expect(statSync(join(dest, file.path)).mode & 0o777, file.path).toBe(file.mode);
      expect(readFileSync(join(dest, file.path)).equals(file.content), file.path).toBe(true);
    }
    const second = cli(dest);
    expect(second.status).toBe(2);
    expect(second.stderr).toMatch(/not empty/);
  });
});
