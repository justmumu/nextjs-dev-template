import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { parseJson } from "../support/json.ts";
import { denial, guardArea, stateModule } from "../support/guard-fixture.ts";

const { createFixture, area } = guardArea("guard-launch-");
const shell = (command: string, id: string, root: string) => ({ cwd: root, tool_name: "Bash", tool_input: { command }, tool_use_id: id });

describe("a raw Node launch with no dependency environment (R2, AE5)", () => {
  test("with no node_modules, no pnpm, a malformed manifest and a broken TypeScript configuration the guard still restores a protected edit", () => {
    const fixture = createFixture({ "package.json": "{ not valid json", "tsconfig.json": '{"compilerOptions": {"strict": ' });
    expect(existsSync(join(fixture.root, "node_modules"))).toBe(false);
    const payload = shell("echo evil >> AGENTS.md", "c1", fixture.root);
    expect(fixture.launch("pre", payload)).toMatchObject({ status: 0, json: {} });
    fixture.write("AGENTS.md", "# Rules\nevil\n");
    const post = fixture.launch("post", payload);
    expect(post.status).toBe(0);
    expect(post.json.decision).toBe("block");
    expect(fixture.read("AGENTS.md")).toBe("# Rules\n");
    expect(fixture.launch("pre", shell("true", "c2", fixture.root)).json).toEqual({});
  });

  test("a call result that arrives late for another call cannot approve the waiting change", () => {
    const fixture = createFixture();
    const mine = shell("pnpm run deps:add --package=left-pad@1.3.0 --group=prod", "mine", fixture.root);
    expect(fixture.launch("pre", mine).json).toEqual({});
    const manifest = JSON.parse(fixture.read("package.json")) as { dependencies: Record<string, string> };
    manifest.dependencies["left-pad"] = "1.3.0";
    fixture.write("package.json", JSON.stringify(manifest, null, 2));
    expect(fixture.launch("post", shell("pnpm run deps:add --package=left-pad@1.3.0 --group=prod", "someone-else", fixture.root)).json).toEqual({});
    const stored = JSON.parse(readFileSync(join(fixture.root, ".git", "protected-baseline", "state.json"), "utf8")) as {
      inflight: Record<string, unknown>;
      window: unknown[];
    };
    expect(Object.keys(stored.inflight)).toEqual(["mine"]);
    expect(stored.inflight["mine"]).toMatchObject({ route: "deps-add", exclusive: true });
    expect(stored.window).toEqual([]);
    expect(denial(fixture.launch("pre", shell("true", "next", fixture.root)).json)).toMatch(/Another call/);
    expect(fixture.launch("post", mine).json).toEqual({});
    expect(parseJson<{ dependencies: Record<string, string> }>(fixture.read("package.json")).dependencies["left-pad"]).toBe("1.3.0");
  });
});

