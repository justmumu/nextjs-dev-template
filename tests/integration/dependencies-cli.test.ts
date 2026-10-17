import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture, roleFiles, scratchArea } from "../support/project.ts";

const dependencies = createRequire(import.meta.url)("../../scripts/dependencies.cjs") as typeof import("../../scripts/dependencies.cjs");
const state = createRequire(import.meta.url)("../../scripts/core/install-state.cjs") as typeof import("../../scripts/core/install-state.cjs");
type Runner = import("../../scripts/core/transaction.cjs").Runner;
const scratch = scratchArea("dependencies-cli-");

const manifest = (devDependencies: Record<string, string>, dependencies: Record<string, string> = {}) =>
  JSON.stringify({ name: "fixture", private: true, packageManager: "pnpm@12.14.0", dependencies, devDependencies });

function project(role: "generator" | "application", files: Record<string, string> = {}) {
  return scratch.project({ ...roleFiles(role), "tooling/capabilities.json": '{"guard":false,"hooks":false}', ...files });
}

const run = (root: string, argv: string[], runner?: Runner) => {
  const sink = capture();
  const status = dependencies.main(argv, { root, io: sink.io, ...(runner ? { runner } : {}) });
  return { status, out: sink.out(), err: sink.err() };
};

describe("request grammar", () => {
  test("a malformed request prints the usage and changes nothing", () => {
    const root = project("application");
    for (const argv of [[], ["install"], ["add"], ["add", "--package=x", "--group=dev", "--force=1"], ["remove", "--package=x@1.0.0", "--group=dev"]]) {
      const result = run(root, argv);
      expect(result.status, argv.join(" ")).toBe(2);
      expect(result.err).toMatch(/usage: pnpm run deps:add/);
    }
  });
});

describe("refusals before the package manager runs", () => {
  test("a node or manager mismatch stops the command", () => {
    const root = project("application", { ".node-version": "1.0.0\n" });
    const result = run(root, ["add", "--package=left-pad", "--group=dev"]);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/Node 1\.0\.0 is required/);
  });

  test("an unresolved guard state stops the command", () => {
    const root = project("application", {
      "tooling/capabilities.json": '{"guard":true,"hooks":false}',
      "scripts/hooks/state.cjs": 'exports.status = () => ({ clean: false, reason: "pending reservation" });',
    });
    expect(run(root, ["upgrade"]).err).toMatch(/pending reservation/);
  });

  test("an incomplete install must be repaired first", () => {
    const root = project("application");
    state.markDirty(root, "earlier failure");
    expect(run(root, ["upgrade"]).err).toMatch(/incomplete.*bootstrap\.cjs repair/);
  });

  describe("reviewed tool pins of the generator", () => {
    const generator = () =>
      project("generator", {
        "package.json": manifest({ vitest: "5.0.5", eslint: "9.39.5" }, { other: "1.0.0" }),
        "tooling/versions.json": JSON.stringify({ root: { reviewedTools: ["vitest", "eslint"] } }),
      });

    test("a pin cannot be added, removed or upgraded through the dependency commands", () => {
      const root = generator();
      expect(run(root, ["add", "--package=vitest@5.0.6", "--group=dev"]).err).toMatch(/vitest is a reviewed tool pin \(5\.0\.5\)/);
      expect(run(root, ["remove", "--package=vitest", "--group=dev"]).err).toMatch(/reviewed tool pin/);
      expect(run(root, ["upgrade", "--package=eslint"]).err).toMatch(/upgrading it is a reviewed tooling change/);
    });

    test("a reviewed manifest change is reflected without changing the reviewed-name file", () => {
      const fixture = generator();
      const metadata = readFileSync(join(fixture, "tooling/versions.json"), "utf8");
      writeFileSync(join(fixture, "package.json"), manifest({ vitest: "5.0.6", eslint: "9.39.5", ordinary: "1.0.0" }));
      expect(dependencies.reviewedPins(fixture)).toEqual({ vitest: "5.0.6", eslint: "9.39.5" });
      expect(readFileSync(join(fixture, "tooling/versions.json"), "utf8")).toBe(metadata);
    });

    test("collateral changes to a reviewed tool roll back against its pre-transaction manifest version", () => {
      const root = generator();
      writeFileSync(join(root, "package.json"), manifest({ vitest: "5.0.6", eslint: "9.39.5" }, { other: "1.0.0" }));
      const before = readFileSync(join(root, "package.json"), "utf8");
      const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
      const result = run(root, ["upgrade", "--package=other"], () => {
        writeFileSync(join(root, "package.json"), manifest({ vitest: "5.0.7", eslint: "9.39.5" }, { other: "1.0.1" }));
        return { status: 0, stdout: "", stderr: "" };
      });
      expect(result.status).toBe(1);
      expect(result.err).toContain("reviewed tool pin (5.0.6)");
      expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
      expect(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")).toBe(lock);
    });

    test("an all-dependency upgrade is refused as a whole while any pin is a dependency", () => {
      const result = run(generator(), ["upgrade"]);
      expect(result.status).toBe(1);
      expect(result.err).toMatch(/eslint@9\.39\.5, vitest@5\.0\.5/);
      expect(result.err).toMatch(/Nothing was changed/);
    });

    test("an application has no pins, even when it carries a versions file", () => {
      const root = project("application", { "tooling/versions.json": "not JSON: an application must not read this generator file" });
      expect(dependencies.reviewedPins(root)).toEqual({});
      expect(dependencies.reviewedPins(generator())).toEqual({ vitest: "5.0.5", eslint: "9.39.5" });
      expect(dependencies.reviewedPins(project("generator"))).toEqual({});
    });
  });
});

