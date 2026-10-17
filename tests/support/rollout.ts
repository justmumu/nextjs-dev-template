import * as disk from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
export const completion = require("../../scripts/hooks/completion.cjs") as typeof import("../../scripts/hooks/completion.cjs");
export type State = ReturnType<(typeof import("../../scripts/hooks/state.cjs"))["parseState"]>;
export type Reservation = State["inflight"][string];

/** What a transcript is written and read through: the real disk by default, or a memory fs in a unit test. */
export type Store = Pick<typeof disk, "appendFileSync" | "mkdirSync" | "readFileSync" | "writeFileSync">;
/** What the completion reader opens, reads and lists. */
export type Files = NonNullable<Parameters<typeof completion.createAncestry>[0]["files"]>;
export type Medium = Store & Files;

const none = { files: "none", edit: null, environment: "none", hooks: false, head: false, accept: false, client: "codex" } as const;

/**
 * A synthetic, sanitized session transcript in the shape the host writes: a first `session_meta`
 * header, then records. It holds no real conversation, path or identifier.
 */
export class Rollout {
  readonly thread: string;
  readonly parent: string | null;
  readonly files: Store;

  constructor(
    readonly path: string,
    options: { thread?: string; parent?: string | null; history?: string | null; files?: Store } = {},
  ) {
    this.files = options.files ?? disk;
    this.thread = options.thread ?? "thread";
    this.parent = options.parent ?? null;
    this.files.mkdirSync(dirname(path), { recursive: true });
    this.files.writeFileSync(path, "");
    this.append({
      type: "session_meta",
      payload: { id: this.thread, parent_thread_id: this.parent, history_mode: options.history === undefined ? "paginated" : options.history },
    });
  }

  append(record: unknown): void {
    this.files.appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }

  /** The terminal item of a command, as the host records it when the process ends. */
  complete(fields: { call?: string; thread?: string; turn?: string; process?: string | null; exit_code?: unknown; [key: string]: unknown } = {}): void {
    const { call = "call", thread, turn = "turn", process = "42", exit_code: code = 0, ...rest } = fields;
    const item: Record<string, unknown> = {
      type: "CommandExecution",
      id: call,
      source: "unified_exec_startup",
      status: code === 0 ? "completed" : "failed",
      exit_code: code,
      ...rest,
    };
    if (process !== null) item.process_id = process;
    this.append({ type: "event_msg", payload: { type: "item_completed", thread_id: thread ?? this.thread, turn_id: turn, item } });
  }

  /** The session a hook of this transcript reports: its root ancestor's, or its own. */
  session(): string {
    return this.parent ?? this.thread;
  }

  reservation(extra: Partial<Reservation> = {}): Reservation {
    return {
      client: "codex",
      session: this.session(),
      turn: "turn",
      digest: "digest",
      exclusive: false,
      route: null,
      completion: "result",
      allowances: { success: none, failure: none },
      shell: true,
      transcript: this.path,
      ...extra,
    };
  }

  state(call = "call", extra: Partial<Reservation> = {}): State {
    return blankState({ [call]: this.reservation(extra) });
  }
}

export function blankState(inflight: Record<string, Reservation> = {}): State {
  return {
    version: 2,
    policy: "p".repeat(40),
    files: {},
    approved: {},
    head: null,
    hooks: { path: null, scripts: {} },
    environment: "absent",
    environmentBlocked: false,
    user: {},
    blocked: null,
    inflight,
    window: [],
    needsEvaluation: false,
  };
}

/** Stores a transcript under the host's file name convention. */
export function storedRollout(directory: string, options: { thread: string; parent?: string | null; history?: string | null; files?: Store }): Rollout {
  return new Rollout(join(directory, `rollout-2026-10-14T12-00-00-${options.thread}.jsonl`), options);
}

/** A host home holding a middle session whose parent is `root`, and the leaf session that the call runs in. */
export function nestedHome(area: string, files?: Store) {
  const home = join(area, "codex");
  const middle = storedRollout(join(home, "sessions/2026/10/13"), { thread: "middle", parent: "root", ...(files && { files }) });
  const leaf = storedRollout(join(home, "sessions/2026/10/14"), { thread: "leaf", parent: "middle", ...(files && { files }) });
  const state = leaf.state("call", { session: "root" });
  return { home, middle, leaf, state };
}

export const reservationOf = (state: State, call = "call") => state.inflight[call] as Reservation;
