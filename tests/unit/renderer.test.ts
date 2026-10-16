import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { parseJson } from "../support/json.ts";

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
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "renderer-unit-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let counter = 0;
function fresh(label: string) {
  return join(scratch, `${label}-${counter++}`);
}

function listTree(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listTree(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

const answers = { name: "demo-app", description: "A demo", owner: "some-owner" };

describe("determinism", () => {
  test("same inputs give the same bytes, modes and digest from two roots", () => {
    const a = render.renderTree({ manifest, bases, answers });
    const b = render.renderTree({ manifest, bases, answers });
    expect(a.digest).toBe(b.digest);
    const destA = fresh("a");
    const destB = fresh("b");
    render.writeTree(a.files, destA);
    render.writeTree(b.files, destB);
    expect(listTree(destA)).toEqual(listTree(destB));
    for (const file of listTree(destA)) {
      expect(readFileSync(join(destA, file)).equals(readFileSync(join(destB, file))), file).toBe(true);
      expect(statSync(join(destA, file)).mode & 0o777, file).toBe(statSync(join(destB, file)).mode & 0o777);
    }
    expect(statSync(join(destA, "bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(destA, "dir/data.txt")).mode & 0o777).toBe(0o644);
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
      expect(text).not.toContain(scratch);
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

describe("source safety", () => {
  function sandbox() {
    const dir = fresh("src");
    mkdirSync(join(dir, "template"), { recursive: true });
    mkdirSync(join(dir, "outside"), { recursive: true });
    writeFileSync(join(dir, "outside", "secret.txt"), "secret\n");
    return dir;
  }
  const one = (source: string) => ({ ...manifest, entries: [{ type: "copy", base: "template", source, destination: "out.txt" }] });

  test("rejects a symlinked source file", () => {
    const dir = sandbox();
    symlinkSync(join(dir, "outside", "secret.txt"), join(dir, "template", "link.txt"));
    expect(() => render.renderTree({ manifest: one("link.txt"), bases: { template: join(dir, "template"), root: dir }, answers })).toThrow(/symlink/);
  });

  test("rejects a symlinked source ancestor", () => {
    const dir = sandbox();
    symlinkSync(join(dir, "outside"), join(dir, "template", "sub"));
    expect(() => render.renderTree({ manifest: one("sub/secret.txt"), bases: { template: join(dir, "template"), root: dir }, answers })).toThrow(/symlink/);
  });

  test("rejects a symlinked base directory", () => {
    const dir = sandbox();
    symlinkSync(join(dir, "outside"), join(dir, "linked-base"));
    expect(() => render.renderTree({ manifest: one("secret.txt"), bases: { template: join(dir, "linked-base"), root: dir }, answers })).toThrow(/symlink/);
  });

  test("rejects a directory or submodule checkout as a source", () => {
    const dir = sandbox();
    mkdirSync(join(dir, "template", "module"));
    writeFileSync(join(dir, "template", "module", ".git"), "gitdir: ../.git/modules/module\n");
    expect(() => render.renderTree({ manifest: one("module"), bases: { template: join(dir, "template"), root: dir }, answers })).toThrow(/regular file/);
  });

  test("rejects a missing source", () => {
    const dir = sandbox();
    expect(() => render.renderTree({ manifest: one("nope.txt"), bases: { template: join(dir, "template"), root: dir }, answers })).toThrow(render.RenderError);
  });

  test("rejects invalid JSON and projected-key collisions in the template", () => {
    const dir = sandbox();
    const bases2 = { template: join(dir, "template"), root: dir };
    const projection = { ...manifest, entries: [{ ...manifest.entries[0], source: "package.json" }] };
    writeFileSync(join(dir, "template", "package.json"), "{ nope");
    expect(() => render.renderTree({ manifest: projection, bases: bases2, answers })).toThrow(render.RenderError);
    writeFileSync(join(dir, "template", "package.json"), '{"name":"preset"}');
    expect(() => render.renderTree({ manifest: projection, bases: bases2, answers })).toThrow(/name/);
  });

  test("normalizes the executable bit only", () => {
    const dir = sandbox();
    writeFileSync(join(dir, "template", "odd.txt"), "x");
    chmodSync(join(dir, "template", "odd.txt"), 0o666);
    const { files } = render.renderTree({ manifest: one("odd.txt"), bases: { template: join(dir, "template"), root: dir }, answers });
    expect(files[0]?.mode).toBe(0o644);
  });
});

describe("destination safety", () => {
  const { files } = render.renderTree({ manifest, bases, answers });

  test("creates a missing destination root, including parents", () => {
    const dest = join(fresh("new"), "deeper");
    render.writeTree(files, dest);
    expect(existsSync(join(dest, "package.json"))).toBe(true);
  });

  test("accepts an existing empty directory", () => {
    const dest = fresh("empty");
    mkdirSync(dest);
    render.writeTree(files, dest);
    expect(existsSync(join(dest, ".node-version"))).toBe(true);
  });

  test("rejects a non-empty destination without touching it", () => {
    const dest = fresh("full");
    mkdirSync(dest);
    writeFileSync(join(dest, "keep.txt"), "mine");
    expect(() => {
      render.writeTree(files, dest);
    }).toThrow(/not empty/);
    expect(listTree(dest)).toEqual(["keep.txt"]);
    expect(readFileSync(join(dest, "keep.txt"), "utf8")).toBe("mine");
  });

  test("rejects an existing file or a symlinked destination root", () => {
    const target = fresh("target");
    mkdirSync(target);
    const link = fresh("link");
    symlinkSync(target, link);
    expect(() => {
      render.writeTree(files, link);
    }).toThrow(/symlink/);
    expect(listTree(target)).toEqual([]);
    const file = fresh("file");
    writeFileSync(file, "x");
    expect(() => {
      render.writeTree(files, file);
    }).toThrow(render.RenderError);
  });

  test("rejects a relative destination root", () => {
    expect(() => {
      render.writeTree(files, "relative/dest");
    }).toThrow(/absolute/);
  });

  test("never writes outside the destination for tampered file lists", () => {
    const dest = fresh("tamper");
    const evil = [{ path: "../escape.txt", mode: 0o644, content: Buffer.from("x") }];
    expect(() => {
      render.writeTree(evil, dest);
    }).toThrow(render.RenderError);
    expect(existsSync(join(dest, "..", "escape.txt"))).toBe(false);
  });

  test("removes what it created when a write fails midway", () => {
    const dest = join(fresh("rollback"), "deeper");
    const broken = [...files, { path: "package.json/nested", mode: 0o644, content: Buffer.from("x") }];
    expect(() => {
      render.writeTree(broken, dest);
    }).toThrow();
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(dest, ".."))).toBe(false);
  });
});

describe("symlinked ancestors", () => {
  test("rejects a symlink among the destination ancestors before writing anything", () => {
    const { files } = render.renderTree({ manifest, bases, answers });
    const outside = fresh("outside");
    mkdirSync(outside);
    const alias = fresh("alias");
    symlinkSync(outside, alias);
    expect(() => {
      render.writeTree(files, join(alias, "app"));
    }).toThrow(/symlink/);
    expect(listTree(outside)).toEqual([]);
  });

  test("rejects a symlink among the source base ancestors", () => {
    const real = fresh("real");
    mkdirSync(join(real, "template"), { recursive: true });
    writeFileSync(join(real, "template", "a.txt"), "a\n");
    const alias = fresh("alias");
    symlinkSync(real, alias);
    const entries = [{ type: "copy", base: "template", source: "a.txt", destination: "a.txt" }];
    expect(() => render.renderTree({ manifest: { ...manifest, entries }, bases: { template: join(alias, "template"), root: real }, answers })).toThrow(
      /symlink/,
    );
  });
});

describe("rollback ownership", () => {
  afterEach(() => vi.restoreAllMocks());
  const planned = ["a.txt", "b.txt", "c.txt"].map((path) => ({ path, mode: 0o644, content: Buffer.from(`generated ${path}\n`) }));

  /** Runs `before` just before the renderer writes the named file; a `fail` error replaces that write. */
  function interceptWrite(name: string, before: () => void, fail?: Error) {
    const original = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target: unknown, ...rest: unknown[]) => {
      if (String(target).endsWith(`/${name}`)) {
        before();
        if (fail) throw fail;
      }
      (original as (...args: unknown[]) => void)(target, ...rest);
    });
  }

  test("removes owned files and newly created parents after an actual write failure", () => {
    const parent = fresh("failed-write-parents");
    const dest = join(parent, "deeper");
    interceptWrite(
      "b.txt",
      () => {
        expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("generated a.txt\n");
      },
      new Error("simulated disk write failure"),
    );
    expect(() => {
      render.writeTree(planned, dest);
    }).toThrow(/simulated disk write failure/);
    expect(existsSync(parent)).toBe(false);
  });

  test("preserves a file a concurrent user created at a planned path", () => {
    const dest = fresh("collision");
    // The user's write goes through the unmocked function; the renderer's wx write then hits EEXIST.
    const original = fs.writeFileSync;
    interceptWrite("b.txt", () => {
      original(join(dest, "b.txt"), "user content\n");
    });
    expect(() => {
      render.writeTree(planned, dest);
    }).toThrow(/EEXIST/);
    expect(listTree(dest)).toEqual(["b.txt"]);
    expect(readFileSync(join(dest, "b.txt"), "utf8")).toBe("user content\n");
  });

  test("preserves a created file that changed concurrently, and still removes the rest", () => {
    const dest = fresh("edited");
    const original = fs.writeFileSync;
    interceptWrite(
      "c.txt",
      () => {
        original(join(dest, "a.txt"), "edited by user\n");
      },
      new Error("boom"),
    );
    expect(() => {
      render.writeTree(planned, dest);
    }).toThrow(/boom/);
    expect(listTree(dest)).toEqual(["a.txt"]);
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("edited by user\n");
  });

  test("preserves a created path replaced by another file", () => {
    const dest = fresh("replaced");
    const original = fs.writeFileSync;
    interceptWrite(
      "c.txt",
      () => {
        unlinkSync(join(dest, "a.txt"));
        original(join(dest, "a.txt"), "replacement\n");
      },
      new Error("boom"),
    );
    expect(() => {
      render.writeTree(planned, dest);
    }).toThrow(/boom/);
    expect(listTree(dest)).toEqual(["a.txt"]);
  });

  test("keeps a directory that gained unrelated content", () => {
    const dest = fresh("nested");
    const nested = [
      { path: "d/e/f.txt", mode: 0o644, content: Buffer.from("f") },
      { path: "g.txt", mode: 0o644, content: Buffer.from("g") },
    ];
    const original = fs.writeFileSync;
    interceptWrite(
      "g.txt",
      () => {
        original(join(dest, "d", "user.txt"), "mine");
      },
      new Error("boom"),
    );
    expect(() => {
      render.writeTree(nested, dest);
    }).toThrow(/boom/);
    expect(listTree(dest)).toEqual(["d/user.txt"]);
  });
});

describe("protocol constants", () => {
  test("exports the supported schema and protocol", () => {
    expect(render.SCHEMA).toBe("nextjs-dev-template/manifest");
    expect(render.PROTOCOL).toBe(1);
  });
});
