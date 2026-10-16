import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { parseJson } from "../../support/json.ts";
import { inventory, memoryRepo, policyText, shell, type Context } from "../../support/guard-repo.ts";

const guard = createRequire(import.meta.url)("../../../scripts/hooks/guard.cjs") as typeof import("../../../scripts/hooks/guard.cjs");

const reasonOf = (output: Record<string, unknown>) => (typeof output["reason"] === "string" ? output["reason"] : "");
const PROJECT = { "package.json": "{}", "AGENTS.md": "# r\n", "tooling/policy.json": policyText.toString() };

/** Runs the event dispatcher against a memory project. */
function run(argv: string[], machine = memoryRepo(PROJECT), input: unknown = shell("true", "c1")) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: { cwd: string; client: string; workingPolicy: boolean }[] = [];
  const status = guard.main(argv, {
    cwd: "/p",
    input: () => (typeof input === "string" || Buffer.isBuffer(input) ? input : JSON.stringify(input)),
    open: (cwd, client, workingPolicy) => {
      opened.push({ cwd, client, workingPolicy });
      return machine.context(client);
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { status, out: out.join(""), err: err.join(""), opened, machine };
}

describe("the arguments", () => {
  test.each([
    [["--event", "pre"], { client: "claude", event: "pre" }],
    [["--client", "codex", "--event", "post-failure"], { client: "codex", event: "post-failure" }],
    [["--event", "stop", "--client", "claude"], { client: "claude", event: "stop" }],
  ])("%j", (argv, expected) => {
    expect(guard.parseArgv(argv)).toEqual(expected);
  });

  test.each([
    [[]],
    [["--event"]],
    [["--event", "sudo"]],
    [["--client", "other", "--event", "pre"]],
    [["--event", "pre", "--event", "stop"]],
    [["pre"]],
    [["--event", "pre", "--debug", "1"]],
  ])("%j is a usage error", (argv) => {
    expect(guard.parseArgv(argv)).toBeNull();
    const result = run(argv);
    expect(result.status).toBe(2);
    expect(result.err).toMatch(/usage: guard\.cjs/);
  });
});

describe("the input envelope", () => {
  test("an object with an object tool_input is accepted, from text or from bytes", () => {
    expect(guard.parsePayload('{"tool_name":"Bash","tool_input":{}}')).toMatchObject({ tool_name: "Bash" });
    expect(guard.parsePayload(Buffer.from("{}"))).toEqual({});
  });

  test.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["a tool_input that is a string", '{"tool_input":"x"}'],
    ["a tool_input that is null", '{"tool_input":null}'],
  ])("%s is refused", (_label, text) => {
    expect(() => guard.parsePayload(text)).toThrow();
  });

  test("more than the limit is refused before it is parsed", () => {
    expect(() => guard.parsePayload(Buffer.alloc(1024 * 1024 + 1, 32))).toThrow(/too large/);
  });
});

