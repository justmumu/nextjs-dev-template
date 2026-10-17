import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

// The release decisions, judged without a repository or a disk: which versions and tags are valid,
// what a changelog section is, which commits the changelog keeps, what a reviewed release looks like,
// and the order in which the bump and the tag commands check, write and refuse.
const require = createRequire(import.meta.url);
const metadata = require("../../scripts/release/metadata.cjs") as typeof import("../../scripts/release/metadata.cjs");
const changelog = require("../../scripts/release/changelog.cjs") as typeof import("../../scripts/release/changelog.cjs");
const validate = require("../../scripts/release/validate.cjs") as typeof import("../../scripts/release/validate.cjs");
const release = require("../../scripts/release.cjs") as typeof import("../../scripts/release.cjs");
const state = require("../../scripts/template/state.cjs") as typeof import("../../scripts/template/state.cjs");

const MANIFEST = `{\n  "name": "app",\n  "version": "0.0.0",\n  "private": true,\n  "dependencies": { "version": "1.0.0" }\n}\n`;
const at = (local: string, domain: string) => `${local}@${domain}`;
const PATTERN = "^([0-9]+\\+)?[A-Za-z0-9-]+@users\\.noreply\\.github\\.com$";

describe("versions and tags", () => {
  test.each([
    ["0.0.0", "patch", "0.0.1"],
    ["0.0.9", "minor", "0.1.0"],
    ["1.4.2", "major", "2.0.0"],
  ])("%s %s is %s", (current, segment, next) => {
    expect(metadata.nextVersion(current, segment)).toBe(next);
  });

  test.each([["1.0.0-rc.1"], ["1.0"], ["01.0.0"], ["1.0.0+build"], [""]])("a current version of %j is refused", (current) => {
    expect(() => metadata.nextVersion(current, "patch")).toThrow(/plain MAJOR\.MINOR\.PATCH/);
  });

  test("only the three segments are bumps", () => {
    expect(() => metadata.nextVersion("1.0.0", "premajor")).toThrow(/patch, minor or major/);
    expect(() => metadata.nextVersion("1.0.0", "__proto__")).toThrow(/patch, minor or major/);
  });

  test("a tag is v and a plain version, and nothing else", () => {
    expect(metadata.tagOf("1.2.3")).toBe("v1.2.3");
    expect(metadata.versionOfTag("v10.20.30")).toBe("10.20.30");
    for (const tag of ["1.2.3", "v1.2", "v01.2.3", "v1.2.3-rc.1", "v1.2.3 ", "refs/tags/v1.2.3", "v1.2.3\n"]) {
      expect(() => metadata.versionOfTag(tag), tag).toThrow(/vMAJOR\.MINOR\.PATCH/);
    }
  });

  test("the version line is the only change to a manifest, and the version is read from the manifest", () => {
    expect(metadata.readVersion(MANIFEST)).toBe("0.0.0");
    const next = metadata.withVersion(MANIFEST, "0.0.1");
    expect(next).toBe(MANIFEST.replace('"version": "0.0.0"', '"version": "0.0.1"'));
    expect(metadata.readVersion(next)).toBe("0.0.1");
  });

  test("a manifest with no version line, two, or invalid JSON is refused", () => {
    expect(() => metadata.withVersion('{\n  "name": "app"\n}\n', "0.0.1")).toThrow(/exactly one/);
    expect(() => metadata.withVersion('{\n  "version": "0.0.0",\n  "version": "0.0.0"\n}\n', "0.0.1")).toThrow(/exactly one|duplicate/);
    expect(() => metadata.readVersion("{")).toThrow(/not valid JSON/);
    expect(() => metadata.readVersion("[]")).toThrow(/object/);
    expect(() => metadata.readVersion('{"name":"x"}')).toThrow(/no version/);
  });

  test("each role names the manifest it releases", () => {
    expect(metadata.adapterFor("generator")).toEqual({ role: "generator", file: "package.json" });
    expect(metadata.adapterFor("application")).toEqual({ role: "application", file: "package.json" });
    expect(() => metadata.adapterFor("library")).toThrow(/unknown role/);
  });

  test("the latest tag is the highest version, not the newest name", () => {
    expect(metadata.latestTag(["v0.0.9", "v0.0.10", "v0.1.0", "v0.0.2"])).toBe("v0.1.0");
    expect(metadata.latestTag(["v1.9.0", "v1.10.0"])).toBe("v1.10.0");
    expect(metadata.latestTag([])).toBeNull();
  });
});

