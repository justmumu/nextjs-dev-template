import { describe, expect, test } from "vitest";
import plugin from "../../tooling/eslint/suppression-policy.mjs";

const processor = plugin.processors.enforce;

/** Lints nothing, but runs the processor the way ESLint does and returns what it refuses. */
function refusals(text: string, name = "file.ts") {
  const blocks = processor.preprocess?.(text, name);
  expect(blocks).toEqual([text]);
  return processor.postprocess?.([[]], name) ?? [];
}

const REASON = "the upstream parser reports this value as unknown";

describe("suppression policy processor", () => {
  test("accepts a named rule with a concrete reason on the next line", () => {
    expect(refusals(`// eslint-disable-next-line no-console -- ${REASON}\nconsole.log(1);\n`)).toEqual([]);
    expect(refusals(`/* eslint-disable-next-line a-rule, b-rule -- ${REASON} */\nx();\n`)).toEqual([]);
  });

  test.each([
    ["a file-wide disable", `/* eslint-disable */\nx();\n`],
    ["a named file-wide disable", `/* eslint-disable no-console -- ${REASON} */\nx();\n`],
    ["a same-line disable", `x(); // eslint-disable-line no-console -- ${REASON}\n`],
    ["a re-enable", `/* eslint-enable */\nx();\n`],
    ["an inline configuration", `/* eslint no-console: "off" */\nx();\n`],
    ["an environment comment", `/* eslint-env node */\nx();\n`],
    ["no rule named", `// eslint-disable-next-line -- ${REASON}\nx();\n`],
    ["no reason", `// eslint-disable-next-line no-console\nx();\n`],
    ["a token reason", `// eslint-disable-next-line no-console -- ok\nx();\n`],
  ])("refuses %s", (_label, text) => {
    const found = refusals(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ ruleId: "suppression-policy/require-specific-reason", severity: 2, line: expect.any(Number) as number });
  });

  test("reports the position of each refused comment", () => {
    const found = refusals(`const a = 1;\n  // eslint-disable-next-line no-console\nconst b = 2; /* eslint-enable */\n`);
    expect(found.map(({ line, column }) => [line, column])).toEqual([
      [2, 3],
      [3, 14],
    ]);
  });

  test("words inside strings, templates, regular expressions and JSX text are not directives", () => {
    expect(refusals('const a = "/* eslint-disable */";\nconst b = `// eslint-disable-next-line`;\nconst c = /eslint-disable/;\n')).toEqual([]);
    expect(refusals("export const view = <p>// eslint-disable-next-line</p>;\n", "view.tsx")).toEqual([]);
    expect(refusals("// eslint-disable-nextline is only prose\nx();\n")).toEqual([]);
  });

  test("JavaScript files are parsed too, and a directive in JSX attributes position is found", () => {
    expect(refusals("/* eslint-disable */\nmodule.exports = 1;\n", "file.cjs")).toHaveLength(1);
    expect(refusals("export const view = <p title={/* eslint-disable */ 'x'}>y</p>;\n", "view.tsx")).toHaveLength(1);
  });

  test("results of one file never leak into another", () => {
    processor.preprocess?.("/* eslint-disable */\n", "a.ts");
    processor.preprocess?.("x();\n", "b.ts");
    expect(processor.postprocess?.([[]], "b.ts")).toEqual([]);
    expect(processor.postprocess?.([[]], "a.ts")).toHaveLength(1);
    expect(processor.postprocess?.([[]], "a.ts")).toEqual([]);
  });

  test("ordinary lint messages are kept ahead of the refusals", () => {
    processor.preprocess?.("/* eslint-disable */\n", "c.ts");
    const kept = { ruleId: "no-undef", severity: 2 as const, message: "x", line: 1, column: 1 };
    const result = processor.postprocess?.([[kept]], "c.ts");
    expect(result?.[0]).toBe(kept);
    expect(result).toHaveLength(2);
  });
});
