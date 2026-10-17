type Harness = typeof import("../../scripts/testing/harness.cjs");
export type Host = Parameters<Harness["prepareFixture"]>[0]["host"];

export interface Call {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * A harness host that records every tool it is asked to run, every directory it is asked to stage
 * or remove, and answers with scripted statuses, so the order and the environment of a run can be
 * judged without starting, copying or deleting anything. Scratch directories are names only unless
 * a scratch function is given.
 */
export function fakeHost(options: { statuses?: (number | null)[]; isolated?: boolean; removeFails?: string; scratch?: (prefix: string) => string } = {}) {
  const calls: Call[] = [];
  const removed: string[] = [];
  const staged: Parameters<Host["stage"]>[0][] = [];
  const statuses = [...(options.statuses ?? [])];
  let scratches = 0;
  const host: Host = {
    run: (command, args, runOptions) => {
      calls.push({ command, args, ...runOptions });
      const next = statuses.shift();
      return Promise.resolve(next === undefined ? 0 : next);
    },
    isolation: () =>
      options.isolated === false
        ? { available: false, reason: "no namespaces here" }
        : { available: true, wrap: (command, args) => ({ command: "isolate", args: [command, ...args] }) },
    scratch: (prefix) => options.scratch?.(prefix) ?? `/scratch/${prefix}${String(++scratches)}`,
    stage: (stageOptions) => {
      staged.push(stageOptions);
    },
    remove: (dir) => {
      removed.push(dir);
      if (options.removeFails === dir) throw new Error(`cannot remove ${dir}`);
    },
  };
  return { host, calls, removed, staged };
}
