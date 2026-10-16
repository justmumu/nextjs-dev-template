import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { gate, generatorFixture, installRenderedApp, output, removeDir, root, run, scratchDir, writeProjectFile } from "../support/rendered-app.ts";

// Real ESLint, Prettier, tsc and pnpm run through the canonical commands of the generator and of an
// independently installed rendered application. The unit suites never reach this file.

const scratch = scratchDir("static-policy-");
afterAll(() => {
  removeDir(scratch);
});

const REASON = "-- upstream parser limitation tracked in the vendor issue";

/** The stylish report block of one file: its path line up to the next blank line. */
function report(text: string, file: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.endsWith(`/${file}`));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && line.trim() === "");
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

const LINT_FILES = {
  "scripts/control.cjs":
    '// @ts-check\n"use strict";\n/** @param {string[]} items @returns {number} */\nfunction count(items) {\n  return items.length;\n}\nmodule.exports = { count };\n',
  "scripts/unsafe-any.cjs":
    '"use strict";\n/** @param {string} text @returns {string} */\nfunction read(text) {\n  const parsed = JSON.parse(text);\n  return parsed.value;\n}\nmodule.exports = { read };\n',
  "scripts/floating.cjs": '"use strict";\nasync function work() {\n  await Promise.resolve();\n}\nwork();\n',
  "scripts/index.cjs":
    '"use strict";\n/** @param {string[]} items @returns {number} */\nfunction first(items) {\n  return items[0].length;\n}\nmodule.exports = { first };\n',
  "scripts/dead-suppression.cjs": `"use strict";\n// eslint-disable-next-line no-console ${REASON}\nconst value = 1;\nmodule.exports = { value };\n`,
  "scripts/broad.cjs": `"use strict";\n/* eslint-disable ${REASON} */\nconsole.log("x");\n`,
  "scripts/broad-bare.cjs": '"use strict";\n/* eslint-disable */\ndebugger;\n',
  "scripts/no-reason.cjs": '"use strict";\n// eslint-disable-next-line no-debugger\ndebugger;\n',
  "scripts/ts-ignore.cjs": '"use strict";\n// @ts-ignore\nconst value = 1 + "a";\nmodule.exports = { value };\n',
  "scripts/justified.cjs": `"use strict";\n// eslint-disable-next-line no-debugger ${REASON}\ndebugger;\n`,
  // Inline configuration may not switch the enforcement or any other check off.
  "scripts/disable-the-enforcer.cjs": '"use strict";\n/* eslint suppression-policy/require-specific-reason: "off" */\n/* eslint-disable */\ndebugger;\n',
  "scripts/weaken-a-rule.cjs":
    '"use strict";\n/* eslint @typescript-eslint/no-floating-promises: "off" */\nasync function work() {\n  await Promise.resolve();\n}\nwork();\n',
  "scripts/line-comment-config.cjs": '"use strict";\n/*eslint no-debugger:0*/\ndebugger;\n',
  // Words inside strings, templates, regular expressions and ordinary comments are not directives.
  "scripts/words-only.cjs":
    '"use strict";\nconst example = "/* eslint-disable */ and // eslint-disable-next-line no-debugger";\nconst template = `/* eslint x: "off" */`;\nconst pattern = /\\/\\* eslint-disable \\*\\//;\n// Documentation may mention eslint-disable and eslint-env without being a directive here.\nmodule.exports = { example, template, pattern };\n',
  "scripts/unbound.cjs":
    '"use strict";\nclass Counter {\n  constructor() {\n    this.total = 0;\n  }\n  /** @returns {number} */\n  bump() {\n    this.total += 1;\n    return this.total;\n  }\n}\nconst counter = new Counter();\nconst { bump } = counter;\nmodule.exports = { value: bump() };\n',
  "scripts/safe-node.cjs":
    '"use strict";\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst { readFileSync } = require("node:fs");\n/** @param {string} dir @returns {string} */\nfunction read(dir) {\n  return fs.readFileSync(path.join(dir, "a"), "utf8") + readFileSync(path.join(dir, "b"), "utf8");\n}\nmodule.exports = { read };\n',
};

