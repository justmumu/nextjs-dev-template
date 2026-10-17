import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { scratchArea } from "../support/project.ts";

// The startup smoke against a real process group: a stand-in for `next start` at the path the smoke
// starts, so that no installed application is needed to prove what the smoke does with a real server.
const require = createRequire(import.meta.url);
const { smoke, NEXT, assetOf } = require("../../scripts/template/smoke.cjs") as typeof import("../../scripts/template/smoke.cjs");
const owned = require("../../scripts/testing/owned.cjs") as typeof import("../../scripts/testing/owned.cjs");
const { createCancellation } = owned;

const scratch = scratchArea("template-smoke-");
const realFetch = async (url: string) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return { ok: response.ok, text: await response.text() };
  } catch {
    return null;
  }
};

const STAND_IN = `
const http = require("node:http");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const mode = fs.readFileSync("mode", "utf8").trim();
if (mode === "exit") process.exit(3);
if (mode === "mute") {
  fs.writeFileSync("pids.json", JSON.stringify({ server: process.pid, grandchild: process.pid, args: process.argv.slice(2) }));
  setInterval(() => {}, 1000);
  return;
}
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync("pids.json", JSON.stringify({ server: process.pid, grandchild: grandchild.pid, args: process.argv.slice(2) }));
http.createServer((request, response) => {
  // The nonce asset is served from public/ as a production server does; the pages answer as the mode says.
  const asset = /^\\/(template-smoke-[^/]+\\.txt)$/.exec(request.url);
  if (asset && fs.existsSync("public/" + asset[1])) {
    response.setHeader("content-type", "text/plain");
    response.end(fs.readFileSync("public/" + asset[1]));
    return;
  }
  response.statusCode = mode === "broken" ? 500 : 200;
  response.setHeader("content-type", "text/html");
  response.end(mode === "silent" ? "{}" : "<!DOCTYPE html><html><body>ok</body></html>");
}).listen(Number(process.argv[process.argv.indexOf("--port") + 1]), "127.0.0.1");
`;

const NONCE = "5d1e-run-nonce";

function app(mode: string): string {
  const dir = scratch.project();
  mkdirSync(join(dir, "public"), { recursive: true });
  writeFileSync(join(dir, "public", assetOf(NONCE)), NONCE);
  mkdirSync(join(dir, NEXT, ".."), { recursive: true });
  writeFileSync(join(dir, NEXT), STAND_IN);
  writeFileSync(join(dir, "mode"), mode);
  return dir;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  for (let attempt = 0; attempt < 50 && alive(pid); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  return !alive(pid);
};
const pidsOf = (dir: string) => JSON.parse(readFileSync(join(dir, "pids.json"), "utf8")) as { server: number; grandchild: number; args: string[] };

describe("the startup smoke with a real server process", () => {
  test("an HTML page answers on loopback, and the server and what it started are gone afterwards", async () => {
    const dir = app("ok");
    expect(await smoke({ cwd: dir, env: process.env, cancel: createCancellation(), nonce: NONCE, timeoutMs: 20_000 })).toBeNull();
    const pids = pidsOf(dir);
    expect(pids.args.slice(0, 1)).toEqual(["start"]);
    expect(pids.args).toContain("127.0.0.1");
    expect(await gone(pids.server)).toBe(true);
    expect(await gone(pids.grandchild)).toBe(true);
  }, 60_000);

  test.each([
    ["a server that answers an error page", "broken", /page http:\/\/127\.0\.0\.1:\d+\/ is not a successful HTML document/],
    ["a server that answers something other than a page", "silent", /page http:\/\/127\.0\.0\.1:\d+\/ is not a successful HTML document/],
    ["a server that exits at once", "exit", /exited \(status 3\) before it answered/],
  ])(
    "%s fails the smoke and leaves nothing running",
    async (_name, mode, message) => {
      const dir = app(mode);
      expect(await smoke({ cwd: dir, env: process.env, cancel: createCancellation(), nonce: NONCE, timeoutMs: 1_500 })).toMatch(message);
      if (existsSync(join(dir, "pids.json"))) {
        const pids = pidsOf(dir);
        expect(await gone(pids.server)).toBe(true);
        expect(await gone(pids.grandchild)).toBe(true);
      }
    },
    60_000,
  );

  test("an unrelated HTML listener on the port is not taken for the server: a launched process that never binds fails the smoke and the listener is left alone", async () => {
    const dir = app("mute");
    let hits = 0;
    const listener = createServer((_request, response) => {
      hits += 1;
      response.setHeader("content-type", "text/html");
      response.end("<!DOCTYPE html><html><body>somebody else</body></html>");
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    try {
      const port = (listener.address() as AddressInfo).port;
      const servers = { port: () => Promise.resolve(port), start: owned.startOwned, fetchPage: realFetch };
      const problem = await smoke({ cwd: dir, env: process.env, cancel: createCancellation(), nonce: NONCE, timeoutMs: 1_500, servers });
      expect(problem).toMatch(/did not answer .* within 1500 ms/);
      expect(await gone(pidsOf(dir).server)).toBe(true);
      const before = hits;
      const page = await fetch(`http://127.0.0.1:${String(port)}/`);
      expect(await page.text()).toContain("somebody else");
      expect(hits).toBe(before + 1);
    } finally {
      await new Promise<void>((resolve) =>
        listener.close(() => {
          resolve();
        }),
      );
      if (existsSync(join(dir, "pids.json"))) {
        try {
          process.kill(pidsOf(dir).server, "SIGKILL");
        } catch {
          // Already gone, as it should be.
        }
      }
    }
  }, 60_000);

  test("a missing application fails the smoke", async () => {
    const dir = scratch.project();
    expect(await smoke({ cwd: dir, env: process.env, cancel: createCancellation(), nonce: NONCE, timeoutMs: 1_500 })).toMatch(
      /exited \(status 1\)|did not answer/,
    );
  }, 60_000);

  test("an interruption while the server starts stops it and fails the smoke", async () => {
    const dir = app("broken");
    const cancel = createCancellation();
    const running = smoke({ cwd: dir, env: process.env, cancel, nonce: NONCE, timeoutMs: 20_000 });
    for (let attempt = 0; attempt < 100 && !existsSync(join(dir, "pids.json")); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    const pids = pidsOf(dir);
    cancel.cancel("SIGINT");
    expect(await running).toMatch(/interrupted/);
    expect(await gone(pids.server)).toBe(true);
    expect(await gone(pids.grandchild)).toBe(true);
  }, 60_000);

  test("a run that was interrupted before it started starts no server", async () => {
    const dir = app("ok");
    const cancel = createCancellation();
    cancel.cancel("SIGTERM");
    expect(await smoke({ cwd: dir, env: process.env, cancel, nonce: NONCE })).toMatch(/not started: the run was interrupted/);
    expect(existsSync(join(dir, "pids.json"))).toBe(false);
  }, 60_000);
});
