import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { GIT_DIR, ROOT, STATE, commitId, updating } from "../../support/update-model.ts";
import { scratchArea } from "../../support/project.ts";

const require = createRequire(import.meta.url);
const state = require("../../../scripts/hooks/state.cjs") as typeof import("../../../scripts/hooks/state.cjs");
const repo = require("../../../scripts/hooks/repo.cjs") as typeof import("../../../scripts/hooks/repo.cjs");

type State = ReturnType<typeof state.parseState>;
const none = { files: "none", edit: null, environment: "none", hooks: false, head: false, accept: false, client: "claude" } as const;
const baseline = (extra: Partial<State> = {}): State => ({
  version: state.STATE_VERSION,
  policy: "p".repeat(40),
  files: {},
  approved: {},
  head: null,
  hooks: { path: null, scripts: {} },
  environment: "absent",
  environmentBlocked: false,
  user: {},
  blocked: null,
  inflight: {},
  window: [],
  needsEvaluation: false,
  ...extra,
});
const reservation = (extra: Record<string, unknown> = {}) => ({
  client: "claude",
  session: "s",
  turn: "t",
  digest: "d",
  exclusive: false,
  route: null,
  completion: "result" as const,
  allowances: { success: { ...none, files: "format" as const }, failure: none },
  ...extra,
});
const identity = (extra: Record<string, unknown> = {}) => state.identityOf({ tool_use_id: "a", session_id: "s", turn_id: "t", ...extra }, "claude");

describe("the stored baseline", () => {
  test("it round-trips, and anything but the stored shape is an error", () => {
    expect(state.parseState(JSON.stringify(baseline()))).toEqual(baseline());
    for (const broken of [
      "",
      "[]",
      "null",
      "{",
      JSON.stringify({ ...baseline(), version: 1 }),
      JSON.stringify({ ...baseline(), files: [] }),
      JSON.stringify({ ...baseline(), window: {} }),
      JSON.stringify({ ...baseline(), hooks: { path: null } }),
      JSON.stringify({ ...baseline(), blocked: 1 }),
      JSON.stringify({ ...baseline(), head: 1 }),
      JSON.stringify({ ...baseline(), environmentBlocked: "no" }),
    ])
      expect(() => state.parseState(broken), broken.slice(0, 30)).toThrow(/guard state/);
  });
});

describe("call identity", () => {
  test("a call is identified by a bounded tool_use_id, and its client, session and turn", () => {
    expect(identity()).toEqual({ id: "a", client: "claude", session: "s", turn: "t" });
    expect(state.identityOf({ tool_use_id: "a" }, "codex")).toEqual({ id: "a", client: "codex", session: null, turn: null });
    expect(state.identityOf({ tool_use_id: "a", session_id: 5, turn_id: "" }, "codex")).toMatchObject({ session: null, turn: null });
    for (const payload of [{}, { tool_use_id: "" }, { tool_use_id: 7 }, { tool_use_id: "x".repeat(257) }])
      expect(() => state.identityOf(payload, "claude")).toThrow(/tool_use_id/);
  });
});

describe("reservations", () => {
  test("a call is admitted once", () => {
    const current = baseline();
    expect(state.reserve(current, "a", reservation())).toBe(true);
    expect(state.reserve(current, "a", reservation())).toBe(false);
    expect(Object.keys(state.liveCalls(current))).toEqual(["a"]);
  });

  test("only the very call that was admitted settles it, and only then does its allowance count", () => {
    const current = baseline();
    state.reserve(current, "a", reservation());
    for (const foreign of [
      identity({ tool_use_id: "b" }),
      identity({ session_id: "other" }),
      identity({ turn_id: "other" }),
      state.identityOf({ tool_use_id: "a" }, "claude"),
      state.identityOf({ tool_use_id: "a", session_id: "s", turn_id: "t" }, "codex"),
    ]) {
      expect(state.settle(current, foreign, "d", "success")).toMatchObject({ settled: false });
    }
    expect(state.settle(current, identity(), "other-command", "success")).toEqual({
      settled: false,
      reason: "the result does not belong to the reserved call",
    });
    expect(current.window).toEqual([]);
    expect(current.needsEvaluation).toBe(false);
    expect(state.settle(current, identity(), "d", "failure")).toEqual({ settled: true });
    expect(current.window).toEqual([none]);
    expect(current.inflight).toEqual({});
    expect(current.needsEvaluation).toBe(true);
    expect(state.settle(current, identity(), "d", "success")).toEqual({ settled: false, reason: "no reservation for this call" });
  });

  test("an inherited property name is not a reservation", () => {
    expect(state.settle(baseline(), identity({ tool_use_id: "constructor" }), "d", "success")).toMatchObject({ settled: false });
    expect(state.reserve(baseline(), "constructor", reservation())).toBe(true);
  });
});