describe("changelog sections", () => {
  const text = "# Changelog\n\n## v0.0.10 (2026-01-02)\n\n- ten\n\n## v0.0.1 (2026-01-01)\n\n### Features\n\n- one\n\n## v0.0.0\n\n- zero\n";

  test("a section is found by its exact heading: v0.0.1 is not v0.0.10", () => {
    expect(changelog.extractSection(text, "v0.0.1")).toBe("## v0.0.1 (2026-01-01)\n\n### Features\n\n- one\n");
    expect(changelog.extractSection(text, "v0.0.10")).toBe("## v0.0.10 (2026-01-02)\n\n- ten\n");
    expect(changelog.extractSection(text, "v0.0.0")).toBe("## v0.0.0\n\n- zero\n");
    expect(() => changelog.extractSection(text, "v0.0.2")).toThrow(/exactly one section for v0\.0\.2/);
  });

  test("a heading that only starts like the tag, or appears twice, is not a section", () => {
    expect(() => changelog.extractSection("## v0.0.10\n\nWrong version.\n", "v0.0.1")).toThrow(/exactly one section/);
    expect(() => changelog.extractSection("## v0.0.1\n\na\n\n## v0.0.1 (2026-01-01)\n\nb\n", "v0.0.1")).toThrow(/exactly one section/);
    expect(changelog.hasSection(text, "v0.0.1")).toBe(true);
    expect(changelog.hasSection(text, "v0.0.3")).toBe(false);
  });

  test("a new section goes above the earlier ones and below the title, and the earlier ones stay as they were", () => {
    const section = "## v0.0.11 (2026-02-01)\n\n- eleven\n";
    const composed = changelog.compose(text, section);
    expect(composed).toBe(`# Changelog\n\n${section}\n${text.slice(text.indexOf("## v0.0.10"))}`);
    expect(changelog.extractSection(composed, "v0.0.10")).toBe(changelog.extractSection(text, "v0.0.10"));
  });

  test("the first section creates the file with its title", () => {
    expect(changelog.compose(null, "## v0.0.1 (2026-01-01)\n\n- one\n")).toBe("# Changelog\n\n## v0.0.1 (2026-01-01)\n\n- one\n");
    expect(changelog.compose("# Changelog\n", "## v0.0.1 (2026-01-01)\n\n- one\n")).toBe("# Changelog\n\n## v0.0.1 (2026-01-01)\n\n- one\n");
  });

  test("a section that exists is never written twice", () => {
    expect(() => changelog.compose(text, "## v0.0.1 (2026-03-01)\n\n- again\n")).toThrow(/already has a section for v0\.0\.1/);
  });

  test("the heading is the tag and the date", () => {
    expect(changelog.heading("0.1.0", "2026-10-17")).toBe("## v0.1.0 (2026-10-17)");
  });
});

describe("commits the changelog keeps", () => {
  const params = { options: { formatDate: (date: string | Date) => `date:${String(date)}` }, commits: {} };
  const transform = changelog.keepCommit(new Set(["snapshot-1", "snapshot-2"]));

  test("a snapshot commit of the lineage is dropped by its id, whatever its message says", async () => {
    expect(await transform({ hash: "snapshot-1", header: "feat: looks like a feature" } as never, params as never)).toBeNull();
  });

  test("any other commit keeps the default treatment of its date", async () => {
    const kept = await transform({ hash: "feature-1", committerDate: "2026-01-01", gitTags: "" } as never, params);
    expect(kept).toEqual({ committerDate: "date:2026-01-01" });
  });
});

