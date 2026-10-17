import { readFileSync } from "node:fs";

/** Parses JSON the test knows the shape of; the shape is the test's assertion, not a validation. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller states the shape of a fixture file it knows
export function parseJson<T = Record<string, unknown>>(text: string): T {
  return JSON.parse(text) as T;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test helper: the caller states the shape of a fixture file it knows
export function readJsonFile<T = Record<string, unknown>>(path: string): T {
  return parseJson<T>(readFileSync(path, "utf8"));
}

export interface Versions {
  node: string;
  pnpm: string;
  root: { devDependencies: Record<string, string> };
  seed: { dependencies: Record<string, string>; devDependencies: Record<string, string>; deniedBuilds: string[] };
}

export interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  private?: boolean;
  packageManager?: string;
  engines?: { node?: string };
  devEngines?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** A package.json a test edits in place before writing it back. */
export interface EditableManifest {
  scripts: Record<string, string>;
  engines: Record<string, string>;
  devDependencies: Record<string, string>;
  [key: string]: unknown;
}

export interface Listed {
  name: string;
  path: string;
}
