import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
type Guard = typeof import("../../scripts/hooks/guard.cjs");
const protectedInventory = require("../../scripts/core/protected.cjs") as typeof import("../../scripts/core/protected.cjs");
const policyModule = require("../../scripts/hooks/policy.cjs") as typeof import("../../scripts/hooks/policy.cjs");

export type Repo = Parameters<Guard["snapshot"]>[0]["repo"];
export type Context = Parameters<Guard["snapshot"]>[0];
export type State = NonNullable<ReturnType<Repo["readState"]>>;

/** A file with its executable bit, a symlink, or plain text. */
export type Node = string | { content: string; executable: true } | { link: string };

const declared = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tooling/policy.json"), "utf8")) as { protected: unknown; guard: unknown };
export const inventory = protectedInventory.createInventory(declared.protected);
export const guardPolicy = policyModule.parseGuardPolicy(declared.guard);
export const policyText = Buffer.from(readFileSync(resolve(import.meta.dirname, "../../tooling/policy.json")));

const blobIdOf = (content: Buffer) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

function idOf(node: Node): string {
  if (typeof node === "string") return blobIdOf(Buffer.from(node));
  if ("link" in node) return `symlink:${node.link}`;
  return `${blobIdOf(Buffer.from(node.content))}:x`;
}

/**
 * The worktree, index, commits, hooks and user files of one project held in memory, answering the
 * way the real repository does for the questions the guard asks. Every question is recorded in
 * `calls` where a test needs to know what was touched.
 */
