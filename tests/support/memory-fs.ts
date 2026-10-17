type StateModule = typeof import("../../scripts/hooks/state.cjs");

export type Disk = NonNullable<Parameters<StateModule["readState"]>[1]>;

type Stored = { kind: "file"; content: Buffer; mode: number; mtimeMs: number; ino: number } | { kind: "symlink"; target: string };

const failure = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code });
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";
const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

/**
 * The part of `node:fs` the guard's repository and state use, answered from memory. Paths are
 * absolute and posix. Files and symlinks are stored; directories exist because something is in them
 * or because they were made. Symlinks are followed only by `realpathSync`, as far as the guard asks.
 */
export function memoryFs(nodes: Record<string, string | { content: string; mode: number; mtimeMs?: number } | { link: string }> = {}) {
  const entries = new Map<string, Stored>();
  const dirs = new Set<string>(["/"]);
  const operations: string[] = [];
  const addDirs = (path: string) => {
    for (let dir = parentOf(path); !dirs.has(dir); dir = parentOf(dir)) dirs.add(dir);
  };
  let nextInode = 1;
  const put = (path: string, stored: Stored) => {
    addDirs(path);
    entries.set(path, stored);
  };
  for (const [path, node] of Object.entries(nodes)) {
    if (typeof node === "string") put(path, { kind: "file", content: Buffer.from(node), mode: 0o100644, mtimeMs: 1000, ino: nextInode++ });
    else if ("link" in node) put(path, { kind: "symlink", target: node.link });
    else put(path, { kind: "file", content: Buffer.from(node.content), mode: node.mode, mtimeMs: node.mtimeMs ?? 1000, ino: nextInode++ });
  }
  const kindOf = (path: string) => entries.get(path) ?? (dirs.has(path) ? ("dir" as const) : undefined);
  const stat = (path: string) => {
    const found = kindOf(path);
    if (found === undefined) throw failure(entries.has(parentOf(path)) ? "ENOTDIR" : "ENOENT", path);
    return {
      isSymbolicLink: () => found !== "dir" && found.kind === "symlink",
      isDirectory: () => found === "dir",
      isFile: () => found !== "dir" && found.kind === "file",
      size: found !== "dir" && found.kind === "file" ? found.content.length : 0,
      mode: found !== "dir" && found.kind === "file" ? found.mode : 0o40755,
      mtimeMs: found !== "dir" && found.kind === "file" ? found.mtimeMs : 0,
    };
  };
  const children = (dir: string) =>
    [
      ...new Set(
        [...entries.keys(), ...dirs].filter((path) => path !== dir && parentOf(path) === dir).map((path) => path.slice(dir === "/" ? 1 : dir.length + 1)),
      ),
    ].sort();
  const file = (path: string) => {
    const found = entries.get(path);
    if (found === undefined || found.kind !== "file") throw failure(dirs.has(path) ? "EISDIR" : "ENOENT", path);
    return found;
  };
  const resolveLinks = (path: string): string => {
    let current = path;
    for (let hops = 0; hops < 20; hops++) {
      const found = entries.get(current);
      if (found?.kind !== "symlink") return current;
      current = found.target.startsWith("/") ? found.target : join(parentOf(current), found.target);
    }
    throw failure("ELOOP", path);
  };
  const open = new Map<number, string>();
  let nextHandle = 100;

  const disk = {
    lstatSync: (path: string, options?: { throwIfNoEntry: boolean }) => {
      if (options?.throwIfNoEntry === false && kindOf(path) === undefined) return undefined;
      return stat(path);
    },
    statSync: (path: string) => stat(resolveLinks(path)),
    existsSync: (path: string) => kindOf(path) !== undefined,
    readlinkSync: (path: string) => {
      const found = entries.get(path);
      if (found?.kind !== "symlink") throw failure("EINVAL", path);
      return found.target;
    },
    readFileSync: (path: string | number, encoding?: string) => {
      const target = typeof path === "number" ? (open.get(path) ?? "") : path;
      const content = file(resolveLinks(target)).content;
      return encoding ? content.toString() : Buffer.from(content);
    },
    readdirSync: (path: string, options?: { withFileTypes: boolean }) => {
      if (!dirs.has(path)) throw failure(entries.has(path) ? "ENOTDIR" : "ENOENT", path);
      const names = children(path);
      if (!options?.withFileTypes) return names;
      return names.map((name) => {
        const found = stat(join(path, name));
        return { name, isDirectory: found.isDirectory, isFile: found.isFile, isSymbolicLink: found.isSymbolicLink };
      });
    },
    writeFileSync: (path: string | number, data: string | Buffer, options?: { flag?: string; mode?: number }) => {
      const target = typeof path === "number" ? (open.get(path) ?? "") : path;
      if (options?.flag === "wx" && kindOf(target) !== undefined) throw failure("EEXIST", target);
      operations.push(`write ${target}`);
      const existing = entries.get(target);
      const ino = existing?.kind === "file" ? existing.ino : nextInode++;
      put(target, { kind: "file", content: Buffer.from(data), mode: 0o100000 | (options?.mode ?? 0o644), mtimeMs: operations.length, ino });
    },
    appendFileSync: (path: string, data: string | Buffer) => {
      const existing = entries.get(path);
      const before = existing?.kind === "file" ? existing : undefined;
      operations.push(`append ${path}`);
      put(path, {
        kind: "file",
        content: Buffer.concat([before?.content ?? Buffer.alloc(0), Buffer.from(data)]),
        mode: before?.mode ?? 0o100644,
        mtimeMs: operations.length,
        ino: before?.ino ?? nextInode++,
      });
    },
    // A read-only open (a numeric flag) needs the entry to exist, as it does on disk; a write open
    // ("w") names a file the write is about to create.
    openSync: (path: string, flags?: string | number) => {
      if (typeof flags === "number" && kindOf(resolveLinks(path)) === undefined) throw failure("ENOENT", path);
      const handle = nextHandle++;
      open.set(handle, path);
      return handle;
    },
    fstatSync: (handle: number, options?: { bigint: true }) => {
      const found = stat(resolveLinks(open.get(handle) ?? ""));
      const node = entries.get(resolveLinks(open.get(handle) ?? ""));
      const inode = node?.kind === "file" ? node.ino : 0;
      const size = options?.bigint ? BigInt(found.size) : found.size;
      return Object.assign(found, options?.bigint ? { dev: 1n, ino: BigInt(inode), size } : { dev: 1, ino: inode, size });
    },
    readSync: (handle: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const content = file(resolveLinks(open.get(handle) ?? "")).content;
      const copied = content.subarray(position, position + length);
      copied.copy(buffer, offset);
      return copied.length;
    },
    fsyncSync: () => undefined,
    closeSync: (handle: number) => {
      open.delete(handle);
    },
    mkdirSync: (path: string) => {
      operations.push(`mkdir ${path}`);
      dirs.add(path);
      addDirs(path);
    },
    chmodSync: (path: string, mode: number) => {
      const found = file(path);
      found.mode = 0o100000 | mode;
    },
    renameSync: (from: string, to: string) => {
      operations.push(`rename ${from} ${to}`);
      const found = entries.get(from);
      if (found === undefined) throw failure("ENOENT", from);
      entries.delete(from);
      put(to, found);
    },
    unlinkSync: (path: string) => {
      operations.push(`unlink ${path}`);
      if (!entries.delete(path)) throw failure("ENOENT", path);
    },
    rmdirSync: (path: string) => {
      operations.push(`rmdir ${path}`);
      if (children(path).length > 0) throw failure("ENOTEMPTY", path);
      if (!dirs.delete(path)) throw failure("ENOENT", path);
    },
    rmSync: (path: string, options?: { force?: boolean }) => {
      operations.push(`rm ${path}`);
      if (!entries.delete(path) && !options?.force) throw failure("ENOENT", path);
    },
    symlinkSync: (target: string, path: string) => {
      operations.push(`symlink ${path}`);
      put(path, { kind: "symlink", target });
    },
    realpathSync: Object.assign(
      (path: string) => {
        const parts = path.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
          current = resolveLinks(`${current}/${part}`);
          if (kindOf(current) === undefined) throw failure("ENOENT", path);
        }
        return current || "/";
      },
      {
        native: (path: string) => {
          const resolved = disk.realpathSync(path);
          return resolved;
        },
      },
    ),
  };
  return Object.assign(disk as unknown as Disk, {
    operations,
    paths: () => [...entries.keys()].sort(),
    text: (path: string) => {
      const found = entries.get(path);
      return found?.kind === "file" ? found.content.toString() : undefined;
    },
    modeOf: (path: string) => {
      const found = entries.get(path);
      return found?.kind === "file" ? found.mode & 0o777 : undefined;
    },
    linkOf: (path: string) => {
      const found = entries.get(path);
      return found?.kind === "symlink" ? found.target : undefined;
    },
  });
}
