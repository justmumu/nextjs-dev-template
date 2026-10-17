import { createServer, type Server } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import { afterEach, describe, expect, test } from "vitest";
import { scratchArea } from "../support/project.ts";

const require = createRequire(import.meta.url);
const owned = require("../../scripts/testing/owned.cjs") as typeof import("../../scripts/testing/owned.cjs");
const network = require("../../scripts/testing/network.cjs") as typeof import("../../scripts/testing/network.cjs");
const processes = require("../../scripts/core/process.cjs") as typeof import("../../scripts/core/process.cjs");

const scratch = scratchArea("owned-process-");
const cwd = scratch.project();

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

// A server that answers the nonce and spawns a grandchild into the same process group.
const SERVER = `
const http = require("node:http");
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
http.createServer((request, response) => {
  response.end(request.url === "/grandchild" ? String(grandchild.pid) : "nonce-1");
}).listen(Number(process.env.OWNED_PORT), "127.0.0.1");
`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function listen(server: Server | HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
    });
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          server.close(() => {
            done();
          });
        }),
    );
  });
}

const spec = (port: number, script: string, timeoutMs = 20_000) => ({
  command: process.execPath,
  args: ["-e", script],
  cwd,
  env: { ...process.env, OWNED_PORT: String(port) },
  url: `http://127.0.0.1:${String(port)}/`,
  expect: "nonce-1",
  timeoutMs,
});

describe("owned processes", () => {
  test("a server is started on its port, answers its nonce, and stopping it ends its whole process group", async () => {
    const port = await owned.freePort();
    const server = await owned.startOwned(spec(port, SERVER));
    const grandchild = Number(await (await fetch(`http://127.0.0.1:${String(port)}/grandchild`)).text());
    expect(alive(server.pid)).toBe(true);
    expect(alive(grandchild)).toBe(true);
    await server.stop();
    expect(await gone(server.pid)).toBe(true);
    expect(await gone(grandchild)).toBe(true);
  }, 60_000);

  test("a port held by an unrelated server is a failed start: the unrelated server keeps running and nothing of ours is left", async () => {
    const foreign = createHttpServer((_request, response) => {
      response.end("foreign server");
    });
    const port = await listen(foreign);
    await expect(owned.startOwned(spec(port, SERVER))).rejects.toThrow(/exited \(status 1\) before it answered[\s\S]*EADDRINUSE/);
    expect(await (await fetch(`http://127.0.0.1:${String(port)}/`)).text()).toBe("foreign server");
  }, 60_000);

  test("a command that fails at startup is reported with its output", async () => {
    const port = await owned.freePort();
    await expect(owned.startOwned(spec(port, 'console.error("cannot start: boom"); process.exit(3)'))).rejects.toThrow(
      /exited \(status 3\)[\s\S]*cannot start: boom/,
    );
  }, 60_000);

  test("a command that cannot be started at all is reported", async () => {
    const port = await owned.freePort();
    await expect(owned.startOwned({ ...spec(port, ""), command: "definitely-not-a-command-u10" })).rejects.toThrow(
      /exited \(status null\) before it answered|has no process group|ENOENT/,
    );
  }, 60_000);

  test("a server that never answers is stopped at the timeout together with what it started", async () => {
    const port = await owned.freePort();
    const silent = `
      const { spawn } = require("node:child_process");
      const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log("GRANDCHILD " + grandchild.pid);
      setInterval(() => {}, 1000);
    `;
    const started = Date.now();
    const failure = await owned.startOwned(spec(port, silent, 1_500)).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/did not answer/);
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = Number(/GRANDCHILD (\d+)/.exec(failure?.message ?? "")?.[1]);
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    expect(await gone(pid)).toBe(true);
  }, 60_000);

  test("a probe of a port nothing listens on answers nothing instead of failing, and one of a server answers its body", async () => {
    const closed = await owned.freePort();
    expect(await owned.realHost().probe(`http://127.0.0.1:${String(closed)}/`)).toBeNull();
    const server = createHttpServer((_request, response) => {
      response.end("body");
    });
    const open = await listen(server);
    expect(await owned.realHost().probe(`http://127.0.0.1:${String(open)}/`)).toBe("body");
  });

  test("a free port is a loopback port that can be bound", async () => {
    const port = await owned.freePort();
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    probe.close();
    expect(port).toBeGreaterThan(0);
  });
});

describe("a command run attached to the terminal", () => {
  test("reports the exit status, and no status for a command that could not start", () => {
    expect(processes.runInherited(process.execPath, ["-e", "process.exitCode = 4"], { cwd })).toEqual({ status: 4 });
    expect(processes.runInherited("definitely-not-a-command-u10", [], { cwd }).status).toBeNull();
  });
});

describe("network isolation", () => {
  const isolation = network.isolation();

  test("is either proved or explicitly unavailable with a reason", () => {
    expect(isolation.available ? "available" : isolation.reason).toMatch(/^available$|\S{10}/);
  });

  test.runIf(isolation.available)("a wrapped command cannot reach outward but still has loopback", () => {
    if (!isolation.available) return;
    const wrapped = isolation.wrap(process.execPath, [
      "-e",
      `
      const net = require("node:net");
      net.connect({ host: "192.0.2.1", port: 80 }).on("error", (error) => {
        const server = net.createServer((socket) => socket.end()).listen(0, "127.0.0.1", () => {
          net.connect(server.address().port, "127.0.0.1").on("connect", () => { console.log("outbound " + error.code + " loopback ok"); process.exit(0); });
        });
      }).on("connect", () => { console.log("outbound reachable"); process.exit(1); });
      `,
    ]);
    const result = processes.run(wrapped.command, wrapped.args, { cwd });
    expect(result.stdout.trim()).toMatch(/^outbound (?:ENETUNREACH|EHOSTUNREACH|ENETDOWN) loopback ok$/);
    expect(result.status).toBe(0);
  });
});
