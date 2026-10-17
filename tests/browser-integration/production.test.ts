import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { installRenderedApp, output, removeDir, run, scratchDir } from "../support/rendered-app.ts";

// The real harnesses against a rendered application: a production build, a server, real browsers and a
// relocated standalone artifact. They need the project's dependencies and Playwright's browsers installed
// beforehand (`docs/contributing/production-tests.md`); the build itself needs no network.
const scratch = scratchDir("production-proof-");
afterAll(() => {
  removeDir(scratch);
});

const HARNESS_DIRECTORIES = /^(?:production-fixture|artifact-fixture|artifact-complete|artifact-incomplete|rendered-app)-/;
const leftovers = () => new Set(readdirSync(tmpdir()).filter((name) => HARNESS_DIRECTORIES.test(name)));
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const refused = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(true);
    });
  });

let app = "";
beforeAll(() => {
  app = installRenderedApp(scratch, "production-app");
}, 240_000);

describe("production browser proof", () => {
  test.each(["test:e2e", "test:artifact"])(
    "%s preserves a PostCSS configuration and its local imports",
    (command) => {
      const before = leftovers();
      mkdirSync(join(app, "config/css"), { recursive: true });
      writeFileSync(join(app, "postcss.config.mjs"), 'export { default } from "./config/css/pipeline.mjs";\n');
      writeFileSync(join(app, "config/css/pipeline.mjs"), 'import "./sentinel.mjs";\nexport default { plugins: {} };\n');
      writeFileSync(join(app, "config/css/sentinel.mjs"), 'throw new Error("POSTCSS_PROJECT_INPUT_SENTINEL");\n');
      try {
        const result = run(app, "pnpm", ["run", command], 600_000);
        const text = output(result);
        expect(result.status, text).toBe(1);
        expect(text).toContain("POSTCSS_PROJECT_INPUT_SENTINEL");
        expect(text).toContain("build: the production build failed");
        expect(text).not.toMatch(/server: next start owned|artifact: relocated/);
        expect([...leftovers()].filter((name) => !before.has(name))).toEqual([]);
      } finally {
        rmSync(join(app, "postcss.config.mjs"));
        rmSync(join(app, "config"), { recursive: true });
      }
    },
    700_000,
  );

  test("passes in a hostile environment, uses its own server and leaves the project and the machine as it found them", async () => {
    // A local environment file and the caller's own test-mode variables must not change the result.
    writeFileSync(join(app, ".env.local"), "NEXT_PUBLIC_LOCAL_SENTINEL=local-env-sentinel\nFIXTURE_SERVER_ONLY=from-local-file\n");
    const before = leftovers();
    const result = run(app, "pnpm", ["run", "test:e2e"], 600_000, {
      NODE_ENV: "test",
      NEXT_PUBLIC_FIXTURE_PUBLIC: "caller-public-value",
      FIXTURE_SERVER_ONLY: "caller-server-value",
      PORT: "1",
      HOSTNAME: "nowhere.invalid",
    });
    const text = output(result);
    expect(result.status, text).toBe(0);
    expect(text).toMatch(/no outbound network \(loopback only\)|offline proof unavailable \(.+\); this run is not an offline proof/);
    expect(text).toMatch(/passed/);
    for (const value of ["build-time-server-only-value", "runtime-server-only-value", "local-env-sentinel", "caller-server-value"])
      expect(text).not.toContain(value);
    const port = Number(/next start owned by this run on http:\/\/127\.0\.0\.1:(\d+)/.exec(text)?.[1]);
    expect(Number.isInteger(port)).toBe(true);
    expect(await refused(port)).toBe(true);
    expect([...leftovers()].filter((name) => !before.has(name))).toEqual([]);
    // The build happened in the fixture: the project itself has no production build or generated type file.
    expect(existsSync(join(app, ".next"))).toBe(false);
    expect(existsSync(join(app, "next-env.d.ts"))).toBe(false);
  }, 700_000);

  test("cannot be narrowed to fewer browser lanes from the environment", () => {
    const listed = run(app, process.execPath, [join(app, "node_modules/@playwright/test/cli.js"), "test", "--list"], 120_000, {
      E2E_BASE_URL: "http://127.0.0.1:9",
      E2E_BROWSERS: "chromium-desktop",
    });
    const text = output(listed);
    expect(listed.status, text).toBe(0);
    for (const lane of ["chromium-desktop", "chromium-mobile", "webkit-smoke"]) expect(text, lane).toContain(`[${lane}]`);
  }, 180_000);

  test("stops with the prerequisite, before staging anything, when offline isolation cannot be proved", () => {
    const before = leftovers();
    // A PATH with only Node: no unshare, so the namespace proof is impossible.
    for (const script of ["production", "artifact"]) {
      const result = run(app, process.execPath, [join(app, `scripts/testing/${script}.cjs`)], 120_000, { PATH: dirname(process.execPath) });
      const text = output(result);
      expect(result.status, text).toBe(1);
      expect(text, script).toMatch(/offline build proof unavailable: unshare is not installed/);
      expect(text, script).toMatch(/do not pass without that proof/);
      expect(text, script).not.toMatch(/fixture: staged|build:|passed|artifact: relocated/);
    }
    expect([...leftovers()].filter((name) => !before.has(name))).toEqual([]);
  }, 240_000);

  test("catches a missing skip link and a missing document language", () => {
    const layout = join(app, "src/app/layout.tsx");
    const original = readFileSync(layout, "utf8");
    try {
      writeFileSync(layout, original.replace('<html lang="en">', "<html>").replace(/<a className="skip-link"[\s\S]*?<\/a>\n/, ""));
      const result = run(app, "pnpm", ["run", "test:e2e"], 600_000);
      const text = output(result);
      expect(result.status, text).toBe(1);
      expect(text).toMatch(/keyboard reaches the skip link first/);
      expect(text).toMatch(/accessibility violations/);
      expect(text).toMatch(/browser suite failed/);
    } finally {
      writeFileSync(layout, original);
    }
  }, 700_000);

  test("every run path refuses a managed Next.js agent block and leaves the file alone", () => {
    const agents = join(app, "AGENTS.md");
    const original = readFileSync(agents, "utf8");
    const managed = `${original}\n<!-- BEGIN:nextjs-agent-rules -->\nmanaged\n<!-- END:nextjs-agent-rules -->\n`;
    writeFileSync(agents, managed);
    const digest = sha(agents);
    try {
      for (const command of ["dev", "build", "start", "typecheck", "test:e2e", "test:artifact"]) {
        const result = run(app, "pnpm", ["run", command], 120_000);
        expect(result.status, command).toBe(1);
        expect(output(result), command).toMatch(/AGENTS\.md contains the Next\.js agent rules block/);
        expect(sha(agents), command).toBe(digest);
      }
      expect(existsSync(join(app, ".next"))).toBe(false);
    } finally {
      writeFileSync(agents, original);
    }
  }, 240_000);
});

describe("standalone artifact proof", () => {
  test("serves its static and public assets from outside the project without development-only dependencies, and notices missing assets", () => {
    const before = leftovers();
    const result = run(app, "pnpm", ["run", "test:artifact"], 600_000, { NODE_ENV: "test", PORT: "1" });
    const text = output(result);
    expect(result.status, text).toBe(0);
    expect(text).toMatch(/relocated outside the project, served with its static and public assets, no development-only dependency present/);
    expect(text).toMatch(/negative control detected \d+ missing asset/);
    expect([...leftovers()].filter((name) => !before.has(name))).toEqual([]);
  }, 700_000);
});

describe("the generator's route to the same proofs", () => {
  test("renders an application, installs it, proves its artifact and removes it", () => {
    const before = leftovers();
    const result = run(process.cwd(), "pnpm", ["run", "test:artifact"], 900_000);
    const text = output(result);
    expect(result.status, text).toBe(0);
    expect(text).toMatch(/negative control detected \d+ missing asset/);
    expect([...leftovers()].filter((name) => !before.has(name))).toEqual([]);
  }, 1_000_000);
});
