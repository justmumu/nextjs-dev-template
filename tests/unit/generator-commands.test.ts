import { resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

const { createCancellation } = createRequire(import.meta.url)("../../scripts/testing/owned.cjs") as typeof import("../../scripts/testing/owned.cjs");

const templateCommands = createRequire(import.meta.url)("../../scripts/template/commands.cjs") as typeof import("../../scripts/template/commands.cjs");
const { UsageError } = createRequire(import.meta.url)("../../scripts/core/args.cjs") as typeof import("../../scripts/core/args.cjs");
const development = createRequire(import.meta.url)("../../scripts/development.cjs") as typeof import("../../scripts/development.cjs");

describe("generator-only commands", () => {
  const root = resolve(import.meta.dirname, "../..");
  const sink = () => capture().io;
  const generator = (name: string) => development.COMMANDS[name]?.handlers.generator;

  test("template:create needs every answer before anything is rendered or written", () => {
    const create = generator("template:create");
    for (const args of [[], ["--name=a-app"], ["--name=a-app", "--owner=o"], ["--owner=o", "--dest=out"]]) {
      expect(() => create?.(args, { root, cwd: root, io: sink() }), args.join(" ")).toThrow(/is required/);
    }
  });

  test("template:seed:refresh takes no arguments, and the application does not have either command", () => {
    expect(() => generator("template:seed:refresh")?.(["--force=1"], { root, cwd: root, io: sink() })).toThrow(/unknown flag/);
    for (const name of ["template:create", "template:seed:refresh"]) expect(development.COMMANDS[name]?.handlers.application, name).toBeUndefined();
  });
});

describe("production proofs of the generator", () => {
  type Host = NonNullable<Parameters<typeof templateCommands.inRenderedApp>[2]>;
  function host(options: { install?: number | null; command?: number | null } = {}) {
    const steps: string[] = [];
    const value: Host = {
      scratch: () => "/scratch",
      remove: (dir) => steps.push(`remove ${dir}`),
      render: (dest) => steps.push(`render ${dest}`),
      install: (dir) => {
        steps.push(`install ${dir}`);
        return options.install === undefined ? 0 : options.install;
      },
      command: (dir, command) => {
        steps.push(`run ${command} in ${dir}`);
        return options.command === undefined ? 0 : options.command;
      },
    };
    return { value, steps };
  }

  test("renders an application, installs it from its frozen lock, runs the application's own command in it and removes it", async () => {
    const { value, steps } = host({ command: 5 });
    expect(await templateCommands.inRenderedApp("test:e2e", capture().io, value)).toBe(5);
    expect(steps).toEqual(["render /scratch/app", "install /scratch/app", "run test:e2e in /scratch/app", "remove /scratch"]);
  });

  test("an application that cannot be installed is not run, and is still removed", async () => {
    const { value, steps } = host({ install: 1 });
    const sink = capture();
    expect(await templateCommands.inRenderedApp("test:artifact", sink.io, value)).toBe(1);
    expect(steps).toEqual(["render /scratch/app", "install /scratch/app", "remove /scratch"]);
    expect(sink.err()).toMatch(/could not be installed from its frozen lock/);
  });

  test("a command that was killed by a signal is a failure", async () => {
    expect(await templateCommands.inRenderedApp("test:e2e", capture().io, host({ command: null }).value)).toBe(1);
  });

  test("an interrupted run starts nothing after the step that was running, and still removes its scratch", async () => {
    const cancel = createCancellation();
    const { value, steps } = host();
    const interrupted: Host = {
      ...value,
      install: (dir) => {
        steps.push(`install ${dir}`);
        cancel.cancel("SIGTERM");
        return null;
      },
    };
    expect(await templateCommands.inRenderedApp("test:e2e", capture().io, interrupted, cancel)).toBe(1);
    expect(steps).toEqual(["render /scratch/app", "install /scratch/app", "remove /scratch"]);
  });

  test("a run interrupted before it starts renders nothing", async () => {
    const cancel = createCancellation();
    cancel.cancel("SIGINT");
    const { value, steps } = host();
    expect(await templateCommands.inRenderedApp("test:e2e", capture().io, value, cancel)).toBe(1);
    expect(steps).toEqual(["remove /scratch"]);
  });

  test("both commands take no arguments", () => {
    for (const run of [templateCommands.testE2e, templateCommands.testArtifact]) {
      expect(() => run(["--headed=1"], { root: "/r", cwd: "/r", io: capture().io })).toThrow(/unknown flag/);
    }
  });
});

describe("a command that owns asynchronous work", () => {
  const root = resolve(import.meta.dirname, "../..");
  const handlers = development.COMMANDS["test:e2e"]?.handlers;
  const original = handlers?.generator;
  const restore = () => {
    if (handlers && original) handlers.generator = original;
  };
  const answer = (handler: NonNullable<typeof original>) => {
    if (handlers) handlers.generator = handler;
  };

  test("answers with a promise of its status, and reports a usage error as status 2 after it", async () => {
    try {
      answer(() => Promise.resolve(143));
      expect(await development.main(["test:e2e"], { root, io: capture().io, skipPreflight: true })).toBe(143);
      const sink = capture();
      answer(() => Promise.reject(new UsageError("bad argument")));
      expect(await development.main(["test:e2e"], { root, io: sink.io, skipPreflight: true })).toBe(2);
      expect(sink.err()).toBe("bad argument\n");
      answer(() => Promise.reject(new Error("unexpected")));
      await expect(development.main(["test:e2e"], { root, io: capture().io, skipPreflight: true })).rejects.toThrow("unexpected");
    } finally {
      restore();
    }
  });

  test("cannot run as a synchronous gate", () => {
    try {
      answer(() => Promise.resolve(0));
      expect(() => development.mainSync(["test:e2e"], { root, io: capture().io, skipPreflight: true })).toThrow(/asynchronous work/);
    } finally {
      restore();
    }
    expect(development.mainSync(["nothing"], { root, io: capture().io, skipPreflight: true })).toBe(2);
  });
});
