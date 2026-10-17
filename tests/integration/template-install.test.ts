import * as fs from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { scratchArea } from "../support/project.ts";

// The installation over a source, undone from its backup, on a real filesystem. The same decisions
// with an in-memory disk are in tests/unit/template-transaction.test.ts.
const require = createRequire(import.meta.url);
const transaction = require("../../scripts/template/transaction.cjs") as typeof import("../../scripts/template/transaction.cjs");

const scratch = scratchArea("template-install-");
const rendered = (path: string, text: string, mode = 0o644) => ({ path, mode, content: Buffer.from(text) });

function layout(files: Record<string, string>, modes: Record<string, number> = {}) {
  const dir = scratch.project();
  const root = join(dir, "src");
  const backup = join(dir, "backup");
  fs.mkdirSync(root);
  fs.mkdirSync(backup);
  for (const [path, text] of Object.entries(files)) {
    fs.writeFileSync(join(root, path), text);
    fs.chmodSync(join(root, path), modes[path] ?? 0o644);
  }
  return { dir, root, backup };
}

const read = (path: string) => fs.readFileSync(path, "utf8");

describe("rolling an installation back on a real filesystem", () => {
  test("a file replaced by a link to a user file is not written through; the path is named and the user file stays", () => {
    const { dir, root, backup } = layout({ "a.txt": "old\n" });
    const outside = join(dir, "outside.txt");
    fs.writeFileSync(outside, "new\n");
    const { undo } = transaction.installTree({ disk: fs, root, plan: { add: [], change: [rendered("a.txt", "new\n")], remove: [] }, backup });
    fs.rmSync(join(root, "a.txt"));
    fs.symlinkSync(outside, join(root, "a.txt"));
    expect(undo()).toEqual([join(root, "a.txt")]);
    expect(read(outside)).toBe("new\n");
    expect(fs.lstatSync(join(root, "a.txt")).isSymbolicLink()).toBe(true);
    expect(read(join(backup, "a.txt"))).toBe("old\n");
  });

  test("a new file replaced by a link is left alone and named", () => {
    const { dir, root, backup } = layout({ "keep.txt": "k" });
    const outside = join(dir, "outside.txt");
    fs.writeFileSync(outside, "user\n");
    const { undo } = transaction.installTree({ disk: fs, root, plan: { add: [rendered("n.txt", "n")], change: [], remove: [] }, backup });
    fs.rmSync(join(root, "n.txt"));
    fs.symlinkSync(outside, join(root, "n.txt"));
    expect(undo()).toEqual([join(root, "n.txt")]);
    expect(read(outside)).toBe("user\n");
    expect(fs.lstatSync(join(root, "n.txt")).isSymbolicLink()).toBe(true);
  });

  /** A disk that stores one byte of a file and then fails, for the writes `tears` selects. */
  const tearing = (target: string, tears: (content: Buffer) => boolean) => ({
    ...fs,
    writeFileSync: (path: string, content: Buffer, options: { mode: number }) => {
      if (path === target && tears(content)) {
        fs.writeFileSync(path, content.subarray(0, 1), options);
        throw new Error("no space left");
      }
      fs.writeFileSync(path, content, options);
    },
  });
  const failureOf = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error as InstanceType<typeof transaction.InstallError>;
    }
    throw new Error("expected the installation to fail");
  };

  test("a write that stores one byte and then fails is taken back to the original bytes", () => {
    const { root, backup } = layout({ "a.txt": "old\n" });
    const disk = tearing(join(root, "a.txt"), (content) => content.toString() === "new\n");
    const error = failureOf(() => transaction.installTree({ disk, root, plan: { add: [], change: [rendered("a.txt", "new\n")], remove: [] }, backup }));
    expect(error).toBeInstanceOf(transaction.InstallError);
    expect(error.failures).toEqual([]);
    expect(error.message).toContain("was taken back");
    expect(read(join(root, "a.txt"))).toBe("old\n");
  });

  test("a torn write whose restore also tears is named, and the backup holds the original", () => {
    const { root, backup } = layout({ "a.txt": "old\n" });
    const disk = tearing(join(root, "a.txt"), () => true);
    const error = failureOf(() => transaction.installTree({ disk, root, plan: { add: [], change: [rendered("a.txt", "new\n")], remove: [] }, backup }));
    expect(error.failures).toEqual([join(root, "a.txt")]);
    expect(error.message).toContain("could not be taken back completely");
    expect(read(join(backup, "a.txt"))).toBe("old\n");
  });

  describe("rollback follows only the path the installation walked", () => {
    const tree = () => {
      const area = scratch.project();
      const root = join(area, "src");
      const backup = join(area, "backup");
      const outside = join(area, "outside");
      for (const dir of [root, backup, outside, join(root, "sub")]) fs.mkdirSync(dir);
      return { area, root, backup, outside };
    };

    test("a changed file whose parent directory became a link to an outside directory is not written through", () => {
      const { root, backup, outside } = tree();
      fs.writeFileSync(join(root, "sub", "a.txt"), "old\n");
      fs.writeFileSync(join(outside, "a.txt"), "new\n");
      const { undo } = transaction.installTree({ disk: fs, root, plan: { add: [], change: [rendered("sub/a.txt", "new\n")], remove: [] }, backup });
      fs.renameSync(join(root, "sub"), join(root, "sub-moved"));
      fs.symlinkSync(outside, join(root, "sub"));
      expect(undo()).toEqual([join(root, "sub", "a.txt")]);
      expect(read(join(outside, "a.txt"))).toBe("new\n");
      expect(read(join(root, "sub-moved", "a.txt"))).toBe("new\n");
      expect(read(join(backup, "sub", "a.txt"))).toBe("old\n");
    });

    test("a parent directory replaced by another real directory holding the same bytes is not rolled back through either", () => {
      const { root, backup } = tree();
      fs.writeFileSync(join(root, "sub", "a.txt"), "old\n");
      const { undo } = transaction.installTree({ disk: fs, root, plan: { add: [], change: [rendered("sub/a.txt", "new\n")], remove: [] }, backup });
      fs.renameSync(join(root, "sub"), join(root, "sub-moved"));
      fs.mkdirSync(join(root, "sub"));
      fs.writeFileSync(join(root, "sub", "a.txt"), "new\n");
      expect(undo()).toEqual([join(root, "sub", "a.txt")]);
      expect(read(join(root, "sub", "a.txt"))).toBe("new\n");
      expect(read(join(backup, "sub", "a.txt"))).toBe("old\n");
    });

    test("a removed file is not restored through a swapped parent, and a new file is not unlinked through one", () => {
      const { root, backup, outside } = tree();
      fs.writeFileSync(join(root, "sub", "gone.txt"), "gone\n");
      fs.writeFileSync(join(outside, "n.txt"), "user\n");
      const { undo } = transaction.installTree({
        disk: fs,
        root,
        plan: { add: [rendered("sub/n.txt", "n\n")], change: [], remove: ["sub/gone.txt"] },
        backup,
      });
      fs.renameSync(join(root, "sub"), join(root, "sub-moved"));
      fs.symlinkSync(outside, join(root, "sub"));
      const refused = undo();
      expect(refused).toEqual(expect.arrayContaining([join(root, "sub", "gone.txt"), join(root, "sub", "n.txt")]));
      expect(refused.every((path) => path.startsWith(join(root, "sub")))).toBe(true);
      expect(fs.readdirSync(outside)).toEqual(["n.txt"]);
      expect(read(join(outside, "n.txt"))).toBe("user\n");
      expect(read(join(backup, "sub", "gone.txt"))).toBe("gone\n");
    });

    test("a directory this installation made is not removed once it was replaced", () => {
      const { root, backup } = tree();
      const { undo } = transaction.installTree({ disk: fs, root, plan: { add: [rendered("made/n.txt", "n\n")], change: [], remove: [] }, backup });
      fs.renameSync(join(root, "made"), join(root, "made-moved"));
      fs.mkdirSync(join(root, "made"));
      expect(undo()).toContain(join(root, "made", "n.txt"));
      expect(fs.existsSync(join(root, "made"))).toBe(true);
    });

    test("removed nested directories and their files are restored on rollback", () => {
      const { root, backup } = tree();
      fs.mkdirSync(join(root, "sub", "nested"));
      fs.writeFileSync(join(root, "sub", "nested", "gone.txt"), "original\n");
      const { undo } = transaction.installTree({ disk: fs, root, plan: { add: [], change: [], remove: ["sub/nested/gone.txt"] }, backup });
      expect(fs.existsSync(join(root, "sub"))).toBe(false);
      // Occupy freed directory inodes so restoration cannot accidentally pass by reusing them.
      for (let i = 0; i < 8; i += 1) fs.mkdirSync(join(backup, `unrelated-${String(i)}`));
      expect(undo()).toEqual([]);
      expect(read(join(root, "sub", "nested", "gone.txt"))).toBe("original\n");
    });
  });

  describe("a write that failed is not an ownership claim on whatever is there afterwards", () => {
    /** A write that stores one byte, lets `interfere` act on the target, and then fails. */
    const failing = (target: string, interfere: () => void) => ({
      ...fs,
      writeFileSync: (path: string, content: Buffer, options: { mode: number }) => {
        if (path === target && content.toString() === "new\n") {
          fs.writeFileSync(path, content.subarray(0, 1), options);
          interfere();
          throw new Error("no space left");
        }
        fs.writeFileSync(path, content, options);
      },
    });

    test("a user file that atomically replaced the target is left alone and named", () => {
      const { dir, root, backup } = layout({ "a.txt": "old\n" });
      const target = join(root, "a.txt");
      const disk = failing(target, () => {
        fs.writeFileSync(join(dir, "user.tmp"), "user edit\n");
        fs.renameSync(join(dir, "user.tmp"), target);
      });
      const error = failureOf(() => transaction.installTree({ disk, root, plan: { add: [], change: [rendered("a.txt", "new\n")], remove: [] }, backup }));
      expect(error.failures).toEqual([target]);
      expect(error.message).toContain("could not be taken back completely");
      expect(read(target)).toBe("user edit\n");
      expect(read(join(backup, "a.txt"))).toBe("old\n");
    });

    test("a file that is gone after a failed write over a real file is not claimed as restored", () => {
      const { root, backup } = layout({ "a.txt": "old\n" });
      const target = join(root, "a.txt");
      const disk = failing(target, () => {
        fs.unlinkSync(target);
      });
      const error = failureOf(() => transaction.installTree({ disk, root, plan: { add: [], change: [rendered("a.txt", "new\n")], remove: [] }, backup }));
      expect(error.failures).toEqual([target]);
      expect(fs.existsSync(target)).toBe(false);
      expect(read(join(backup, "a.txt"))).toBe("old\n");
    });

    test("a user file that replaced a new file's partial write is not unlinked", () => {
      const { dir, root, backup } = layout({ "keep.txt": "k" });
      const target = join(root, "n.txt");
      const disk = failing(target, () => {
        fs.writeFileSync(join(dir, "user.tmp"), "n");
        fs.renameSync(join(dir, "user.tmp"), target);
      });
      const error = failureOf(() => transaction.installTree({ disk, root, plan: { add: [rendered("n.txt", "new\n")], change: [], remove: [] }, backup }));
      expect(error.failures).toEqual([target]);
      expect(read(target)).toBe("n");
    });
  });

  test("a private file keeps its permissions in the backup and after a rollback", () => {
    const { root, backup } = layout({ "private.txt": "old\n", "gone.txt": "g\n" }, { "private.txt": 0o600, "gone.txt": 0o640 });
    const previous = process.umask(0o077);
    try {
      const { undo } = transaction.installTree({
        disk: fs,
        root,
        plan: { add: [], change: [rendered("private.txt", "new\n")], remove: ["gone.txt"] },
        backup,
      });
      expect(fs.statSync(join(backup, "private.txt")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(join(backup, "gone.txt")).mode & 0o777).toBe(0o640);
      expect(undo()).toEqual([]);
    } finally {
      process.umask(previous);
    }
    expect(fs.statSync(join(root, "private.txt")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(root, "gone.txt")).mode & 0o777).toBe(0o640);
    expect(read(join(root, "private.txt"))).toBe("old\n");
  });
});
