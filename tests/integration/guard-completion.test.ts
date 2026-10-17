import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJson } from "../support/json.ts";
import { denial, guardArea } from "../support/guard-fixture.ts";
import { blankState, completion, nestedHome, Rollout, storedRollout, type State } from "../support/rollout.ts";

// Completion against real files and the real launcher: links, moved and replaced transcripts, and a
// Codex call whose result is only a yield. The transcripts are the synthetic fixtures of this repository.

const { createFixture, area } = guardArea("guard-completion-");
const fixtures = join(import.meta.dirname, "../fixtures");
let counter = 0;
const directory = () => join(area, `d${++counter}`);
const open = (state: State, home: string) => completion.liveCalls(state, { codexHome: home });

function hostEvent(name: string, root: string, transcript: string) {
  const text = readFileSync(join(fixtures, "host-events", name), "utf8")
    .replaceAll("<ROOT>", root)
    .replaceAll("<TRANSCRIPT>", transcript);
  return parseJson(text);
}

const shell = (command: string, id: string, root: string) => ({ cwd: root, tool_name: "Bash", tool_input: { command }, tool_use_id: id });

const stored = (root: string) =>
  parseJson<{ inflight: Record<string, { rolloutRequired?: boolean; rolloutReader?: unknown }>; window: unknown[]; needsEvaluation: boolean }>(
    readFileSync(join(root, ".git", "protected-baseline", "state.json"), "utf8"),
  );

describe("a Codex shell call through the real launcher", () => {
  test("a yielded result keeps the call reserved; its terminal record, not a later duplicate, settles it", () => {
    const fixture = createFixture();
    const transcript = join(directory(), "rollout.jsonl");
    mkdirSync(join(transcript, ".."), { recursive: true });
    copyFileSync(join(fixtures, "rollouts/paginated-yielded.jsonl"), transcript);
    const pre = hostEvent("codex-shell-pre.json", fixture.root, transcript);
    expect(fixture.launch("pre", pre, { client: "codex" })).toMatchObject({ status: 0, json: {} });
    expect(stored(fixture.root).inflight["call-1"]).toMatchObject({ rolloutRequired: true });

    const yielded = hostEvent("codex-shell-post-yield.json", fixture.root, transcript);
    expect(fixture.launch("post", yielded, { client: "codex" }).json).toEqual({});
    expect(Object.keys(stored(fixture.root).inflight)).toEqual(["call-1"]);

    expect(fixture.launch("post", hostEvent("codex-shell-post-late-other.json", fixture.root, transcript), { client: "codex" }).json).toEqual({});
    expect(Object.keys(stored(fixture.root).inflight)).toEqual(["call-1"]);

    // The host appends the terminal record; the next hook finds it.
    const finished = join(directory(), "finished.jsonl");
    mkdirSync(join(finished, ".."), { recursive: true });
    copyFileSync(join(fixtures, "rollouts/paginated-terminal.jsonl"), finished);
    renameSync(finished, transcript);
    expect(fixture.launch("post", yielded, { client: "codex" }).json).toEqual({});
    expect(stored(fixture.root).inflight).toEqual({});
    expect(fixture.launch("post", yielded, { client: "codex" }).json).toEqual({});
    expect(stored(fixture.root).window).toEqual([]);
  });

  test("a command whose terminal record is a failure is not given the environment change it made", () => {
    const fixture = createFixture();
    const transcript = join(directory(), "rollout.jsonl");
    mkdirSync(join(transcript, ".."), { recursive: true });
    copyFileSync(join(fixtures, "rollouts/paginated-yielded.jsonl"), transcript);
    const pre = {
      ...hostEvent("codex-shell-pre.json", fixture.root, transcript),
      tool_input: { command: "pnpm run deps:add --package=left-pad@1.3.0 --group=prod" },
    };
    expect(fixture.launch("pre", pre, { client: "codex" }).json).toEqual({});
    fixture.write("node_modules/left-pad/index.js", "module.exports = 1;\n");
    const failed = join(directory(), "failed.jsonl");
    mkdirSync(join(failed, ".."), { recursive: true });
    copyFileSync(join(fixtures, "rollouts/paginated-failed.jsonl"), failed);
    renameSync(failed, transcript);
    const post = fixture.launch("post", { ...pre, tool_response: "failed" }, { client: "codex" });
    expect(post.json.decision).toBe("block");
    expect(JSON.stringify(post.json)).toMatch(/repair/);
    expect(stored(fixture.root).inflight).toEqual({});
    expect(denial(fixture.launch("pre", shell("true", "next", fixture.root), { client: "codex" }).json)).toMatch(/repair/);
  });
});