const UGLY_MARKDOWN = "#   Title\n\n*   item\n*   other\n";
const UGLY_YAML = "name:   ci\non:\n    push:\n        branches: [ main ]\n";

describe.each([
  ["generator", () => generatorFixture(scratch, "generator", LINT_FILES)],
  ["application", () => installRenderedApp(scratch, "policy-app")],
] as const)("%s static gates", (kind, prepare) => {
  let dir = "";
  beforeAll(() => {
    dir = prepare();
    if (kind === "application") for (const [path, content] of Object.entries(LINT_FILES)) writeProjectFile(dir, path, content);
  }, 240_000);

  describe("lint", () => {
    let lint: ReturnType<typeof gate>;
    beforeAll(() => {
      lint = gate(dir, "lint", kind);
    }, 240_000);
    const block = (file: string) => report(output(lint), file);

    test.each([
      ["scripts/unsafe-any.cjs", /no-unsafe-member-access|no-unsafe-return|no-unsafe-assignment/],
      ["scripts/floating.cjs", /no-floating-promises/],
      ["scripts/dead-suppression.cjs", /Unused eslint-disable directive/],
      ["scripts/broad.cjs", /suppression-policy/],
      ["scripts/broad-bare.cjs", /suppression-policy/],
      ["scripts/no-reason.cjs", /suppression-policy/],
      ["scripts/ts-ignore.cjs", /ban-ts-comment/],
      ["scripts/disable-the-enforcer.cjs", /suppression-policy/],
      ["scripts/weaken-a-rule.cjs", /suppression-policy/],
      ["scripts/line-comment-config.cjs", /suppression-policy/],
      ["scripts/unbound.cjs", /unbound-method/],
    ])("%s is rejected", (file, message) => {
      expect(block(file)).toMatch(message);
    });

    test.each(["scripts/control.cjs", "scripts/justified.cjs", "scripts/words-only.cjs", "scripts/safe-node.cjs"])("%s is accepted", (file) => {
      expect(block(file)).toBe("");
    });

    test("the gate fails and no refusal has an invalid position", () => {
      expect(lint.status).toBe(1);
      expect(output(lint)).not.toMatch(/\b\d+:(0|-\d+)\s/);
    });
  });

  test("lint:fix cannot be used to get past the suppression policy", () => {
    writeProjectFile(dir, "scripts/fix-bypass.cjs", LINT_FILES["scripts/disable-the-enforcer.cjs"]);
    const result = gate(dir, "lint:fix", kind);
    expect(result.status).toBe(1);
    expect(report(output(result), "scripts/fix-bypass.cjs")).toMatch(/suppression-policy/);
  }, 240_000);

  test("an unchecked index access fails strict typing", () => {
    const result =
      kind === "generator"
        ? gate(dir, "typecheck", kind)
        : run(dir, process.execPath, [join(dir, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.tooling.json"]);
    expect(output(result)).toMatch(/scripts\/index\.cjs.*TS(2532|18048)/);
    expect(result.status).not.toBe(0);
  }, 240_000);

  describe("format", () => {
    test("unformatted public Markdown and workflow YAML fail format:check and are repaired by format", () => {
      // Normalise the lint fixtures first so that only the files under test can fail the check.
      expect(gate(dir, "format", kind).status).toBe(0);
      writeProjectFile(dir, "docs/guide.md", UGLY_MARKDOWN);
      writeProjectFile(dir, ".github/workflows/ci.yml", UGLY_YAML);
      writeProjectFile(dir, ".compound-engineering/private-notes.md", UGLY_MARKDOWN);
      writeProjectFile(dir, ".private/notes.md", UGLY_MARKDOWN);
      const workspace = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8");

      const failing = gate(dir, "format:check", kind);
      expect(failing.status).toBe(1);
      expect(output(failing)).toMatch(/docs\/guide\.md/);
      expect(output(failing)).toMatch(/ci\.yml/);
      expect(output(failing)).not.toMatch(/private-notes|\.private/);

      const repaired = gate(dir, "format", kind);
      expect(repaired.status, output(repaired)).toBe(0);
      expect(readFileSync(join(dir, "docs/guide.md"), "utf8")).not.toBe(UGLY_MARKDOWN);
      expect(readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8")).not.toBe(UGLY_YAML);
      expect(readFileSync(join(dir, ".compound-engineering/private-notes.md"), "utf8")).toBe(UGLY_MARKDOWN);
      expect(readFileSync(join(dir, ".private/notes.md"), "utf8")).toBe(UGLY_MARKDOWN);
      expect(readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8")).toBe(workspace);

      const passing = gate(dir, "format:check", kind);
      expect(output(passing)).not.toMatch(/warn/);
      expect(passing.status).toBe(0);
    }, 240_000);
  });
});

describe("generated application gates", () => {
  let app = "";
  beforeAll(() => {
    app = installRenderedApp(scratch, "next-app");
  }, 240_000);

  const pnpm = (...args: string[]) => run(app, "pnpm", ["run", ...args]);

  test("a checkout without .next or next-env.d.ts passes typegen, typecheck, lint and format", () => {
    for (const command of ["typecheck", "lint", "format:check"]) {
      const result = pnpm(command);
      expect(output(result), command).not.toMatch(/not available yet|error/i);
      expect(result.status, command).toBe(0);
    }
  });

  test("unsafe any, floating promises, unchecked indexes and dead suppressions fail the application gates", () => {
    writeProjectFile(
      app,
      "src/lib/unsafe.ts",
      "export function read(text: string): string {\n  const parsed = JSON.parse(text);\n  return parsed.value;\n}\nexport async function work(): Promise<void> {\n  await Promise.resolve();\n}\nwork();\nexport function first(items: string[]): number {\n  return items[0].length;\n}\n// eslint-disable-next-line no-console -- vendor logging limitation tracked upstream\nexport const dead = 1;\n",
    );
    const lint = pnpm("lint");
    expect(lint.status).toBe(1);
    expect(output(lint)).toMatch(/no-unsafe-member-access|no-unsafe-return/);
    expect(output(lint)).toMatch(/no-floating-promises/);
    expect(output(lint)).toMatch(/Unused eslint-disable directive/);
    const types = pnpm("typecheck");
    expect(types.status).not.toBe(0);
    expect(output(types)).toMatch(/src\/lib\/unsafe\.ts.*TS2532|TS18048/);
  });

  test("directive-like words in TSX strings, templates and expressions are not directives", () => {
    writeProjectFile(
      app,
      "src/lib/words.tsx",
      'export function Words(): React.JSX.Element {\n  const note = "/* eslint-disable */";\n  return <p title={`// eslint-disable-next-line ${note}`}>{note}</p>;\n}\n',
    );
    const lint = pnpm("lint");
    expect(report(output(lint), "src/lib/words.tsx")).toBe("");
  });

  test("a managed Next agent block requires an explicit migration instead of a silent baseline change", () => {
    for (const [file, marker] of [
      ["AGENTS.md", "<!-- BEGIN:nextjs-agent-rules -->\nrules\n<!-- END:nextjs-agent-rules -->\n"],
      ["CLAUDE.md", "<!-- NEXT-AGENTS-MD-START -->\nrules\n<!-- NEXT-AGENTS-MD-END -->\n"],
    ] as const) {
      writeProjectFile(app, file, `# Rules\n\n${marker}`);
      const result = pnpm("typecheck");
      expect(result.status, file).not.toBe(0);
      expect(output(result), file).toMatch(/migrat/i);
      expect(readFileSync(join(app, file), "utf8"), file).toContain(marker);
      writeProjectFile(app, file, "# Rules\n");
    }
  });

  test("the generator shares the same suppression policy source as the application", () => {
    expect(readFileSync(join(app, "tooling/eslint/suppression-policy.mjs"), "utf8")).toBe(
      readFileSync(join(root, "tooling/eslint/suppression-policy.mjs"), "utf8"),
    );
  });
});
