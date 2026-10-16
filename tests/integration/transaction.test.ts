import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { put, roleFiles, scratchArea } from "../support/project.ts";

const transaction = createRequire(import.meta.url)("../../scripts/core/transaction.cjs") as typeof import("../../scripts/core/transaction.cjs");
const state = createRequire(import.meta.url)("../../scripts/core/install-state.cjs") as typeof import("../../scripts/core/install-state.cjs");
const scratch = scratchArea("transaction-");

const files = () => ({
  ...roleFiles("application"),
  "scripts/tool.cjs": "module.exports = 1;\n",
  "AGENTS.md": "# rules\n",
  "src/app/page.tsx": "export {};\n",
});
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

describe("protected snapshot", () => {
  test("records protected content and ignores ordinary source and dependency trees", () => {
    const root = scratch.project({ ...files(), "node_modules/x/index.js": "dep" });
    const keys = [...transaction.snapshot(root).keys()];
    expect(keys).toEqual(expect.arrayContaining(["package.json", "AGENTS.md", "scripts", "scripts/tool.cjs", "tooling", "tooling/project-role.json"]));
    expect(keys.some((key) => key.startsWith("src") || key.startsWith("node_modules"))).toBe(false);
  });

  test("records protected symlinks, and a configuration shadow below the root", () => {
    const root = scratch.project({ ...files(), "src/eslint.config.mjs": "export default [];\n" });
    symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    const snapshot = transaction.snapshot(root);
    expect(snapshot.get("CLAUDE.md")).toEqual({ type: "symlink", target: "AGENTS.md" });
    expect(snapshot.has("src/eslint.config.mjs")).toBe(true);
  });

  test("changed paths name content, mode and kind differences in both directions", () => {
    const root = scratch.project(files());
    const before = transaction.snapshot(root);
    writeFileSync(join(root, "AGENTS.md"), "# changed\n");
    chmodSync(join(root, "scripts/tool.cjs"), 0o755);
    unlinkSync(join(root, "pnpm-lock.yaml"));
    put(root, "scripts/new.cjs", "x");
    expect(transaction.changedPaths(before, transaction.snapshot(root))).toEqual(["AGENTS.md", "pnpm-lock.yaml", "scripts/new.cjs", "scripts/tool.cjs"]);
  });
});

describe("rollback", () => {
  test("puts back edited, deleted, retyped and added protected paths, and leaves ordinary source alone", () => {
    const root = scratch.project(files());
    const where = transaction.locate(root);
    const before = transaction.snapshot(where);
    writeFileSync(join(root, "AGENTS.md"), "# hostile\n");
    rmSync(join(root, "scripts/tool.cjs"));
    put(root, "scripts/injected/hook.cjs", "evil");
    rmSync(join(root, "tooling/project-role.json"));
    symlinkSync("/etc/passwd", join(root, "tooling/project-role.json"));
    writeFileSync(join(root, "src/app/page.tsx"), "export const edited = 1;\n");
    transaction.restore(where, before);
    expect(read(root, "AGENTS.md")).toBe("# rules\n");
    expect(read(root, "scripts/tool.cjs")).toBe("module.exports = 1;\n");
    expect(existsSync(join(root, "scripts/injected"))).toBe(false);
    expect(lstatSync(join(root, "tooling/project-role.json")).isSymbolicLink()).toBe(false);
    expect(read(root, "tooling/project-role.json")).toContain("application");
    expect(read(root, "src/app/page.tsx")).toBe("export const edited = 1;\n");
    expect(transaction.changedPaths(before, transaction.snapshot(where))).toEqual([]);
  });

  test("a retargeted symlink is repointed and never followed", () => {
    const root = scratch.project(files());
    symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    const where = transaction.locate(root);
    const before = transaction.snapshot(where);
    unlinkSync(join(root, "CLAUDE.md"));
    symlinkSync("package.json", join(root, "CLAUDE.md"));
    transaction.restore(where, before);
    expect(readlinkSync(join(root, "CLAUDE.md"))).toBe("AGENTS.md");
  });

  test("directories the transaction created are removed together with the protected content in them", () => {
    const root = scratch.project(files());
    const where = transaction.locate(root);
    const before = transaction.snapshot(where);
    mkdirSync(join(root, ".claude/empty"), { recursive: true });
    put(root, "tooling/extra/note.txt", "kept?");
    transaction.restore(where, before);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, "tooling/extra"))).toBe(false);
  });
});