/** A repository that answers the Git questions of the release commands from a description. */
function repository(over: Partial<Facts> = {}) {
  const facts: Facts = {
    top: "/project",
    shallow: false,
    hidden: [],
    changes: [],
    branch: "release/first",
    tags: [],
    head: "h".repeat(40),
    main: "h".repeat(40),
    parents: ["a".repeat(40), "b".repeat(40)],
    firstParent: [],
    ancestors: [],
    tagType: "tag",
    trees: {},
    blobs: {},
    log: "",
    stateLog: "",
    tagCommit: "c".repeat(40),
    ...over,
  };
  const calls: string[][] = [];
  const git = {
    head: () => facts.head,
    hasCommit: (_cwd: string, commit: string) => Object.hasOwn(facts.trees, commit),
    treeOf: (_cwd: string, commit: string) => facts.trees[commit] ?? "",
    toplevel: () => facts.top,
    isShallow: () => facts.shallow,
    hiddenFlags: () => facts.hidden,
    changes: () => facts.changes,
    isAncestor: (_cwd: string, ancestor: string) => facts.ancestors.includes(ancestor),
    blob: (_cwd: string, spec: string) => {
      const blob = facts.blobs[spec];
      if (blob === undefined) throw new Error(`no blob ${spec}`);
      return Buffer.from(blob);
    },
    out: (_cwd: string, args: readonly string[]) => {
      calls.push([...args]);
      const line = args.join(" ");
      if (line === "branch --show-current") return `${facts.branch}\n`;
      if (line === "tag --list") return facts.tags.join("\n");
      if (line === "rev-parse --verify HEAD") return `${facts.head}\n`;
      if (line === "rev-parse --verify --quiet refs/remotes/origin/main^{commit}") {
        if (facts.main === null) throw new Error("no main");
        return `${facts.main}\n`;
      }
      if (args.slice(0, 4).join(" ") === "rev-list --parents -n 1") return `${[facts.head, ...facts.parents].join(" ")}\n`;
      if (line === "rev-list --first-parent refs/remotes/origin/main") return facts.firstParent.join("\n");
      if (args[0] === "cat-file" && args[1] === "-t") return `${facts.tagType}\n`;
      if (args[0] === "rev-parse" && args[1] === "--verify" && typeof args[2] === "string") {
        const revision = args[2];
        const tree = facts.trees[revision];
        if (tree !== undefined) return `${tree}\n`;
        if (revision.endsWith("^{commit}")) return `${facts.tagCommit}\n`;
      }
      if (args[0] === "rev-list" && args.includes("--ancestry-path")) return facts.ancestors.join("\n");
      if (args[0] === "log") return args.includes("-m") ? facts.stateLog : facts.log;
      if (args[0] === "tag" && args[1] === "-a") {
        facts.tags.push(String(args[2]));
        return "";
      }
      return "";
    },
  };
  return { facts, git, calls };
}

interface Facts {
  top: string;
  shallow: boolean;
  hidden: string[];
  changes: string[];
  branch: string;
  tags: string[];
  head: string;
  main: string | null;
  parents: string[];
  firstParent: string[];
  ancestors: string[];
  tagType: string;
  trees: Record<string, string>;
  blobs: Record<string, string>;
  log: string;
  stateLog: string;
  tagCommit: string;
}

describe("who may release", () => {
  const root = "/project";

  test("the command runs from the repository root and refuses a shallow history", () => {
    expect(() => {
      validate.requireRepository(repository({ top: "/elsewhere" }).git, root);
    }).toThrow(/repository root/);
    expect(() => {
      validate.requireRepository(repository({ shallow: true }).git, root);
    }).toThrow(/full Git history/);
    expect(() => {
      validate.requireRepository(repository().git, root);
    }).not.toThrow();
  });

  test.each([["main"], ["master"], [""]])("branch %j is not a feature branch", (branch) => {
    expect(() => {
      validate.requireFeatureBranch(repository({ branch }).git, root);
    }).toThrow(/feature branch/);
  });

  test("a clean tree has no change and no index flag that hides one", () => {
    expect(() => {
      validate.requireCleanTree(repository({ changes: ["?? new.txt"] }).git, root);
    }).toThrow(/clean working tree/);
    expect(() => {
      validate.requireCleanTree(repository({ hidden: ["app.js"] }).git, root);
    }).toThrow(/index flags/);
    expect(() => {
      validate.requireCleanTree(repository().git, root);
    }).not.toThrow();
  });
});

