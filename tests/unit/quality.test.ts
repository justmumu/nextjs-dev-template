import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, test } from "vitest";

const quality = createRequire(import.meta.url)("../../scripts/core/quality.cjs") as typeof import("../../scripts/core/quality.cjs");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "quality-unit-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(scratch, "p-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("managed Next.js agent blocks", () => {
  test("a project without instruction files has none", () => {
    expect(quality.managedAgentBlockErrors(project({}))).toEqual([]);
  });

  test("hand-written instructions, including a pointer at the local docs, are not a managed block", () => {
    const dir = project({ "AGENTS.md": "# Rules\n\nRead node_modules/next/dist/docs/ for the installed version.\n", "CLAUDE.md": "@AGENTS.md\n" });
    expect(quality.managedAgentBlockErrors(dir)).toEqual([]);
  });

  test.each([
    ["AGENTS.md", "<!-- BEGIN:nextjs-agent-rules -->"],
    ["AGENTS.md", "<!-- BEGIN:nextjs-agent-feedback -->"],
    ["CLAUDE.md", "<!-- NEXT-AGENTS-MD-START -->"],
  ])("%s with %s asks for an explicit migration and is left untouched", (file, marker) => {
    const dir = project({ [file]: `# Rules\n${marker}\nx\n` });
    const errors = quality.managedAgentBlockErrors(dir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(new RegExp(`^${file.replace(".", "\\.")} contains`));
    expect(errors[0]).toMatch(/Migrate it explicitly/);
  });
});