describe("a rejected change", () => {
  test("restores the manifest, marks the install incomplete and reports the violations and the needed build review", () => {
    const root = project("application", { "package.json": manifest({}) });
    const original = readFileSync(join(root, "package.json"), "utf8");
    const result = run(root, ["add", "--package=left-pad@1.3.0", "--group=dev"], () => {
      writeFileSync(join(root, "package.json"), manifest({ "left-pad": "1.3.0", sneaky: "1.0.0" }));
      return { status: 0, stdout: "Ignored build scripts: sneaky@1.0.0\n", stderr: "" };
    });
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/dependency change rejected/);
    expect(result.err).toMatch(/need a reviewed build decision.*sneaky@1\.0\.0/);
    expect(result.err).toMatch(/node scripts\/bootstrap\.cjs repair/);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(original);
    expect(state.dirtyReason(root)).toMatch(/rejected/);
  });

  test("a package manager that fails is a failure, not a success", () => {
    const root = project("application", { "package.json": manifest({}) });
    const result = run(root, ["upgrade", "--package=left-pad"], () => ({ status: 1, stdout: "", stderr: "ERR_PNPM_NO_MATCHING_VERSION\n" }));
    expect(result.status).toBe(1);
    expect(state.dirtyReason(root)).toMatch(/failed/);
  });
});

describe("request planning", () => {
  test("only an exact version in the request is demanded back from the manifest", () => {
    const exact = dependencies.requestFromArgv("add", ["--package=x@1.2.3", "--group=prod"]);
    const tagged = dependencies.requestFromArgv("add", ["--package=x@next", "--group=prod"]);
    expect(dependencies.planFor(exact)).toMatchObject({ action: "add", group: "prod", name: "x", version: "1.2.3" });
    expect(dependencies.planFor(tagged)).toMatchObject({ action: "add", version: null });
    expect(dependencies.planFor(dependencies.requestFromArgv("remove", ["--package=x", "--group=dev"]), { y: "1.0.0" })).toEqual({
      action: "remove",
      group: "dev",
      name: "x",
      pinned: { y: "1.0.0" },
    });
    expect(dependencies.planFor(dependencies.requestFromArgv("upgrade", ["--package=x"]))).toMatchObject({ action: "upgrade", name: "x" });
  });
});
