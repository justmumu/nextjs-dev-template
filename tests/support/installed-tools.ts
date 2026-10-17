import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** The pnpm process running the canonical test command, without a host-specific shell or Corepack shim. */
export function installedPnpm(): string {
  const executable = process.env.npm_execpath;
  if (!executable || !isAbsolute(executable) || !existsSync(executable)) throw new Error("run this fixture through the canonical pnpm test command");
  return executable;
}

/** Keep the installed toolchain available without exposing optional agent CLIs from the user's PATH. */
export function agentFreePath(area: string): string {
  const bin = join(area, "fixture-tools");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(installedPnpm(), join(bin, "pnpm"));
  return `${bin}:/usr/bin:/bin`;
}
