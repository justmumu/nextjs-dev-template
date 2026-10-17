import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

// Decisions about template lineage, with Git and the disk answered from memory: what the committed
// state and its baseline must prove before a preview, what a source revision may contain, how
// conflicts are named and what a preview is bound to. Real repositories are in
// tests/integration/template-preview.test.ts.
const require = createRequire(import.meta.url);
const provenance = require("../../scripts/template/provenance.cjs") as typeof import("../../scripts/template/provenance.cjs");
const stateModule = require("../../scripts/template/state.cjs") as typeof import("../../scripts/template/state.cjs");
const update = require("../../scripts/template/pristine.cjs") as typeof import("../../scripts/template/pristine.cjs");
const previewModule = require("../../scripts/template/preview.cjs") as typeof import("../../scripts/template/preview.cjs");

const id = (seed: string) => createHash("sha1").update(seed).digest("hex");
const digest = (seed: string) => createHash("sha256").update(seed).digest("hex");

const answers = { name: "demo-app", description: "", owner: "some-owner", version: "0.0.0" };
const baseline = { commit: id("b0"), tree: id("b0-tree") };
const head = id("head");

function stateText(over: Record<string, unknown> = {}): string {
  const state = stateModule.buildState({ baseline, source: { kind: "local-generator", revision: id("s0") }, answers, renderDigest: digest("render") });
  return stateModule.serializeState({ ...state, ...over });
}

interface World {
  head: string | null;
  shallow: boolean;
  blobs: Record<string, string>;
  commits: string[];
  ancestors: string[];
  trees: Record<string, string>;
}

function world(over: Partial<World> = {}): World {
  return {
    head,
    shallow: false,
    blobs: {
      [`${head}:.template-state.json`]: stateText(),
      [`${baseline.commit}:package.json`]: JSON.stringify({ name: answers.name, version: answers.version, author: answers.owner }),
    },
    commits: [baseline.commit],
    ancestors: [baseline.commit],
    trees: { [baseline.commit]: baseline.tree },
    ...over,
  };
}

function gitOf(w: World) {
  return {
    head: () => w.head,
    isShallow: () => w.shallow,
    blob: (_cwd: string, spec: string) => {
      const found = w.blobs[spec];
      if (found === undefined) throw new Error(`no ${spec}`);
      return Buffer.from(found);
    },
    hasCommit: (_cwd: string, commit: string) => w.commits.includes(commit),
    isAncestor: (_cwd: string, ancestor: string) => w.ancestors.includes(ancestor),
    treeOf: (_cwd: string, commit: string) => w.trees[commit] ?? "",
  };
}