describe("the transcript store is not followed out of itself", () => {
  test("a parent that is a link to a file outside the store proves nothing", () => {
    const { home, middle, leaf, state } = nestedHome(directory());
    const outside = join(directory(), "outside");
    mkdirSync(outside, { recursive: true });
    const target = join(outside, "rollout-2026-10-13T12-00-00-middle.jsonl");
    renameSync(middle.path, target);
    symlinkSync(target, middle.path);
    leaf.complete();
    expect(open(state, home)).toHaveProperty("call");
  });

  test("a parent below a linked directory proves nothing, and the linked directory is not read", () => {
    const { home, middle, leaf, state } = nestedHome(directory());
    const outside = join(directory(), "outside");
    mkdirSync(outside, { recursive: true });
    renameSync(middle.path, join(outside, "rollout-2026-10-13T12-00-00-middle.jsonl"));
    symlinkSync(outside, join(home, "sessions/linked"));
    leaf.complete();
    expect(open(state, home)).toHaveProperty("call");
  });

  test("a linked store is refused", () => {
    const area_ = directory();
    const home = join(area_, "codex");
    const real = join(area_, "real-sessions");
    mkdirSync(real, { recursive: true });
    mkdirSync(home, { recursive: true });
    symlinkSync(real, join(home, "sessions"));
    const leaf = storedRollout(join(area_, "leaf"), { thread: "leaf", parent: "middle" });
    leaf.complete();
    expect(open(leaf.state("call", { session: "root" }), home)).toHaveProperty("call");
  });
});

describe("transcripts that move while a call is waiting", () => {
  test("a parent that is archived, and one that is deleted and comes back, still complete the call", () => {
    const { home, middle, leaf, state } = nestedHome(directory());
    leaf.complete();
    expect(open(state, home)).toEqual({});

    const second = nestedHome(directory());
    second.leaf.complete();
    const header = readFileSync(second.middle.path);
    unlinkSync(second.middle.path);
    expect(open(second.state, second.home)).toHaveProperty("call");
    writeFileSync(second.middle.path, header);
    expect(open(second.state, second.home)).toEqual({});
    expect(middle.thread).toBe("middle");
  });

  test("a transcript deleted after the call was observed pending keeps it pending", () => {
    const run = new Rollout(join(directory(), "rollout.jsonl"));
    const state = run.state();
    expect(open(state, directory())).toHaveProperty("call");
    unlinkSync(run.path);
    expect(open(state, directory())).toHaveProperty("call");
    expect(state.needsEvaluation).toBe(false);
  });

  test("a transcript replaced by another session's is revalidated, and a replacement that fits restarts at its header", () => {
    const run = new Rollout(join(directory(), "rollout.jsonl"));
    run.append({ type: "irrelevant", padding: "x".repeat(4096) });
    const state = run.state();
    expect(open(state, directory())).toHaveProperty("call");

    const other = new Rollout(join(directory(), "other.jsonl"), { thread: "other" });
    other.complete();
    renameSync(other.path, run.path);
    expect(open(state, directory())).toHaveProperty("call");

    const fitting = new Rollout(join(directory(), "fitting.jsonl"));
    fitting.complete();
    fitting.append({ type: "irrelevant", padding: "x".repeat(8192) });
    renameSync(fitting.path, run.path);
    expect(open(state, directory())).toEqual({});
  });

  test("a parent header replaced by another's invalidates the binding until it is valid again", () => {
    const { home, middle, leaf, state } = nestedHome(directory());
    const valid = readFileSync(middle.path);
    expect(open(state, home)).toHaveProperty("call");
    const replacement = storedRollout(join(directory(), "replacement"), { thread: "middle", parent: "unrelated" });
    renameSync(replacement.path, middle.path);
    leaf.complete();
    expect(open(state, home)).toHaveProperty("call");
    writeFileSync(middle.path, valid);
    expect(open(state, home)).toEqual({});
  });

  test("a call whose state holds nothing of the reader is read from its first record", () => {
    const run = new Rollout(join(directory(), "rollout.jsonl"));
    run.complete();
    expect(open(blankState({ call: run.reservation() }), directory())).toEqual({});
  });
});

