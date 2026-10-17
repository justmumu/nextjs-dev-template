import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { memoryFs } from "../../support/memory-fs.ts";
import { blankState, completion, nestedHome, Rollout, reservationOf, storedRollout, type Files, type Medium, type State } from "../../support/rollout.ts";

// Completion is decided by evidence that carries the call's own identity, never by output, time or a
// repeated record. The transcripts here are synthetic and sanitized and, like the reservations, held
// in memory; the same scenarios against real files are in tests/integration/guard-completion.test.ts.

let disk: Medium = memoryFs();
beforeEach(() => {
  disk = memoryFs();
});
let counter = 0;
const directory = () => `/area/d${++counter}`;
const NO_HOME = "/area/no-host-home";
const TAIL = completion.TRANSCRIPT_TAIL_BYTES;

const environment = (home = NO_HOME, files: Files = disk) => ({ codexHome: home, files });
const open = (state: State, home = NO_HOME, files: Files = disk) => completion.liveCalls(state, environment(home, files));
const make = (path: string, options: ConstructorParameters<typeof Rollout>[1] = {}) => new Rollout(path, { ...options, files: disk });
const stored = (area: string, options: Parameters<typeof storedRollout>[1]) => storedRollout(area, { ...options, files: disk });
const rollout = (options: ConstructorParameters<typeof Rollout>[1] = {}) => make(join(directory(), "rollout.jsonl"), options);
const marked = {
  success: { files: "format", edit: null, environment: "none", hooks: false, head: false, accept: false, client: "codex" },
  failure: { files: "lint-fix", edit: null, environment: "none", hooks: false, head: false, accept: false, client: "codex" },
} as const;

