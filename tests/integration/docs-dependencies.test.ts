import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { installRenderedApp, output, removeDir, run, scratchDir } from "../support/rendered-app.ts";

import { fixtureEnv, git } from "../support/template-fixture.ts";
import { accept } from "../support/template-lineage.ts";

const scratch = scratchDir("docs-dependencies-");
afterAll(() => {
  removeDir(scratch);
});

const REVIEWED_WORKSPACE = 'overrides:\n  "vitepress@1.6.4>@docsearch/js": 3.9.0\n  "vitepress@1.6.4>@docsearch/css": 3.9.0\n';
const REVIEWED_LOCK = "overrides:\n  vitepress@1.6.4>@docsearch/js: 3.9.0\n  vitepress@1.6.4>@docsearch/css: 3.9.0\n";

describe("reviewed documentation overrides in a rendered application", () => {
  test("the canonical dependency add keeps the exact overrides in the workspace file and the lock", () => {
    const app = installRenderedApp(scratch, "overrides-app");
    const env = fixtureEnv(scratch);
    git(app, ["init", "-b", "codex/fixture"], env);
    git(app, ["add", "."], env);
    git(app, ["commit", "-m", "chore: initialize fixture"], env);
    const setup = run(app, process.execPath, ["scripts/bootstrap.cjs", "setup"], 170_000, { PATH: dirname(process.execPath) + ":/usr/bin:/bin" });
    expect(setup.status, output(setup)).toBe(0);
    expect(accept(app).status).toBe(0);
    const workspace = join(app, "pnpm-workspace.yaml");
    const before = readFileSync(workspace, "utf8");
    expect(before).toContain(REVIEWED_WORKSPACE);
    expect(readFileSync(join(app, "pnpm-lock.yaml"), "utf8")).toContain(REVIEWED_LOCK);

    const added = run(app, "pnpm", ["run", "deps:add", "--package=left-pad@1.3.0", "--group=dev"]);
    expect(added.status, output(added)).toBe(0);

    expect(readFileSync(workspace, "utf8")).toBe(before);
    expect(readFileSync(join(app, "pnpm-lock.yaml"), "utf8")).toContain(REVIEWED_LOCK);
    expect(readFileSync(join(app, "package.json"), "utf8")).toContain('"left-pad": "1.3.0"');
  });
});
