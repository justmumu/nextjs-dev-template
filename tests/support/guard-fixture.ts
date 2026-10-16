import { cpSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterAll } from "vitest";

const require = createRequire(import.meta.url);
export const repositoryRoot = resolve(import.meta.dirname, "../..");
export const stateModule = require("../../scripts/hooks/state.cjs") as typeof import("../../scripts/hooks/state.cjs");
export const guardModule = require("../../scripts/hooks/guard.cjs") as typeof import("../../scripts/hooks/guard.cjs");

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@users.noreply.github.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@users.noreply.github.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/** The guard and the shared modules it loads, as a generated project holds them. */
const SHIPPED = ["scripts/core", "scripts/hooks", "scripts/dependencies.cjs", "scripts/bootstrap.cjs", "tooling/policy.json"];

export const WORKSPACE = readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");

export const PACKAGE = JSON.stringify(
  { name: "fixture", version: "1.0.0", private: true, scripts: { check: "node scripts/development.cjs check" }, dependencies: {}, devDependencies: {} },
  null,
  2,
);

export const PROJECT_FILES: Record<string, string> = {
  "package.json": PACKAGE,
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": WORKSPACE,
  ".npmrc": "engine-strict=true\n",
  ".node-version": "24.21.0\n",
  ".gitignore": "node_modules/\n",
  "AGENTS.md": "# Rules\n",
  "CLAUDE.md": "@AGENTS.md\n",
  "tsconfig.json": '{"compilerOptions":{"strict":true}}\n',
  "src/app.ts": "export const app = 1;\n",
  "tooling/capabilities.json": JSON.stringify({ guard: true, hooks: false }),
  "tooling/project-role.json": JSON.stringify({ role: "application" }),
};

export interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
  write(path: string, content: string): void;
  read(path: string): string;
  git(...args: string[]): string;
  /** Runs the launcher the way a host does, with a minimal environment that holds neither node nor pnpm. */
  launch(
    event: string,
    payload: unknown,
    options?: { client?: string; env?: NodeJS.ProcessEnv; raw?: string },
  ): { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> };
  /** Runs one event in this process against the real worktree. */
  run(event: string, payload: Record<string, unknown>, client?: string): { status: number; stdout: string; stderr: string; json: Record<string, unknown> };
  /** Runs one tool call: the pre hook, the effect, the post hook. */
  call(
    command: string,
    effect?: () => void,
    options?: { client?: string; failed?: boolean; extra?: Record<string, unknown> },
  ): { pre: Record<string, unknown>; post: Record<string, unknown> };
  accept(): number;
}

/** A scratch area removed when the calling file finishes. */
export function guardArea(prefix: string) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  afterAll(() => {
    rmSync(area, { recursive: true, force: true });
  });
  let counter = 0;

  function createFixture(extra: Record<string, string> = {}, options: { bind?: boolean; commit?: boolean } = {}): Fixture {
    const root = join(area, `p${++counter}`);
    const home = join(area, `home${counter}`);
    mkdirSync(root, { recursive: true });
    mkdirSync(home, { recursive: true });
    for (const item of SHIPPED) {
      mkdirSync(dirname(join(root, item)), { recursive: true });
      cpSync(join(repositoryRoot, item), join(root, item), { recursive: true });
    }
    for (const [path, content] of Object.entries({ ...PROJECT_FILES, ...extra })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: join(home, ".codex"), ...GIT_ENV };
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout;
    };
    git("init", "-q", "-b", "main");
    if (options.commit !== false) {
      git("add", "-A");
      git("commit", "-q", "-m", "init");
    }
    if (options.bind !== false) stateModule.bindNode(root, process.execPath);

    let calls = 0;
    const launch: Fixture["launch"] = (event, payload, launchOptions = {}) => {
      const result = spawnSync("sh", [join(root, "scripts/hooks/launch.sh"), "--client", launchOptions.client ?? "claude", "--event", event], {
        cwd: root,
        env: { ...env, ...launchOptions.env },
        input: launchOptions.raw ?? JSON.stringify(payload),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        json: result.stdout.trim() ? (JSON.parse(result.stdout) as Record<string, unknown>) : {},
      };
    };
    const run: Fixture["run"] = (event, payload, client = "claude") => {
      const input = join(area, `input-${counter}-${++calls}.json`);
      writeFileSync(input, JSON.stringify(payload));
      const fd = openSync(input, "r");
      const out: string[] = [];
      const err: string[] = [];
      const saved = { ...process.env };
      Object.assign(process.env, env);
      try {
        const status = guardModule.main(["--client", client, "--event", event], {
          cwd: root,
          stdin: fd,
          stdout: (text) => out.push(text),
          stderr: (text) => err.push(text),
        });
        return { status, stdout: out.join(""), stderr: err.join(""), json: out.join("").trim() ? (JSON.parse(out.join("")) as Record<string, unknown>) : {} };
      } finally {
        closeSync(fd);
        for (const key of Object.keys(env)) if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
        Object.assign(process.env, saved);
      }
    };
    return {
      root,
      env,
      write(path, content) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      },
      read: (path) => readFileSync(join(root, path), "utf8"),
      git,
      launch,
      run,
      call(command, effect = () => undefined, callOptions = {}) {
        const payload = { cwd: root, tool_name: "Bash", tool_input: { command }, tool_use_id: `call-${++calls}`, ...callOptions.extra };
        const client = callOptions.client ?? "claude";
        const pre = run("pre", payload, client);
        if (Object.keys(pre.json).length > 0 || pre.status !== 0) return { pre: pre.json, post: {} };
        effect();
        return { pre: pre.json, post: run(callOptions.failed ? "post-failure" : "post", payload, client).json };
      },
      accept: () => {
        const saved = { ...process.env };
        Object.assign(process.env, env);
        try {
          return guardModule.main(["--event", "accept"], { cwd: root, stdout: () => undefined, stderr: () => undefined });
        } finally {
          for (const key of Object.keys(env)) if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
          Object.assign(process.env, saved);
        }
      },
    };
  }
  return { area, createFixture };
}

export const denial = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)?.permissionDecisionReason ?? "";
