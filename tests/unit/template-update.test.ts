import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

// The entry of the update commands, judged without a repository: how it reads its arguments, what it
// reports as a refusal rather than a crash, and what its loader will and will not load.
const require = createRequire(import.meta.url);
const update = require("../../scripts/template/update.cjs") as typeof import("../../scripts/template/update.cjs");
const repository = join(import.meta.dirname, "../../scripts");

describe("canonical", () => {
  test("gives equal text for equal data whatever the key order, and different text for different data", () => {
    expect(update.canonical({ b: [1, { d: null, c: "x" }], a: true })).toBe(update.canonical({ a: true, b: [1, { c: "x", d: null }] }));
    expect(update.canonical({ a: 1 })).not.toBe(update.canonical({ a: 2 }));
    expect(update.canonical([1, 2])).not.toBe(update.canonical([2, 1]));
    expect(update.canonical("a")).toBe('"a"');
  });
});

describe("main", () => {
  test.each([[[]], [["restore"]], [["inspect", "extra"]], [["--help"]]])("%j is a usage error, and nothing is loaded", (argv) => {
    const sink = capture();
    const status = update.main(argv, {
      io: sink.io,
      load: () => {
        throw new Error("loaded");
      },
    });
    expect(status).toBe(2);
    expect(sink.err()).toMatch(/usage: node scripts\/template\/update\.cjs inspect\|abort\|resume/);
  });

  test("a refusal is a message and a status of 1; anything else is a crash", () => {
    const sink = capture();
    const refusing = {
      inspect: () => {
        throw Object.assign(new Error("the update cannot go on"), { name: "JournalError" });
      },
    };
    const load = (relative: string): unknown => {
      if (relative === "template/recovery.cjs") return refusing;
      return { createGit: () => ({ out: () => "/project/.git\n" }) };
    };
    expect(update.main(["inspect"], { io: sink.io, load, scripts: "/project/scripts" })).toBe(1);
    expect(sink.err()).toBe("the update cannot go on\n");

    const crashing = {
      abort: () => {
        throw new TypeError("bug");
      },
    };
    const crash = (relative: string): unknown => (relative === "template/recovery.cjs" ? crashing : { createGit: () => ({ out: () => "/project/.git\n" }) });
    expect(() => update.main(["abort"], { io: sink.io, scripts: "/project/scripts", load: crash })).toThrow(/bug/);
  });

  test("runs the command it names against the installed modules with the project's Git directory", () => {
    const seen: unknown[] = [];
    const sink = capture();
    const load = (relative: string): unknown =>
      relative === "template/recovery.cjs"
        ? { resume: (host: { root: string; gitDir: string }) => (seen.push([host.root, host.gitDir]), 0) }
        : { createGit: () => ({ out: () => "/project/.git\n" }) };
    expect(update.main(["resume"], { io: sink.io, load, scripts: "/project/scripts" })).toBe(0);
    expect(seen).toEqual([["/project", "/project/.git"]]);
  });
});

describe("installedLoader", () => {
  test("loads installed .cjs files below scripts without the resolver, and nothing else", () => {
    const load = update.installedLoader(repository);
    const journal = load(join(repository, "template/journal.cjs")) as typeof import("../../scripts/template/journal.cjs");
    expect(journal.PENDING_REF).toBe("refs/template-update/pending");
    // A module of the project's dependencies, a file outside scripts and a non-.cjs file are not the loader's to read.
    expect(() => load(join(repository, "../package.json"))).toThrow();
  });

  test("refuses an installation that has no loader", () => {
    expect(() => update.installedLoader("/nonexistent/scripts")).toThrow();
  });
});