describe("the state the dependency commands ask for", () => {
  const { area } = scratchArea("guard-state-");
  let counter = 0;
  const statusOf = (current: State | string | null, markers: string[] = []) => {
    const gitDir = join(area, `git-${++counter}`);
    mkdirSync(join(gitDir, "protected-baseline"), { recursive: true });
    if (current !== null) writeFileSync(join(gitDir, "protected-baseline", "state.json"), typeof current === "string" ? current : JSON.stringify(current));
    for (const marker of markers) writeFileSync(join(gitDir, marker), "");
    return state.status("/unused", { gitDir });
  };

  test("only a coherent approved baseline with nothing pending is clean", () => {
    expect(statusOf(baseline())).toEqual({ clean: true });
  });

  test.each([
    ["no baseline", null, /no approved baseline/],
    ["a damaged baseline", "{", /could not be read.*not valid JSON/],
    ["an unfinished call", baseline({ inflight: { a: reservation() } }), /1 call\(s\)/],
    ["a held conflict", baseline({ blocked: "A merge could not settle AGENTS.md" }), /could not settle/],
    ["unchecked finished calls", baseline({ needsEvaluation: true }), /not been checked/],
    ["a window to judge", baseline({ window: [none] }), /not been checked/],
    ["environment drift", baseline({ environmentBlocked: true }), /repair/],
  ])("%s is not clean", (_label, current, reason) => {
    const answer = statusOf(current);
    expect(answer.clean).toBe(false);
    expect(answer.reason).toMatch(reason);
  });

  test("an operation waiting to be finished is not clean", () => {
    expect(statusOf(baseline(), ["MERGE_HEAD"]).reason).toMatch(/waiting to be finished/);
    expect(statusOf(baseline(), ["rebase-merge"]).clean).toBe(false);
  });

  test("a dependency command may ask from inside its own reservation, and nothing else may be pending", () => {
    expect(statusOf(baseline({ inflight: { a: reservation({ route: "deps-add" }) } }))).toEqual({ clean: true });
    expect(statusOf(baseline({ inflight: { a: reservation({ route: "deps-lock" }) } })).clean).toBe(true);
    expect(statusOf(baseline({ inflight: { a: reservation({ route: "format" }) } })).clean).toBe(false);
    expect(statusOf(baseline({ inflight: { a: reservation({ route: "deps-add" }), b: reservation() } })).clean).toBe(false);
    expect(statusOf(baseline({ inflight: { a: reservation({ route: "deps-add" }), b: reservation({ route: "deps-add" }) } })).clean).toBe(false);
  });
});

