import { globSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

// Unit and integration are told apart by the real collaborator, not by duration (R14, KTD10): a test
// that starts a process or changes the filesystem beyond its own scratch input belongs to the
// integration suite. This reads the sources of the default selection and refuses the APIs that do.

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const testing = require("../../scripts/core/testing.cjs") as typeof import("../../scripts/core/testing.cjs");
const toolchain = require("../../scripts/core/toolchain.cjs") as typeof import("../../scripts/core/toolchain.cjs");

const role = toolchain.readRole(root);
const select = (name: string) => {
  const suite = testing.SUITES[name];
  if (!suite) throw new Error(`unknown suite ${name}`);
  return testing.includeGlobs(suite).flatMap((pattern) => globSync(pattern, { cwd: root }));
};

// Starting a process, or linking, moving, removing or re-moding files for real, is what the process and
// filesystem integrations are about. Calls on an in-memory disk (`disk.unlinkSync`), and writing a scratch
// input file for a policy decision to read, are not matched.
const REAL_EFFECTS = [
  ["a child process", /node:child_process|\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/],
  ["the process wrapper started for real", /\bprocesses\.run(?:Logged)?\(\s*(?:process\.execPath|"(?:git|pnpm|node)")/],
  ["a symlink", /(?<![.\w])symlinkSync\(/],
  ["a changed mode", /(?<![.\w])chmodSync\(/],
  ["a moved, removed or copied entry of the code under test", /(?<![.\w])(?:renameSync|unlinkSync|copyFileSync|cpSync)\(/],
  ["a spied filesystem", /vi\.spyOn\(\s*fs\b/],
  ["the real report filesystem copier", /\btemplateCommands\.keepReports\s*\(/],
] as const;

describe("the default unit selection", () => {
  const defaults = ["infrastructure", "app"]
    .filter((name) => testing.suitesFor(role).includes(name))
    .flatMap(select)
    .sort();

  test("holds no integration test", () => {
    expect(defaults.filter((path) => path.startsWith("tests/integration/"))).toEqual([]);
  });

  // The renderer is the generator's; an application has neither test.
  test.runIf(role === "generator")("holds the renderer's decisions and none of its filesystem behaviour", () => {
    expect(defaults).toContain("tests/unit/renderer.test.ts");
    expect(defaults).not.toContain("tests/integration/renderer.test.ts");
    expect(select("integration")).toContain("tests/integration/renderer.test.ts");
    const source = readFileSync(join(root, "tests/unit/renderer.test.ts"), "utf8");
    expect([...source.matchAll(/import\s*\{([^}]*)\}\s*from "node:fs"/g)].map((match) => match[1]?.trim())).toEqual(["readFileSync"]);
    expect(source).not.toMatch(/node:os|mkdtemp|vi\.spyOn/);
  });

  // This file names the APIs it forbids, so it is the one file not read for them.
  test.each(defaults.filter((path) => path !== "tests/contracts/suite-classification.test.ts"))(
    "%s starts no process and changes no entry of the code under test",
    (path) => {
      const source = readFileSync(join(root, path), "utf8");
      const found = REAL_EFFECTS.filter(([, pattern]) => pattern.test(source)).map(([what]) => what);
      expect(found, `${path} uses ${found.join(", ")}: a real interaction belongs in tests/integration`).toEqual([]);
    },
  );
});

describe("the classification check itself", () => {
  test.each([
    'import { spawnSync } from "node:child_process";',
    "symlinkSync(a, b);",
    "chmodSync(path, 0o755);",
    "unlinkSync(path);",
    "vi.spyOn(fs, 'writeFileSync')",
    'processes.run(process.execPath, ["-e", "1"], {});',
    "templateCommands.keepReports(app, generator);",
  ])("%s is a real effect", (line) => {
    expect(REAL_EFFECTS.some(([, pattern]) => pattern.test(line))).toBe(true);
  });

  test.each(["writeFileSync(join(dir, name), content);", 'disk.unlinkSync("/p/a");', 'processes.runLogged("tool", [], opts, fake);'])("%s is not", (line) => {
    expect(REAL_EFFECTS.some(([, pattern]) => pattern.test(line))).toBe(false);
  });
});
