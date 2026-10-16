import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";

/** A scratch directory area that is removed when the calling test file finishes. */
export function scratchArea(prefix: string) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  afterAll(() => {
    rmSync(area, { recursive: true, force: true });
  });
  return {
    area,
    /** A new project directory holding `files` (relative path to content). */
    project(files: Record<string, string> = {}): string {
      const dir = mkdtempSync(join(area, "p-"));
      for (const [path, content] of Object.entries(files)) put(dir, path, content);
      return dir;
    },
  };
}

export function put(dir: string, path: string, content: string, mode?: number) {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  if (mode !== undefined) chmodSync(target, mode);
}

/** Collects what a command writes. */
export function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** The files that make a directory a project of the given role as far as the dispatchers are concerned. */
export function roleFiles(role: "generator" | "application", pnpm = "12.14.0", node = process.versions.node): Record<string, string> {
  return {
    "tooling/project-role.json": JSON.stringify({ role }),
    "package.json": JSON.stringify({ name: "fixture", private: true, packageManager: `pnpm@${pnpm}`, dependencies: {}, devDependencies: {} }),
    ".node-version": `${node}\n`,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  };
}