describe("a reviewed release", () => {
  const root = "/project";
  const commit = "c".repeat(40);
  const merge = "d".repeat(40);

  test("a regular merge on the first-parent line of main is reviewed; an ordinary commit is not", () => {
    expect(validate.reviewedTreeProblem(repository({ firstParent: [commit] }).git as never, root, commit)).toBeNull();
    expect(validate.reviewedTreeProblem(repository({ firstParent: [commit], parents: [merge] }).git as never, root, commit)).toMatch(/reviewed.*merge/);
  });

  test("a feature commit is not the reviewed merge even when their trees match", () => {
    const same = repository({ firstParent: [merge], ancestors: [commit, merge], trees: { [`${commit}^{tree}`]: "t1", [`${merge}^{tree}`]: "t1" } });
    expect(validate.reviewedTreeProblem(same.git as never, root, commit)).toMatch(/reviewed.*merge/);
    const changed = repository({ firstParent: [merge], ancestors: [commit, merge], trees: { [`${commit}^{tree}`]: "t1", [`${merge}^{tree}`]: "t2" } });
    expect(validate.reviewedTreeProblem(changed.git as never, root, commit)).toMatch(/reviewed.*merge/);
    expect(validate.reviewedTreeProblem(repository({ firstParent: [], ancestors: [commit] }).git as never, root, commit)).toMatch(/reviewed.*merge/);
  });

  const valid = (over: Partial<Facts> = {}) =>
    repository({
      firstParent: [commit],
      ancestors: [commit],
      blobs: {
        "refs/tags/v0.0.1:package.json": MANIFEST.replace("0.0.0", "0.0.1"),
        "refs/tags/v0.0.1:CHANGELOG.md": "# Changelog\n\n## v0.0.1 (2026-01-01)\n\n- one\n",
      },
      ...over,
    });

  test("an annotated tag on main, with its version and its section, gives its notes", () => {
    expect(validate.validateTag(valid().git as never, root, "generator", "v0.0.1")).toEqual({
      commit,
      version: "0.0.1",
      notes: "## v0.0.1 (2026-01-01)\n\n- one\n",
    });
  });

  test.each([
    ["a malformed tag", "v1", {}, /vMAJOR\.MINOR\.PATCH/],
    ["a lightweight tag", "v0.0.1", { tagType: "commit" }, /annotated tag/],
    ["a tag that is not on main", "v0.0.1", { ancestors: [] }, /not reachable from main|origin\/main/],
    [
      "a tag whose version differs",
      "v0.0.2",
      { blobs: { "refs/tags/v0.0.2:package.json": MANIFEST.replace("0.0.0", "0.0.1"), "refs/tags/v0.0.2:CHANGELOG.md": "## v0.0.2\n" } },
      /version must match/,
    ],
    [
      "a tag with no section",
      "v0.0.1",
      { blobs: { "refs/tags/v0.0.1:package.json": MANIFEST.replace("0.0.0", "0.0.1"), "refs/tags/v0.0.1:CHANGELOG.md": "## v0.0.10\n" } },
      /exactly one section/,
    ],
    ["a tag with no changelog", "v0.0.1", { blobs: { "refs/tags/v0.0.1:package.json": MANIFEST.replace("0.0.0", "0.0.1") } }, /CHANGELOG\.md/],
    ["a tag with no manifest", "v0.0.1", { blobs: {} }, /package\.json/],
  ] as const)("%s is refused", (_name, tag, over, message) => {
    expect(() => validate.validateTag(valid(over as Partial<Facts>).git as never, root, "generator", tag)).toThrow(message);
  });

  test("an old release stays valid after main moves on, because only its own reachability is judged", () => {
    const later = valid({ main: "9".repeat(40), firstParent: ["9".repeat(40), commit] });
    expect(validate.validateTag(later.git as never, root, "generator", "v0.0.1").version).toBe("0.0.1");
  });
});

