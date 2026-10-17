import { mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { scratchArea } from "../support/project.ts";

const artifact = createRequire(import.meta.url)("../../scripts/testing/artifact.cjs") as typeof import("../../scripts/testing/artifact.cjs");
const scratch = scratchArea("artifact-compose-");

describe("composing the artifact", () => {
  function built() {
    return scratch.project({
      ".next/standalone/server.js": "server",
      ".next/standalone/.next/server/app.js": "app",
      ".next/standalone/node_modules/next/package.json": "{}",
      ".next/static/chunks/main.js": "main",
      "public/favicon.svg": "<svg/>",
    });
  }

  test("places the traced server, then public and .next/static beside it", () => {
    const fixture = built();
    const destination = scratch.project();
    artifact.composeArtifact({ fixture, destination, assets: true });
    for (const [path, content] of [
      ["server.js", "server"],
      [".next/server/app.js", "app"],
      ["public/favicon.svg", "<svg/>"],
      [".next/static/chunks/main.js", "main"],
    ] as const) {
      expect(readFileSync(join(destination, path), "utf8")).toBe(content);
    }
  });

  test("without assets it is exactly the incomplete artifact the negative control needs", () => {
    const destination = scratch.project();
    artifact.composeArtifact({ fixture: built(), destination, assets: false });
    expect(() => readFileSync(join(destination, "public/favicon.svg"))).toThrow(/ENOENT/);
    expect(() => readFileSync(join(destination, ".next/static/chunks/main.js"))).toThrow(/ENOENT/);
    expect(readFileSync(join(destination, "server.js"), "utf8")).toBe("server");
  });

  test("keeps a relative link inside the artifact as it is", () => {
    const fixture = built();
    mkdirSync(join(fixture, ".next/standalone/node_modules/.pnpm/a"), { recursive: true });
    symlinkSync("./.pnpm/a", join(fixture, ".next/standalone/node_modules/linked"));
    const destination = scratch.project();
    artifact.composeArtifact({ fixture, destination, assets: true });
    expect(readlinkSync(join(destination, "node_modules/linked"))).toBe("./.pnpm/a");
    expect(readFileSync(join(destination, "node_modules/next/package.json"), "utf8")).toBe("{}");
  });
});
