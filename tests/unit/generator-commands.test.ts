import { resolve } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture } from "../support/project.ts";

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