describe("commit identities", () => {
  const entry = (hash: string, author: string, committer: string) => `${hash}\u001f${author}\u001f${committer}`;

  test("user and bot noreply identities pass; any other address is reported by commit and role, never by value", () => {
    const log = [
      entry("a1", at("7+someone", "users.noreply.github.com"), at("someone", "users.noreply.github.com")),
      entry("b2", at("nextjs-dev-template", "users.noreply.github.com"), at("nextjs-dev-template", "users.noreply.github.com")),
      entry("c3", at("secret.person", "example.com"), at("someone", "users.noreply.github.com")),
      entry("d4", at("someone", "users.noreply.github.com"), at("other.secret", "example.org")),
    ].join("\u0000");
    const errors = validate.identityErrors(repository({ log }).git, "/project", PATTERN, ["HEAD"]);
    expect(errors).toEqual(["c3: author e-mail is not a GitHub noreply address", "d4: committer e-mail is not a GitHub noreply address"]);
    expect(errors.join("\n")).not.toMatch(/secret|example/);
  });

  test("a history with no commit has nothing to report", () => {
    expect(validate.identityErrors(repository({ log: "" }).git as never, "/project", PATTERN, ["HEAD"])).toEqual([]);
  });
});

describe("the template lineage", () => {
  const baseline = "b".repeat(40);
  const stateText = (upstream: boolean) =>
    state.serializeState({
      ...state.buildState({
        baseline: { commit: baseline, tree: "e".repeat(40) },
        source: { kind: "local-generator", revision: "f".repeat(40) },
        answers: { name: "a", description: "", owner: null, version: "0.0.0" },
        renderDigest: "0".repeat(64),
      }),
      ...(upstream ? { upstream: { url: "file:///source", sha: "1".repeat(40) } } : {}),
    });

  test("a project that was never enrolled has no lineage to leave out", () => {
    const none = repository({ stateLog: "" });
    expect(changelog.snapshotLineage(none.git as never, "/project")).toEqual({ excluded: new Set(), baselines: [], enrollments: [] });
  });

  test("the baselines of every state and the enrollment itself are outside the application's history", () => {
    const enrol = "1".repeat(40);
    const merge = "2".repeat(40);
    const source = repository({
      stateLog: `${enrol}\u0000${merge}\u0000${enrol}`,
      parents: [baseline],
      ancestors: [baseline],
      trees: { [baseline]: "e".repeat(40) },
      blobs: {
        [`${enrol}:.template-state.json`]: stateText(false),
        [`${merge}:.template-state.json`]: stateText(true),
        [`${baseline}:package.json`]: '{"name":"a","version":"0.0.0"}',
      },
    });
    const out = source.git.out;
    source.git.out = (cwd, args) => (args[0] === "diff-tree" ? ".template-state.json\0" : out(cwd, args));
    const lineage = changelog.snapshotLineage(source.git, "/project");
    expect(lineage.baselines).toEqual([baseline]);
    expect(lineage.enrollments).toEqual([enrol]);
    expect(lineage.excluded.has(enrol)).toBe(true);
    expect(lineage.excluded.has(merge)).toBe(false);
  });

  test("a state that was removed from a commit is skipped, and one that cannot be read stops the release", () => {
    const gone = "3".repeat(40);
    const absent = repository({ stateLog: gone, blobs: {} });
    expect(changelog.snapshotLineage(absent.git as never, "/project").baselines).toEqual([]);
    const broken = repository({ stateLog: gone, blobs: { [`${gone}:.template-state.json`]: "{" } });
    expect(() => changelog.snapshotLineage(broken.git as never, "/project")).toThrow(/state/);
  });
});

/** The disk of the release commands: a map from a project path to its text. */
function disk(files: Record<string, string>) {
  return {
    files,
    read: (path: string): string | null => files[path] ?? null,
    write: (path: string, text: string) => {
      files[path] = text;
    },
    remove: (path: string) => {
      Reflect.deleteProperty(files, path);
    },
  };
}

