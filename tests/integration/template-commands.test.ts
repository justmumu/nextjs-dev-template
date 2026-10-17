import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  test("refuses a non-exact seed version before running any package manager", () => {
    const copy = scratch.project();
    mkdirSync(join(copy, "template"), { recursive: true });
    cpSync(join(root, "template/app"), join(copy, "template/app"), { recursive: true });
    cpSync(join(root, "tooling"), join(copy, "tooling"), { recursive: true });
    const seedManifest = join(copy, "template/app/package.json");
    const parsed = JSON.parse(readFileSync(seedManifest, "utf8")) as { dependencies: Record<string, string> };
    parsed.dependencies["react"] = "^19.3.0";
    writeFileSync(seedManifest, JSON.stringify(parsed));
    const lock = readFileSync(join(copy, "template/app/pnpm-lock.yaml"), "utf8");
    const sink = capture();
    expect(commands.seedRefresh([], { root: copy, cwd: copy, io: sink.io })).toBe(1);
    expect(sink.err()).toMatch(/dependencies.react must be an exact version/);
    expect(readFileSync(join(copy, "template/app/pnpm-lock.yaml"), "utf8")).toBe(lock);
    expect(existsSync(join(copy, "node_modules"))).toBe(false);
  });

  test.each(["7.8.5", "99999.0.0"])("refreshing an exact seed version %s resolves in isolation and preserves the lock on failure", (version) => {
    const copy = scratch.project({ "package.json": '{"name":"root-fixture","private":true}\n', "pnpm-lock.yaml": "root-lock\n" });
    mkdirSync(join(copy, "template"), { recursive: true });
    cpSync(join(root, "template/app"), join(copy, "template/app"), { recursive: true });
    writeFileSync(join(copy, ".node-version"), readFileSync(join(root, ".node-version")));
    const seed = join(copy, "template/app");
    const manifest = JSON.parse(readFileSync(join(seed, "package.json"), "utf8")) as Record<string, unknown>;
    manifest.dependencies = { semver: version };
    manifest.devDependencies = {};
    writeFileSync(join(seed, "package.json"), JSON.stringify(manifest));
    const beforeManifest = readFileSync(join(seed, "package.json"), "utf8");
    const beforeLock = readFileSync(join(seed, "pnpm-lock.yaml"), "utf8");
    const temporary = scratch.project();
    const script =
      "const { refreshSeed } = require(process.argv[1]); process.exitCode = refreshSeed({ root: process.cwd(), io: { stdout: t => process.stdout.write(t), stderr: t => process.stderr.write(t) } });";
    const result = run(copy, process.execPath, ["-e", script, join(root, "scripts/template/seed.cjs")], 170_000, { TMPDIR: temporary });
    const lock = readFileSync(join(seed, "pnpm-lock.yaml"), "utf8");
    if (version === "7.8.5") {
      expect(result.status, output(result)).toBe(0);
      expect(lock).not.toBe(beforeLock);
      expect(lock).toContain("specifier: 7.8.5");
      expect(result.stdout).toContain("updated; review the diff");
    } else {
      expect(result.status, output(result)).toBe(1);
      expect(result.stderr).toContain("pnpm could not resolve the seed lock");
      expect(lock).toBe(beforeLock);
    }
    expect(readFileSync(join(seed, "package.json"), "utf8")).toBe(beforeManifest);
    expect(readFileSync(join(copy, "package.json"), "utf8")).toBe('{"name":"root-fixture","private":true}\n');
    expect(readFileSync(join(copy, "pnpm-lock.yaml"), "utf8")).toBe("root-lock\n");
    expect(existsSync(join(copy, "node_modules"))).toBe(false);
    expect(existsSync(join(seed, "node_modules"))).toBe(false);
    expect(readdirSync(temporary).filter((name) => name.startsWith("seed-refresh-"))).toEqual([]);
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
