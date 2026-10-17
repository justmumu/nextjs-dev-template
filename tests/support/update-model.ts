import { createRequire } from "node:module";
import type { Journal } from "../../scripts/template/journal.cjs";

// An in-memory project for the decisions of the update recovery: a disk, and a model of the few Git
// commands the recovery steps ask for. Nothing here starts a process or touches the machine.
const require = createRequire(import.meta.url);
const journals = require("../../scripts/template/journal.cjs") as typeof import("../../scripts/template/journal.cjs");
const gitModule = require("../../scripts/template/git.cjs") as typeof import("../../scripts/template/git.cjs");
const stateModule = require("../../scripts/template/state.cjs") as typeof import("../../scripts/template/state.cjs");
export type Host = Parameters<(typeof import("../../scripts/template/recovery.cjs"))["inspect"]>[0];

export const ROOT = "/project";
export const GIT_DIR = "/project/.git";
export const STATE = ".template-state.json";
const id = (seed: string) => gitModule.blobId(Buffer.from(seed));
export const commitId = (seed: string) => id(`commit ${seed}`);

const failure = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code });

export function memoryDisk(initial: Record<string, string> = {}) {
  const files = new Map<string, { content: Buffer; mode: number }>();
  const dirs = new Set<string>();
  const put = (path: string, data: string | Buffer, mode = 0o644) => files.set(path, { content: Buffer.from(data), mode });
  for (const [path, content] of Object.entries(initial)) put(path, content);
  const disk = {
    existsSync: (path: string) => files.has(path) || dirs.has(path),
    readFileSync: (path: string, encoding?: BufferEncoding) => {
      const found = files.get(path);
      if (!found) throw failure("ENOENT", path);
      return encoding ? found.content.toString(encoding) : Buffer.from(found.content);
    },
    writeFileSync: (path: string, data: string | Buffer, options?: { flag?: string; mode?: number }) => {
      if (options?.flag === "wx" && files.has(path)) throw failure("EEXIST", path);
      put(path, data, options?.mode);
    },
    renameSync: (from: string, to: string) => {
      const found = files.get(from);
      if (!found) throw failure("ENOENT", from);
      files.set(to, found);
      files.delete(from);
    },
    mkdirSync: (path: string) => {
      dirs.add(path);
    },
    linkSync: (from: string, to: string) => {
      const found = files.get(from);
      if (!found) throw failure("ENOENT", from);
      if (files.has(to)) throw failure("EEXIST", to);
      files.set(to, found);
    },
    rmSync: (path: string, options?: { recursive?: boolean }) => {
      files.delete(path);
      if (options?.recursive) for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key);
    },
    copyFileSync: (from: string, to: string) => {
      const found = files.get(from);
      if (!found) throw failure("ENOENT", from);
      put(to, found.content, found.mode);
    },
    chmodSync: () => undefined,
    lstatSync: (path: string) => {
      const found = files.get(path);
      if (!found) throw failure("ENOENT", path);
      return { isFile: () => true, mode: found.mode };
    },
  };
  return { disk, files, put, text: (path: string) => files.get(path)?.content.toString("utf8") };
}

export interface Model {
  host: Host;
  disk: ReturnType<typeof memoryDisk>;
  journal: Journal;
  calls: string[];
  /** What the repository holds, for a scenario to arrange and to read back. */
  repo: {
    head: string;
    parents: Map<string, string[]>;
    refs: Map<string, string>;
    unmerged: string[];
    dirty: string[];
    index: Map<string, string>;
    committed: Map<string, string>;
    mergeStatus: number;
    failAbort: boolean;
    merges: number;
  };
  output: { out: string[]; err: string[] };
}

/**
 * A project in the middle of an update. The state file's old and new text are real, so the journal's
 * digests are the ones `apply` would have written.
 */