function hostOf(over: { git?: ReturnType<typeof repository>; files?: Record<string, string>; lock?: boolean; formatFails?: boolean; generate?: string } = {}) {
  const git = over.git ?? repository();
  const files = disk(over.files ?? { "package.json": MANIFEST });
  const sink = capture();
  const events: string[] = [];
  const host = {
    root: "/project",
    role: "generator" as const,
    git: {
      ...git.git,
      out: (cwd: string, args: readonly string[]) => {
        if (args[0] === "add" || args[0] === "commit" || args[0] === "reset") events.push(args.join(" "));
        if (args[0] === "commit" && over.formatFails === undefined && files.read("package.json")?.includes("fail-hook")) throw new Error("hook failed");
        return git.git.out(cwd, args);
      },
    },
    disk: files,
    io: sink.io,
    now: () => new Date("2026-10-17T12:00:00Z"),
    emailPattern: PATTERN,
    generate: (input: { version: string; date: string }) => {
      events.push(`generate ${input.version} ${input.date}`);
      return Promise.resolve(over.generate ?? `## v${input.version} (${input.date})\n\n### Features\n\n- feature\n`);
    },
    format: () => {
      events.push("format");
      if (over.formatFails) throw new Error("prettier failed");
    },
    checkLock: () => {
      events.push("lock");
      return { ok: over.lock !== false, output: "lock output" };
    },
  };
  return { host, events, files, sink, git };
}

