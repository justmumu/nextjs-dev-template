import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

// The decisions of the startup smoke, judged with a fake server owner. A real production server is
// started in tests/integration/template-smoke.test.ts.
const require = createRequire(import.meta.url);
const { smoke, NEXT, assetOf } = require("../../scripts/template/smoke.cjs") as typeof import("../../scripts/template/smoke.cjs");
const { createCancellation } = require("../../scripts/testing/owned.cjs") as typeof import("../../scripts/testing/owned.cjs");

type Servers = NonNullable<Parameters<typeof smoke>[0]["servers"]>;
type Spec = Parameters<Servers["start"]>[0];

const NONCE = "0b1f-nonce";
const ASSET = `http://127.0.0.1:4321/${assetOf(NONCE)}`;

/** `page` is what the application's page answers; `asset` what the nonce asset answers (the owned server's own by default). */
function servers(
  page: { ok: boolean; text: string } | null,
  over: { stopFails?: boolean; startFails?: string; asset?: { ok: boolean; text: string } | null } = {},
) {
  const log: string[] = [];
  const asset = "asset" in over ? over.asset : { ok: true, text: NONCE };
  const fake: Servers = {
    port: () => Promise.resolve(4321),
    fetchPage: (url) => {
      log.push(`fetch ${url.replace("http://127.0.0.1:4321", "")}`);
      return Promise.resolve(url === ASSET ? asset : page);
    },
    start: async (spec: Spec, host) => {
      log.push(`start ${spec.command === process.execPath ? "node" : spec.command} ${spec.args.slice(1).join(" ")} in ${spec.cwd} expecting ${spec.expect}`);
      if (over.startFails) throw new Error(over.startFails);
      const answer = await host?.probe(spec.url);
      if (answer !== spec.expect) throw new Error(`nothing answered ${spec.url}`);
      return {
        pid: 1,
        log: () => "",
        stop: () => {
          log.push("stop");
          return over.stopFails ? Promise.reject(new Error("still running")) : Promise.resolve();
        },
      };
    },
  };
  return { fake, log };
}

const run = (fake: Servers) => smoke({ cwd: "/app", env: {}, cancel: createCancellation(), nonce: NONCE, servers: fake });

describe("the startup smoke", () => {
  test("starts the application's own production server on loopback, takes it for the owned one by its nonce asset, then requires the HTML page and stops it", async () => {
    const { fake, log } = servers({ ok: true, text: "<!DOCTYPE html><html lang=en><body>hi</body></html>" });
    expect(await run(fake)).toBeNull();
    expect(NEXT).toBe("node_modules/next/dist/bin/next");
    expect(assetOf(NONCE)).toBe("template-smoke-0b1f-nonce.txt");
    expect(log).toEqual([`start node start --hostname 127.0.0.1 --port 4321 in /app expecting ${NONCE}`, `fetch /${assetOf(NONCE)}`, "fetch /", "stop"]);
  });

  test("any HTML on the port is not the owned server: without the nonce nothing counts as started, whatever the page says", async () => {
    const { fake, log } = servers(
      { ok: true, text: "<html>an unrelated listener</html>" },
      { asset: { ok: true, text: "<html>an unrelated listener</html>" } },
    );
    expect(await run(fake)).toMatch(/nothing answered/);
    expect(log).not.toContain("fetch /");
    expect(log).not.toContain("stop");
  });

  test("the owned server must also answer the application's page: an error, a non-page or no answer is a problem, and the server is still stopped", async () => {
    for (const page of [{ ok: false, text: "<html>" }, { ok: true, text: '{"a":1}' }, null]) {
      const { fake, log } = servers(page);
      expect(await run(fake)).toMatch(/page http:\/\/127\.0\.0\.1:4321\/ is not a successful HTML document/);
      expect(log.at(-1)).toBe("stop");
    }
  });

  test("a server that does not start is a problem with its reason", async () => {
    const { fake, log } = servers(null, { startFails: "exited (status 1) before it answered" });
    expect(await run(fake)).toBe("exited (status 1) before it answered");
    expect(log).not.toContain("stop");
  });

  test("a server that cannot be stopped fails the smoke even though it answered", async () => {
    expect(await run(servers({ ok: true, text: "<html>" }, { stopFails: true }).fake)).toMatch(/could not be stopped: still running/);
  });
});