export function updating(options: { phase?: Journal["phase"]; merged?: boolean; conflicted?: boolean; stateOnDisk?: "before" | "after" } = {}): Model {
  const start = commitId("start");
  const next = commitId("next");
  const source = { kind: "local-generator", revision: commitId("revision") } as const;
  const baseline = { commit: commitId("baseline"), tree: id("baseline tree") };
  const before = stateModule.serializeState(
    stateModule.buildState({ baseline, source, answers: { name: "app", description: "", owner: null, version: "0.0.0" }, renderDigest: "a".repeat(64) }),
  );
  const nextState = { commit: next, tree: id("next tree"), renderDigest: "b".repeat(64) };
  const after = stateModule.serializeState(
    stateModule.advanceState(stateModule.parseState(before), { next: nextState, upstream: { url: "file:///source", sha: commitId("source") } }),
  );
  const disk = memoryDisk({ [`${ROOT}/${STATE}`]: options.stateOnDisk === "before" ? before : after });
  const repo: Model["repo"] = {
    head: start,
    parents: new Map(),
    refs: new Map([[journals.PENDING_REF, next]]),
    unmerged: options.conflicted ? ["package.json"] : [],
    dirty: [],
    index: new Map([[STATE, options.stateOnDisk === "before" ? gitModule.blobId(Buffer.from(before)) : gitModule.blobId(Buffer.from(after))]]),
    committed: new Map([[`${start}:${STATE}`, before]]),
    mergeStatus: options.conflicted ? 1 : 0,
    failAbort: false,
    merges: 0,
  };
  if (options.merged !== false) disk.put(`${GIT_DIR}/MERGE_HEAD`, `${next}\n`);
  const entries = [{ mode: "100644", sha: id("merged"), stage: "0", path: "next.config.ts" }];
  const journal: Journal = {
    schema: journals.JOURNAL_SCHEMA,
    journalVersion: journals.JOURNAL_VERSION,
    phase: options.phase ?? "ready",
    source: { url: "file:///source", ref: "main", sha: commitId("source") },
    start: { head: start, baseline },
    next: nextState,
    outputDigest: journals.sha256(gitModule.indexKey(entries)),
    conflicted: options.conflicted ?? false,
    owned: [
      {
        path: STATE,
        before: { digest: journals.sha256(before), blob: gitModule.blobId(Buffer.from(before)) },
        after: { digest: journals.sha256(after), blob: gitModule.blobId(Buffer.from(after)) },
      },
    ],
    pendingRef: journals.PENDING_REF,
  };
  disk.put(`${GIT_DIR}/template-update/journal.json`, journals.serializeJournal(journal));
  const calls: string[] = [];
  const output = { out: [] as string[], err: [] as string[] };
  const blobAt = (path: string) => {
    const found = repo.committed.get(path);
    if (found === undefined) throw new Error(`no such blob: ${path}`);
    return Buffer.from(found);
  };

  const git = {
    out: (_cwd: string, args: readonly string[]) => {
      const a = args[0] === "-c" ? args.slice(2) : [...args];
      calls.push(a.join(" "));
      const [command, ...rest] = a;
      if (command === "rev-parse" && rest.includes("--absolute-git-dir")) return `${GIT_DIR}\n`;
      if (command === "rev-parse" && rest.includes("HEAD^{commit}")) return `${repo.head}\n`;
      if (command === "rev-parse" && rest.includes(`${journals.PENDING_REF}^{commit}`)) {
        const found = repo.refs.get(journals.PENDING_REF);
        if (found === undefined) throw new Error("missing");
        return `${found}\n`;
      }
      if (command === "rev-parse" && rest.includes("MERGE_HEAD")) {
        if (!disk.disk.existsSync(`${GIT_DIR}/MERGE_HEAD`)) throw new Error("missing");
        return disk.text(`${GIT_DIR}/MERGE_HEAD`) ?? "";
      }
      if (command === "rev-list") return `${repo.head} ${(repo.parents.get(repo.head) ?? []).join(" ")}\n`;
      if (command === "ls-files" && rest.includes("-u")) return repo.unmerged.map((path) => `100644 ${id("theirs")} 2\t${path}\0`).join("");
      if (command === "ls-files" && rest.includes("-s")) {
        const path = rest[rest.length - 1] ?? "";
        const blob = repo.index.get(path);
        return blob === undefined ? "" : `100644 ${blob} 0\t${path}\0`;
      }
      if (command === "status") return repo.dirty.map((path) => ` M ${path}\0`).join("");
      if (command === "update-ref" && rest[0] === "-d") {
        repo.refs.delete(rest[1] ?? "");
        return "";
      }
      if (command === "add") {
        const path = rest[rest.length - 1] ?? "";
        repo.index.set(path, gitModule.blobId(Buffer.from(disk.disk.readFileSync(`${ROOT}/${path}`))));
        return "";
      }
      if (command === "reset") {
        const path = rest[rest.length - 1] ?? "";
        repo.index.set(path, gitModule.blobId(blobAt(`${repo.head}:${path}`)));
        return "";
      }
      if (command === "merge" && rest[0] === "--abort") {
        if (repo.failAbort) throw new Error("Entry 'next.config.ts' not uptodate. Cannot merge.");
        if (!disk.disk.existsSync(`${GIT_DIR}/MERGE_HEAD`)) throw new Error("There is no merge to abort");
        disk.disk.rmSync(`${GIT_DIR}/MERGE_HEAD`);
        repo.unmerged = [];
        repo.dirty = [];
        return "";
      }
      throw new Error(`unscripted git ${a.join(" ")}`);
    },
    inventory: () => entries,
    blob: (_cwd: string, spec: string) => {
      const at = spec.startsWith("HEAD:") ? `${repo.head}:${spec.slice(5)}` : spec;
      return blobAt(at);
    },
    mergeNoCommit: (_cwd: string, commit: string) => {
      repo.merges += 1;
      calls.push(`merge ${commit}`);
      if (repo.mergeStatus === 0 || repo.mergeStatus === 1) disk.put(`${GIT_DIR}/MERGE_HEAD`, `${commit}\n`);
      return { status: repo.mergeStatus, stdout: "", stderr: repo.mergeStatus > 1 ? "untracked files would be overwritten" : "" };
    },
  };
  const host = {
    git,
    fs: disk.disk,
    root: ROOT,
    gitDir: GIT_DIR,
    io: { stdout: (text: string) => output.out.push(text), stderr: (text: string) => output.err.push(text) },
  } as unknown as Host;
  return { host, disk, journal, calls, repo, output };
}

/** The update's own commit, as the person makes it: HEAD with the two parents and the new state in it. */
export function commitIt(model: Model) {
  const merge = commitId("merge");
  model.repo.parents.set(merge, [model.journal.start.head, model.journal.next.commit]);
  model.repo.committed.set(`${merge}:${STATE}`, model.disk.text(`${ROOT}/${STATE}`) ?? "");
  model.repo.head = merge;
  model.disk.disk.rmSync(`${GIT_DIR}/MERGE_HEAD`);
}
