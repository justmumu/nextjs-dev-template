import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import {
  prefixRules,
  read,
  isGenerator,
  repositoryRoot,
  ruleMatches,
  declarations,
  type ClaudeSettings,
  type CodexHooks,
  type HookEntry,
} from "../support/agent-declarations.ts";
import { parseJson } from "../support/json.ts";

// The host declarations are data the two agent hosts read. Their rules are derived from, or checked
// against, tooling/policy.json, the one inventory of protected files and approved commands.

const require = createRequire(import.meta.url);
const guard = require("../../scripts/hooks/guard.cjs") as typeof import("../../scripts/hooks/guard.cjs");
const policyModule = require("../../scripts/hooks/policy.cjs") as typeof import("../../scripts/hooks/policy.cjs");
const pluginsModule = require("../../scripts/core/plugins.cjs") as typeof import("../../scripts/core/plugins.cjs");
const protectedModule = require("../../scripts/core/protected.cjs") as typeof import("../../scripts/core/protected.cjs");

interface Policy {
  protected: unknown;
  guard: { commands: { id: string; argv: string[]; flags?: Record<string, string>; positional?: string[]; allowance: string; userApproved?: boolean }[] };
}
const policy = parseJson<Policy>(read(repositoryRoot, "tooling/policy.json"));
const inventory = protectedModule.createInventory(policy.protected);
const declared = policy.protected as { files: string[]; dirs: string[] };

const claude = parseJson<ClaudeSettings>(read(declarations, ".claude/settings.json"));
const codexHooks = parseJson<CodexHooks>(read(declarations, ".codex/hooks.json"));
const codexConfig = read(declarations, ".codex/config.toml");
// The generator also holds its own, not yet activated, rules next to the ones it stages for applications.
const rulesFiles = {
  declared: read(declarations, ".codex/rules/publishing.rules"),
  ...(isGenerator ? { generator: read(repositoryRoot, ".codex/rules/publishing.rules") } : {}),
};