describe("nested transcripts bind to the hook session through verified parent headers", () => {
  test.each([2, 5])("a nested completion keeps the leaf call's identity at depth %i", (depth) => {
    const { home, middle, leaf, state } = nestedHome(directory(), disk);
    let parent: Rollout = middle;
    for (let index = 0; index < depth - 2; index++)
      parent = stored(join(home, "sessions/2026/10/12"), { thread: parent.parent ?? "", parent: `root-${index}` });
    reservationOf(state).session = parent.parent;
    leaf.complete();
    expect(open(state, home)).toEqual({});
    expect(state.needsEvaluation).toBe(true);
  });

  test("a reservation saved without reader fields recovers, and age is not what recovers it", () => {
    const { home, leaf, state } = nestedHome(directory(), disk);
    leaf.complete();
    const restored = JSON.parse(JSON.stringify(state)) as State;
    expect(open(restored, home)).toEqual({});
  });

  test.each([false, true])("a nested parent can be archived (also stored twice: %s)", (duplicate) => {
    const area = directory();
    const home = join(area, "codex");
    const leaf = stored(join(home, "sessions/2026/10/14"), { thread: "leaf", parent: "middle" });
    const state = leaf.state("call", { session: "root" });
    expect(open(state, home)).toHaveProperty("call");
    stored(join(home, "archived_sessions"), { thread: "middle", parent: "root" });
    if (duplicate) stored(join(home, "sessions/2026/10/13"), { thread: "middle", parent: "root" });
    leaf.complete();
    expect(open(state, home)).toEqual({});
  });

  test.each(["unrelated", "middle", "leaf", null, "", 3, ["root"]])("unverified nested ancestry stays pending (parent %j)", (parentId) => {
    const { home, middle, leaf, state } = nestedHome(directory(), disk);
    const header = JSON.parse(disk.readFileSync(middle.path, "utf8")) as { payload: Record<string, unknown> };
    header.payload.parent_thread_id = parentId;
    disk.writeFileSync(middle.path, `${JSON.stringify(header)}\n`);
    leaf.complete();
    expect(open(state, home)).toHaveProperty("call");
    expect(state.window).toEqual([]);
  });

  test.each(["id", "type", "partial", "malformed", "oversized", "replayed"])("nested ancestry requires a valid first header (%s)", (fault) => {
    const { home, middle, leaf, state } = nestedHome(directory(), disk);
    const valid = disk.readFileSync(middle.path, "utf8");
    const header = JSON.parse(valid) as { type: string; payload: { id: string }; padding?: string };
    if (fault === "id") header.payload.id = "impostor";
    else if (fault === "type") header.type = "event_msg";
    else if (fault === "oversized") header.padding = "x".repeat(TAIL);
    let content = `${JSON.stringify(header)}\n`;
    if (fault === "partial") content = valid.trimEnd();
    else if (fault === "malformed") content = "not json\n";
    else if (fault === "replayed") content = `{"type":"session_meta","payload":{"id":"impostor"}}\n${valid}`;
    disk.writeFileSync(middle.path, content);
    leaf.complete();
    expect(open(state, home)).toHaveProperty("call");
  });

  test.each([false, true])("a conflicting duplicate parent cannot prove ancestry (conflict first: %s)", (conflictFirst) => {
    const { home, middle, leaf, state } = nestedHome(directory(), disk);
    const duplicate = stored(join(home, "archived_sessions"), { thread: "middle", parent: "unrelated" });
    if (conflictFirst) {
      const original = disk.readFileSync(middle.path);
      disk.writeFileSync(middle.path, disk.readFileSync(duplicate.path));
      disk.writeFileSync(duplicate.path, original);
    }
    leaf.complete();
    expect(open(state, home)).toHaveProperty("call");
  });

  test("an invalid duplicate parent is not ignored", () => {
    const { home, leaf, state } = nestedHome(directory(), disk);
    const duplicate = stored(join(home, "archived_sessions"), { thread: "middle", parent: "root" });
    disk.writeFileSync(duplicate.path, "not json\n");
    leaf.complete();
    expect(open(state, home)).toHaveProperty("call");
  });

  test("a missing parent can appear without losing the completion", () => {
    const home = join(directory(), "codex");
    const leaf = stored(join(home, "sessions/2026/10/14"), { thread: "leaf", parent: "middle" });
    const state = leaf.state("call", { session: "root" });
    leaf.complete();
    expect(open(state, home)).toHaveProperty("call");
    stored(join(home, "sessions/2026/10/13"), { thread: "middle", parent: "root" });
    expect(open(state, home)).toEqual({});
  });

  test("a changed ancestor invalidates the previous binding", () => {
    const { home, middle, leaf, state } = nestedHome(directory(), disk);
    const valid = disk.readFileSync(middle.path);
    expect(open(state, home)).toHaveProperty("call");
    const replacement = stored(join(directory(), "replacement"), { thread: "middle", parent: "unrelated" });
    disk.writeFileSync(middle.path, disk.readFileSync(replacement.path));
    leaf.complete();
    expect(open(state, home)).toHaveProperty("call");
    disk.writeFileSync(middle.path, valid);
    expect(open(state, home)).toEqual({});
  });

  test("an unreadable parent does not prove ancestry", () => {
    const { home, middle, leaf, state } = nestedHome(directory(), disk);
    leaf.complete();
    const unreadable: Files = {
      ...disk,
      openSync: ((path: string, ...rest: unknown[]) => {
        if (path.includes(middle.thread)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return (disk.openSync as (...args: unknown[]) => number)(path, ...rest);
      }) as typeof disk.openSync,
    };
    expect(open(state, home, unreadable)).toHaveProperty("call");
    expect(open(state, home)).toEqual({});
  });

  test("a store that is not a directory proves nothing", () => {
    const home = join(directory(), "codex");
    disk.mkdirSync(home, { recursive: true });
    disk.writeFileSync(join(home, "sessions"), "not a directory");
    const leaf = stored(join(directory(), "leaf"), { thread: "leaf", parent: "middle" });
    leaf.complete();
    expect(open(leaf.state("call", { session: "root" }), home)).toHaveProperty("call");
  });

  test.each(["call", "thread", "turn"])("a nested terminal must match the leaf call (%s)", (identity) => {
    const { home, middle, leaf, state } = nestedHome(directory(), disk);
    leaf.complete({ [identity]: "middle" });
    middle.complete({ thread: "leaf" });
    expect(open(state, home)).toHaveProperty("call");
    leaf.complete();
    expect(open(state, home)).toEqual({});
  });

  test.each([{ source: "other" }, { status: "failed" }, { process: null }, { exit_code: true }, { type: "unknown" }])(
    "nested ancestry does not relax terminal evidence (%j)",
    (fields) => {
      const { home, leaf, state } = nestedHome(directory(), disk);
      leaf.complete(fields);
      expect(open(state, home)).toHaveProperty("call");
      leaf.complete();
      expect(open(state, home)).toEqual({});
    },
  );

  test.each([
    ["42", 0, "success"],
    ["42", 1, "failure"],
    [null, -1, null],
  ] as const)("a nested completion keeps its outcome allowance once (process %s, exit %i)", (process, exitCode, expected) => {
    const { home, leaf, state } = nestedHome(directory(), disk);
    reservationOf(state).allowances = marked;
    leaf.complete({ process, exit_code: exitCode });
    expect(open(state, home)).toEqual({});
    expect(open(state, home)).toEqual({});
    expect(state.window).toEqual(expected ? [marked[expected]] : []);
  });

  test("nested admission skips the results before it but not a future completion", () => {
    const { home, leaf, state } = nestedHome(directory(), disk);
    leaf.complete();
    const ancestry = completion.createAncestry(environment(home));
    expect(completion.commandCompletion(reservationOf(state), "call", { environment: environment(home), ancestry, starting: true })).toBe("pending");
    expect(open(state, home)).toHaveProperty("call");
    leaf.complete();
    expect(open(state, home)).toEqual({});
  });

  test("nested calls share one discovery and read no unrelated transcript body", () => {
    const { home, leaf, state } = nestedHome(directory(), disk);
    for (let index = 0; index < 120; index++) stored(join(home, "sessions/2026/10/01"), { thread: `other-${index}` });
    state.inflight.second = { ...reservationOf(state) };
    leaf.complete();
    leaf.complete({ call: "second" });
    const listed: string[] = [];
    const opened: string[] = [];
    const watched: Files = {
      ...disk,
      readdirSync: ((path: string, ...rest: unknown[]) => {
        listed.push(path);
        return (disk.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
      }) as typeof disk.readdirSync,
      openSync: ((path: string, ...rest: unknown[]) => {
        opened.push(path);
        return (disk.openSync as (...args: unknown[]) => number)(path, ...rest);
      }) as typeof disk.openSync,
    };
    expect(open(state, home, watched)).toEqual({});
    expect(new Set(listed).size).toBe(listed.length);
    expect(opened.filter((path) => path.includes("-other-"))).toEqual([]);
  });
});

describe("a process is finished by its own terminal record", () => {
  test("a spawn failure closes only its own call", () => {
    const run = rollout();
    run.complete({ process: null, exit_code: -1 });
    const state = run.state();
    state.inflight.other = run.reservation();
    expect(Object.keys(open(state))).toEqual(["other"]);
    expect(state.needsEvaluation).toBe(true);
    expect(state.window).toEqual([]);
  });

  test("a new call skips the history before its admission", () => {
    const run = rollout();
    run.append({ type: "irrelevant", text: "x".repeat(TAIL + 1) });
    const state = run.state();
    const ancestry = completion.createAncestry(environment(NO_HOME));
    expect(completion.commandCompletion(reservationOf(state), "call", { environment: environment(NO_HOME), ancestry, starting: true })).toBe("pending");
    run.complete({ process: null, exit_code: -1 });
    expect(open(state)).toEqual({});
  });

  test("admission does not skip an incomplete record", () => {
    const run = rollout();
    const state = run.state();
    disk.appendFileSync(run.path, '{"type": "irrelevant"');
    const ancestry = completion.createAncestry(environment(NO_HOME));
    expect(completion.commandCompletion(reservationOf(state), "call", { environment: environment(NO_HOME), ancestry, starting: true })).toBe("pending");
    disk.appendFileSync(run.path, "}\n");
    run.complete({ process: null, exit_code: -1 });
    expect(open(state)).toEqual({});
  });

  test.each([0, 1, -15])("process completion grants the existing outcome allowance once (exit %i)", (exitCode) => {
    const run = rollout();
    const state = run.state("call", { allowances: marked });
    expect(open(state)).toHaveProperty("call");
    run.complete({ exit_code: exitCode });
    expect(open(state)).toEqual({});
    expect(state.window).toEqual([exitCode === 0 ? marked.success : marked.failure]);
    open(state);
    expect(state.window).toHaveLength(1);
  });

  test("yielded output and age do not prove process completion", () => {
    const run = rollout();
    const state = run.state("call", { started: 0 } as never);
    run.append({ type: "function_call_output", call_id: "call", output: "yield" });
    expect(open(state)).toHaveProperty("call");
    run.complete();
    expect(open(state)).toEqual({});
  });

  test("a reservation is never completed by its age", () => {
    const run = rollout();
    const state = run.state("call", { started: 0 } as never);
    expect(open(state)).toHaveProperty("call");
    expect(state.window).toEqual([]);
    expect(state.needsEvaluation).toBe(false);
    const plain = blankState({ old: { ...run.reservation(), client: "claude", shell: false, transcript: null, started: 0 } as never });
    expect(open(plain)).toHaveProperty("old");
  });

  test.each(["call", "thread", "turn"])("another identity cannot close the call (%s)", (identity) => {
    const run = rollout();
    run.complete({ [identity]: "other" });
    expect(open(run.state())).toHaveProperty("call");
  });

  test.each([
    { source: "unrelated" },
    { type: "unknown" },
    { status: "unknown" },
    { exit_code: true },
    { exit_code: "0" },
    { exit_code: 1.5 },
    { status: "failed", exit_code: 0 },
    { process: null, exit_code: 0 },
    { process: null, exit_code: 1 },
    { process: "" },
  ])("an unrecognized or inconsistent result stays pending (%j)", (fields) => {
    const run = rollout();
    run.complete(fields);
    expect(open(run.state())).toHaveProperty("call");
  });

  test("a partial last line is retried", () => {
    const run = rollout();
    run.complete();
    const written = disk.readFileSync(run.path);
    disk.writeFileSync(run.path, written.subarray(0, written.length - 1));
    const state = run.state();
    expect(open(state)).toHaveProperty("call");
    disk.appendFileSync(run.path, "\n");
    expect(open(state)).toEqual({});
  });

  test("a missing transcript keeps the call pending, however long it has been", () => {
    const run = rollout();
    const state = run.state("call", { transcript: join(directory(), "gone.jsonl") });
    expect(open(state)).toHaveProperty("call");
    expect(open(state)).toHaveProperty("call");
    expect(state.needsEvaluation).toBe(false);
  });

  test("a transcript that is not a regular file proves nothing", () => {
    const state = rollout().state("call", { transcript: directory() });
    disk.mkdirSync(reservationOf(state).transcript ?? "", { recursive: true });
    expect(open(state)).toHaveProperty("call");
  });

  test("duplicate records do not duplicate the allowance", () => {
    const run = rollout();
    run.complete();
    run.complete();
    const state = run.state("call", { allowances: { ...marked, success: marked.success } });
    expect(open(state)).toEqual({});
    expect(state.window).toEqual([marked.success]);
  });

  test("a large transcript advances without losing the completion", () => {
    const run = rollout();
    for (let index = 0; index < 70; index++) run.append({ type: "irrelevant", padding: "x".repeat(65536) });
    run.complete();
    const state = run.state();
    expect(open(state)).toHaveProperty("call");
    expect(open(state)).toEqual({});
  });

  test("an oversized unrelated record does not hide the completion", () => {
    const run = rollout();
    const state = run.state();
    const ancestry = completion.createAncestry(environment(NO_HOME));
    expect(completion.commandCompletion(reservationOf(state), "call", { environment: environment(NO_HOME), ancestry, starting: true })).toBe("pending");
    run.append({ type: "irrelevant", padding: "x".repeat(TAIL + 1024) });
    run.complete();
    expect(open(state)).toHaveProperty("call");
    expect(open(state)).toEqual({});
  });

  test("an oversized terminal record is not completion evidence", () => {
    const run = rollout();
    const state = run.state();
    run.complete({ padding: "x".repeat(TAIL + 1024) });
    for (let scan = 0; scan < 3; scan++) expect(open(state)).toHaveProperty("call");
  });

  test("a replaced transcript revalidates its identity", () => {
    const run = rollout();
    const state = run.state();
    expect(open(state)).toHaveProperty("call");
    const replacement = make(join(directory(), "replacement.jsonl"), { thread: "other" });
    replacement.complete();
    disk.writeFileSync(run.path, disk.readFileSync(replacement.path));
    expect(open(state)).toHaveProperty("call");
  });

  test("a replaced transcript restarts at its matching session header", () => {
    const run = rollout();
    run.append({ type: "irrelevant", padding: "x".repeat(4096) });
    const state = run.state();
    let shift = 0;
    const replaced: Files = {
      ...disk,
      fstatSync: ((fd: number, options?: { bigint: true }) => {
        const stat = disk.fstatSync(fd, options);
        return Object.assign(Object.create(stat) as object, { ino: BigInt(stat.ino) + BigInt(shift) });
      }) as typeof disk.fstatSync,
    };
    expect(open(state, NO_HOME, replaced)).toHaveProperty("call");
    const replacement = make(join(directory(), "replacement.jsonl"));
    replacement.complete();
    replacement.append({ type: "irrelevant", padding: "x".repeat(8192) });
    disk.writeFileSync(run.path, disk.readFileSync(replacement.path));
    shift = 1;
    expect(open(state, NO_HOME, replaced)).toEqual({});
  });

  test("a truncated transcript restarts the reader", () => {
    const run = rollout();
    run.append({ type: "irrelevant", padding: "x".repeat(4096) });
    const state = run.state();
    expect(open(state)).toHaveProperty("call");
    const updated = make(run.path);
    updated.complete();
    expect(open(state)).toEqual({});
  });

  test.each(["parent", "unrelated"])("a child transcript must belong to the hook session (parent %s)", (parent) => {
    const run = rollout({ thread: "child", parent });
    run.complete();
    const state = run.state("call", { session: "parent" });
    expect(Object.keys(open(state))).toEqual(parent === "parent" ? [] : ["call"]);
  });

  test("a malformed record is not completion evidence", () => {
    const run = rollout();
    disk.appendFileSync(run.path, "not json\n");
    run.complete();
    expect(open(run.state())).toHaveProperty("call");
  });

  test("a stored reader that is not exactly the stored shape starts over", () => {
    const run = rollout();
    run.complete();
    for (const reader of [
      { identity: null, offset: -1, discarding: false },
      { identity: ["1"], offset: 0, discarding: false },
      "x",
      { identity: ["a", "b"], offset: 1.5, discarding: false },
    ]) {
      const state = run.state("call", { rolloutReader: reader } as never);
      expect(open(state)).toEqual({});
    }
  });
});

describe("a host that records results rather than processes", () => {
  test("a legacy transcript result still finishes the call", () => {
    const run = rollout({ history: "legacy" });
    run.append({ type: "function_call_output", call_id: "call", output: "done" });
    expect(open(run.state())).toEqual({});
  });

  test("a missing history mode uses the legacy results", () => {
    const run = rollout();
    const header = JSON.parse(disk.readFileSync(run.path, "utf8")) as { payload: Record<string, unknown> };
    Reflect.deleteProperty(header.payload, "history_mode");
    disk.writeFileSync(run.path, `${JSON.stringify(header)}\n`);
    run.append({ type: "function_call_output", call_id: "call", output: "done" });
    expect(open(run.state())).toEqual({});
  });

  test.each([null, "future"])("an unrecognized history mode stays pending (%s)", (history) => {
    const run = rollout({ history });
    run.append({ type: "function_call_output", call_id: "call", output: "done" });
    expect(open(run.state())).toHaveProperty("call");
  });

  test("a transcript that turned legacy after it was paginated stays pending", () => {
    const run = rollout();
    const state = run.state();
    expect(open(state)).toHaveProperty("call");
    const legacy = make(join(directory(), "legacy.jsonl"), { history: "legacy" });
    legacy.append({ type: "function_call_output", call_id: "call", output: "done" });
    disk.writeFileSync(run.path, disk.readFileSync(legacy.path));
    expect(open(state)).toHaveProperty("call");
  });

  test("a non-shell tool keeps the existing completion path", () => {
    const run = rollout();
    run.append({ type: "function_call_output", call_id: "call", output: "done" });
    expect(open(run.state("call", { shell: false }))).toEqual({});
  });

  test("a tool result finds the call at any depth and by either identifier", () => {
    expect(completion.hasResult({ a: [{ b: { type: "tool_result", tool_use_id: "x" } }] }, "x")).toBe(true);
    expect(completion.hasResult([{ type: "custom_tool_call_output", call_id: "x" }], "x")).toBe(true);
    expect(completion.hasResult({ type: "tool_result", tool_use_id: "y" }, "x")).toBe(false);
    expect(completion.hasResult("x", "x")).toBe(false);
  });

  test("a result in the transcript tail finishes a call without an allowance, and other lines do not", () => {
    const area = directory();
    disk.mkdirSync(area, { recursive: true });
    const path = join(area, "claude.jsonl");
    const claude = (transcript: string) => make(join(area, "unused.jsonl")).reservation({ client: "claude", shell: false, transcript, allowances: marked });
    disk.writeFileSync(path, `${JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "call" }] } })}\nnot json call\n`);
    const state = blankState({ call: claude(path) });
    expect(open(state)).toEqual({});
    expect(state.window).toEqual([]);
    expect(state.needsEvaluation).toBe(true);
    disk.writeFileSync(path, "not json call\n");
    const entry = claude(path);
    expect(completion.transcriptFinished(entry, "call", environment())).toBe(false);
    expect(completion.transcriptFinished(entry, "absent", environment())).toBe(false);
    expect(completion.transcriptFinished(claude(join(area, "missing.jsonl")), "call", environment())).toBe(false);
    expect(completion.transcriptFinished({ ...entry, transcript: null }, "call", environment())).toBe(false);
  });

  test.each(["completed", "failed", "declined"])("an intercepted patch finishes the call without a shell allowance (%s)", (status) => {
    const run = rollout();
    run.complete({ type: "FileChange", status, process: null });
    const state = run.state("call", { allowances: { success: marked.success, failure: marked.failure } });
    expect(open(state)).toEqual({});
    expect(state.window).toEqual([]);
    expect(state.needsEvaluation).toBe(true);
  });

  test("an intercepted patch that has not reached a terminal status is not a completion", () => {
    const run = rollout();
    run.complete({ type: "FileChange", status: "inProgress", process: null });
    expect(open(run.state())).toHaveProperty("call");
  });

  test("replayed parent metadata does not replace the child identity", () => {
    const run = rollout({ thread: "child", parent: "parent" });
    run.append({ type: "session_meta", payload: { id: "parent", history_mode: "paginated" } });
    run.complete();
    expect(open(run.state())).toEqual({});
  });
});

describe("finishing a call", () => {
  test("a reservation is closed once, and an unknown call is ignored", () => {
    const run = rollout();
    const state = run.state("call", { allowances: marked });
    completion.finishCall(state, "absent", "success");
    expect(state.needsEvaluation).toBe(false);
    completion.finishCall(state, "constructor", "success");
    completion.finishCall(state, "call", "failure");
    completion.finishCall(state, "call", "failure");
    expect(state.window).toEqual([marked.failure]);
    expect(state.inflight).toEqual({});
  });

  test("only a call that may change protected files is exclusive", () => {
    const run = rollout();
    const state = run.state();
    state.inflight.writer = run.reservation({ exclusive: true });
    expect(completion.exclusiveCalls(state.inflight).length).toBe(1);
  });
});
