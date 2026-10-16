import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, test } from "vitest";
import { parseJson, type Listed } from "../support/json.ts";

const render = createRequire(import.meta.url)("../../scripts/template/render.cjs") as typeof import("../../scripts/template/render.cjs");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "rendered-install-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function pnpm(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("pnpm", args, { cwd, env, encoding: "utf8", timeout: 170_000 });
}

describe("rendered seeds install frozen against the reviewed lock", () => {
  for (const answers of [
    { name: "first-app", description: 'quote " and \\', owner: "first-owner" },
    { name: "@scope/second-app", version: "3.4.5" },
  ]) {
    test(`frozen install succeeds for ${answers.name}`, () => {
      const { manifest, bases } = render.defaultInputs();
      const { files } = render.renderTree({ manifest, bases, answers });
      const dest = join(scratch, answers.name.replace(/\W/g, "_"));
      render.writeTree(files, dest);
      const install = pnpm(dest, ["install", "--frozen-lockfile", "--config.strict-peer-dependencies=true", "--config.engine-strict=true"]);
      expect(install.stderr + install.stdout).not.toMatch(/ERR_PNPM|ignored build/i);
      expect(install.status).toBe(0);
      const listed = parseJson<Listed[]>(pnpm(dest, ["list", "--depth", "-1", "--json"]).stdout);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.path).toBe(dest);
      expect(listed[0]?.name).toBe(answers.name);
    });
  }
});

describe("cold store", () => {
  test("frozen install from an empty store and cache needs no release-age exemption", () => {
    const { manifest, bases } = render.defaultInputs();
    const { files } = render.renderTree({ manifest, bases, answers: { name: "cold-app" } });
    const dest = join(scratch, "cold-app");
    render.writeTree(files, dest);
    const cold = join(scratch, "cold");
    mkdirSync(cold);
    const env = {
      ...process.env,
      XDG_CACHE_HOME: join(cold, "cache"),
      XDG_DATA_HOME: join(cold, "data"),
      XDG_STATE_HOME: join(cold, "state"),
      pnpm_config_store_dir: join(cold, "store"),
    };
    const install = pnpm(dest, ["install", "--frozen-lockfile", "--config.strict-peer-dependencies=true", "--config.engine-strict=true"], env);
    expect(install.stderr + install.stdout).not.toMatch(/ERR_PNPM|ignored build|minimumReleaseAge/i);
    expect(install.status).toBe(0);
    expect(readFileSync(join(dest, "pnpm-workspace.yaml"), "utf8")).not.toMatch(/minimumReleaseAge/);
    expect(readFileSync(join(dest, "pnpm-lock.yaml"), "utf8")).not.toMatch(/minimumReleaseAge/);
  });
});
