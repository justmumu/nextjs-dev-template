import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

const plugins = createRequire(import.meta.url)("../../scripts/core/plugins.cjs") as typeof import("../../scripts/core/plugins.cjs");
type Host = Parameters<typeof plugins.installPlugins>[2];

const SETTINGS = JSON.stringify({
  extraKnownMarketplaces: {
    "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
    "other-plugins": { source: { source: "git", repo: "ignored" } },
    "compound-engineering-plugin": { source: { source: "github", repo: "EveryInc/compound-engineering-plugin" } },
  },
  enabledPlugins: { "compound-engineering@compound-engineering-plugin": true, "off@claude-plugins-official": false },
});
const CODEX = '[marketplaces.compound-engineering-plugin]\nsource_type = "git"\n\n[plugins."x@y"]\nenabled = true\n\n[marketplaces.second_one]\nsource = "x"\n';
const ROOT = "/project";

/** Agent CLIs that answer from memory; `claude` rewrites the tracked settings the way the real CLI does. */
function machine(options: { clis?: string[]; failing?: string; rewrites?: boolean; files?: Record<string, string> } = {}) {
  const files = new Map(Object.entries(options.files ?? { [`${ROOT}/.claude/settings.json`]: SETTINGS, [`${ROOT}/.codex/config.toml`]: CODEX }));
  const commands: string[] = [];
  const host: Host = {
    find: (name) => (options.clis ?? ["claude", "codex"]).includes(name),
    run: (command, args) => {
      commands.push([command, ...args].join(" "));
      if (command === "claude" && options.rewrites !== false) files.set(`${ROOT}/.claude/settings.json`, '{"rewritten":true}');
      const failed = options.failing !== undefined && commands.length === Number(options.failing);
      return { status: failed ? 1 : 0, stdout: "", stderr: failed ? "network down" : "" };
    },
    read: (path) => (files.has(path) ? Buffer.from(files.get(path) ?? "") : null),
    write: (path, content) => {
      files.set(path, content.toString("utf8"));
    },
  };
  return { host, commands, files };
}

describe("declared plugins", () => {
  test("the Claude declaration is read from the tracked settings: GitHub marketplaces and enabled plugins only", () => {
    expect(plugins.claudeDeclaration(Buffer.from(SETTINGS))).toEqual({
      marketplaces: ["anthropics/claude-plugins-official", "EveryInc/compound-engineering-plugin"],
      plugins: ["compound-engineering@compound-engineering-plugin"],
    });
    expect(plugins.claudeDeclaration(null)).toEqual({ marketplaces: [], plugins: [] });
    expect(plugins.claudeDeclaration(Buffer.from("{}"))).toEqual({ marketplaces: [], plugins: [] });
  });

  test("the Codex declaration is its marketplace tables", () => {
    expect(plugins.codexMarketplaces(Buffer.from(CODEX))).toEqual(["compound-engineering-plugin", "second_one"]);
    expect(plugins.codexMarketplaces(null)).toEqual([]);
  });
});

describe("the machine's agent CLIs and tracked files", () => {
  test("a CLI is found on the given PATH, and the two files are read and written through the disk", () => {
    const written: [string, string][] = [];
    const disk = {
      existsSync: (path: string) => path === "/there",
      readFileSync: () => Buffer.from("bytes"),
      writeFileSync: (path: string, content: Buffer) => written.push([path, content.toString("utf8")]),
    };
    const start = () => ({ status: 0, stdout: "", stderr: "" });
    const host = plugins.realHost({ path: "/definitely/not/a/bin/directory", start, disk });
    expect(host.find("claude")).toBe(false);
    expect(host.run).toBe(start);
    expect(host.read("/there")?.toString("utf8")).toBe("bytes");
    expect(host.read("/missing")).toBeNull();
    host.write("/there", Buffer.from("again"));
    expect(written).toEqual([["/there", "again"]]);
  });
});

describe("installation", () => {
  test("installs every declared plugin in project scope, refreshes the Codex marketplaces with one-command trust, and restores the settings bytes", async () => {
    const { host, commands, files } = machine();
    const sink = capture();
    await plugins.installPlugins(ROOT, sink.io, host);
    expect(commands).toEqual([
      "claude plugin marketplace add anthropics/claude-plugins-official --scope project",
      "claude plugin marketplace add EveryInc/compound-engineering-plugin --scope project",
      "claude plugin install compound-engineering@compound-engineering-plugin --scope project",
      'codex plugin marketplace upgrade compound-engineering-plugin -c projects={"/project"={trust_level="trusted"}}',
      'codex plugin marketplace upgrade second_one -c projects={"/project"={trust_level="trusted"}}',
    ]);
    expect(files.get(`${ROOT}/.claude/settings.json`)).toBe(SETTINGS);
    expect(sink.err()).toBe("");
  });

  test("without an agent CLI nothing runs and nothing is written", async () => {
    const { host, commands, files } = machine({ clis: [] });
    await plugins.installPlugins(ROOT, capture().io, host);
    expect(commands).toEqual([]);
    expect(files.get(`${ROOT}/.claude/settings.json`)).toBe(SETTINGS);
  });

  test("a failing Claude step warns, stops the Claude steps, still restores the settings and leaves Codex to run", async () => {
    const { host, commands, files } = machine({ failing: "2" });
    const sink = capture();
    await plugins.installPlugins(ROOT, sink.io, host);
    expect(commands.filter((command) => command.startsWith("claude"))).toHaveLength(2);
    expect(commands.filter((command) => command.startsWith("codex"))).toHaveLength(2);
    expect(sink.err()).toMatch(/warning: Claude Code plugin install failed; install the project plugins from \/plugin\.\nnetwork down/);
    expect(files.get(`${ROOT}/.claude/settings.json`)).toBe(SETTINGS);
  });

  test("a failing Codex refresh names the command to run after trusting the project", async () => {
    const { host } = machine({ clis: ["codex"], failing: "1" });
    const sink = capture();
    await plugins.installPlugins(ROOT, sink.io, host);
    expect(sink.err()).toMatch(
      /Codex plugin download failed; trust this project in Codex, then run: codex plugin marketplace upgrade compound-engineering-plugin/,
    );
  });

  test("settings that cannot be parsed still come back byte for byte", async () => {
    const { host, files } = machine({ files: { [`${ROOT}/.claude/settings.json`]: "{ broken" } });
    await expect(plugins.installPlugins(ROOT, capture().io, host)).rejects.toThrow();
    expect(files.get(`${ROOT}/.claude/settings.json`)).toBe("{ broken");
  });

  test("a project without host settings has nothing to install", async () => {
    const { host, commands } = machine({ files: {} });
    await plugins.installPlugins(ROOT, capture().io, host);
    expect(commands).toEqual([]);
  });

  test("registry credentials in a CLI's error never reach the log", async () => {
    const { host } = machine({ clis: ["claude"] });
    const sink = capture();
    await plugins.installPlugins(ROOT, sink.io, {
      ...host,
      run: () => ({ status: 1, stdout: "", stderr: "//r.example/:_authToken=top-secret" }),
    });
    expect(sink.err()).not.toMatch(/top-secret/);
  });
});
