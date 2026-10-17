import { cpSync, copyFileSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, run, writeProjectFile } from "./rendered-app.ts";

/**
 * A generator-shaped scratch project whose documentation is one of `tests/fixtures/docs`. It carries
 * the real site configuration, `scripts/` and package metadata. `node_modules` is a real directory of
 * links to the root packages, so the build output (below `node_modules/.cache`) stays in the scratch
 * project instead of the root install.
 */
export function docsSite(scratch: string, name: string, fixture: string, options: { version?: string; extra?: Record<string, string> } = {}): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  for (const entry of readdirSync(join(root, "node_modules"))) {
    if (entry !== ".cache") symlinkSync(join(root, "node_modules", entry), join(dir, "node_modules", entry));
  }
  for (const file of ["tsconfig.json", "pnpm-workspace.yaml"]) copyFileSync(join(root, file), join(dir, file));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ ...manifest, version: options.version ?? "1.2.3" }, null, 2)}\n`);
  for (const directory of ["scripts", "tooling"]) cpSync(join(root, directory), join(dir, directory), { recursive: true });
  cpSync(join(root, "docs/.vitepress"), join(dir, "docs/.vitepress"), { recursive: true });
  cpSync(join(root, "tests/fixtures/docs", fixture), join(dir, "docs"), { recursive: true });
  // The fixture has its own pages, so it has its own (empty) navigation.
  writeProjectFile(dir, "docs/.vitepress/site.json", `${JSON.stringify({ title: "Fixture", description: "A fixture site", sidebar: [] })}\n`);
  for (const [path, content] of Object.entries(options.extra ?? {})) writeProjectFile(dir, path, content);
  return dir;
}

/** The canonical `docs:build` command through the real dispatcher, with extra environment. */
export function buildDocs(dir: string, env: Record<string, string> = {}) {
  const entry = 'process.exitCode = require("./scripts/development.cjs").main(["docs:build"], { skipPreflight: true });';
  return run(dir, process.execPath, ["-e", entry], 170_000, env);
}

/** The built site below a scratch project. */
export const siteDir = (dir: string) => join(dir, "node_modules/.cache/docs/site");
