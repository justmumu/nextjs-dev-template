import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { childEnv, installRenderedApp, output, removeDir, run, scratchDir, writeProjectFile } from "../support/rendered-app.ts";

const scratch = scratchDir("next-generated-");
afterAll(() => {
  removeDir(scratch);
});

const PROTECTED = ["AGENTS.md", "CLAUDE.md", "tsconfig.json", "tsconfig.tooling.json", "next.config.ts", "eslint.config.mjs", "package.json", ".gitignore"];
const hashes = (dir: string) =>
  Object.fromEntries(
    PROTECTED.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(dir, file)))
        .digest("hex"),
    ]),
  );
const next = (dir: string, args: string[]) => run(dir, process.execPath, [join(dir, "node_modules/next/dist/bin/next"), ...args]);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

async function devServerSees(dir: string): Promise<string> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [join(dir, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: dir,
      env: { ...childEnv, CLAUDECODE: "1", AI_AGENT: "claude-code" },
      stdio: "ignore",
    },
  );
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) return await response.text();
      } catch {
        // server not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("dev server did not answer");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

let app = "";
beforeAll(() => {
  app = installRenderedApp(scratch, "generated-app");
  writeProjectFile(app, "AGENTS.md", "# Rules\n\nRead the Next docs in node_modules/next/dist/docs/ for the installed version.\n");
  writeProjectFile(app, "CLAUDE.md", "@AGENTS.md\n");
}, 180_000);

describe("real Next generated files", () => {
  test("typegen, typecheck, dev and production build leave protected files byte-identical", async () => {
    const before = hashes(app);
    expect(existsSync(join(app, ".next"))).toBe(false);
    expect(existsSync(join(app, "next-env.d.ts"))).toBe(false);
    const typecheck = run(app, "pnpm", ["run", "typecheck"]);
    expect(output(typecheck)).not.toMatch(/error/i);
    expect(typecheck.status).toBe(0);
    expect(hashes(app)).toEqual(before);
    const html = await devServerSees(app);
    expect(html).toMatch(/<h1/);
    expect(hashes(app)).toEqual(before);
    const build = next(app, ["build"]);
    expect(output(build)).toContain("Compiled successfully");
    expect(build.status).toBe(0);
    expect(hashes(app)).toEqual(before);
  }, 360_000);

  test("generated Next files are ignored by Git", () => {
    const ignore = readFileSync(join(app, ".gitignore"), "utf8");
    for (const pattern of [".next/", "next-env.d.ts"]) expect(ignore).toContain(pattern);
  });

  test("a mistyped route fails typecheck", () => {
    writeProjectFile(
      app,
      "src/app/bad-link.tsx",
      'import Link from "next/link";\n\nexport function BadLink() {\n  return <Link href="/does-not-exist">Nowhere</Link>;\n}\n',
    );
    const result = run(app, "pnpm", ["run", "typecheck"]);
    expect(result.status).not.toBe(0);
    expect(output(result)).toMatch(/bad-link\.tsx.*TS2769/s);
    rmSync(join(app, "src/app/bad-link.tsx"));
  }, 120_000);

  test("a server-only module reached from a client component fails the production build", () => {
    writeProjectFile(app, "src/fixture/secret.ts", 'import "server-only";\n\nexport const secret = "server";\n');
    writeProjectFile(
      app,
      "src/fixture/client.tsx",
      '"use client";\n\nimport { secret } from "./secret";\n\nexport function Leak() {\n  return <p>{secret}</p>;\n}\n',
    );
    writeProjectFile(app, "src/app/leak/page.tsx", 'import { Leak } from "../../fixture/client";\n\nexport default function Page() {\n  return <Leak />;\n}\n');
    const build = next(app, ["build"]);
    expect(build.status).not.toBe(0);
    expect(output(build)).toMatch(/server-only|Server Components/);
    for (const path of ["src/fixture", "src/app/leak"]) rmSync(join(app, path), { recursive: true });
  }, 240_000);
});
