import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseJson } from "./json.ts";

/** The project root: the generator itself, or a generated application. */
export const repositoryRoot = resolve(import.meta.dirname, "../..");
export const isGenerator = parseJson<{ role: string }>(readFileSync(join(repositoryRoot, "tooling/project-role.json"), "utf8")).role === "generator";
/**
 * Where the final host declarations live: in an application they are its own files; the generator
 * stages them below its application seed until the coherent activation.
 */
export const declarations = isGenerator ? join(repositoryRoot, "template/app") : repositoryRoot;

type Json = Record<string, unknown>;
export interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}
export interface ClaudeSettings extends Json {
  hooks: Record<string, HookEntry[]>;
  permissions: { defaultMode: string; allow: string[]; ask: string[] };
}
export interface CodexHooks {
  hooks: Record<string, HookEntry[]>;
}

export const read = (base: string, path: string): string => readFileSync(join(base, path), "utf8");
export const present = (base: string, path: string): boolean => existsSync(join(base, path));

export interface PrefixRule {
  pattern: (string | string[])[];
  decision: string;
}

/** The prefix_rule calls of a Codex rules file, read as data: the file is Starlark and is never executed. */
export function prefixRules(text: string): PrefixRule[] {
  const rules: PrefixRule[] = [];
  for (const call of text.replace(/^\s*#.*$/gm, "").matchAll(/prefix_rule\(([\s\S]*?)\n\)/g)) {
    const body = call[1] ?? "";
    const pattern = /pattern\s*=\s*(\[[\s\S]*?\]),\s*\n/.exec(body)?.[1];
    if (pattern === undefined) throw new Error(`a prefix_rule without a pattern: ${body}`);
    // Codex treats a rule without a decision as "allow".
    const decision = /decision\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? "allow";
    rules.push({ pattern: parseJson<(string | string[])[]>(pattern.replace(/,(\s*\])/g, "$1")), decision });
  }
  return rules;
}

/** Whether a rule's prefix pattern matches the start of a command, as Codex matches argv. */
export function ruleMatches(rule: PrefixRule, argv: string[]): boolean {
  return (
    argv.length >= rule.pattern.length && rule.pattern.every((part, index) => (Array.isArray(part) ? part.includes(argv[index] ?? "") : part === argv[index]))
  );
}