describe("the launcher clears what Node would load before it starts (KTD15)", () => {
  const marker = (name: string) => join(area, name);
  const preload = (name: string) => {
    const file = join(area, `${name}.cjs`);
    writeFileSync(file, `require("node:fs").writeFileSync(${JSON.stringify(marker(name))}, "loaded");\n`);
    return file;
  };

  test("a control: the same environment does load a preload when Node is started directly", () => {
    const file = preload("control");
    spawnSync(process.execPath, ["-e", "0"], { env: { PATH: "/usr/bin:/bin", NODE_OPTIONS: `--require=${file}` } });
    expect(readFileSync(marker("control"), "utf8")).toBe("loaded");
  });

  test("NODE_OPTIONS preloads and NODE_PATH candidates are never loaded", () => {
    const fixture = createFixture();
    const file = preload("options");
    mkdirSync(join(area, "node-path-dir"), { recursive: true });
    writeFileSync(join(area, "node-path-dir", "viaPath.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker("path"))}, "loaded");\n`);
    const result = fixture.launch("pre", shell("true", "c1", fixture.root), {
      env: { NODE_OPTIONS: `--require=${file} --require=viaPath.cjs`, NODE_PATH: join(area, "node-path-dir"), NODE_COMPILE_CACHE: join(area, "cache") },
    });
    expect(result).toMatchObject({ status: 0, json: {} });
    expect(existsSync(marker("options"))).toBe(false);
    expect(existsSync(marker("path"))).toBe(false);
    expect(existsSync(join(area, "cache"))).toBe(false);
  });

  test("a node in the project's dependency bin directory, first on PATH, is never started", () => {
    const fixture = createFixture();
    const bin = join(fixture.root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf loaded > ${JSON.stringify(marker("bin"))}\nexit 1\n`);
    chmodSync(join(bin, "node"), 0o755);
    const result = fixture.launch("pre", shell("true", "c1", fixture.root), { env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect(result).toMatchObject({ status: 0, json: {} });
    expect(existsSync(marker("bin"))).toBe(false);
  });

  test("the bound binary is started with the hardening flags and with every NODE_* variable removed", () => {
    const fixture = createFixture({}, { bind: false });
    const stub = join(area, "stub-node.sh");
    const record = marker("invocation");
    writeFileSync(stub, `#!/bin/sh\n{ printf '%s\\n' "$@"; env | grep '^NODE_'; } > ${JSON.stringify(record)}\nexit 0\n`);
    chmodSync(stub, 0o755);
    stateModule.bindNode(fixture.root, stub);
    const result = fixture.launch(
      "stop",
      {},
      { env: { NODE_OPTIONS: "--require=x", NODE_PATH: "/tmp", NODE_V8_COVERAGE: "/tmp/cov", NODE_FAKE_SETTING: "1" } },
    );
    expect(result.status).toBe(0);
    const lines = readFileSync(record, "utf8").split("\n").filter(Boolean);
    expect(lines.slice(0, 3)).toEqual(["--no-addons", "--no-global-search-paths", "--disable-proto=throw"]);
    expect(lines[3]).toBe(join(fixture.root, "scripts/hooks/entry.cjs"));
    expect(lines.slice(4)).toEqual(["--client", "claude", "--event", "stop"]);
    expect(lines.filter((line) => line.startsWith("NODE_"))).toEqual([]);
  });

  test("the real Node accepts those flags on the guard", () => {
    const fixture = createFixture();
    const result = spawnSync(
      process.execPath,
      ["--no-addons", "--no-global-search-paths", "--disable-proto=throw", join(fixture.root, "scripts/hooks/entry.cjs"), "--event", "stop"],
      {
        cwd: fixture.root,
        input: "{}",
        env: fixture.env,
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
  });
});

describe("the machine-local Node binding (R2)", () => {
  test("a launch with nothing bound refuses to run, with the stop event exiting softly", () => {
    const fixture = createFixture({}, { bind: false });
    const refused = fixture.launch("pre", shell("true", "c1", fixture.root));
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/no Node binary is bound.*setup/);
    expect(fixture.launch("stop", {}).status).toBe(1);
  });

  test("a binary inside the project, a relative path, a missing file and a directory are refused at binding time", () => {
    const fixture = createFixture({}, { bind: false });
    const inside = join(fixture.root, "node_modules", ".bin", "node");
    mkdirSync(join(fixture.root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(inside, "#!/bin/sh\n");
    chmodSync(inside, 0o755);
    expect(() => stateModule.bindNode(fixture.root, inside)).toThrow(/outside the project/);
    expect(() => stateModule.bindNode(fixture.root, "node")).toThrow(/absolute/);
    expect(() => stateModule.bindNode(fixture.root, join(area, "missing-node"))).toThrow();
    expect(() => stateModule.bindNode(fixture.root, area)).toThrow();
    const plain = join(area, "not-executable");
    writeFileSync(plain, "");
    expect(() => stateModule.bindNode(fixture.root, plain)).toThrow();
  });

  test("a binding that points into the project, that is not absolute or that no longer exists is refused by the launcher", () => {
    const fixture = createFixture();
    const binding = join(fixture.root, ".git", "protected-baseline-node");
    for (const [content, message] of [
      [`${fixture.root}/node_modules/.bin/node\n`, /inside the project/],
      ["node\n", /not absolute/],
      [`${area}/gone-node\n`, /missing/],
    ] as const) {
      writeFileSync(binding, content);
      const result = fixture.launch("pre", shell("true", "c1", fixture.root));
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(message);
    }
  });

  test("the binding is machine-local Git state, never tracked, and the repository holds no absolute Node path", () => {
    const fixture = createFixture();
    expect(readFileSync(join(fixture.root, ".git", "protected-baseline-node"), "utf8").trim()).toBe(process.execPath);
    expect(fixture.git("ls-files")).not.toContain("protected-baseline-node");
    for (const file of ["scripts/hooks/launch.sh", "scripts/hooks/guard.cjs", "scripts/hooks/state.cjs", "tooling/policy.json"])
      expect(fixture.read(file)).not.toContain(process.execPath);
  });

  test("outside a Git worktree the launcher refuses", () => {
    const fixture = createFixture();
    const result = spawnSync("sh", [join(fixture.root, "scripts/hooks/launch.sh"), "--event", "stop"], {
      cwd: area,
      env: { ...fixture.env, GIT_DIR: join(area, "nope") },
      input: "{}",
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not a Git worktree/);
  });
});

describe("input the guard cannot evaluate blocks instead of passing", () => {
  test.each([
    ["not JSON", "{"],
    ["not an object", "[]"],
    ["a tool_input that is not an object", JSON.stringify({ tool_name: "Bash", tool_input: "echo", tool_use_id: "x" })],
    ["no tool_use_id", JSON.stringify({ tool_name: "Bash", tool_input: { command: "true" } })],
    ["more than the input limit", JSON.stringify({ padding: "x".repeat(1024 * 1024 + 10) })],
  ])("%s exits with 2, and a stop with 1", (_label, raw) => {
    const fixture = createFixture();
    const refused = fixture.launch("pre", null, { raw });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/cannot evaluate this event/);
    expect(fixture.launch("stop", null, { raw: _label === "no tool_use_id" ? "{" : raw }).status).toBe(1);
  });

  test("an unknown event or client is a usage error", () => {
    const fixture = createFixture();
    expect(fixture.launch("sudo", {}).status).toBe(2);
    expect(fixture.launch("pre", {}, { client: "other" }).status).toBe(2);
  });

  test("the message of a failure is bounded and the baseline records no environment", () => {
    const fixture = createFixture();
    const secret = "very-secret-value-123";
    const payload = shell("true", "c1", fixture.root);
    fixture.launch("pre", payload, { env: { GUARD_SECRET: secret } });
    const state = readFileSync(join(fixture.root, ".git", "protected-baseline", "state.json"), "utf8");
    expect(state).not.toContain(secret);
    expect(state).not.toContain("GUARD_SECRET");
    const failure = fixture.launch("pre", null, { raw: JSON.stringify({ tool_name: "Bash", tool_input: {}, tool_use_id: "y".repeat(5000) }) });
    expect(failure.stderr.length).toBeLessThan(2400);
  });
});
