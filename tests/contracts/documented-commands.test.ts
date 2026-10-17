import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseJson, type Manifest } from "../support/json.ts";

// Every command the public text tells a person to run is a real script or one of the few documented
// exceptions, in this project and in the applications it emits. The same file runs in both roles.

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const isGenerator = parseJson<{ role: string }>(read("tooling/project-role.json")).role === "generator";
const policy = parseJson<{ forbiddenTools: string[] }>(read("tooling/policy.json"));

/** The generator documents the commands of the applications it creates as well as its own. */
const scripts = new Set([
  ...Object.keys(parseJson<Manifest>(read("package.json")).scripts ?? {}),
  ...(isGenerator ? Object.keys(parseJson<Manifest>(read("template/app/package.json")).scripts ?? {}) : []),
]);

function markdownFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
    .flatMap((entry) => (entry.isDirectory() ? markdownFiles(`${directory}/${entry.name}`) : entry.name.endsWith(".md") ? [`${directory}/${entry.name}`] : []));
}
const documents = ["README.md", "AGENTS.md", ...markdownFiles("docs")];

/** Inline code and fenced `sh` blocks, which are where a document tells a person what to type. */
function commandsOf(text: string): string[] {
  const fenced = [...text.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)].flatMap((match) => (match[1] ?? "").split("\n"));
  const inline = [...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
  return [...fenced, ...inline].map((line) => line.trim()).filter((line) => line !== "");
}

const BOOTSTRAP = new Set(["setup", "repair", "deps-lock", "guard-accept"]);
const UPDATE = new Set(["inspect", "resume", "abort"]);

describe("the commands the public text documents", () => {
  test("there is public text to check", () => {
    expect(documents).toContain("docs/getting-started.md");
    expect(documents).toContain("docs/contributing/agents.md");
    expect(documents).toContain("docs/guides/first-use.md");
  });

  test("every `pnpm run <script>` names a script of the project or of the applications it emits", () => {
    const unknown: string[] = [];
    for (const document of documents) {
      for (const command of commandsOf(read(document))) {
        for (const match of command.matchAll(/\bpnpm run ([a-z][a-z0-9:-]*)/g)) {
          if (!scripts.has(match[1] ?? "")) unknown.push(`${document}: ${command}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  test("every `node scripts/...` command names a file the project ships and a subcommand it has", () => {
    const wrong: string[] = [];
    for (const document of documents) {
      for (const command of commandsOf(read(document))) {
        for (const match of command.matchAll(/\bnode (scripts\/[\w/.-]+\.cjs)(?: ([a-z-]+))?/g)) {
          const [, file = "", subcommand] = match;
          if (!existsSync(join(root, file))) wrong.push(`${document}: ${command} (no ${file})`);
          if (file === "scripts/bootstrap.cjs" && subcommand !== undefined && !BOOTSTRAP.has(subcommand)) wrong.push(`${document}: ${command}`);
          if (file === "scripts/template/update.cjs" && subcommand !== undefined && !UPDATE.has(subcommand)) wrong.push(`${document}: ${command}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("every bootstrap subcommand is one the dispatcher implements", () => {
    const source = read("scripts/bootstrap.cjs");
    for (const subcommand of BOOTSTRAP) expect(source, subcommand).toContain(`"${subcommand}"`);
  });

  test("no shell block tells a person to run a tool the project forbids", () => {
    const offenders: string[] = [];
    for (const document of documents) {
      for (const match of read(document).matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)) {
        for (const line of (match[1] ?? "").split("\n")) {
          const first = line.trim().split(/\s+/)[0] ?? "";
          if (policy.forbiddenTools.includes(first)) offenders.push(`${document}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the command table of the toolchain page lists every script the project has", () => {
    const toolchain = read("docs/contributing/toolchain.md");
    const own = Object.keys(parseJson<Manifest>(read("package.json")).scripts ?? {});
    // `release:bump` and its siblings share one row group; a script counts as listed when its name appears.
    expect(own.filter((script) => !toolchain.includes(script) && !toolchain.includes(`${script.split(":")[0] ?? script}:*`))).toEqual([]);
  });

  test("the agent policy and the public guides state the prerequisites that JavaScript-only tooling still has", () => {
    for (const path of ["docs/guides/platforms.md", "docs/getting-started.md", "docs/index.md"]) {
      const text = read(path);
      expect(text, path).toMatch(/\bGit\b/);
      expect(text, path).toMatch(/\bfile\b/);
    }
    expect(read("AGENTS.md")).toMatch(/Git\s+and\s+the\s+operating\s+system's\s+`file`/);
  });
});
