import { existsSync, readFileSync } from "node:fs";

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const until = async (done: () => boolean, ms: number) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline && !done();) await new Promise((wait) => setTimeout(wait, 50));
  return done();
};

/** The process ids a fixture program wrote to files; a file that is missing or not yet complete names nothing. */
export const recordedPids = (files: readonly string[]): number[] =>
  files.flatMap((file) => {
    if (!existsSync(file)) return [];
    const text = readFileSync(file, "utf8").trim();
    return /^\d+$/.test(text) ? [Number(text)] : [];
  });

/**
 * Failure cleanup for a test that starts processes: kills each recorded process that is still alive
 * (each one individually: a recorded id is never taken to be a process group), tries every one even
 * when another fails, ignores only a process that is already gone, and waits for them to exit.
 */
export async function reclaim(pids: readonly number[], ms = 10_000): Promise<void> {
  const failures: string[] = [];
  const owned: number[] = [];
  for (const pid of new Set(pids)) {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      failures.push(`not a process id that may be killed: ${String(pid)}`);
      continue;
    }
    owned.push(pid);
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") failures.push(`${String(pid)}: ${(error as Error).message}`);
    }
  }
  if (!(await until(() => owned.every((pid) => !alive(pid)), ms))) failures.push(`still running: ${owned.filter(alive).join(", ")}`);
  if (failures.length > 0) throw new Error(`fixture cleanup failed: ${failures.join("; ")}`);
}
