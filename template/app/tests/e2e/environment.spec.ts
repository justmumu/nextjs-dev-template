import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { settled } from "./support";

// The harness builds with one set of values and starts the server with another, so what was fixed at
// build time and what the server reads at run time can be told apart. The values are compared only
// through booleans: a failing assertion must not print them.
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set: run this specification with \`pnpm run test:e2e\``);
  return value;
}

function clientFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? clientFiles(path) : [path];
  });
}

test("a public variable is fixed at build time; a server-only variable is read at run time and stays out of the client bundle", async ({ page }) => {
  const [buildPublic, buildServer, runtimePublic, runtimeServer] = ["E2E_BUILD_PUBLIC", "E2E_BUILD_SERVER", "E2E_RUNTIME_PUBLIC", "E2E_RUNTIME_SERVER"].map(
    required,
  );
  await page.goto("/fixture/env");
  await settled(page);
  expect((await page.getByTestId("public").textContent()) === buildPublic, "the public value shown is the build-time value").toBe(true);
  expect((await page.getByTestId("server").textContent()) === runtimeServer, "the server value shown is the run-time value").toBe(true);
  // A lookup by a computed name is not a documented way to read a public variable; whatever it yields, it is never the run-time value.
  expect((await page.getByTestId("dynamic").textContent()) === runtimePublic, "a dynamically indexed variable shows the run-time value").toBe(false);

  const client = clientFiles(join(required("E2E_FIXTURE_DIR"), ".next", "static"))
    .filter((path) => /\.(?:js|css|html|json)$/.test(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  expect(client.includes(buildPublic ?? ""), "the build-time public value is in the client bundle").toBe(true);
  for (const [name, value] of [
    ["the build-time server-only value", buildServer],
    ["the run-time server-only value", runtimeServer],
    ["the run-time public value", runtimePublic],
  ] as const) {
    expect(client.includes(value ?? ""), `${name} is in the client bundle`).toBe(false);
  }
});

test("the fixture was built from a staged copy with no local environment file", () => {
  expect(readdirSync(required("E2E_FIXTURE_DIR")).filter((name) => name.startsWith(".env"))).toEqual([]);
});