describe("dependency transaction judged from the files", () => {
  const plan = { action: "none" } as const;
  const run = (root: string, change: (root: string) => void, status = 0, kind?: string) =>
    transaction.runTransaction({
      root,
      steps: [["install"]],
      plan,
      kind,
      runner: () => {
        change(root);
        return { status, stdout: "pnpm output\n", stderr: "" };
      },
    });

  test("a protected file edited by the package manager is rejected, restored and marks the install incomplete", () => {
    const root = scratch.project(files());
    const result = run(root, (dir) => {
      writeFileSync(join(dir, "scripts/tool.cjs"), "evil");
    });
    expect(result).toMatchObject({ ok: false, restored: true, status: 0, output: "pnpm output\n" });
    expect(result.violations).toContain("protected path changed: scripts/tool.cjs");
    expect(read(root, "scripts/tool.cjs")).toBe("module.exports = 1;\n");
    expect(state.dirtyReason(root)).toMatch(/rejected/);
  });

  test("a failing package manager restores the files and keeps its exit status and the recovery kind", () => {
    const root = scratch.project(files());
    const result = run(
      root,
      (dir) => {
        writeFileSync(join(dir, "pnpm-lock.yaml"), "partial");
      },
      7,
      "deps-lock",
    );
    expect(result).toMatchObject({ ok: false, status: 7, restored: true, violations: [] });
    expect(read(root, "pnpm-lock.yaml")).toBe("lockfileVersion: '9.0'\n");
    expect(state.dirtyReason(root)).toMatch(/failed/);
    expect(state.dirtyKind(root)).toBe("deps-lock");
  });

  test("a manifest changed beyond the plan, or left unreadable, is rejected and restored", () => {
    const root = scratch.project(files());
    const original = read(root, "package.json");
    const widened = run(root, (dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ ...(JSON.parse(original) as object), scripts: { check: "evil" } }));
    });
    expect(widened.ok).toBe(false);
    expect(widened.violations.join("\n")).toMatch(/scripts/);
    const broken = run(root, (dir) => {
      writeFileSync(join(dir, "package.json"), "{ not json");
    });
    expect(broken.violations.join("\n")).toMatch(/unreadable after the transaction/);
    expect(read(root, "package.json")).toBe(original);
  });

  test("a deleted lock is a violation even though the manager exited cleanly", () => {
    const root = scratch.project(files());
    const result = run(root, (dir) => {
      unlinkSync(join(dir, "pnpm-lock.yaml"));
    });
    expect(result.violations).toContain("pnpm-lock.yaml is missing after the transaction");
    expect(read(root, "pnpm-lock.yaml")).toContain("lockfileVersion");
  });

  test("a manager that throws leaves the files restored and the error visible", () => {
    const root = scratch.project(files());
    expect(() =>
      transaction.runTransaction({
        root,
        steps: [["install"]],
        plan,
        runner: () => {
          writeFileSync(join(root, "AGENTS.md"), "hostile");
          throw new Error("manager crashed");
        },
      }),
    ).toThrow(/manager crashed/);
    expect(read(root, "AGENTS.md")).toBe("# rules\n");
    expect(state.dirtyReason(root)).toMatch(/interrupted/);
  });

  test("steps run in order and stop at the first failure", () => {
    const root = scratch.project(files());
    const seen: string[] = [];
    const result = transaction.runTransaction({
      root,
      steps: [["first"], ["second"], ["third"]],
      plan,
      runner: (args) => {
        seen.push(args.join(" "));
        return { status: args[0] === "second" ? 1 : 0, stdout: "", stderr: `${args[0] ?? ""}\n` };
      },
    });
    expect(seen).toEqual(["first", "second"]);
    expect(result.output).toBe("first\nsecond\n");
  });

  test("a project without a manifest cannot start a transaction", () => {
    const root = scratch.project({ "AGENTS.md": "x" });
    expect(() => transaction.runTransaction({ root, steps: [], plan, runner: () => ({ status: 0, stdout: "", stderr: "" }) })).toThrow(
      /package\.json is missing/,
    );
  });
});
