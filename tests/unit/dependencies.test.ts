import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

const dependencies = createRequire(import.meta.url)("../../scripts/dependencies.cjs") as typeof import("../../scripts/dependencies.cjs");
type Options = NonNullable<Parameters<typeof dependencies.main>[1]>;
type Host = NonNullable<Options["host"]>;
type Result = ReturnType<Host["transact"]>;

const accepted: Result = { ok: true, status: 0, violations: [], output: "pnpm output\n", restored: false };

/** A project on which nothing stands in the way; a test overrides the one thing that does. */
function project(overrides: Partial<Host> = {}) {
  const transactions: Parameters<Host["transact"]>[0][] = [];
  const host: Host = {
    gateErrors: () => [],
    guardRefusal: () => null,
    pins: () => ({}),
    dependencies: () => [],
    transact: (options) => {
      transactions.push(options);
      return accepted;
    },
    ...overrides,
  };
  return { host, transactions };
}

function run(argv: string[], host: Host) {
  const sink = capture();
  const status = dependencies.main(argv, { root: "/p", io: sink.io, host });
  return { status, out: sink.out(), err: sink.err() };
}

describe("request grammar", () => {
  test("a malformed request prints the usage and changes nothing", () => {
    for (const argv of [[], ["install"], ["add"], ["add", "--package=x", "--group=dev", "--force=1"], ["remove", "--package=x@1.0.0", "--group=dev"]]) {
      const { host, transactions } = project();
      const result = run(argv, host);
      expect(result.status, argv.join(" ")).toBe(2);
      expect(result.err).toMatch(/usage: pnpm run deps:add/);
      expect(transactions).toEqual([]);
    }
  });

  test.each(["x y", "x@^1.0.0", "x@https://evil.example/x.tgz", "https://evil.example/x.tgz", "x@npm:other@1.0.0", "./x", "../x"])(
    "%s is not a literal package",
    (spec) => {
      expect(() => dependencies.parseSpec(spec)).toThrow(/unsupported/);
    },
  );

  test.each(["--global", "-g", "-D", "--global@1.0.0", "-g@latest", "--package=x"])(
    "%s is an option, not a package: no action sends it to the package manager",
    (value) => {
      for (const argv of [
        ["add", `--package=${value}`, "--group=dev"],
        ["add", `--package=${value}`, "--group=prod"],
        ["remove", `--package=${value}`, "--group=dev"],
        ["upgrade", `--package=${value}`],
      ]) {
        const { host, transactions } = project();
        const result = run(argv, host);
        expect(result.status, argv.join(" ")).toBe(2);
        expect(result.err).toMatch(/unsupported package name/);
        expect(transactions).toEqual([]);
      }
    },
  );

  test("an option-shaped value never reaches pnpm through the request boundary", () => {
    for (const argv of [
      ["add", "--package=--global", "--group=dev"],
      ["remove", "--package=--global", "--group=dev"],
      ["upgrade", "--package=--global"],
    ]) {
      let sent: string[] = [];
      try {
        const request = dependencies.requestFromArgv(argv[0] ?? "", argv.slice(1));
        sent = dependencies.pnpmArgsFor(request);
      } catch {
        // refused before any argument list exists
      }
      expect(sent.filter((arg) => arg.startsWith("-") && !["--save-dev", "--save-prod", "--save-exact", "--latest"].includes(arg))).toEqual([]);
    }
  });

  test.each([
    ["left-pad", "left-pad", null],
    ["left-pad@1.3.0", "left-pad", "1.3.0"],
    ["@scope/pkg@next", "@scope/pkg", "next"],
    ["pkg@1.0.0-rc.1", "pkg", "1.0.0-rc.1"],
  ])("%s names one package and at most one version or tag", (spec, name, selector) => {
    expect(dependencies.parseSpec(spec)).toEqual({ name, selector });
  });
});