export function memoryRepo(committed: Record<string, Node>, options: { codex?: Record<string, string> } = {}) {
  const worktree = new Map<string, Node>(Object.entries(committed));
  const commits = new Map<string, Map<string, Node>>();
  const commit = (id: string, files: Map<string, Node>) => commits.set(id, new Map(files));
  commit("c1", worktree);
  let head: string | null = "c1";
  let index = new Map<string, Node>(Object.entries(committed));
  const objects = new Map<string, Buffer>();
  const stored = new Map<string, Buffer>();
  let persisted: State | null = null;
  const hooks = { path: null as string | null, scripts: { "pre-commit": `${blobIdOf(Buffer.from("#!/bin/sh\n"))}:755` } as Record<string, string> };
  const hookBodies = new Map<string, string>([["pre-commit", "#!/bin/sh\n"]]);
  const users = new Map<string, Buffer | null>([
    ["config.toml", options.codex?.["config.toml"] === undefined ? null : Buffer.from(options.codex["config.toml"])],
    ["hooks.json", options.codex?.["hooks.json"] === undefined ? null : Buffer.from(options.codex["hooks.json"])],
  ]);
  const writtenUsers: string[] = [];
  const texts = new Map<string, string>();
  const links = new Map<string, string>();
  let environment = "env-1";
  let operation = false;
  const conflicts = new Set<string>();
  const log: string[] = [];

  const treeOf = (revision: string) => commits.get(revision === "HEAD" ? (head ?? "") : revision);
  const content = (node: Node | undefined) =>
    node === undefined ? null : typeof node === "string" ? Buffer.from(node) : "link" in node ? null : Buffer.from(node.content);
  const isCandidate = (path: string) => inventory.isProtectedFile(path) || inventory.isShadowOverride(path);

  const repo: Repo = {
    root: "/p",
    gitDir: "/p/.git",
    stateDir: "/p/.git/protected-baseline",
    candidates: (extra) => [...new Set([...worktree.keys(), ...index.keys(), ...(treeOf("HEAD")?.keys() ?? []), ...extra])].filter(isCandidate).sort(),
    worktreeIds: (paths) => Object.fromEntries(paths.map((path) => [path, worktree.has(path) ? idOf(worktree.get(path) as Node) : null])),
    indexIds: (paths) => Object.fromEntries(paths.map((path) => [path, index.has(path) ? idOf(index.get(path) as Node) : null])),
    treeIds(paths, revision = "HEAD") {
      const tree = treeOf(revision);
      return Object.fromEntries(paths.map((path) => [path, tree?.has(path) ? idOf(tree.get(path) as Node) : null]));
    },
    treePaths: (revision) => new Set([...(treeOf(revision)?.keys() ?? [])].filter(isCandidate)),
    unmerged: (paths) => new Set(paths.filter((path) => conflicts.has(path))),
    head: () => head,
    operationInProgress: () => operation,
    stagedNames(filter) {
      const base = treeOf("HEAD") ?? new Map();
      return [...index.keys()].filter((path) => !base.has(path) && (filter === undefined || filter === "A")).sort();
    },
    resetIndex(paths) {
      log.push(`reset ${paths.join(",")}`);
      const base = treeOf("HEAD") ?? new Map<string, Node>();
      for (const path of paths) {
        const original = base.get(path);
        if (original === undefined) index.delete(path);
        else index.set(path, original);
      }
    },
    blobId: blobIdOf,
    readWorktree: (path) => content(worktree.get(path)),
    readBlob: (id) => (id === null ? null : (stored.get(id.replace(/:x$/, "")) ?? null)),
    readObject: (blob) => objects.get(blob) ?? null,
    capture(path) {
      const node = worktree.get(path);
      if (node === undefined) return null;
      const body = content(node);
      if (body !== null) stored.set(blobIdOf(body), body);
      return idOf(node);
    },
    storeContent(body) {
      stored.set(blobIdOf(body), body);
      return blobIdOf(body);
    },
    restore(path, id) {
      log.push(`restore ${path}`);
      if (id === null) {
        worktree.delete(path);
        return;
      }
      if (id.startsWith("symlink:")) {
        worktree.set(path, { link: id.slice(8) });
        return;
      }
      const body = stored.get(id.replace(/:x$/, ""));
      if (!body) throw new Error(`no stored copy of ${path}`);
      worktree.set(path, id.endsWith(":x") ? { content: body.toString(), executable: true } : body.toString());
    },
    prune(keep) {
      const wanted = new Set([...keep].filter(Boolean).map((id) => (id as string).replace(/:x$/, "")));
      for (const key of [...stored.keys()]) if (!wanted.has(key)) stored.delete(key);
    },
    hooks(keep) {
      if (keep) for (const body of hookBodies.values()) stored.set(blobIdOf(Buffer.from(body)), Buffer.from(body));
      return structuredClone(hooks);
    },
    restoreHooks(baseline) {
      log.push("restore hooks");
      hooks.path = baseline.path;
      hooks.scripts = { ...baseline.scripts };
    },
    environment: () => environment,
    userFile: (name) => ({ path: `/home/.codex/${name}`, content: users.get(name) ?? null }),
    writeUserFile(name, body) {
      writtenUsers.push(name);
      users.set(name, body);
    },
    realpath: (absolute) => links.get(absolute) ?? absolute,
    userHome: "/home",
    readText: (absolute) => texts.get(absolute) ?? null,
    writeText(absolute, text) {
      texts.set(absolute, text);
    },
    readState: () => (persisted === null ? null : (JSON.parse(JSON.stringify(persisted)) as State)),
    writeState: (baseline) => {
      persisted = JSON.parse(JSON.stringify(baseline)) as State;
    },
    locked: (action) => action(),
  };
  const context = (client = "claude"): Context => ({ repo, policy: guardPolicy, inventory, client, policyText });
  return {
    repo,
    context,
    log,
    worktree,
    index,
    objects,
    users,
    texts,
    links,
    writtenUsers,
    hooks,
    conflicts,
    state: () => persisted,
    setState(next: State | null) {
      persisted = next;
    },
    /** Records the current worktree as a new commit and moves HEAD to it. */
    commit(id: string) {
      commit(id, worktree);
      head = id;
      index = new Map(worktree);
    },
    setHead(next: string | null) {
      head = next;
    },
    /** Adds the object a commit's blob id names, so the guard can read committed content. */
    object(body: string) {
      const buffer = Buffer.from(body);
      objects.set(blobIdOf(buffer), buffer);
      return blobIdOf(buffer);
    },
    setEnvironment(next: string) {
      environment = next;
    },
    setOperation(next: boolean) {
      operation = next;
    },
  };
}

export const bytes = (text: string) => Buffer.from(text);
export const idOfText = (text: string) => blobIdOf(Buffer.from(text));

/** The hook payload of a Bash call. */
export function shell(command: string, id: string, extra: Record<string, unknown> = {}) {
  return { cwd: "/p", tool_name: "Bash", tool_input: { command }, tool_use_id: id, ...extra };
}
