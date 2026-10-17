import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

const templateCommands = createRequire(import.meta.url)("../../scripts/template/commands.cjs") as typeof import("../../scripts/template/commands.cjs");
type Host = NonNullable<Parameters<typeof templateCommands.inRenderedApp>[2]>;

describe("generator failure reports on disk", () => {
  test("only the test-results directory is kept, replacing what an earlier failure left, and a missing one is no error", () => {
    const base = mkdtempSync(join(tmpdir(), "reports-"));
    try {
      const app = join(base, "app");
      const generator = join(base, "generator");
      mkdirSync(join(app, "test-results/case"), { recursive: true });
      mkdirSync(join(app, "node_modules/pkg"), { recursive: true });
      writeFileSync(join(app, "test-results/case/trace.zip"), "trace");
      writeFileSync(join(app, "node_modules/pkg/index.js"), "dependency");
      mkdirSync(join(generator, "test-results"), { recursive: true });
      writeFileSync(join(generator, "test-results/old.txt"), "old");

      templateCommands.keepReports(app, generator);
      expect(readFileSync(join(generator, "test-results/case/trace.zip"), "utf8")).toBe("trace");
      expect(readdirSync(generator)).toEqual(["test-results"]);
      expect(readdirSync(join(generator, "test-results"))).toEqual(["case"]);

      templateCommands.keepReports(join(base, "no-reports"), generator);
      expect(readdirSync(join(generator, "test-results"))).toEqual(["case"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a failing browser command leaves usable reports in the generator and no fixture; a passing one leaves nothing", async () => {
    const base = mkdtempSync(join(tmpdir(), "report-flow-"));
    try {
      const generator = join(base, "generator");
      mkdirSync(generator);
      for (const [status, kept] of [
        [1, true],
        [0, false],
      ] as const) {
        const scratch = join(base, `scratch-${String(status)}`);
        mkdirSync(scratch);
        const real: Host = {
          scratch: () => scratch,
          remove: (dir) => {
            rmSync(dir, { recursive: true, force: true });
          },
          render: (dest) => {
            mkdirSync(dest);
          },
          install: () => 0,
          command: (dir) => {
            mkdirSync(join(dir, "test-results/home-chromium-desktop"), { recursive: true });
            writeFileSync(join(dir, "test-results/home-chromium-desktop/trace.zip"), "trace");
            return status;
          },
          keepReports: (dir) => {
            templateCommands.keepReports(dir, generator);
          },
        };
        expect(await templateCommands.inRenderedApp("test:e2e", capture().io, real)).toBe(status);
        expect(existsSync(scratch), "the fixture is removed").toBe(false);
        const trace = join(generator, "test-results/home-chromium-desktop/trace.zip");
        expect(existsSync(trace), `status ${String(status)}`).toBe(kept);
        if (kept) {
          expect(readFileSync(trace, "utf8")).toBe("trace");
          rmSync(join(generator, "test-results"), { recursive: true });
        }
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