describe("what Git reports", () => {
  test("an index listing keeps the stage, the mode and paths with spaces", () => {
    const listing = "100644 " + "a".repeat(40) + " 0\tsrc/a b.ts\0" + "100755 " + "b".repeat(40) + " 2\tscripts/x.cjs\0garbage\0";
    expect(repo.parseIndexListing(listing)).toEqual([
      { mode: "100644", blob: "a".repeat(40), stage: 0, path: "src/a b.ts" },
      { mode: "100755", blob: "b".repeat(40), stage: 2, path: "scripts/x.cjs" },
    ]);
    expect(repo.parseIndexListing("")).toEqual([]);
  });

  test("a tree listing keeps blobs only", () => {
    const listing = [`100644 blob ${"a".repeat(40)}\tAGENTS.md`, `160000 commit ${"b".repeat(40)}\tsub`, `120000 blob ${"c".repeat(40)}\tlink`, ""].join("\0");
    expect(repo.parseTreeListing(listing)).toEqual([
      { mode: "100644", blob: "a".repeat(40), path: "AGENTS.md" },
      { mode: "120000", blob: "c".repeat(40), path: "link" },
    ]);
  });

  test("an id of an executable file names the same content as the plain one", () => {
    expect(repo.contentOf("abc:x")).toBe("abc");
    expect(repo.contentOf("abc")).toBe("abc");
  });
});

describe("relocking an accepted template merge", () => {
  const approvedManifest = '{"name":"app","description":"accepted upstream metadata"}';
  function merging() {
    const model = updating();
    const dir = `${GIT_DIR}/protected-baseline`;
    const manifestId = commitId("approved manifest");
    const current = baseline({ head: model.journal.start.head, files: { [STATE]: model.journal.owned[0]?.after.blob ?? null, "package.json": manifestId } });
    model.disk.put(`${dir}/blobs/${manifestId}`, approvedManifest);
    const options = {
      gitDir: GIT_DIR,
      disk: { ...model.disk.disk, statSync: (path: string) => ({ size: Buffer.byteLength(model.disk.text(path) ?? "") }) } as never,
      operation: "deps-lock" as const,
      git: (args: string[]) => {
        try {
          return { status: 0, stdout: model.host.git.out(ROOT, args) };
        } catch {
          return { status: 1, stdout: "" };
        }
      },
    };
    const check = () => {
      model.disk.put(`${dir}/state.json`, JSON.stringify(current));
      return state.status(ROOT, options);
    };
    return { model, current, check };
  }
  test("only deps-lock receives the currently accepted manifest of the owned resolved merge", () => {
    const fixture = merging();
    expect(fixture.check()).toEqual({ clean: true, approvedManifest });
    // The ordinary dependency operation still refuses the very same pending merge.
    fixture.model.disk.put(`${GIT_DIR}/protected-baseline/state.json`, JSON.stringify(fixture.current));
    expect(state.status(ROOT, { gitDir: GIT_DIR, disk: { ...fixture.model.disk.disk, statSync: () => ({ size: 1 }) } as never }).clean).toBe(false);
  });
  test.each([
    "before acceptance",
    "historical approval only",
    "moved baseline",
    "unresolved",
    "foreign merge",
    "ordinary merge",
    "other operation",
    "missing manifest",
    "pending call",
  ])("refuses %s", (scenario) => {
    const fixture = merging();
    const owned = fixture.model.journal.owned[0];
    if (scenario === "before acceptance" || scenario === "historical approval only") fixture.current.files[STATE] = owned?.before.blob ?? null;
    if (scenario === "historical approval only") fixture.current.approved[STATE] = [owned?.after.blob ?? null];
    if (scenario === "moved baseline") fixture.current.head = commitId("other");
    if (scenario === "unresolved") fixture.model.repo.unmerged.push("package.json");
    if (scenario === "foreign merge") fixture.model.disk.put(`${GIT_DIR}/MERGE_HEAD`, `${commitId("foreign")}\n`);
    if (scenario === "ordinary merge") fixture.model.disk.disk.rmSync(`${GIT_DIR}/template-update/journal.json`);
    if (scenario === "other operation") fixture.model.disk.put(`${GIT_DIR}/CHERRY_PICK_HEAD`, "x");
    if (scenario === "missing manifest") fixture.current.files["package.json"] = commitId("absent");
    if (scenario === "pending call") fixture.current.inflight["x"] = reservation();
    expect(fixture.check().clean).toBe(false);
  });
});
