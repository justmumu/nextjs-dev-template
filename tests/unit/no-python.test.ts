import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

const acceptance = createRequire(import.meta.url)("../../scripts/ci/no-python.cjs") as typeof import("../../scripts/ci/no-python.cjs");

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const upstream = JSON.stringify({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [{ names: ["read"], action: "SCMP_ACT_ALLOW" }] }, null, "\t");

describe("the seccomp profile", () => {
  test("is the pinned upstream profile plus the single namespace rule", () => {
    const derived = JSON.parse(acceptance.deriveProfile(upstream, digest(upstream))) as { defaultAction: string; syscalls: unknown[] };
    expect(derived.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(derived.syscalls).toEqual([{ names: ["read"], action: "SCMP_ACT_ALLOW" }, acceptance.NAMESPACE_RULE]);
  });

  test("allows unshare only for the user and network namespace flags", () => {
    expect(acceptance.NAMESPACE_RULE.args).toEqual([{ index: 0, value: 0x10000000 | 0x40000000, op: "SCMP_CMP_EQ" }]);
    expect(acceptance.NAMESPACE_RULE.names).toEqual(["unshare"]);
  });

  test("pins a revision and a digest", () => {
    expect(acceptance.UPSTREAM.url).toContain(acceptance.UPSTREAM.revision);
    expect(acceptance.UPSTREAM.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses bytes that are not the pinned ones", () => {
    expect(() => acceptance.deriveProfile(`${upstream} `, digest(upstream))).toThrow(/not the pinned one/);
  });

  test("refuses a profile without rules and one that already has the rule", () => {
    const empty = JSON.stringify({ defaultAction: "SCMP_ACT_ERRNO" });
    expect(() => acceptance.deriveProfile(empty, digest(empty))).toThrow(/no syscall rules/);
    const decided = JSON.stringify({ syscalls: [acceptance.NAMESPACE_RULE] });
    expect(() => acceptance.deriveProfile(decided, digest(decided))).toThrow(/already carries/);
  });
});

describe("the acceptance chain", () => {
  const dirs = { source: "/src", work: "/work" };

  function hostFor(over: { present?: string[]; failing?: string } = {}) {
    const sink = capture();
    const ran: string[] = [];
    const present = new Set(over.present ?? []);
    // A tool that appears once a step has run models something the chain installed.
    const host = {
      which: (name: string) => (present.has(name) ? `/usr/bin/${name}` : null),
      run: (command: string, args: readonly string[], options: { cwd: string }): number | null => {
        const line = `${options.cwd}$ ${command} ${args.join(" ")}`;
        ran.push(line);
        return over.failing !== undefined && line.includes(over.failing) ? 3 : 0;
      },
      io: sink.io,
    };
    return { host, sink, ran, present };
  }

  test("clones the committed source, installs from the frozen lock and then runs the gates of the root and of a created application", () => {
    const names = acceptance.acceptanceSteps(dirs).map(({ name }) => name);
    expect(names.slice(0, 8)).toEqual(["git name", "git email", "git trust", "clone", "install", "check", "docs", "create"]);
    expect(names.slice(8, 12)).toEqual(["app setup", "app check", "app docs", "app build"]);
    expect(names.slice(12)).toEqual(acceptance.SCENARIOS.map((name) => `scenario ${name}`));
  });

  test("runs every step with literal arguments and never fetches or fixes anything", () => {
    const steps = acceptance.acceptanceSteps(dirs);
    expect(steps[1]).toMatchObject({ args: ["config", "--global", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"] });
    expect(steps[2]).toMatchObject({ args: ["config", "--global", "--add", "safe.directory", "/src/.git"] });
    expect(steps[3]).toEqual({
      name: "clone",
      command: "git",
      args: ["clone", "--quiet", "--no-hardlinks", "/src", "/work/repo"],
      cwd: "/work",
    });
    expect(steps[4]).toMatchObject({ command: "pnpm", args: ["install", "--frozen-lockfile"], cwd: "/work/repo" });
    expect(steps[7]?.args).toEqual(["run", "template:create", "--name=acceptance-app", "--owner=acceptance", "--dest=/work/app"]);
    expect(JSON.stringify(steps)).not.toMatch(/npx|dlx|latest|--fix|--force|--no-frozen/);
  });

  test("covers the creation, update, recovery and release scenarios of the integration suite", () => {
    expect(acceptance.SCENARIOS).toEqual([
      "template-create",
      "template-initialize",
      "template-preview",
      "template-update",
      "template-recovery",
      "release",
      "release-lineage",
    ]);
  });

  test("passes when every step passes and the forbidden tools are absent before and after", () => {
    const { host, sink, ran } = hostFor();
    expect(acceptance.accept(host, dirs)).toBe(0);
    expect(ran).toHaveLength(acceptance.acceptanceSteps(dirs).length);
    expect(sink.out()).toContain("acceptance: passed");
  });

  test.each(acceptance.FORBIDDEN)("does not start when %s is present", (tool) => {
    const { host, sink, ran } = hostFor({ present: [tool] });
    expect(acceptance.accept(host, dirs)).toBe(1);
    expect(ran).toEqual([]);
    expect(sink.err()).toContain(`${tool} present before the run`);
  });

  test("stops at the first failing step and reports its own status", () => {
    const { host, sink, ran } = hostFor({ failing: "run check" });
    expect(acceptance.accept(host, dirs)).toBe(1);
    expect(sink.err()).toContain("acceptance: check failed with status 3");
    expect(ran).toHaveLength(6);
    expect(sink.out()).not.toContain("acceptance: passed");
  });

  test("a tool that became available during the run fails it", () => {
    const { host, sink, present } = hostFor();
    const original = host.run;
    host.run = (command, args, options) => {
      if (args.includes("build")) present.add("make");
      return original(command, args, options);
    };
    expect(acceptance.accept(host, dirs)).toBe(1);
    expect(sink.err()).toContain("make present after the run");
    expect(sink.out()).not.toContain("acceptance: passed");
  });

  test("a step that could not even start fails the run", () => {
    const { host } = hostFor();
    host.run = () => null;
    expect(acceptance.accept(host, dirs)).toBe(1);
  });
});

describe("the command line", () => {
  function depsFor(over: Partial<Parameters<typeof acceptance.cli>[1]> = {}) {
    const sink = capture();
    const written: [string, string][] = [];
    const made: string[] = [];
    const deps: Parameters<typeof acceptance.cli>[1] = {
      fetchText: (url) => Promise.resolve(url === acceptance.UPSTREAM.url ? upstream : ""),
      writeFile: (path, text) => written.push([path, text]),
      makeDirectory: (path) => made.push(path),
      which: () => null,
      run: () => 0,
      io: sink.io,
      ...over,
    };
    return { deps, written, made, sink };
  }

  test("profile downloads the pinned URL, derives the profile and writes it", async () => {
    const asked: string[] = [];
    const { deps, written } = depsFor({
      pin: { url: "https://example.test/default.json", sha256: digest(upstream) },
      fetchText: (url) => {
        asked.push(url);
        return Promise.resolve(upstream);
      },
    });
    await expect(acceptance.cli(["profile", "--out=/tmp/seccomp.json"], deps)).resolves.toBe(0);
    expect(asked).toEqual(["https://example.test/default.json"]);
    expect(written).toEqual([["/tmp/seccomp.json", acceptance.deriveProfile(upstream, digest(upstream))]]);
  });

  test("profile writes nothing unless the download is the pinned profile", async () => {
    const wrong = depsFor();
    await expect(acceptance.cli(["profile", "--out=/tmp/seccomp.json"], wrong.deps)).rejects.toThrow(/not the pinned one/);
    expect(wrong.written).toEqual([]);
  });

  test("profile writes nothing when the download fails", async () => {
    const { deps, written } = depsFor({ fetchText: () => Promise.reject(new Error("offline")) });
    await expect(acceptance.cli(["profile", "--out=/tmp/seccomp.json"], deps)).rejects.toThrow("offline");
    expect(written).toEqual([]);
  });

  test("accept makes the work directory and runs the chain", async () => {
    const { deps, made, sink } = depsFor();
    await expect(acceptance.cli(["accept", "--source=/src", "--work=/work"], deps)).resolves.toBe(0);
    expect(made).toEqual(["/work"]);
    expect(sink.out()).toContain("acceptance: passed");
  });

  test("needs both directories, and knows only two commands", async () => {
    await expect(acceptance.cli(["accept", "--source=/src"], depsFor().deps)).rejects.toThrow(/--work is required/);
    await expect(acceptance.cli(["profile"], depsFor().deps)).rejects.toThrow(/--out is required/);
    await expect(acceptance.cli(["build"], depsFor().deps)).rejects.toThrow(/usage: node scripts\/ci\/no-python.cjs/);
  });
});