describe("release:bump", () => {
  test("a bump writes the version and the changelog and commits them, and never tags", async () => {
    const { host, events, files, git } = hostOf();
    await release.bump(host, "patch");
    expect(files.files["package.json"]).toBe(MANIFEST.replace('"version": "0.0.0"', '"version": "0.0.1"'));
    expect(files.files["CHANGELOG.md"]).toBe("# Changelog\n\n## v0.0.1 (2026-10-17)\n\n### Features\n\n- feature\n");
    expect(events).toEqual([
      "generate 0.0.1 2026-10-17",
      "format",
      "lock",
      "add -- package.json CHANGELOG.md",
      "commit --quiet --only -m chore: bump version to v0.0.1 -- package.json CHANGELOG.md",
    ]);
    expect(git.calls.some((args) => args[0] === "tag" && args[1] === "-a")).toBe(false);
  });

  test("an earlier section survives the next bump", async () => {
    const earlier = "# Changelog\n\n## v0.0.1 (2026-10-01)\n\n- first\n";
    const { host, files } = hostOf({ files: { "package.json": MANIFEST.replace("0.0.0", "0.0.1"), "CHANGELOG.md": earlier } });
    await release.bump(host, "minor");
    expect(files.files["CHANGELOG.md"]).toBe(
      `# Changelog\n\n## v0.1.0 (2026-10-17)\n\n### Features\n\n- feature\n\n${earlier.slice(earlier.indexOf("## v0.0.1"))}`,
    );
  });

  test.each([
    ["a main branch", { branch: "main" }, /feature branch/],
    ["a detached head", { branch: "" }, /feature branch/],
    ["a shallow history", { shallow: true }, /full Git history/],
    ["a dirty tree", { changes: ["?? scratch"] }, /clean working tree/],
    ["a hidden index flag", { hidden: ["a.js"] }, /index flags/],
    ["an existing tag", { tags: ["v0.0.1"] }, /Tag v0\.0\.1 already exists; no files changed/],
  ] as const)("%s refuses before anything is written", async (_name, over, message) => {
    const { host, events, files } = hostOf({ git: repository(over as Partial<Facts>) });
    await expect(release.bump(host as never, "patch")).rejects.toThrow(message);
    expect(events).toEqual([]);
    expect(files.files).toEqual({ "package.json": MANIFEST });
  });

  test("a segment other than patch, minor or major is a usage error before the repository is read", async () => {
    const { host, git } = hostOf();
    await expect(release.bump(host as never, "prerelease")).rejects.toThrow(/patch, minor or major/);
    expect(git.calls).toEqual([]);
  });

  test("a changelog that already has the section stops the bump before it writes", async () => {
    const { host, events } = hostOf({ files: { "package.json": MANIFEST, "CHANGELOG.md": "# Changelog\n\n## v0.0.1 (2026-01-01)\n\n- stale\n" } });
    await expect(release.bump(host as never, "patch")).rejects.toThrow(/already has a section for v0\.0\.1/);
    expect(events).toEqual(["generate 0.0.1 2026-10-17"]);
  });

  test.each([
    ["the formatter", { formatFails: true }, /prettier failed/],
    ["the lock check", { lock: false }, /pnpm-lock\.yaml/],
    ["the commit hook", { files: { "package.json": MANIFEST.replace('"private": true', '"private": true, "x": "fail-hook"') } }, /hook failed/],
  ] as const)("a failing %s leaves prepared files visible and creates no tag", async (_name, over, message) => {
    const original = (over as { files?: Record<string, string> }).files?.["package.json"] ?? MANIFEST;
    const { host, events, files, git } = hostOf(over);
    await expect(release.bump(host as never, "patch")).rejects.toThrow(message);
    expect(files.files["package.json"]).toBe(original.replace('"version": "0.0.0"', '"version": "0.0.1"'));
    expect(files.files["CHANGELOG.md"]).toContain("## v0.0.1");
    expect(events.some((event) => event.startsWith("reset "))).toBe(false);
    expect(git.calls.some((args) => args[0] === "tag" && args[1] === "-a")).toBe(false);
  });

  test("a post-commit hook that dirties the tree is reported, and the commit stays", async () => {
    const dirty = repository();
    const { host, sink, events } = hostOf({ git: dirty });
    const commit = host.git.out;
    host.git.out = (cwd, args) => {
      const result = commit(cwd, args);
      if (args[0] === "commit") dirty.facts.changes = [" M app.js"];
      return result;
    };
    await expect(release.bump(host as never, "patch")).rejects.toThrow(/clean working tree/);
    expect(events.at(-1)).toBe("commit --quiet --only -m chore: bump version to v0.0.1 -- package.json CHANGELOG.md");
    expect(sink.out()).toBe("");
  });

  test("the message names the tag, the branch, and the approvals that remain", async () => {
    const { host, sink } = hostOf();
    await release.bump(host, "major");
    expect(sink.out()).toMatch(/Release v1\.0\.0 prepared/);
    expect(sink.out()).toMatch(/release\/first/);
    expect(sink.out()).toContain("node scripts/bootstrap.cjs setup");
    expect(sink.out()).toMatch(/release:tag/);
  });
});

describe("release:tag", () => {
  const changelogText = "# Changelog\n\n## v0.0.1 (2026-10-17)\n\n- one\n";
  const reviewed = (over: Partial<Facts> = {}) =>
    hostOf({ git: repository({ branch: "main", ...over }), files: { "package.json": MANIFEST.replace("0.0.0", "0.0.1"), "CHANGELOG.md": changelogText } });

  test("the reviewed merge at the head of the current main gets an annotated tag", async () => {
    const { host, git, sink } = reviewed();
    await release.tag(host);
    expect(git.calls).toContainEqual(["tag", "-a", "v0.0.1", "HEAD", "-m", "v0.0.1"]);
    expect(sink.out()).toMatch(/v0\.0\.1/);
    expect(sink.out()).toMatch(/push/);
  });

  test.each([
    ["a feature branch", { branch: "release/first" }, /from main/],
    ["a stale main", { main: "9".repeat(40) }, /origin\/main/],
    ["a missing origin/main", { main: null }, /origin\/main/],
    ["a head that is not a merge", { parents: ["a".repeat(40)] }, /regular merge commit/],
    ["a dirty tree", { changes: [" M a.js"] }, /clean working tree/],
    ["an existing tag", { tags: ["v0.0.1"] }, /Tag v0\.0\.1 already exists/],
  ] as const)("%s creates no tag", async (_name, over, message) => {
    const { host, git } = reviewed(over as Partial<Facts>);
    await expect(release.tag(host as never)).rejects.toThrow(message);
    expect(git.calls.some((args) => args[0] === "tag" && args[1] === "-a")).toBe(false);
  });

  test("a version without a changelog section creates no tag", async () => {
    const { host, git } = hostOf({
      git: repository({ branch: "main" }),
      files: { "package.json": MANIFEST.replace("0.0.0", "0.0.2"), "CHANGELOG.md": changelogText },
    });
    await expect(release.tag(host as never)).rejects.toThrow(/exactly one section for v0\.0\.2/);
    expect(git.calls.some((args) => args[0] === "tag" && args[1] === "-a")).toBe(false);
  });

  test("an address that is not a noreply address creates no tag and is not printed", async () => {
    const { host, git } = reviewed({ log: `h1\u001f${at("private.person", "example.com")}\u001f${at("someone", "users.noreply.github.com")}` });
    const failure = await release.tag(host as never).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/h1: author e-mail is not a GitHub noreply address/);
    expect(failure?.message).not.toMatch(/private|example/);
    expect(git.calls.some((args) => args[0] === "tag" && args[1] === "-a")).toBe(false);
  });
});