const CLAUDE_EVENTS = { PreToolUse: "pre", PostToolUse: "post", PostToolUseFailure: "post-failure", ConfigChange: "config-change", Stop: "stop" };
const CODEX_EVENTS = { PreToolUse: "pre", PostToolUse: "post", Stop: "stop" };
// Every tool that can write files: the shell tools, Claude's file tools and MCP tools.
const CLAUDE_TOOLS = ["Bash", "Monitor", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit", "mcp__.*"];
/** The registered hook: it refuses, in every shell, when the launcher is missing (a stop only reports), and otherwise runs it. */
const registered = (base: string, client: string, event: string) =>
  `f="${base}/scripts/hooks/launch.sh"; [ -f "$f" ] || { echo "Protected-files guard launcher is missing: $f" >&2; exit ${event === "stop" ? "1" : "2"}; }; exec sh "$f" --client ${client} --event ${event}`;
const entryOf = (entries: HookEntry[] | undefined): HookEntry => {
  expect(entries).toHaveLength(1);
  return entries?.[0] ?? { hooks: [] };
};

describe("Claude Code", () => {
  test("runs without an OS sandbox and without a bare Bash allowance", () => {
    expect(claude).not.toHaveProperty("sandbox");
    expect(claude.permissions.defaultMode).toBe("acceptEdits");
    expect(claude.permissions.allow).not.toContain("Bash");
  });

  test.each(Object.entries(CLAUDE_EVENTS))("%s runs the guard launcher with the %s event", (event, argument) => {
    const entry = entryOf(claude.hooks[event]);
    expect(entry.hooks).toEqual([{ type: "command", command: registered("$CLAUDE_PROJECT_DIR", "claude", argument) }]);
    if (event.startsWith("Pre") || event.startsWith("Post")) expect(entry.matcher?.split("|")).toEqual(CLAUDE_TOOLS);
    else expect(entry).not.toHaveProperty("matcher");
    expect(guard.parseArgv(["--client", "claude", "--event", argument])).toEqual({ client: "claude", event: argument });
  });

  test("declares exactly the guard events, and the guard's own registration check accepts the settings", () => {
    expect(Object.keys(claude.hooks).sort()).toEqual(Object.keys(CLAUDE_EVENTS).sort());
    expect(guard.guardRegistered(claude)).toBe(true);
    expect(guard.guardRegistered({ hooks: { ...claude.hooks, Stop: [] } })).toBe(false);
  });

  test("asks before editing every protected file and directory of the policy inventory", () => {
    const ask = claude.permissions.ask;
    for (const file of declared.files) expect(ask, file).toContain(`Edit(/${file})`);
    for (const dir of declared.dirs) expect(ask, dir).toContain(`Edit(/${dir}/**)`);
  });

  test("every Edit rule it asks about names something the inventory protects", () => {
    const rules = claude.permissions.ask.flatMap((rule) => /^Edit\(\/(.+)\)$/.exec(rule)?.[1] ?? []);
    expect(rules.length).toBeGreaterThan(declared.files.length);
    for (const rule of rules) {
      const directory = rule.endsWith("/**") ? rule.slice(0, -3) : null;
      if (directory === null) expect(inventory.isProtectedFile(rule), rule).toBe(true);
      else expect(declared.dirs, rule).toContain(directory);
    }
  });

  /** The permission rule a guard command is declared as: a flag or a positional makes it a prefix rule. */
  const rulesOf = (command: Policy["guard"]["commands"][number]): string[] => {
    const text = command.argv.join(" ");
    const open = command.flags !== undefined || command.positional !== undefined;
    const optional = command.positional === undefined && Object.values(command.flags ?? {}).every((kind) => kind.endsWith("?"));
    return open ? [...(optional ? [`Bash(${text})`] : []), `Bash(${text} *)`] : [`Bash(${text})`];
  };

  test("runs the guard's approved commands without asking and asks for the user-approved ones", () => {
    const { allow, ask } = claude.permissions;
    for (const command of policy.guard.commands) {
      const rules = rulesOf(command);
      if (command.userApproved === true) {
        for (const rule of rules) {
          expect(ask, command.id).toContain(rule);
          expect(allow, command.id).not.toContain(rule);
        }
      } else {
        for (const rule of rules) expect(allow, command.id).toContain(rule);
      }
    }
  });

  test("does not grant a general bootstrap, shell or interpreter allowance", () => {
    for (const rule of claude.permissions.allow) {
      expect(rule, rule).toMatch(/^Bash\((?:pnpm run [a-z:-]+(?: .*)?|node scripts\/bootstrap\.cjs (?:setup|repair|deps-lock))\)$/);
      expect(rule).not.toMatch(/guard-accept|release:|template:|update\.cjs|\bnode \*|\bsh\b|\bbash\b/);
    }
    expect(claude.permissions.allow).toContain("Bash(pnpm run test:one --test=tests/*)");
  });

  test.each([
    "git switch *",
    "git checkout *",
    "git pull",
    "git pull *",
    "git merge *",
    "git rebase *",
    "git restore *",
    "git stash",
    "git stash *",
    "git reset *",
    "git cherry-pick *",
    "gh pr checkout *",
    "git push",
    "git push *",
    "gh pr create",
    "gh pr create *",
    "gh pr merge",
    "gh pr merge *",
  ])("asks before %s", (command) => {
    expect(claude.permissions.ask).toContain(`Bash(${command})`);
  });
});

describe("Codex", () => {
  test("runs without a sandbox and every prompt reaches a person", () => {
    expect(codexConfig).toMatch(/^sandbox_mode = "danger-full-access"$/m);
    expect(codexConfig).toMatch(/^approval_policy = "on-request"$/m);
    expect(codexConfig).toMatch(/^approvals_reviewer = "user"$/m);
    const remoteCatalogSetting = /^\[features\]\nremote_plugin = false\n(?=\n\[|$)/m;
    expect(codexConfig).toMatch(remoteCatalogSetting);
    expect(codexConfig.replace(remoteCatalogSetting, "")).not.toMatch(/^(?:default_permissions|permissions|features)\b|^\[(?:permissions|features)/m);
  });

  test("declares exactly the pre, post and stop events", () => {
    expect(Object.keys(codexHooks.hooks).sort()).toEqual(Object.keys(CODEX_EVENTS).sort());
  });

  test.each(Object.entries(CODEX_EVENTS))("%s runs the guard launcher with the %s event", (event, argument) => {
    const entry = entryOf(codexHooks.hooks[event]);
    expect(entry.hooks).toEqual([{ type: "command", command: registered("$(git rev-parse --show-toplevel)", "codex", argument) }]);
    if (event === "Stop") expect(entry).not.toHaveProperty("matcher");
    else expect(entry.matcher).toBe("Bash|apply_patch");
    expect(guard.parseArgv(["--client", "codex", "--event", argument])).toEqual({ client: "codex", event: argument });
  });

  test("the tools its matcher names are the ones the guard classifies", () => {
    // Codex documents shell execution as Bash and file edits as apply_patch; the guard also reads the shell tool names a rollout records.
    expect(policyModule.SHELL_TOOLS.has("Bash")).toBe(true);
    expect(policyModule.SHELL_TOOLS.has("exec_command")).toBe(true);
    expect(policyModule.patchPaths("*** Update File: package.json\n*** Move to: other.json")).toEqual(["package.json", "other.json"]);
  });
});

describe.each(Object.entries(rulesFiles))("publishing rules (%s)", (_label, text) => {
  const rules = prefixRules(text);
  const PUBLISHING = [
    ["git", "switch"],
    ["git", "checkout"],
    ["git", "pull"],
    ["git", "merge"],
    ["git", "rebase"],
    ["git", "reset"],
    ["git", "restore"],
    ["git", "stash"],
    ["git", "cherry-pick"],
    ["gh", "pr", "checkout", "1"],
    ["git", "push"],
    ["git", "push", "origin", "feature"],
    ["gh", "pr", "create", "--fill"],
    ["gh", "pr", "merge", "52", "--merge"],
    ["pnpm", "run", "release:bump", "patch"],
    ["pnpm", "run", "release:tag"],
    ["node", "scripts/bootstrap.cjs", "guard-accept"],
  ];

  test("only ever prompt, and carry no template syntax", () => {
    expect(rules.length).toBeGreaterThan(0);
    expect(new Set(rules.map((rule) => rule.decision))).toEqual(new Set(["prompt"]));
    expect(text).not.toMatch(/\{\{|\{%|\{#/);
  });

  test.each(PUBLISHING)("covers %s", (...command) => {
    expect(rules.some((rule) => ruleMatches(rule, command))).toBe(true);
  });

  test.each([
    ["git", "status"],
    ["pnpm", "run", "check"],
    ["gh", "pr", "view"],
    ["pnpm", "run", "template:apply"],
    ["node", "scripts/template/update.cjs", "abort"],
    ["node", "scripts/bootstrap.cjs", "setup"],
  ])("leaves %s alone", (...command) => {
    expect(rules.some((rule) => ruleMatches(rule, command))).toBe(false);
  });

  test("prompts for every user-approved command of the policy", () => {
    for (const command of policy.guard.commands.filter((entry) => entry.userApproved === true)) {
      const argv = [...command.argv, ...(command.positional?.slice(0, 1) ?? [])];
      expect(
        rules.some((rule) => ruleMatches(rule, argv)),
        command.id,
      ).toBe(true);
    }
  });
});

describe("the human update boundary and the host settings the agents share", () => {
  test("neither host pre-approves the template update, so an agent cannot apply it", () => {
    expect(claude.permissions.allow.filter((rule) => rule.includes("template"))).toEqual([]);
    for (const text of Object.values(rulesFiles)) expect(prefixRules(text).filter((rule) => rule.decision === "allow")).toEqual([]);
  });

  test("enables only the sanctioned plugin, declares its marketplace and names no retired plugin", () => {
    for (const root of new Set([declarations, repositoryRoot])) {
      const settings = parseJson<ClaudeSettings>(read(root, ".claude/settings.json"));
      expect(settings["syncClaudeAiPlugins"]).toBe(false);
      expect(settings["disableClaudeAiConnectors"]).toBe(true);
      expect(read(root, ".codex/config.toml")).toMatch(/^\[features\]\nremote_plugin = false\n(?=\n\[|$)/m);
    }
    expect(claude["enabledPlugins"]).toEqual({ "compound-engineering@compound-engineering-plugin": true });
    const marketplaces = claude["extraKnownMarketplaces"] as Record<string, { source: { source: string; repo: string } }>;
    for (const plugin of Object.keys(claude["enabledPlugins"] as object)) {
      const source = marketplaces[plugin.split("@")[1] ?? ""]?.source;
      expect(source?.source).toBe("github");
      expect(source?.repo).toBeTruthy();
    }
    for (const text of [read(declarations, ".claude/settings.json").toLowerCase(), read(declarations, "AGENTS.md").toLowerCase()]) {
      expect(text).not.toContain("superpowers");
      expect(text).not.toContain("caveman");
    }
  });

  test("setup installs exactly the plugins and marketplaces both hosts declare, in project scope", () => {
    const declaration = pluginsModule.claudeDeclaration(Buffer.from(read(declarations, ".claude/settings.json")));
    expect(declaration.plugins).toEqual(Object.keys(claude["enabledPlugins"] as object));
    expect(declaration.marketplaces).toEqual(
      Object.values(claude["extraKnownMarketplaces"] as Record<string, { source: { repo: string } }>).map((entry) => entry.source.repo),
    );
    expect(pluginsModule.codexMarketplaces(Buffer.from(codexConfig))).toEqual(["compound-engineering-plugin"]);
  });

  test("the shared policy imports into Claude and states the rules the declarations enforce", () => {
    expect(read(declarations, "CLAUDE.md")).toBe("@AGENTS.md\n");
    const agents = read(declarations, "AGENTS.md");
    expect(agents).not.toMatch(/BEGIN:nextjs-agent|NEXT-AGENTS-MD/);
    for (const text of [
      "pnpm run check",
      "node scripts/bootstrap.cjs guard-accept",
      "72 characters",
      "never squash",
      "not an operating-system sandbox",
      "node_modules/next/dist/docs/",
    ])
      expect(agents).toContain(text);
  });
});

describe("Git hook bypasses are no approved route", () => {
  test.each([
    "git commit --no-verify -m x",
    "git commit -nm x",
    "git push --no-verify",
    "SKIP=lint git commit -m x",
    "HUSKY=0 git commit -m x",
    "git -c core.hooksPath=/tmp git commit -m x",
    "git config core.hooksPath /dev/null",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath git commit",
  ])("%s is refused", (command) => {
    expect(
      policyModule.switchOffReason(command, {
        words: policyModule.simpleWords(command),
        route: null,
        kind: policyModule.gitKind(policyModule.simpleWords(command) ?? []),
      }),
    ).toMatch(/^Refused:/);
  });

  test("none of the guard's approved commands is a hook route", () => {
    expect(policy.guard.commands.filter((command) => /hook|verify|push|commit/.test(command.argv.join(" ")))).toEqual([]);
  });
});