describe("the dispatcher (R2)", () => {
  test("each event reaches its handler and writes its answer only when there is one", () => {
    const machine = memoryRepo(PROJECT);
    expect(run(["--event", "pre"], machine, shell("true", "a"))).toMatchObject({ status: 0, out: "" });
    expect(run(["--event", "post"], machine, shell("true", "a"))).toMatchObject({ status: 0, out: "" });
    machine.worktree.set("AGENTS.md", "# changed\n");
    const stopped = run(["--event", "stop"], machine, {});
    expect(stopped.status).toBe(0);
    expect(parseJson(stopped.out)["decision"]).toBe("block");
    expect(run(["--event", "post-failure"], machine, shell("true", "b")).status).toBe(0);
    expect(run(["--client", "codex", "--event", "config-change"], machine, { source: "user_settings" })).toMatchObject({ status: 0, out: "" });
    expect(machine.state()).not.toBeNull();
  });

  test("a denial is written as the hook answer", () => {
    const result = run(["--event", "pre"], memoryRepo(PROJECT), shell("git commit --no-verify -m x", "a"));
    expect(result.status).toBe(0);
    expect(parseJson<{ hookSpecificOutput: { permissionDecision: string } }>(result.out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("the working directory of the payload is where the worktree is looked for, and accept adopts the working policy", () => {
    const machine = memoryRepo(PROJECT);
    expect(run(["--event", "pre"], machine, { ...shell("true", "a"), cwd: "/p/src" }).opened).toEqual([
      { cwd: "/p/src", client: "claude", workingPolicy: false },
    ]);
    expect(run(["--event", "pre"], machine, { tool_name: "Bash", tool_input: { command: "true" }, tool_use_id: "b" }).opened[0]?.cwd).toBe("/p");
    expect(run(["--event", "accept"], machine).opened).toEqual([{ cwd: "/p", client: "claude", workingPolicy: true }]);
    expect(run(["--event", "pre-commit"], machine).opened).toEqual([{ cwd: "/p", client: "claude", workingPolicy: false }]);
  });

  test("accept prints what it accepted, and the pre-commit check reports through stderr", () => {
    const machine = memoryRepo(PROJECT);
    expect(run(["--event", "accept"], machine).out).toMatch(/Accepted the current protected state\./);
    guard.preTool(machine.context(), shell("true", "running"));
    machine.index.set("AGENTS.md", "# staged\n");
    const rejected = run(["--event", "pre-commit"], machine);
    expect(rejected.status).toBe(1);
    expect(rejected.err).toMatch(/Unapproved protected changes are staged: AGENTS\.md/);
  });

  test.each([["pre"], ["post"], ["config-change"]])("input it cannot evaluate blocks a %s event with 2", (event) => {
    const result = run(["--event", event], memoryRepo(PROJECT), "{ not json");
    expect(result.status).toBe(2);
    expect(result.err).toMatch(/cannot evaluate this event/);
  });

  test("a stop that cannot be evaluated does not block the turn", () => {
    expect(run(["--event", "stop"], memoryRepo(PROJECT), "[]").status).toBe(1);
  });

  test("a failure inside a handler is reported, bounded, and blocks", () => {
    const machine = memoryRepo(PROJECT);
    machine.repo.candidates = () => {
      throw new Error("x".repeat(5000));
    };
    const result = run(["--event", "pre"], machine, shell("true", "a"));
    expect(result.status).toBe(2);
    expect(result.err.length).toBeLessThan(2100);
  });
});

describe("the policy the guard enforces", () => {
  const baseline = { policy: "p".repeat(40) } as NonNullable<ReturnType<ReturnType<typeof memoryRepo>["state"]>>;

  test("with no baseline it is the working copy; with one it is the recorded copy, and a missing copy is an error", () => {
    const working = Buffer.from("working");
    const stored = Buffer.from("stored");
    expect(guard.choosePolicy({ baseline: null, stored: null, working: () => working })).toBe(working);
    expect(guard.choosePolicy({ baseline: null, stored, working: () => working })).toBe(working);
    expect(guard.choosePolicy({ baseline, stored, working: () => working })).toBe(stored);
    expect(() => guard.choosePolicy({ baseline, stored: null, working: () => working })).toThrow(/policy copy is missing/);
  });

  test("a policy parses into an inventory and a command grammar, and a broken one is refused", () => {
    const parsed = guard.parsePolicy(policyText);
    expect(parsed.inventory.isProtectedFile("package.json")).toBe(true);
    expect(parsed.guardPolicy.commands.length).toBeGreaterThan(5);
    expect(inventory.isProtectedFile("package.json")).toBe(true);
    for (const broken of ["[]", "{}", '{"protected":{},"guard":{}}']) expect(() => guard.parsePolicy(Buffer.from(broken))).toThrow();
  });
});

describe("Claude settings", () => {
  const registered = Object.fromEntries(
    ["PreToolUse", "PostToolUse", "PostToolUseFailure", "ConfigChange", "Stop"].map((event) => [
      event,
      [{ hooks: [{ command: "scripts/hooks/launch.sh --event x" }] }],
    ]),
  );
  const settings = (value: unknown) => JSON.stringify(value);
  const check = (machine: ReturnType<typeof memoryRepo>, payload: Record<string, unknown>) => guard.configChange(machine.context(), payload);

  test("the hooks must all still run the launcher", () => {
    expect(guard.guardRegistered({ hooks: registered })).toBe(true);
    expect(guard.guardRegistered({ hooks: { ...registered, Stop: [] } })).toBe(false);
    expect(guard.guardRegistered({ hooks: "no" })).toBe(false);
    expect(guard.guardRegistered({})).toBe(false);
  });

  test("project settings that keep the guard are fine; ones that drop it, disable hooks or cannot be read are blocked", () => {
    const machine = memoryRepo(PROJECT);
    const path = "/p/.claude/settings.json";
    machine.texts.set(path, settings({ hooks: registered }));
    expect(check(machine, { source: "project_settings" })).toEqual({});
    machine.texts.set(path, settings({ hooks: {} }));
    expect(reasonOf(check(machine, { source: "project_settings" }))).toMatch(/keep the protected-files guard/);
    expect(check(machine, { source: "local_settings" })).toEqual({});
    machine.texts.set(path, "{ not json");
    expect(reasonOf(check(machine, { source: "project_settings" }))).toMatch(/cannot be parsed/);
    machine.texts.set(path, settings({ hooks: registered, disableAllHooks: true }));
    expect(reasonOf(check(machine, { source: "project_settings" }))).toMatch(/disableAllHooks/);
    expect(parseJson(machine.texts.get(path) ?? "")["disableAllHooks"]).toBe(true);
    machine.texts.set(path, settings([]));
    expect(check(machine, { source: "user_settings", file_path: "/nowhere" })).toEqual({});
  });

  test("hooks switched off in the user's or local settings are removed there, never in the project's own file", () => {
    const machine = memoryRepo(PROJECT);
    machine.texts.set("/home/.claude/settings.json", settings({ disableAllHooks: true, theme: "dark" }));
    expect(check(machine, { source: "user_settings" })).toMatchObject({ decision: "block" });
    expect(parseJson(machine.texts.get("/home/.claude/settings.json") ?? "")).toEqual({ theme: "dark" });
    machine.texts.set("/p/.claude/settings.local.json", settings({ disableAllHooks: true }));
    check(machine, { source: "local_settings" });
    expect(parseJson(machine.texts.get("/p/.claude/settings.local.json") ?? "")).toEqual({});
    machine.links.set("/p/alias.json", "/p/.claude/settings.json");
    machine.texts.set("/p/alias.json", settings({ disableAllHooks: true }));
    machine.texts.set("/p/.claude/settings.json", settings({ hooks: registered }));
    expect(check(machine, { source: "project_settings", file_path: "/p/alias.json" })).toMatchObject({ decision: "block" });
    expect(parseJson(machine.texts.get("/p/alias.json") ?? "")["disableAllHooks"]).toBe(true);
  });
});

describe("user-level Codex files", () => {
  const disables = (name: string, content: string | null, root = "/p") => guard.disablesHooks(name, content === null ? null : Buffer.from(content), root);

  test("hooks switched off or a project no longer trusted are recognized", () => {
    expect(disables("config.toml", 'model = "x"\nhooks = false\n')).toBe(true);
    expect(disables("config.toml", "codex_hooks = false\n")).toBe(true);
    expect(disables("config.toml", '[projects."/p"]\ntrust_level = "untrusted"\n')).toBe(true);
    expect(disables("config.toml", '[projects."/p"]\ntrust_level = "trusted"\n')).toBe(false);
    expect(disables("config.toml", '[projects."/other"]\ntrust_level = "untrusted"\n')).toBe(false);
    expect(disables("config.toml", "hooks = true\n")).toBe(false);
    expect(disables("config.toml", null)).toBe(false);
    expect(disables("hooks.json", "{ broken")).toBe(true);
    expect(disables("hooks.json", "{}")).toBe(false);
  });
});

describe("the baseline against the approved state", () => {
  test("it is compared by approved ids, and an unapproved staged copy is named", () => {
    const machine = memoryRepo(PROJECT);
    const context: Context = machine.context();
    const baseline = guard.snapshot(context, null);
    expect(guard.drift(context, baseline)).toEqual([]);
    machine.index.set("AGENTS.md", "# staged\n");
    expect(guard.drift(context, baseline)).toEqual(["AGENTS.md (staged)"]);
    expect(guard.unapproved({ a: "1", b: "2", c: null }, { a: "1", b: "x", c: "y" }, { b: ["2"] })).toEqual(["c"]);
    expect(guard.driftFromHead(context)).toBe(true);
  });
});