describe("release:validate", () => {
  const valid = () =>
    hostOf({
      git: repository({
        firstParent: ["c".repeat(40)],
        ancestors: ["c".repeat(40)],
        blobs: {
          "refs/tags/v0.0.1:package.json": MANIFEST.replace("0.0.0", "0.0.1"),
          "refs/tags/v0.0.1:CHANGELOG.md": "# Changelog\n\n## v0.0.1 (2026-10-17)\n\n- one\n",
        },
      }),
      files: { "package.json": MANIFEST.replace("0.0.0", "0.0.1") },
    });

  test("validates the tag of the current version and writes only the notes it was asked to write", () => {
    const { host, sink, files } = valid();
    release.validate(host, {});
    expect(sink.out()).toMatch(/release v0\.0\.1 is valid/);
    expect(Object.keys(files.files)).toEqual(["package.json"]);
    const named = valid();
    release.validate(named.host, { tag: "v0.0.1", notes: "/out/notes.md" });
    expect(named.files.files["/out/notes.md"]).toBe("## v0.0.1 (2026-10-17)\n\n- one\n");
  });

  test("a tag the repository does not have is a refusal, not a pass", () => {
    const { host } = valid();
    expect(() => {
      release.validate(host, { tag: "v0.0.7" });
    }).toThrow(/v0\.0\.7|package\.json/);
  });
});

describe("the commands", () => {
  const context = (tools?: unknown) => ({ root: "/project", cwd: "/project", io: capture().io, ...(tools === undefined ? {} : { tools }) });

  test("the bump takes exactly one segment", async () => {
    for (const args of [[], ["patch", "minor"], ["--segment=patch"], ["prerelease"]]) {
      await expect(
        Promise.resolve().then(() => release.bumpCommand(args, context() as never)),
        args.join(" "),
      ).rejects.toThrow(/patch, minor or major|unexpected/);
    }
  });

  test("the tag takes no argument and the validator only its two flags", async () => {
    await expect(Promise.resolve().then(() => release.tagCommand(["now"], context() as never))).rejects.toThrow(/unexpected argument/);
    await expect(Promise.resolve().then(() => release.validateCommand(["--force=1"], context() as never))).rejects.toThrow(/unknown flag/);
    await expect(Promise.resolve().then(() => release.validateCommand(["--tag=latest"], context() as never))).rejects.toThrow(/--tag/);
  });

  test("a release refusal is a message and a status of 1", async () => {
    const sink = capture();
    const status = await release.report(sink.io, () => {
      throw new metadata.ReleaseError("not a feature branch");
    });
    expect(status).toBe(1);
    expect(sink.err()).toBe("not a feature branch\n");
    await expect(release.report(sink.io, () => Promise.reject(new TypeError("crash")))).rejects.toThrow("crash");
    expect(await release.report(sink.io, () => Promise.resolve())).toBe(0);
  });
});
