import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { parseJson } from "../support/json.ts";

// Pure rendering decisions: what the renderer makes of its inputs. The committed fixture is only the
// text it is given; writing a tree, symlinks, modes on disk and rollback are in
// tests/integration/renderer.test.ts because they are the renderer's real filesystem behaviour.
const require = createRequire(import.meta.url);
const render = require("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");

const fixture = resolve(import.meta.dirname, "../fixtures/render");
interface ManifestEntry {
  type: string;
  base: string;
  source: string;
  destination: string;
}
const manifest = parseJson<{ entries: ManifestEntry[] } & Record<string, unknown>>(readFileSync(join(fixture, "manifest.json"), "utf8"));
const bases = { template: join(fixture, "template"), root: join(fixture, "root") };

const answers = { name: "demo-app", description: "A demo", owner: "some-owner" };

describe("determinism", () => {
  test("same inputs give the same bytes, modes and digest", () => {
    const a = render.renderTree({ manifest, bases, answers });
    const b = render.renderTree({ manifest, bases, answers });
    expect(a.digest).toBe(b.digest);
    expect(a.files.map((file) => [file.path, file.mode, file.content.toString("base64")])).toEqual(
      b.files.map((file) => [file.path, file.mode, file.content.toString("base64")]),
    );
    expect(a.files.find((file) => file.path === "bin/run.sh")?.mode).toBe(0o755);
    expect(a.files.find((file) => file.path === "dir/data.txt")?.mode).toBe(0o644);
  });

  test("a different answer changes the digest", () => {
    const a = render.renderTree({ manifest, bases, answers });
    const b = render.renderTree({ manifest, bases, answers: { ...answers, name: "other-app" } });
    expect(a.digest).not.toBe(b.digest);
  });

  test("output has no timestamps or local paths", () => {
    const { files } = render.renderTree({ manifest, bases, answers });
    for (const file of files) {
      const text = file.content.toString("utf8");
      expect(text).not.toContain(fixture);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });
});

describe("metadata projection", () => {
  function projected(overrides: Record<string, unknown>) {
    const { files } = render.renderTree({ manifest, bases, answers: { ...answers, ...overrides } });
    const file = files.find((entry) => entry.path === "package.json");
    return { text: (file?.content as Buffer).toString("utf8"), json: parseJson((file?.content as Buffer).toString("utf8")) };
  }

  test("quotes, backslashes, Unicode and numeric-looking text survive losslessly", () => {
    for (const description of ['say "hi" \\ back', "çok güzel ✓ 日本語 😀", "0123", "1e3", "true", "null", "{{ x }}", "$(id) `id` ${HOME}"]) {
      const { json } = projected({ description });
      expect(json.description).toBe(description);
      expect(json.private).toBe(true);
    }
  });

  test("version is answer-owned and defaults to 0.0.0", () => {
    expect(projected({}).json.version).toBe("0.0.0");
    expect(projected({ version: "1.2.3" }).json.version).toBe("1.2.3");
  });

  test("owner is projected as author and omitted when absent", () => {
    expect(projected({}).json.author).toBe("some-owner");
    expect(projected({ owner: undefined }).json).not.toHaveProperty("author");
  });

  test("output is canonical two-space JSON with a final newline", () => {
    const { text, json } = projected({});
    expect(text).toBe(`${JSON.stringify(json, null, 2)}\n`);
  });

  test("template keys are kept after the projected metadata", () => {
    expect(Object.keys(projected({}).json)).toEqual(["name", "version", "description", "author", "private", "type"]);
  });
});

describe("answers validation", () => {
  const bad: [string, unknown][] = [
    ["unknown answer", { ...answers, extra: "x" }],
    ["missing name", { description: "x" }],
    ["newline in name", { ...answers, name: "a\nb" }],
    ["uppercase name", { ...answers, name: "Demo" }],
    ["path-like name", { ...answers, name: "../x" }],
    ["control char in description", { ...answers, description: "a\nb" }],
    ["lone surrogate", { ...answers, description: "a\ud800" }],
    ["non-string description", { ...answers, description: 3 }],
    ["owner with e-mail", { ...answers, owner: "me@example.com" }],
    ["non-semver version", { ...answers, version: "latest" }],
    ["array answers", []],
    ["null answers", null],
  ];
  for (const [label, value] of bad) {
    test(`rejects ${label}`, () => {
      expect(() => render.renderTree({ manifest, bases, answers: value })).toThrow(render.RenderError);
    });
  }
});

describe("manifest validation", () => {
  const entry = manifest.entries[2];
  if (entry === undefined) throw new Error("the fixture manifest needs three entries");
  function withEntries(entries: unknown[], extra: Record<string, unknown> = {}) {
    return { ...manifest, entries, ...extra };
  }
  const bad: [string, unknown][] = [
    ["unknown schema", { ...manifest, schema: "other" }],
    ["unsupported protocol", { ...manifest, protocol: 2 }],
    ["non-application role", { ...manifest, role: "generator" }],
    ["missing role", (({ role: _role, ...rest }) => rest)(manifest)],
    ["unknown top-level key", { ...manifest, hooks: [] }],
    ["unknown entry type", withEntries([{ ...entry, type: "exec" }])],
    ["unknown entry key", withEntries([{ ...entry, replace: { a: "b" } }])],
    ["unknown projection", withEntries([{ ...manifest.entries[0], projection: "shell" }])],
    ["unknown base", withEntries([{ ...entry, base: "home" }])],
    ["absolute destination", withEntries([{ ...entry, destination: "/etc/passwd" }])],
    ["traversal destination", withEntries([{ ...entry, destination: "../x" }])],
    ["nested traversal destination", withEntries([{ ...entry, destination: "a/../../x" }])],
    ["backslash destination", withEntries([{ ...entry, destination: "a\\b" }])],
    ["dot segment destination", withEntries([{ ...entry, destination: "a/./b" }])],
    ["git directory destination", withEntries([{ ...entry, destination: ".git/hooks/x" }])],
    ["newline destination", withEntries([{ ...entry, destination: "a\nb" }])],
    ["absolute source", withEntries([{ ...entry, source: "/etc/passwd" }])],
    ["traversal source", withEntries([{ ...entry, source: "../x" }])],
    ["duplicate destination", withEntries([entry, entry])],
    ["case-colliding destination", withEntries([entry, { ...entry, destination: entry.destination.toUpperCase() }])],
    ["file and directory collision", withEntries([entry, { ...entry, destination: "dir/data.txt/x" }])],
    ["empty entries", withEntries([])],
  ];
  for (const [label, value] of bad) {
    test(`rejects ${label}`, () => {
      expect(() => render.renderTree({ manifest: value, bases, answers })).toThrow(render.RenderError);
    });
  }
});

describe("destination argument", () => {
  const { files } = render.renderTree({ manifest, bases, answers });

  test("rejects a relative destination root", () => {
    expect(() => {
      render.writeTree(files, "relative/dest");
    }).toThrow(/absolute/);
  });

  test("rejects a tampered file list before anything is written", () => {
    const evil = [{ path: "../escape.txt", mode: 0o644, content: Buffer.from("x") }];
    expect(() => {
      render.writeTree(evil, "/never-written");
    }).toThrow(render.RenderError);
    expect(() => {
      render.writeTree([{ path: "a.txt", mode: 0o777, content: Buffer.from("x") }], "/never-written");
    }).toThrow(/unsupported mode/);
    expect(() => {
      render.writeTree(
        [
          { path: "a.txt", mode: 0o644, content: Buffer.from("x") },
          { path: "A.txt", mode: 0o644, content: Buffer.from("y") },
        ],
        "/never-written",
      );
    }).toThrow(render.RenderError);
  });
});

describe("protocol constants", () => {
  test("exports the supported schema and protocol", () => {
    expect(render.SCHEMA).toBe("nextjs-dev-template/manifest");
    expect(render.PROTOCOL).toBe(1);
  });
});
