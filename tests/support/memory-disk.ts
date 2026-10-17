type Transaction = typeof import("../../scripts/core/transaction.cjs");
type Disk = NonNullable<Parameters<Transaction["snapshot"]>[1]>;

/** A file with its mode, a symlink, or plain text (mode 0o644). */
export type Node = string | { link: string } | { content: string; mode: number };

type Stored = { kind: "file"; content: Buffer; mode: number } | { kind: "symlink"; target: string };

const failure = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code });
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";

/**
 * A filesystem held in memory that answers the way a disk does for the calls a snapshot and a
 * rollback make, and records what they did. Keys are absolute paths of files and symlinks; their
 * parent directories exist. Directories stay when what is in them is removed, and a directory with
 * content cannot be removed, as on a disk. It lets decisions about what a tree contains and how it
 * is put back be judged without touching one.
 */
export function memoryDisk(nodes: Record<string, Node>): Disk & { operations: string[]; paths: () => string[] } {
  const entries = new Map<string, Stored>();
  const dirs = new Set<string>(["/"]);
  const addDirs = (path: string) => {
    for (let dir = parentOf(path); !dirs.has(dir); dir = parentOf(dir)) dirs.add(dir);
  };
  const store = (path: string, stored: Stored) => {
    addDirs(path);
    entries.set(path, stored);
  };
  for (const [path, node] of Object.entries(nodes)) {
    if (typeof node === "string") store(path, { kind: "file", content: Buffer.from(node), mode: 0o644 });
    else if ("link" in node) store(path, { kind: "symlink", target: node.link });
    else store(path, { kind: "file", content: Buffer.from(node.content), mode: node.mode });
  }
  const operations: string[] = [];
  const children = (dir: string) => [
    ...new Set([...entries.keys(), ...dirs].filter((path) => path !== dir && parentOf(path) === dir).map((path) => path.slice(dir.length).replace(/^\//, ""))),
  ];
  const need = (path: string) => {
    const found = entries.get(path);
    if (found === undefined) throw failure(entries.has(parentOf(path)) ? "ENOTDIR" : "ENOENT", path);
    return found;
  };
  return {
    operations,
    paths: () => [...entries.keys()].sort(),
    lstatSync: (path) => {
      const found = entries.get(path);
      if (found === undefined && !dirs.has(path)) throw failure(entries.has(parentOf(path)) ? "ENOTDIR" : "ENOENT", path);
      return {
        isSymbolicLink: () => found?.kind === "symlink",
        isDirectory: () => found === undefined,
        mode: found?.kind === "file" ? found.mode : 0o755,
      };
    },
    readlinkSync: (path) => {
      const found = need(path);
      if (found.kind !== "symlink") throw failure("EINVAL", path);
      return found.target;
    },
    readdirSync: (path) => {
      if (!dirs.has(path)) throw failure(entries.has(path) ? "ENOTDIR" : "ENOENT", path);
      return children(path);
    },
    readFileSync: (path) => {
      const found = need(path);
      if (found.kind !== "file") throw failure("EINVAL", path);
      return found.content;
    },
    mkdirSync: (path) => {
      operations.push(`mkdir ${path}`);
      if (entries.has(path)) throw failure("EEXIST", path);
      dirs.add(path);
      addDirs(path);
    },
    rmdirSync: (path) => {
      operations.push(`rmdir ${path}`);
      if (!dirs.has(path)) throw failure("ENOENT", path);
      if (children(path).length > 0) throw failure("ENOTEMPTY", path);
      dirs.delete(path);
    },
    unlinkSync: (path) => {
      operations.push(`unlink ${path}`);
      need(path);
      entries.delete(path);
    },
    symlinkSync: (target, path) => {
      operations.push(`symlink ${path} -> ${target}`);
      if (entries.has(path) || dirs.has(path)) throw failure("EEXIST", path);
      store(path, { kind: "symlink", target });
    },
    writeFileSync: (path, content, options) => {
      operations.push(`write ${path}`);
      if (!dirs.has(parentOf(path))) throw failure("ENOENT", path);
      store(path, { kind: "file", content: Buffer.from(content), mode: options.mode });
    },
    chmodSync: (path, mode) => {
      operations.push(`chmod ${path} ${mode.toString(8)}`);
      const found = need(path);
      if (found.kind === "file") found.mode = mode;
    },
  };
}
