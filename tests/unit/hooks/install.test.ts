import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

const installer = createRequire(import.meta.url)("../../../scripts/hooks/install.cjs") as typeof import("../../../scripts/hooks/install.cjs");
type Disk = NonNullable<Parameters<typeof installer.install>[0]["disk"]>;

const HOOKS = "/repo/.git/hooks";

/** A directory of hook files in memory; `failOn` makes the nth rename fail the way a full disk would. */
function memoryHooks(initial: Record<string, { content: string; mode: number } | { symlink: true }> = {}, failOn = Infinity) {
  const files = new Map<string, { content: Buffer; mode: number } | { symlink: true }>();
  for (const [path, node] of Object.entries(initial)) files.set(path, "symlink" in node ? node : { content: Buffer.from(node.content), mode: node.mode });
  let renames = 0;
  const disk = {
    lstatSync: (path: string) => {
      const found = files.get(path);
      if (!found) return undefined;
      return { isFile: () => !("symlink" in found), mode: "symlink" in found ? 0o120777 : found.mode };
    },
    readFileSync: (path: string) => {
      const found = files.get(path);
      if (!found || "symlink" in found) throw new Error(`cannot read ${path}`);
      return found.content;
    },
    mkdirSync: () => undefined,
    writeFileSync: (path: string, data: string | Buffer, options?: { mode?: number }) => {
      const prior = files.get(path);
      files.set(path, { content: Buffer.from(data), mode: options?.mode ?? (prior && !("symlink" in prior) ? prior.mode : 0o644) });
    },
    chmodSync: (path: string, mode: number) => {
      const found = files.get(path);
      if (found && !("symlink" in found)) found.mode = mode;
    },
    renameSync: (from: string, to: string) => {
      renames += 1;
      if (renames >= failOn) throw new Error("no space left on device");
      const found = files.get(from);
      if (!found) throw new Error("missing");
      files.delete(from);
      files.set(to, found);
    },
    rmSync: (path: string) => {
      files.delete(path);
    },
  } as unknown as Disk;
  const content = (name: string) => {
    const found = files.get(`${HOOKS}/${name}`);
    return found && !("symlink" in found) ? found.content.toString("utf8") : null;
  };
  return { disk, files, content, mode: (name: string) => (files.get(`${HOOKS}/${name}`) as { mode: number } | undefined)?.mode };
}

/** Answers the two questions the installer asks Git; `dir` is where Git runs hooks from. */
const gitAt =
  (dir = HOOKS) =>
  (_command: string, args: readonly string[]) => ({
    status: 0,
    stdout: args.includes("--git-path") ? `${dir}\n` : "/repo/.git\n",
    stderr: "",
  });

const options = (machine: ReturnType<typeof memoryHooks>, dir = HOOKS) => ({ root: "/repo", disk: machine.disk, start: gitAt(dir) });

describe("hook installation", () => {
  test("writes the three owned hooks as executable shims that find the worktree at run time", () => {
    const machine = memoryHooks();
    const result = installer.install(options(machine));
    expect(result).toEqual({ dir: HOOKS, written: installer.HOOKS, unchanged: [], notice: [] });
    for (const name of installer.HOOKS) {
      expect(machine.content(name)).toBe(installer.shim(name));
      expect(machine.mode(name)).toBe(0o755);
    }
    expect(installer.shim("pre-push")).toContain('exec node "$root/scripts/hooks/pre-push.cjs" "$@"');
    expect(installer.shim("pre-push")).toContain("git rev-parse --show-toplevel");
  });

  test("a second installation changes nothing and creates no duplicate entry", () => {
    const machine = memoryHooks();
    installer.install(options(machine));
    const before = new Map(machine.files);
    const again = installer.install(options(machine));
    expect(again.written).toEqual([]);
    expect(again.unchanged).toEqual(installer.HOOKS);
    expect(machine.files).toEqual(before);
  });

  test("replaces a stale owned hook and a hook that lost its executable bit", () => {
    const machine = memoryHooks({
      [`${HOOKS}/pre-commit`]: { content: `#!/bin/sh\n${installer.MARKER}: pre-commit\nexit 0\n`, mode: 0o755 },
      [`${HOOKS}/commit-msg`]: { content: installer.shim("commit-msg"), mode: 0o644 },
    });
    expect(installer.inspect(options(machine)).hooks).toEqual({ "pre-commit": "stale", "commit-msg": "stale", "pre-push": "missing" });
    installer.install(options(machine));
    expect(machine.content("pre-commit")).toBe(installer.shim("pre-commit"));
    expect(machine.mode("commit-msg")).toBe(0o755);
  });

  test.each([
    ["a script of someone else", { content: "#!/bin/sh\necho mine\n", mode: 0o755 }],
    ["a symbolic link", { symlink: true } as const],
    ["a hook that only mentions the marker", { content: `#!/bin/sh\necho ${installer.MARKER}: pre-commit\n`, mode: 0o755 }],
  ])("%s is never overwritten, and nothing else is written either", (_label, foreign) => {
    const machine = memoryHooks({ [`${HOOKS}/pre-commit`]: foreign });
    const before = new Map(machine.files);
    expect(() => installer.install(options(machine))).toThrow(/not managed by this template; nothing was changed/);
    expect(machine.files).toEqual(before);
  });

  test("a failure in the middle restores the previous bytes and modes and leaves no temporary file", () => {
    const previous = { content: `#!/bin/sh\n${installer.MARKER}: pre-commit\nexit 0\n`, mode: 0o750 };
    const machine = memoryHooks({ [`${HOOKS}/pre-commit`]: previous }, 2);
    expect(() => installer.install(options(machine))).toThrow(/no space left/);
    expect(machine.content("pre-commit")).toBe(previous.content);
    expect(machine.mode("pre-commit")).toBe(0o750);
    expect(machine.content("commit-msg")).toBeNull();
    expect([...machine.files.keys()].filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  test("a failure after one new hook was written removes it again", () => {
    const machine = memoryHooks({}, 3);
    expect(() => installer.install(options(machine))).toThrow(/no space left/);
    expect([...machine.files.keys()]).toEqual([]);
  });

  test("a hooks directory that Git resolves elsewhere is used and the usual one is reported as not run", () => {
    const configured = "/elsewhere/hooks";
    const machine = memoryHooks({ [`${HOOKS}/pre-push`]: { content: installer.shim("pre-push"), mode: 0o755 } });
    const inspected = installer.inspect(options(machine, configured));
    expect(inspected.dir).toBe(configured);
    expect(inspected.unreachable).toEqual(["pre-push"]);
    const result = installer.install(options(machine, configured));
    expect(result.dir).toBe(configured);
    expect(result.notice).toEqual([`${HOOKS}/pre-push is managed by this template but Git runs hooks from ${configured}`]);
    expect(machine.files.has(`${configured}/pre-commit`)).toBe(true);
  });

  test("outside a Git worktree the installation refuses", () => {
    const machine = memoryHooks();
    expect(() => installer.install({ root: "/repo", disk: machine.disk, start: () => ({ status: 128, stdout: "", stderr: "" }) })).toThrow(
      /need a Git worktree/,
    );
  });
});
