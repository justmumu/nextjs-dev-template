import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { parseJson, type Manifest, type Versions } from "../support/json.ts";

const root = resolve(import.meta.dirname, "../..");
const toolchain = createRequire(import.meta.url)("../../scripts/core/toolchain.cjs") as typeof import("../../scripts/core/toolchain.cjs");

describe("exact runtime and manager", () => {
  const expected = toolchain.readExpected(root);

  test("accepts the pinned Node and pnpm", () => {
    expect(toolchain.checkEnvironment({ node: expected.node, pnpm: expected.pnpm }, expected)).toEqual([]);
  });

  test("rejects another Node or pnpm with the expected version in the message", () => {
    const errors = toolchain.checkEnvironment({ node: "24.0.0", pnpm: "11.0.0" }, expected);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain(expected.node);
    expect(errors[1]).toContain(expected.pnpm);
  });

  test("rejects a missing pnpm", () => {
    expect(toolchain.checkEnvironment({ node: expected.node, pnpm: null }, expected)[0]).toContain("pnpm");
  });
});

describe("single source of pins", () => {
  const versions = parseJson<Versions>(readFileSync(join(root, "tooling/versions.json"), "utf8"));
  const manifest = parseJson<Manifest>(readFileSync(join(root, "package.json"), "utf8"));

  test("root manifest, .node-version and engines project tooling/versions.json", () => {
    // Reviewed pins must hold; ordinary dependencies added with deps:add are free to appear next to them.
    expect(manifest.devDependencies).toMatchObject(versions.root.devDependencies);
    expect(manifest.packageManager).toBe(`pnpm@${versions.pnpm}`);
    expect(manifest.engines?.node).toBe(versions.node);
    expect(readFileSync(join(root, ".node-version"), "utf8").trim()).toBe(versions.node);
    expect(manifest.devEngines).toBeUndefined();
  });

  test("every pin is exact", () => {
    const all = { ...versions.root.devDependencies, ...versions.seed.dependencies, ...versions.seed.devDependencies };
    for (const [name, range] of Object.entries(all)) expect(range, name).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("workspace policy of both graphs", () => {
  const policy = createRequire(import.meta.url)("../../scripts/core/dependency-policy.cjs") as typeof import("../../scripts/core/dependency-policy.cjs");
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  test("the generator and the seed workspace files satisfy the policy and the seed denies the reviewed builds", () => {
    expect(policy.workspaceViolations(read("pnpm-workspace.yaml"), { reviewedBuilds: [] })).toEqual([]);
    expect(policy.workspaceViolations(read("template/app/pnpm-workspace.yaml"), { reviewedBuilds: [] })).toEqual([]);
    const versions = parseJson<Versions>(read("tooling/versions.json"));
    for (const name of versions.seed.deniedBuilds) expect(read("template/app/pnpm-workspace.yaml")).toContain(`${name}: false`);
  });
});

describe("commit identity", () => {
  const pattern = toolchain.readPolicy(root).commitIdentity.emailPattern;

  test("accepts GitHub noreply author and committer", () => {
    const entry = { rev: "a1", author: "1+someone@users.noreply.github.com", committer: "someone@users.noreply.github.com" };
    expect(toolchain.commitIdentityErrors([entry], pattern)).toEqual([]);
  });

  test("reports author and committer separately", () => {
    const entry = { rev: "b2", author: "me@example.com", committer: "me@example.com" };
    const errors = toolchain.commitIdentityErrors([entry], pattern);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/b2.*author/);
    expect(errors[1]).toMatch(/b2.*committer/);
  });

  test("no owner e-mail is stored in template manifests or state", () => {
    const tracked = [
      "package.json",
      ...readdirSync(join(root, "tooling"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join("tooling", relative(join(root, "tooling"), join(entry.parentPath, entry.name)))),
    ];
    expect(tracked.length).toBeGreaterThan(0);
    for (const file of tracked) {
      const emails = readFileSync(join(root, file), "utf8").match(/[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z][A-Za-z0-9-]*)+/g) ?? [];
      expect(emails, file).toEqual([]);
    }
  });
});

const REVIEWED_OVERRIDES = ["vitepress@1.6.4>@docsearch/js: 3.9.0", "vitepress@1.6.4>@docsearch/css: 3.9.0", "form-data@<2.5.0: 2.5.6", "qs@<6.6.0: 6.16.1"];

/** The indented entries of the top-level overrides block of a workspace file. */
function overrideBlock(workspace: string): string[] {
  const lines = workspace.split("\n");
  const start = lines.indexOf("overrides:");
  if (start < 0) return [];
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    entries.push(line.trim().replace(/^"([^"]+)":/, "$1:"));
  }
  return entries;
}

describe("isolated dependency graphs", () => {
  test("root graph is the generator only: no workspace members, links or unreviewed overrides", () => {
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    expect(lock).not.toMatch(/workspace:|link:\.\./);
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).not.toMatch(/^packages:/m);
    expect(overrideBlock(workspace)).toEqual(REVIEWED_OVERRIDES);
    expect(parseJson<Manifest>(readFileSync(join(root, "package.json"), "utf8")).private).toBe(true);
  });

  test("the seed workspace carries exactly the reviewed overrides and both locks encode them", () => {
    const seedWorkspace = readFileSync(join(root, "template/app/pnpm-workspace.yaml"), "utf8");
    expect(overrideBlock(seedWorkspace)).toEqual(REVIEWED_OVERRIDES);
    for (const lockFile of ["pnpm-lock.yaml", "template/app/pnpm-lock.yaml"]) {
      const lock = readFileSync(join(root, lockFile), "utf8");
      expect(overrideBlock(lock), lockFile).toEqual(REVIEWED_OVERRIDES);
      expect(lock, lockFile).not.toMatch(/\/@docsearch\/(?:js|css)@3\.8\./);
    }
  });
});