describe("bounded incremental reads of real transcripts", () => {
  const TAIL = completion.TRANSCRIPT_TAIL_BYTES;
  const none = () => directory();

  test("a large transcript is read on over several scans without losing the terminal record", () => {
    const run = new Rollout(join(directory(), "rollout.jsonl"));
    for (let index = 0; index < 70; index++) run.append({ type: "irrelevant", padding: "x".repeat(65536) });
    run.complete();
    const state = run.state();
    expect(open(state, none())).toHaveProperty("call");
    expect(open(state, none())).toEqual({});
  });

  test("an oversized unrelated record does not hide the terminal record, and an oversized terminal is no evidence", () => {
    const run = new Rollout(join(directory(), "rollout.jsonl"));
    run.append({ type: "irrelevant", padding: "x".repeat(TAIL + 1024) });
    run.complete();
    const state = run.state();
    expect(open(state, none())).toHaveProperty("call");
    expect(open(state, none())).toEqual({});

    const oversized = new Rollout(join(directory(), "oversized.jsonl"));
    oversized.complete({ padding: "x".repeat(TAIL + 1024) });
    const pending = oversized.state();
    for (let scan = 0; scan < 3; scan++) expect(open(pending, none())).toHaveProperty("call");
  });

  test("a partial last line is retried once its newline is appended", () => {
    const run = new Rollout(join(directory(), "rollout.jsonl"));
    run.complete();
    const written = readFileSync(run.path);
    writeFileSync(run.path, written.subarray(0, written.length - 1));
    const state = run.state();
    expect(open(state, none())).toHaveProperty("call");
    appendFileSync(run.path, "\n");
    expect(open(state, none())).toEqual({});
  });

  test("a transcript truncated in place restarts the reader at its header", () => {
    const run = new Rollout(join(directory(), "rollout.jsonl"));
    run.append({ type: "irrelevant", padding: "x".repeat(4096) });
    const state = run.state();
    expect(open(state, none())).toHaveProperty("call");
    const truncated = new Rollout(run.path);
    truncated.complete();
    expect(open(state, none())).toEqual({});
  });

  test("a directory is not a transcript, and a transcript that is a FIFO is refused without waiting on it", () => {
    const area_ = directory();
    const folder = join(area_, "folder");
    mkdirSync(folder, { recursive: true });
    expect(open(new Rollout(join(area_, "unused.jsonl")).state("call", { transcript: folder }), none())).toHaveProperty("call");
    const fifo = join(area_, "fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    expect(open(new Rollout(join(area_, "unused.jsonl")).state("call", { transcript: fifo }), none())).toHaveProperty("call");
  });

  test("a store that is a file proves nothing", () => {
    const home = join(directory(), "codex");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "sessions"), "not a directory");
    const leaf = storedRollout(join(directory(), "leaf"), { thread: "leaf", parent: "middle" });
    leaf.complete();
    expect(open(leaf.state("call", { session: "root" }), home)).toHaveProperty("call");
  });
});

describe("the sanitized host fixtures", () => {
  const place = (path: string, name: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    copyFileSync(join(fixtures, "rollouts", name), path);
    return path;
  };
  const reserved = (area_: string, session: string, transcript: string) =>
    blankState({ "call-1": new Rollout(join(area_, "unused.jsonl")).reservation({ session, turn: "turn-1", transcript }) });

  test("a nested terminal record in the fixtures finishes the call through the parent's header", () => {
    const area_ = directory();
    const home = join(area_, "codex");
    place(join(home, "sessions/2026/10/13/rollout-2026-10-13T12-00-00-thread-root.jsonl"), "nested-parent.jsonl");
    const leaf = place(join(area_, "leaf.jsonl"), "nested-leaf-terminal.jsonl");
    expect(open(reserved(area_, "thread-grandparent", leaf), home)).toEqual({});
  });

  test("a yield in the fixtures is pending, and a legacy result finishes", () => {
    const area_ = directory();
    const yielded = place(join(area_, "yielded.jsonl"), "paginated-yielded.jsonl");
    expect(open(reserved(area_, "thread-root", yielded), directory())).toHaveProperty("call-1");
    const legacy = place(join(area_, "legacy.jsonl"), "legacy-result.jsonl");
    expect(open(reserved(area_, "thread-root", legacy), directory())).toEqual({});
  });
});