function refusal(action: () => unknown): { code: string; message: string } {
  try {
    action();
  } catch (error) {
    if (error instanceof provenance.Refusal) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

const verify = (over: Partial<World>) => provenance.verifyLineage({ git: gitOf(world(over)), root: "/project" });

describe("the state file", () => {
  test("round-trips, and holds no state about itself", () => {
    const text = stateText();
    expect(stateModule.parseState(text)).toEqual(JSON.parse(text));
    expect(text).not.toContain(stateModule.STATE_FILE);
  });

  test.each([
    ["not JSON", "{"],
    ["not an object", "[]"],
    ["another schema", stateText({ schema: "other" })],
    ["another version", stateText({ stateVersion: 2 })],
    ["an unknown key", stateText({ extra: 1 })],
    ["another manifest protocol", stateText({ manifestProtocol: 2 })],
    ["a baseline that is not an object", stateText({ baseline: 1 })],
    ["a baseline commit that is not a full id", stateText({ baseline: { commit: "abc", tree: baseline.tree } })],
    ["a digest that is not sha-256", stateText({ answersDigest: "abc" })],
    ["a source that is not an object", stateText({ source: 1 })],
    ["an unknown source kind", stateText({ source: { kind: "url" } })],
    ["a source with an extra key", stateText({ source: { kind: "local-generator", revision: id("s"), extra: 1 } })],
  ])("refuses %s", (_name, text) => {
    expect(() => stateModule.parseState(text)).toThrow();
  });

  test("keeps a copied commit as the copy's own, not a template revision", () => {
    const parsed = stateModule.parseState(stateText({ source: { kind: "github-template-copy", copiedCommit: id("o") } }));
    expect(parsed.source).toEqual({ kind: "github-template-copy", copiedCommit: id("o") });
  });

  test("the answers digest depends on every answer", () => {
    const base = stateModule.answersDigest(answers);
    for (const change of [{ name: "other" }, { description: "d" }, { owner: null }, { version: "1.0.0" }]) {
      expect(stateModule.answersDigest({ ...answers, ...change })).not.toBe(base);
    }
  });
});

describe("what HEAD must prove before a preview", () => {
  test("a coherent lineage gives the original answers from the baseline, not from the application", () => {
    const lineage = verify({});
    expect(lineage.answers).toEqual(answers);
    expect(lineage.head).toBe(head);
    expect(lineage.stateDigest).toBe(digest(stateText()));
  });

  test("answers carry the optional description and author the baseline's package.json holds", () => {
    const described = { ...answers, description: "A demo", owner: null };
    const text = stateModule.serializeState(
      stateModule.buildState({ baseline, source: { kind: "local-generator", revision: id("s0") }, answers: described, renderDigest: digest("r") }),
    );
    const lineage = verify({
      blobs: {
        [`${head}:.template-state.json`]: text,
        [`${baseline.commit}:package.json`]: JSON.stringify({ name: "demo-app", version: "0.0.0", description: "A demo" }),
      },
    });
    expect(lineage.answers).toEqual(described);
  });

  test.each<[string, Partial<World>, string]>([
    ["no commit", { head: null }, "no-head"],
    ["a shallow clone", { shallow: true }, "shallow-history"],
    ["no committed state", { blobs: {} }, "not-enrolled"],
    ["a state of another manifest protocol", { blobs: { [`${head}:.template-state.json`]: stateText({ manifestProtocol: 2 }) } }, "engine-upgrade-required"],
    [
      "a state of another manifest schema",
      { blobs: { [`${head}:.template-state.json`]: stateText({ manifestSchema: "other/manifest" }) } },
      "engine-upgrade-required",
    ],
    ["an unreadable state", { blobs: { [`${head}:.template-state.json`]: "{" } }, "invalid-state"],
    ["a baseline commit the repository does not have", { commits: [] }, "baseline-missing"],
    ["a baseline that is not an ancestor of HEAD", { ancestors: [] }, "baseline-unreachable"],
    ["a baseline whose tree is not the recorded one", { trees: { [baseline.commit]: id("other") } }, "baseline-mismatch"],
  ])("refuses %s", (_name, over, code) => {
    expect(refusal(() => verify(over)).code).toBe(code);
  });

  test("refuses a baseline that holds the state file, which must stay outside the pristine tree", () => {
    const base = world();
    const blobs = { ...base.blobs, [`${baseline.commit}:.template-state.json`]: "{}" };
    expect(refusal(() => verify({ blobs })).code).toBe("baseline-mismatch");
  });

  test.each<[string, string | null]>([
    ["a missing package.json", null],
    ["a package.json that is not JSON", "{"],
    ["a package.json that is not an object", "[]"],
    ["a package.json whose name is not valid", JSON.stringify({ name: "Not Valid", version: "0.0.0" })],
    ["answers that are not the recorded ones", JSON.stringify({ name: "demo-app", version: "2.4.1", author: "some-owner" })],
  ])("refuses %s in the baseline", (_name, packageText) => {
    const key = `${baseline.commit}:package.json`;
    const blobs = Object.fromEntries(Object.entries(world().blobs).filter(([name]) => name !== key || packageText !== null));
    if (packageText !== null) blobs[key] = packageText;
    expect(refusal(() => verify({ blobs })).code).toBe("answers-mismatch");
  });
});

describe("refs", () => {
  test.each(["main", "v1.2.3", "refs/heads/release/2", "refs/tags/v1", id("x"), "feature+x@y"])("accepts %s", (ref) => {
    expect(update.validateRef(ref)).toBe(ref);
  });

  test.each(["", "-x", "--upload-pack=x", "a..b", "a//b", "a@{1}", "a/", "x.lock", "a b", "a\nb", 1, null, "x".repeat(201)])("refuses %j", (ref) => {
    expect(refusal(() => update.validateRef(ref)).code).toBe("invalid-ref");
  });
});

describe("the source revision, read as data", () => {
  const sha = id("source");
  const manifest = (over: Record<string, unknown> = {}) => ({
    schema: "nextjs-dev-template/manifest",
    protocol: 1,
    role: "application",
    entries: [{ type: "copy", base: "template", source: "a.txt", destination: "a.txt" }],
    ...over,
  });
  const reader = (blobs: Record<string, string>) => ({ blob: (_cwd: string, spec: string) => Buffer.from(blobs[spec] ?? Buffer.alloc(0)) });
  const manifestAt = (text: string | undefined) =>
    ({
      blob: (_cwd: string, spec: string) => {
        if (text === undefined || spec !== `${sha}:${update.MANIFEST_PATH}`) throw new Error("missing");
        return Buffer.from(text);
      },
    }) as never;

  test("a supported manifest is returned as data", () => {
    expect(update.readSourceManifest({ git: manifestAt(JSON.stringify(manifest())), dir: "/s", sha })).toEqual(manifest());
  });

  test.each([
    ["another protocol", JSON.stringify(manifest({ protocol: 2 }))],
    ["another schema", JSON.stringify(manifest({ schema: "other" }))],
    ["a manifest that is not an object", "[]"],
  ])("%s needs a newer engine and nothing is run", (_name, text) => {
    expect(refusal(() => update.readSourceManifest({ git: manifestAt(text), dir: "/s", sha })).code).toBe("engine-upgrade-required");
  });

  test.each([undefined, "{"])("a manifest that cannot be read is an invalid source (%j)", (text) => {
    expect(refusal(() => update.readSourceManifest({ git: manifestAt(text), dir: "/s", sha })).code).toBe("source-invalid");
  });

  function materialized(listing: string, blobs: Record<string, string>, over: Record<string, unknown> = {}) {
    const written: string[] = [];
    const modes: Record<string, number> = {};
    const disk = {
      mkdirSync: (path: string) => written.push(`mkdir ${path}`),
      writeFileSync: (path: string, content: Buffer, options: { mode: number }) => {
        written.push(`write ${path} ${content.toString()}`);
        modes[path] = options.mode;
      },
      chmodSync: (path: string, mode: number) => {
        modes[path] = mode;
      },
    };
    const git = { ...reader(blobs), out: () => listing } as never;
    const bases = update.materialize({ git, dir: "/s", sha, manifest: manifest(over), into: "/w", disk });
    return { bases, written, modes };
  }

  test("writes exactly the declared files, each in its own base, with the modes Git records", () => {
    const result = materialized("100755 blob aaaa\ttemplate/app/a.txt\0", { [`${sha}:template/app/a.txt`]: "content" });
    expect(result.bases).toEqual({ template: "/w/template", root: "/w/root" });
    expect(result.written).toEqual(["mkdir /w/template", "write /w/template/a.txt content"]);
    expect(result.modes["/w/template/a.txt"]).toBe(0o755);
  });

  test("reads a root-based entry from the source root", () => {
    const entry = { type: "copy", base: "root", source: "scripts/x.cjs", destination: "scripts/x.cjs" };
    const result = materialized("100644 blob bbbb\tscripts/x.cjs\0", { [`${sha}:scripts/x.cjs`]: "x" }, { entries: [entry] });
    expect(result.written[1]).toBe("write /w/root/scripts/x.cjs x");
  });

  test.each([
    ["a symlink", "120000 blob aaaa\ttemplate/app/a.txt\0"],
    ["a submodule", "160000 commit aaaa\ttemplate/app/a.txt\0"],
    ["a file the source does not have", ""],
  ])("refuses %s", (_name, listing) => {
    expect(refusal(() => materialized(listing, {})).code).toBe("source-invalid");
  });

  test("refuses a manifest the engine would not render", () => {
    expect(refusal(() => materialized("", {}, { entries: [{ type: "script" }] })).code).toBe("source-invalid");
  });

  describe("fetching one ref", () => {
    function fetcher(over: { fail?: boolean; sha?: string; date?: string } = {}) {
      const calls: string[] = [];
      const git = {
        init: (dir: string) => calls.push(`init ${dir}`),
        fetchRef: (_dir: string, url: string, ref: string) => {
          calls.push(`fetch ${url} ${ref}`);
          if (over.fail) throw new Error("no such ref");
        },
        out: (_dir: string, args: readonly string[]) => {
          if (args[0] === "rev-parse" && args[2] === "FETCH_HEAD^{commit}") return `${over.sha ?? sha}\n`;
          if (args[0] === "show") return `${over.date ?? "1700000000"}\n`;
          return `${id("tree")}\n`;
        },
      } as never;
      return { git, calls };
    }

    test("resolves the ref to a full commit, its tree and its date", () => {
      const { git, calls } = fetcher();
      expect(update.fetchSource({ git, dir: "/s", url: "file:///up", ref: "main" })).toEqual({ sha, tree: id("tree"), committedAt: 1700000000 });
      expect(calls).toEqual(["init /s", "fetch file:///up main"]);
    });

    test("an unusable ref is refused before anything is fetched", () => {
      const { git, calls } = fetcher();
      expect(refusal(() => update.fetchSource({ git, dir: "/s", url: "file:///up", ref: "--x" })).code).toBe("invalid-ref");
      expect(calls).toEqual([]);
    });

    test.each([
      ["an unreachable ref", { fail: true }, "source-unreachable"],
      ["an answer that is not a commit id", { sha: "main" }, "source-unreachable"],
      ["a commit without a usable date", { date: "soon" }, "source-invalid"],
    ])("%s is refused", (_name, over, code) => {
      expect(refusal(() => update.fetchSource({ git: fetcher(over).git, dir: "/s", url: "file:///up", ref: "main" })).code).toBe(code);
    });
  });
});

describe("naming conflicts from the index", () => {
  const entry = (path: string, stage: string, sha = id(`${path}${stage}`)) => ({ path, stage, sha, mode: "100644" });
  const classify = (entries: ReturnType<typeof entry>[], output = "", binary: string[] = []) =>
    previewModule.classifyConflicts(entries, output, (sha) => binary.includes(sha));

  test("lists only unmerged paths, whatever the files contain", () => {
    expect(classify([entry("merged.txt", "0"), entry("x.txt", "2"), entry("x.txt", "3")]).map((conflict) => conflict.path)).toEqual(["x.txt"]);
  });

  test("without a report, the stages name the kind", () => {
    const kinds = Object.fromEntries(
      classify([
        ...["1", "2", "3"].map((stage) => entry("a-content", stage)),
        ...["2", "3"].map((stage) => entry("b-add", stage)),
        ...["1", "2"].map((stage) => entry("c-theirs-deleted", stage)),
        ...["1", "3"].map((stage) => entry("d-ours-deleted", stage)),
        entry("e-alone", "2"),
        entry("f-odd", "1"),
      ]).map((conflict) => [conflict.path, conflict.kind]),
    );
    expect(kinds).toEqual({
      "a-content": "content",
      "b-add": "add/add",
      "c-theirs-deleted": "modify/delete",
      "d-ours-deleted": "modify/delete",
      "e-alone": "file/directory",
      "f-odd": "unmerged",
    });
  });

  test("Git's report names what the stages cannot: a rename, a directory in the way", () => {
    const output = [
      "CONFLICT (rename/delete): old.txt renamed to moved.txt in theirs, but deleted in HEAD.",
      "CONFLICT (file/directory): directory in the way of fd from HEAD; moving it to fd~HEAD instead.",
      "CONFLICT (content): Merge conflict in same.txt",
    ].join("\n");
    const kinds = Object.fromEntries(
      classify(
        [entry("moved.txt", "1"), entry("moved.txt", "3"), entry("fd~HEAD", "2"), entry("same.txt", "1"), entry("same.txt", "2"), entry("same.txt", "3")],
        output,
      ).map((conflict) => [conflict.path, conflict.kind]),
    );
    expect(kinds).toEqual({ "moved.txt": "rename/delete", "fd~HEAD": "file/directory", "same.txt": "content" });
  });

  test("a path is matched as a whole word, not as part of another", () => {
    const [conflict] = classify(
      [entry("a.txt", "2"), entry("a.txt", "3")],
      "CONFLICT (modify/delete): data.txt deleted in HEAD.\nCONFLICT (add/add): Merge conflict in a.txt",
    );
    expect(conflict?.kind).toBe("add/add");
  });

  test("a content conflict with a binary side is a binary conflict, and each stage is reported", () => {
    const entries = [entry("b.bin", "1"), entry("b.bin", "2"), entry("b.bin", "3")];
    const [conflict] = classify(entries, "CONFLICT (content): Merge conflict in b.bin", [entries[2]?.sha ?? ""]);
    expect(conflict).toEqual({
      path: "b.bin",
      kind: "binary",
      stages: {
        base: { mode: "100644", sha: entries[0]?.sha },
        ours: { mode: "100644", sha: entries[1]?.sha },
        theirs: { mode: "100644", sha: entries[2]?.sha },
      },
    });
  });

  test("a deleted side is null", () => {
    const [conflict] = classify([entry("g.txt", "1"), entry("g.txt", "3")]);
    expect(conflict?.stages.ours).toBeNull();
  });
});

describe("what a preview is bound to", () => {
  const bindings = {
    head,
    stateDigest: digest("state"),
    answersDigest: digest("answers"),
    engineDigest: digest("engine"),
    sourceSha: id("source"),
    manifestSchema: "nextjs-dev-template/manifest",
    manifestProtocol: 1,
  };
  const preview = {
    schema: "nextjs-dev-template/preview",
    previewVersion: 1,
    source: { url: "file:///up", ref: "main", sha: id("source") },
    bindings,
    baseline,
    next: { commit: id("b1"), tree: id("b1-tree"), renderDigest: digest("b1") },
    result: {
      status: "conflicted",
      outputDigest: digest("out"),
      changes: [{ status: "M", path: "a.txt" }],
      conflicts: [{ path: "a.txt", kind: "content", stages: { base: { mode: "100644", sha: id("1") }, ours: null, theirs: { mode: "100644", sha: id("3") } } }],
    },
  };
  const text = (over: Record<string, unknown> = {}) => JSON.stringify({ ...preview, ...over });
  const current = {
    head,
    stateDigest: bindings.stateDigest,
    answersDigest: bindings.answersDigest,
    engineDigest: bindings.engineDigest,
    sourceSha: bindings.sourceSha,
  };

  test("a written preview reads back as it was", () => {
    expect(previewModule.parsePreview(text())).toEqual(preview);
  });

  test.each([
    ["not JSON", "{"],
    ["another schema", text({ schema: "x" })],
    ["another version", text({ previewVersion: 2 })],
    ["an unknown key", text({ extra: 1 })],
    ["a source that is not an object", text({ source: 1 })],
    ["a ref that is an option", text({ source: { ...preview.source, ref: "--x" } })],
    ["a digest that is not sha-256", text({ bindings: { ...bindings, engineDigest: "abc" } })],
    ["a status that does not exist", text({ result: { ...preview.result, status: "applied" } })],
    ["result lists that are not lists", text({ result: { ...preview.result, changes: 1 } })],
    ["a conflict kind with unusual characters", text({ result: { ...preview.result, conflicts: [{ ...preview.result.conflicts[0], kind: "X;" }] } })],
  ])("refuses %s", (_name, content) => {
    expect(() => previewModule.parsePreview(content)).toThrow();
  });

  test("a preview of another manifest protocol needs a newer engine", () => {
    const content = text({ bindings: { ...bindings, manifestProtocol: 2 } });
    expect(refusal(() => previewModule.parsePreview(content)).code).toBe("engine-upgrade-required");
  });

  test("nothing changed: nothing is stale", () => {
    expect(previewModule.staleReasons(previewModule.parsePreview(text()), current)).toEqual([]);
  });

  test.each([
    ["head", id("moved"), "HEAD moved"],
    ["stateDigest", digest("other"), "the committed template state changed"],
    ["answersDigest", digest("other"), "the answers changed"],
    ["engineDigest", digest("other"), "the installed engine changed"],
    ["sourceSha", id("moved"), "the source ref points to another commit"],
  ])("a changed %s makes it stale", (key, value, reason) => {
    expect(previewModule.staleReasons(previewModule.parsePreview(text()), { ...current, [key]: value })).toEqual([reason]);
  });
});

describe("the preview command, before anything is fetched", () => {
  function host(w: World) {
    const scratch: string[] = [];
    return {
      scratch,
      host: {
        git: { ...gitOf(w), inventory: () => [] } as never,
        fs: {} as never,
        scratch: (prefix: string) => {
          scratch.push(prefix);
          return "/scratch";
        },
        remove: () => undefined,
      },
    };
  }
  const run = async (args: string[], w: World) => {
    const out: string[] = [];
    const used = host(w);
    const status = await previewModule.templatePreview(args, {
      root: "/project",
      io: { stdout: (text) => out.push(text), stderr: (text) => out.push(text) },
      host: used.host,
    });
    return { status, text: out.join(""), scratch: used.scratch };
  };

  test("a project that cannot prove its lineage is refused with the reason, and no scratch space is made", async () => {
    const result = await run(["--ref=main"], world({ shallow: true }));
    expect(result.status).toBe(1);
    expect(result.text).toMatch(/shallow/);
    expect(result.scratch).toEqual([]);
  });

  test("a ref that is not a plain ref is refused", async () => {
    const result = await run(["--ref=a..b"], world());
    expect(result.status).toBe(1);
    expect(result.text).toMatch(/not a usable ref/);
  });

  test("the ref is required, and no other flag exists (the source is not chosen per run)", async () => {
    await expect(run([], world())).rejects.toThrow(/--ref is required/);
    await expect(run(["--ref=main", "--url=file:///x"], world())).rejects.toThrow(/unknown flag: --url/);
  });
});

describe("where the preview is kept", () => {
  test("inside the Git directory, written whole to a temporary name and then put in place", () => {
    const operations: string[] = [];
    const host = {
      git: { out: () => "/project/.git\n" } as never,
      fs: {
        mkdirSync: (path: string) => operations.push(`mkdir ${path}`),
        writeFileSync: (path: string, text: string, options: { mode: number }) =>
          operations.push(`write ${path.replace(/\.\d+\.tmp$/, ".<pid>.tmp")} ${String(options.mode)} ${String(text.endsWith("\n"))}`),
        renameSync: (from: string, to: string) => operations.push(`rename ${from.replace(/\.\d+\.tmp$/, ".<pid>.tmp")} ${to}`),
      } as never,
      scratch: () => "/scratch",
      remove: () => undefined,
    };
    const path = previewModule.writePreview({ host, root: "/project", preview: { schema: "x" } as never });
    expect(path).toBe("/project/.git/template-update/preview.json");
    expect(operations).toEqual([
      "mkdir /project/.git/template-update",
      "write /project/.git/template-update/preview.json.<pid>.tmp 384 true",
      "rename /project/.git/template-update/preview.json.<pid>.tmp /project/.git/template-update/preview.json",
    ]);
  });
});

describe("the state an update commits", () => {
  const next = { commit: id("b1"), tree: id("b1-tree"), renderDigest: digest("render 1") };
  const upstream = { url: "https://github.com/justmumu/nextjs-dev-template.git", sha: id("upstream") };
  const copied = stateModule.buildState({ baseline, source: { kind: "github-template-copy", copiedCommit: id("o") }, answers, renderDigest: digest("render") });

  test("moves the baseline and names the chosen revision, and keeps the enrollment, the answers and the kind of source", () => {
    for (const first of [stateModule.parseState(stateText()), copied]) {
      const moved = stateModule.advanceState(first, { next, upstream });
      expect(moved.baseline).toEqual({ commit: next.commit, tree: next.tree });
      expect(moved.renderDigest).toBe(next.renderDigest);
      expect(moved.upstream).toEqual(upstream);
      expect(moved.source).toEqual(first.source);
      expect(moved.answersDigest).toBe(first.answersDigest);
      expect(stateModule.parseState(stateModule.serializeState(moved))).toEqual(moved);
    }
    expect(stateModule.advanceState(copied, { next, upstream }).source).toEqual({ kind: "github-template-copy", copiedCommit: id("o") });
  });

  test("a second update replaces the upstream, never the enrollment", () => {
    const once = stateModule.advanceState(copied, { next, upstream });
    const twice = stateModule.advanceState(once, { next: { ...next, commit: id("b2") }, upstream: { ...upstream, sha: id("upstream 2") } });
    expect(twice.upstream?.sha).toBe(id("upstream 2"));
    expect(twice.source).toEqual(copied.source);
  });

  test("an enrollment state has no upstream and is still read, written and refused exactly as before", () => {
    const enrolled = stateModule.parseState(stateText());
    expect(enrolled).not.toHaveProperty("upstream");
    expect(stateText()).not.toContain("upstream");
  });

  test.each([
    ["a string", "upstream"],
    ["an unknown key", { url: "https://example.com/x.git", sha: id("u"), extra: 1 }],
    ["a short revision", { url: "https://example.com/x.git", sha: "abc" }],
    ["a url with whitespace", { url: "not a url", sha: id("u") }],
    ["a missing revision", { url: "https://example.com/x.git" }],
  ])("refuses an upstream that is %s", (_label, upstreamValue) => {
    expect(() => stateModule.parseState(stateText({ upstream: upstreamValue }))).toThrow();
  });
});