describe("what is asked of the package manager", () => {
  test("an addition is exact and saved in the group that was asked for", () => {
    expect(dependencies.pnpmArgsFor(dependencies.requestFromArgv("add", ["--package=x@1.2.3", "--group=dev"]))).toEqual([
      "add",
      "--save-dev",
      "--save-exact",
      "x@1.2.3",
    ]);
    expect(dependencies.pnpmArgsFor(dependencies.requestFromArgv("add", ["--package=x", "--group=prod"]))).toEqual(["add", "--save-prod", "--save-exact", "x"]);
  });

  test("a removal and an upgrade of one or of all", () => {
    expect(dependencies.pnpmArgsFor(dependencies.requestFromArgv("remove", ["--package=x", "--group=dev"]))).toEqual(["remove", "--save-dev", "x"]);
    expect(dependencies.pnpmArgsFor(dependencies.requestFromArgv("upgrade", ["--package=x"]))).toEqual(["update", "--latest", "--save-exact", "x"]);
    expect(dependencies.pnpmArgsFor(dependencies.requestFromArgv("upgrade", []))).toEqual(["update", "--latest", "--save-exact"]);
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

describe("reviewed tool pins", () => {
  const pins = { vitest: "5.0.5", eslint: "9.39.5" };
  const request = (action: string, ...flags: string[]) => dependencies.requestFromArgv(action, flags);

  test("a pin cannot be added, removed or upgraded by name", () => {
    expect(dependencies.pinRefusal(request("add", "--package=vitest@5.0.6", "--group=dev"), pins, [])).toMatch(/vitest is a reviewed tool pin \(5\.0\.5\)/);
    expect(dependencies.pinRefusal(request("remove", "--package=vitest", "--group=dev"), pins, [])).toMatch(/changing it is a reviewed tooling change/);
    expect(dependencies.pinRefusal(request("upgrade", "--package=eslint"), pins, [])).toMatch(/upgrading it is a reviewed tooling change/);
  });

  test("an all-dependency upgrade is refused as a whole while any pin is a dependency", () => {
    const refusal = dependencies.pinRefusal(request("upgrade"), pins, ["vitest", "other", "eslint"]);
    expect(refusal).toMatch(/eslint@9\.39\.5, vitest@5\.0\.5/);
    expect(refusal).toMatch(/Nothing was changed/);
  });

  test("anything else is not refused", () => {
    expect(dependencies.pinRefusal(request("add", "--package=left-pad", "--group=dev"), pins, [])).toBeNull();
    expect(dependencies.pinRefusal(request("upgrade", "--package=left-pad"), pins, ["vitest"])).toBeNull();
    expect(dependencies.pinRefusal(request("upgrade"), pins, ["left-pad"])).toBeNull();
    expect(dependencies.pinRefusal(request("upgrade"), {}, ["vitest"])).toBeNull();
  });
});

describe("the command", () => {
  test("refusals of the environment or the guard stop it before anything is planned", () => {
    const { host, transactions } = project({
      gateErrors: () => ["Node 24.21.0 is required (found 1.0.0)."],
      guardRefusal: () => "the guard reports an unresolved protected state (pending reservation)",
      pins: () => {
        throw new Error("must not be read");
      },
    });
    const result = run(["upgrade", "--package=left-pad"], host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/Node 24\.21\.0 is required[\s\S]*pending reservation/);
    expect(transactions).toEqual([]);
  });

  test("a pin is refused before the package manager runs", () => {
    const { host, transactions } = project({ pins: () => ({ vitest: "5.0.5" }) });
    const result = run(["add", "--package=vitest@5.0.6", "--group=dev"], host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/reviewed tool pin/);
    expect(transactions).toEqual([]);
  });

  test("the project's dependencies are only consulted for an all-dependency upgrade", () => {
    const asked: string[] = [];
    const { host } = project({
      pins: () => ({ vitest: "5.0.5" }),
      dependencies: () => {
        asked.push("dependencies");
        return ["vitest"];
      },
    });
    expect(run(["upgrade", "--package=left-pad"], host).status).toBe(0);
    expect(asked).toEqual([]);
    expect(run(["upgrade"], host).status).toBe(1);
    expect(asked).toEqual(["dependencies"]);
  });

  test("an accepted change runs exactly the requested step against the plan, and prints the redacted output", () => {
    const { host, transactions } = project({
      pins: () => ({ eslint: "9.39.5" }),
      transact: (options) => {
        transactions.push(options);
        return { ...accepted, output: "//r.example/:_authToken=top-secret\n" };
      },
    });
    const result = run(["add", "--package=left-pad@1.3.0", "--group=dev"], host);
    expect(result.status).toBe(0);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      root: "/p",
      steps: [["add", "--save-dev", "--save-exact", "left-pad@1.3.0"]],
      plan: { action: "add", name: "left-pad", version: "1.3.0", pinned: { eslint: "9.39.5" } },
    });
    expect(result.out).not.toMatch(/top-secret/);
    expect(result.out).toMatch(/Dependency change applied/);
  });

  test("a rejected change reports the violations, the packages that need a build review, and the recovery", () => {
    const { host } = project({
      transact: () => ({
        ok: false,
        status: 0,
        violations: ["package.json dependencies gained sneaky"],
        output: "Ignored build scripts: sneaky@1.0.0\n",
        restored: true,
      }),
    });
    const result = run(["add", "--package=left-pad@1.3.0", "--group=dev"], host);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/dependency change rejected/);
    expect(result.err).toMatch(/- package\.json dependencies gained sneaky/);
    expect(result.err).toMatch(/need a reviewed build decision.*sneaky@1\.0\.0/);
    expect(result.err).toMatch(/Run: node scripts\/bootstrap\.cjs repair/);
  });

  test("a rejection without build scripts does not invent a build review", () => {
    const { host } = project({ transact: () => ({ ok: false, status: 1, violations: [], output: "ERR_PNPM_NO_MATCHING_VERSION\n", restored: true }) });
    const result = run(["upgrade", "--package=left-pad"], host);
    expect(result.status).toBe(1);
    expect(result.err).not.toMatch(/reviewed build decision/);
  });
});

describe("what the project says about its dependencies", () => {
  test("reviewed names resolve from the current manifest, leaving ordinary additions unpinned", () => {
    const versions = { root: { reviewedTools: ["a", "c"] } };
    const manifest = { dependencies: { a: "1.0.0", ordinary: "2.0.0" }, devDependencies: { c: "3.0.0" } };
    expect(dependencies.rootPins(versions, manifest)).toEqual({ a: "1.0.0", c: "3.0.0" });
    manifest.dependencies.a = "1.0.1";
    expect(dependencies.rootPins(versions, manifest)).toEqual({ a: "1.0.1", c: "3.0.0" });
  });

  test.each<[Record<string, unknown>, Record<string, unknown>, string]>([
    [{}, {}, "must be a list"],
    [{ root: { reviewedTools: "a" } }, {}, "must be a list"],
    [{ root: { reviewedTools: [7] } }, {}, "Invalid reviewed tool name"],
    [{ root: { reviewedTools: ["--global"] } }, {}, "Invalid reviewed tool name"],
    [{ root: { reviewedTools: ["a", "a"] } }, { dependencies: { a: "1.0.0" } }, "Duplicate reviewed tool name: a"],
    [{ root: { reviewedTools: ["a"] } }, {}, "Reviewed tool a"],
    [{ root: { reviewedTools: ["a"] } }, { dependencies: { a: "^1.0.0" } }, "Reviewed tool a"],
    [{ root: { reviewedTools: ["a"] } }, { dependencies: { a: "1.0.0" }, devDependencies: { a: "1.0.0" } }, "Reviewed tool a"],
  ])("invalid reviewed-tool data is refused: %j", (versions, manifest, reason) => {
    const pins = dependencies.rootPins(versions, manifest);
    expect(Array.isArray(pins)).toBe(true);
    expect(pins).toEqual(expect.arrayContaining([expect.stringContaining(reason)]));
    const { host, transactions } = project({ pins: () => pins });
    const result = run(["upgrade", "--package=ordinary"], host);
    expect(result.status).toBe(1);
    expect(result.err).toContain(reason);
    expect(transactions).toEqual([]);
  });

  test("the names a project depends on are the union of both maps", () => {
    expect(dependencies.namesOf({ dependencies: { a: "1.0.0", b: "1.0.0" }, devDependencies: { b: "1.0.0", c: "1.0.0" } }).sort()).toEqual(["a", "b", "c"]);
    expect(dependencies.namesOf({ dependencies: "nope" })).toEqual([]);
  });
});
