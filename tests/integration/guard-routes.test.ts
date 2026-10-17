import { chmodSync, openSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { parseJson } from "../support/json.ts";
import { PACKAGE, WORKSPACE, denial, guardArea, guardModule, repositoryRoot, stateModule, type Fixture } from "../support/guard-fixture.ts";

const require = createRequire(import.meta.url);
const bootstrap = require("../../scripts/bootstrap.cjs") as typeof import("../../scripts/bootstrap.cjs");
const installState = require("../../scripts/core/install-state.cjs") as typeof import("../../scripts/core/install-state.cjs");
const processes = require("../../scripts/core/process.cjs") as typeof import("../../scripts/core/process.cjs");

type Host = NonNullable<NonNullable<Parameters<typeof bootstrap.main>[1]>["host"]>;
const { createFixture, area } = guardArea("guard-routes-");

/** One file of every kind the inventory protects, so each canonical path is exercised for real. */
const reasonOf = (output: Record<string, unknown>) => (typeof output["reason"] === "string" ? output["reason"] : "");

const CANONICAL: Record<string, string> = {
  ".nvmrc": "24\n",
  ".gitattributes": "* text=auto\n",
  ".editorconfig": "root = true\n",
  ".prettierignore": "dist\n",
  ".eslintignore": "dist\n",
  ".npmignore": "src\n",
  ".pnpmfile.cjs": "module.exports = {};\n",
  "tsconfig.app.json": "{}\n",
  "next.config.ts": "export default {};\n",
  "eslint.config.mjs": "export default [];\n",
  ".eslintrc.json": "{}\n",
  ".prettierrc.json": "{}\n",
  "prettier.config.mjs": "export default {};\n",
  "vitest.config.ts": "export default {};\n",
  "vitest.app.config.ts": "export default {};\n",
  "playwright.config.ts": "export default {};\n",
  "postcss.config.mjs": "export default {};\n",
  "scripts/development.cjs": "module.exports = 1;\n",
  "tooling/project-role.json.bak": "{}\n",
  "tooling/versions.json": "{}\n",
  ".claude/settings.json": "{}\n",
  ".codex/config.toml": "model = 'x'\n",
  ".githooks/pre-commit": "#!/bin/sh\n",
  ".husky/pre-commit": "#!/bin/sh\n",
  "docs/site.config.ts": "export default {};\n",
  "docs/.vitepress/config.ts": "export default {};\n",
  "docs/.vitepress/config/nav.ts": "export default [];\n",
  "template/app/package.json": "{}\n",
  "template/app/tsconfig.json": "{}\n",
};

const SHADOWS = [
  "src/.npmrc",
  "tests/vitest.config.ts",
  "packages/a/pnpm-workspace.yaml",
  "src/eslint.config.mjs",
  "src/.prettierrc.json",
  "src/.pnpmfile.cjs",
  "lib/prettier.config.mjs",
  "src/.eslintrc.json",
  "src/playwright.config.ts",
  "app/vitest.workspace.ts",
];

const NEW_PROTECTED = ["scripts/dist/new.cjs", "tooling/new.json", ".codex/rules/allow.rules", ".githooks/commit-msg"];

function canonicalPaths(fixture: Fixture): string[] {
  const tracked = fixture.git("ls-files", "-z").split("\0").filter(Boolean);
  const inventory = require("../../scripts/core/protected.cjs") as typeof import("../../scripts/core/protected.cjs");
  return tracked.filter((path) => inventory.isProtectedFile(path)).sort();
}

describe("every canonical protected path, for real (R16, R17)", () => {
  const fixture = createFixture(CANONICAL);
  const paths = canonicalPaths(fixture);

  test("the fixture really holds every kind of protected path", () => {
    for (const expected of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      ".node-version",
      ".gitignore",
      "AGENTS.md",
      "CLAUDE.md",
      "tsconfig.json",
      ...Object.keys(CANONICAL),
    ])
      expect(paths, expected).toContain(expected);
    expect(paths.length).toBeGreaterThan(40);
  });

  test("a first call records the baseline of the committed project and admits", () => {
    expect(fixture.run("pre", { cwd: fixture.root, tool_name: "Bash", tool_input: { command: "true" }, tool_use_id: "first" }).json).toEqual({});
    fixture.run("post", { cwd: fixture.root, tool_name: "Bash", tool_input: { command: "true" }, tool_use_id: "first" });
    const stored = JSON.parse(readFileSync(join(fixture.root, ".git/protected-baseline/state.json"), "utf8")) as { files: Record<string, string> };
    for (const path of paths) expect(stored.files[path], path).toBeTruthy();
    expect(stateModule.status(fixture.root)).toEqual({ clean: true });
  });

  test("a worktree edit of each path is restored", () => {
    const originals = Object.fromEntries(paths.map((path) => [path, fixture.read(path)]));
    const { post } = fixture.call("node -e 'edit everything'", () => {
      for (const path of paths) fixture.write(path, "tampered\n");
    });
    expect(post.decision).toBe("block");
    for (const path of paths) expect(fixture.read(path), path).toBe(originals[path]);
  });

  test("a staged edit of each path is unstaged and restored", () => {
    const originals = Object.fromEntries(paths.map((path) => [path, fixture.read(path)]));
    const { post } = fixture.call("git add everything", () => {
      for (const path of paths) fixture.write(path, "staged tampering\n");
      fixture.git("add", "-A");
    });
    expect(String(post.reason)).toMatch(/Unstaged unapproved changes/);
    expect(fixture.git("diff", "--cached", "--name-only")).toBe("");
    for (const path of paths) expect(fixture.read(path), path).toBe(originals[path]);
  });

  test("a symlink put in place of each path is replaced by the approved content", () => {
    const originals = Object.fromEntries(paths.map((path) => [path, fixture.read(path)]));
    fixture.call("ln -s src/app.ts everything", () => {
      for (const path of paths) {
        rmSync(join(fixture.root, path));
        symlinkSync(join(fixture.root, "src/app.ts"), join(fixture.root, path));
      }
    });
    for (const path of paths) {
      expect(lstatSync(join(fixture.root, path)).isSymbolicLink(), path).toBe(false);
      expect(fixture.read(path), path).toBe(originals[path]);
    }
  });

  test("a deletion of each path is restored", () => {
    const originals = Object.fromEntries(paths.map((path) => [path, fixture.read(path)]));
    fixture.call("rm everything", () => {
      for (const path of paths) rmSync(join(fixture.root, path));
    });
    for (const path of paths) expect(fixture.read(path), path).toBe(originals[path]);
  });

  test("a mode change of an executable protected file is restored", () => {
    const script = join(fixture.root, ".githooks/pre-commit");
    const before = lstatSync(script).mode & 0o777;
    fixture.call("chmod +x", () => {
      chmodSync(script, 0o755);
    });
    expect(lstatSync(script).mode & 0o777).toBe(before);
  });

  test("a new shadow configuration is removed, whether it is only created or also staged, and ordinary source beside it stays", () => {
    fixture.write("src/user.ts", "export const user = 1;\n");
    const { post } = fixture.call("write shadows", () => {
      for (const path of SHADOWS) fixture.write(path, "x\n");
      fixture.git("add", "-f", ...SHADOWS);
    });
    expect(String(post.reason)).toMatch(/restored|Unstaged/);
    for (const path of SHADOWS) expect(existsSync(join(fixture.root, path)), path).toBe(false);
    expect(fixture.git("diff", "--cached", "--name-only")).toBe("");
    expect(fixture.read("src/user.ts")).toBe("export const user = 1;\n");
  });

  test("a new file in a protected directory is removed, including one under a build-output name", () => {
    fixture.call("write new protected files", () => {
      for (const path of NEW_PROTECTED) fixture.write(path, "x\n");
    });
    for (const path of NEW_PROTECTED) expect(existsSync(join(fixture.root, path)), path).toBe(false);
  });

  test("ordinary source edits are never blocked or restored", () => {
    const { pre, post } = fixture.call("echo more >> src/app.ts", () => {
      fixture.write("src/app.ts", "export const app = 2;\n");
    });
    expect(pre).toEqual({});
    expect(post).toEqual({});
    expect(fixture.read("src/app.ts")).toBe("export const app = 2;\n");
  });

  test("a protected directory replaced by a link out of the worktree is never followed, and stays a hold for the user", () => {
    const outside = join(area, "outside");
    mkdirSync(outside, { recursive: true });
    const { post } = fixture.call("ln -s outside scripts", () => {
      rmSync(join(fixture.root, "scripts"), { recursive: true });
      symlinkSync(outside, join(fixture.root, "scripts"));
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(String(post.reason)).toMatch(/could not be restored/);
    expect(stateModule.status(fixture.root).clean).toBe(false);
  });
});

describe("edits by the hosts (R20)", () => {
  test("a Codex patch to a protected file is denied for real, an ordinary one is not", () => {
    const fixture = createFixture();
    const patch = (file: string) => `*** Begin Patch\n*** Update File: ${file}\n*** End Patch`;
    const attempt = (file: string, id: string) =>
      fixture.run("pre", { cwd: fixture.root, tool_name: "apply_patch", tool_input: { command: patch(file) }, tool_use_id: id }, "codex").json;
    expect(denial(attempt("AGENTS.md", "p1"))).toMatch(/ask the user/i);
    expect(denial(attempt("tooling/policy.json", "p2"))).toMatch(/ask the user/i);
    expect(attempt("src/app.ts", "p3")).toEqual({});
  });

  test("an edit the user approved is kept for exactly that path; an unapproved one beside it is restored; ordinary edits pass", () => {
    const fixture = createFixture();
    const edit = (path: string, id: string) => ({
      cwd: fixture.root,
      tool_name: "Write",
      tool_input: { file_path: join(fixture.root, path), content: "x" },
      tool_use_id: id,
    });
    const ordinary = fixture.run("pre", edit("src/app.ts", "e0"));
    expect(ordinary.json).toEqual({});
    fixture.run("post", edit("src/app.ts", "e0"));
    expect(fixture.run("pre", edit("AGENTS.md", "e1")).json).toEqual({});
    fixture.write("AGENTS.md", "# Approved edit\n");
    fixture.write("tsconfig.json", "{}\n");
    const post = fixture.run("post", edit("AGENTS.md", "e1"));
    expect(post.json.decision).toBe("block");
    expect(fixture.read("AGENTS.md")).toBe("# Approved edit\n");
    expect(fixture.read("tsconfig.json")).toBe('{"compilerOptions":{"strict":true}}\n');
  });

  test("an edit through a symlink to a protected file, and an edit of the guard's own baseline, are recognized", () => {
    const fixture = createFixture();
    symlinkSync("AGENTS.md", join(fixture.root, "alias.md"));
    const alias = { cwd: fixture.root, tool_name: "Edit", tool_input: { file_path: join(fixture.root, "alias.md") }, tool_use_id: "a1" };
    expect(fixture.run("pre", alias).json).toEqual({});
    const stored = JSON.parse(readFileSync(join(fixture.root, ".git/protected-baseline/state.json"), "utf8")) as {
      inflight: Record<string, { exclusive: boolean }>;
    };
    expect(stored.inflight["a1"]?.exclusive).toBe(true);
    const state = {
      cwd: fixture.root,
      tool_name: "Write",
      tool_input: { file_path: join(fixture.root, ".git/protected-baseline/state.json") },
      tool_use_id: "a2",
    };
    expect(denial(fixture.run("pre", state).json)).toMatch(/belongs to the guard/);
  });
});

describe("approved dependency and formatting routes (R11, KTD11, AE4)", () => {
  const withDependency = () => JSON.stringify({ ...JSON.parse(PACKAGE), dependencies: { "left-pad": "1.3.0" } }, null, 2);
  const add = "pnpm run deps:add --package=left-pad@1.3.0 --group=prod";

  test("a dependency add keeps the dependency map and the lock, and nothing beside them", () => {
    const fixture = createFixture();
    const { pre, post } = fixture.call(add, () => {
      fixture.write("package.json", withDependency());
      fixture.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters: {}\n");
    });
    expect(pre).toEqual({});
    expect(post).toEqual({});
    expect(parseJson<{ dependencies: unknown }>(fixture.read("package.json")).dependencies).toEqual({ "left-pad": "1.3.0" });
    expect(fixture.call("true").pre).toEqual({});
  });

  test.each([
    ["scripts.check", () => JSON.stringify({ ...JSON.parse(withDependency()), scripts: { check: "node evil.cjs" } }, null, 2)],
    ["engines", () => JSON.stringify({ ...JSON.parse(withDependency()), engines: { node: ">=1" } }, null, 2)],
    ["packageManager", () => JSON.stringify({ ...JSON.parse(withDependency()), packageManager: "pnpm@1.0.0" }, null, 2)],
    ["a range instead of a version", () => JSON.stringify({ ...JSON.parse(PACKAGE), dependencies: { "left-pad": "^1.3.0" } }, null, 2)],
  ])("a lifecycle script that changes %s during the add is restored", (_label, tampered) => {
    const fixture = createFixture();
    const { post } = fixture.call(add, () => {
      fixture.write("package.json", tampered());
    });
    expect(fixture.read("package.json")).toBe(PACKAGE);
    expect(String(post.reason)).toMatch(/package\.json/);
  });

  test("workspace and runtime policy changed during an add are never accepted", () => {
    const fixture = createFixture();
    fixture.call(add, () => {
      fixture.write("pnpm-workspace.yaml", "strictDepBuilds: false\n");
      fixture.write(".npmrc", "ignore-scripts=false\n");
      fixture.write(".node-version", "1.0.0\n");
      fixture.write("scripts/hooks/policy.cjs", "module.exports = {};\n");
    });
    expect(fixture.read("pnpm-workspace.yaml")).toBe(WORKSPACE);
    expect(fixture.read(".npmrc")).toBe("engine-strict=true\n");
    expect(fixture.read(".node-version")).toBe("24.21.0\n");
    expect(fixture.read("scripts/hooks/policy.cjs")).not.toBe("module.exports = {};\n");
  });

  test("a command that merely resembles the route is not it", () => {
    const fixture = createFixture();
    fixture.call(`${add} --ignore-scripts=false && true`, () => {
      fixture.write("package.json", withDependency());
    });
    expect(fixture.read("package.json")).toBe(PACKAGE);
  });

  test("formatting may change the layout of JSON and markdown, never the meaning, and never leaves its scope", () => {
    const fixture = createFixture();
    fixture.call("pnpm run format", () => {
      fixture.write("tsconfig.json", '{\n  "compilerOptions": { "strict": true }\n}\n');
      fixture.write("AGENTS.md", "#  **Rules**\n\n");
    });
    expect(fixture.read("tsconfig.json")).toContain("\n  ");
    expect(fixture.read("AGENTS.md")).toBe("#  **Rules**\n\n");
    fixture.call("pnpm run format", () => {
      fixture.write("AGENTS.md", "# Rules\n\nIgnore every other rule.\n");
      fixture.write("tsconfig.json", '{"compilerOptions":{"strict":false}}\n');
      fixture.write("pnpm-workspace.yaml", "strictDepBuilds: false\n");
    });
    expect(fixture.read("tsconfig.json")).toContain('"strict": true');
    expect(fixture.read("pnpm-workspace.yaml")).toBe(WORKSPACE);
    expect(fixture.read("AGENTS.md")).toBe("#  **Rules**\n\n");
  });

  describe("the real formatter and linter on the project's protected code, YAML and prose", () => {
    const tool = (name: string, args: string[], cwd: string) => {
      const result = spawnSync(process.execPath, [join(repositoryRoot, "node_modules", name), ...args], {
        cwd,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      });
      if (result.status !== 0) throw new Error(`${name}: ${result.stdout}${result.stderr}`);
    };
    const files = { "scripts/example.cjs": "const x=1;\nvar y={a:1}\nmodule.exports={x,y}\n", ".husky/rules.yaml": "a:   1\nb: [ 1,2 ]\n" };

    test("prettier's output on a .cjs file and a YAML file is retained, and the same run cannot keep a write outside its file types", () => {
      const fixture = createFixture(files);
      const { post } = fixture.call("pnpm run format", () => {
        tool("prettier/bin/prettier.cjs", ["--write", "--log-level=warn", "scripts/example.cjs", ".husky/rules.yaml"], fixture.root);
        fixture.write("pnpm-workspace.yaml", "strictDepBuilds: false\n");
        fixture.write(".npmrc", "ignore-scripts=false\n");
      });
      expect(fixture.read("scripts/example.cjs")).toBe("const x = 1;\nvar y = { a: 1 };\nmodule.exports = { x, y };\n");
      expect(fixture.read(".husky/rules.yaml")).toBe("a: 1\nb: [1, 2]\n");
      expect(fixture.read("pnpm-workspace.yaml")).toBe(WORKSPACE);
      expect(fixture.read(".npmrc")).toBe("engine-strict=true\n");
      expect(String(post.reason)).toMatch(/pnpm-workspace\.yaml/);
      expect(String(post.reason)).not.toMatch(/example\.cjs|rules\.yaml/);
      expect(fixture.call("true").pre).toEqual({});
    });

    const REVIEWED = `# policy\n\n\nstrictDepBuilds: true\nverifyDepsBeforeRun: error\nenablePrePostScripts: false\nskills:\n  dirs: []\nallowBuilds: {}\noverrides:\n  'vitepress@1.6.4>@docsearch/js': 3.9.0\n  'vitepress@1.6.4>@docsearch/css': 3.9.0\n`;

    test("prettier's layout of an approved, valid-but-unformatted workspace file is retained, and a policy change in the same run is not", () => {
      const fixture = createFixture({ "pnpm-workspace.yaml": REVIEWED });
      fixture.call("pnpm run format", () => {
        tool("prettier/bin/prettier.cjs", ["--write", "--log-level=warn", "pnpm-workspace.yaml"], fixture.root);
      });
      const formatted = fixture.read("pnpm-workspace.yaml");
      expect(formatted).not.toBe(REVIEWED);
      expect(formatted).toContain('"vitepress@1.6.4>@docsearch/js": 3.9.0');
      expect(formatted).not.toContain("\n\n\n");
      const { post } = fixture.call("pnpm run format", () => {
        fixture.write("pnpm-workspace.yaml", formatted.replace("allowBuilds: {}", "allowBuilds:\n  evil: true").replace("3.9.0", "3.8.2"));
      });
      expect(fixture.read("pnpm-workspace.yaml")).toBe(formatted);
      expect(String(post.reason)).toMatch(/pnpm-workspace\.yaml/);
    });

    test("a standalone commit keeps the formatting its hook applies to the workspace file after the guard's check", () => {
      const fixture = createFixture({ "pnpm-workspace.yaml": REVIEWED });
      const prettier = join(repositoryRoot, "node_modules/prettier/bin/prettier.cjs");
      fixture.write(
        ".git/hooks/pre-commit",
        `#!/bin/sh\nsh scripts/hooks/launch.sh --event pre-commit || exit 1\n"${process.execPath}" "${prettier}" --write --log-level=warn pnpm-workspace.yaml || exit 1\ngit add pnpm-workspace.yaml\n`,
      );
      chmodSync(join(fixture.root, ".git/hooks/pre-commit"), 0o755);
      let result: ReturnType<typeof spawnSync> | undefined;
      const { pre, post } = fixture.call("git commit -q -m fmt", () => {
        fixture.write("src/app.ts", "export const app = 2;\n");
        fixture.git("add", "src/app.ts");
        result = spawnSync("git", ["-C", fixture.root, "commit", "-q", "-m", "fmt"], { env: fixture.env, encoding: "utf8" });
      });
      expect(pre).toEqual({});
      expect(String(result?.stderr)).toBe("");
      expect(result?.status).toBe(0);
      expect(post).toEqual({});
      expect(fixture.read("pnpm-workspace.yaml")).toContain('"vitepress@1.6.4>@docsearch/css": 3.9.0');
      expect(fixture.git("show", "HEAD:pnpm-workspace.yaml")).toBe(fixture.read("pnpm-workspace.yaml"));
    });

    test("eslint's fixes on protected code are retained by lint:fix, but a YAML or JSON write in the same run is refused", () => {
      const fixture = createFixture(files);
      fixture.call("pnpm run lint:fix", () => {
        tool("eslint/bin/eslint.js", ["--no-config-lookup", "--fix", "--rule", "no-var: error", "scripts/example.cjs"], fixture.root);
        fixture.write(".husky/rules.yaml", "a: 2\n");
        fixture.write("tsconfig.json", '{"compilerOptions":{"strict":false}}\n');
      });
      expect(fixture.read("scripts/example.cjs")).toContain("let y");
      expect(fixture.read(".husky/rules.yaml")).toBe(files[".husky/rules.yaml"]);
      expect(fixture.read("tsconfig.json")).toContain('"strict":true');
    });

    test("a mode change or a link in place of the file is not covered by the formatting route", () => {
      const fixture = createFixture(files);
      fixture.call("pnpm run format", () => {
        chmodSync(join(fixture.root, "scripts/example.cjs"), 0o755);
        rmSync(join(fixture.root, ".husky/rules.yaml"));
        symlinkSync("../AGENTS.md", join(fixture.root, ".husky/rules.yaml"));
      });
      expect(lstatSync(join(fixture.root, "scripts/example.cjs")).mode & 0o111).toBe(0);
      expect(lstatSync(join(fixture.root, ".husky/rules.yaml")).isSymbolicLink()).toBe(false);
      expect(fixture.read(".husky/rules.yaml")).toBe(files[".husky/rules.yaml"]);
    });
  });

  test("an environment change by an add is accepted, one outside a route needs a repair", () => {
    const fixture = createFixture();
    const modules = join(fixture.root, "node_modules");
    mkdirSync(join(modules, ".bin"), { recursive: true });
    mkdirSync(join(modules, ".pnpm", "a@1", "node_modules", "a"), { recursive: true });
    writeFileSync(join(modules, ".pnpm", "a@1", "node_modules", "a", "index.js"), "1");
    writeFileSync(join(modules, ".bin", "tool"), "#!/bin/sh\n");
    writeFileSync(join(modules, ".modules.yaml"), "layoutVersion: 5\n");
    symlinkSync(".pnpm/a@1/node_modules/a", join(modules, "a"));
    fixture.accept();
    expect(
      fixture.call(add, () => {
        fixture.write("package.json", withDependency());
        symlinkSync(".pnpm/a@1/node_modules/a", join(modules, "b"));
      }).post,
    ).toEqual({});
    expect(fixture.call("true").pre).toEqual({});
    const { post } = fixture.call("ln -sf elsewhere node_modules/a", () => {
      rmSync(join(modules, "a"));
      symlinkSync("../../evil", join(modules, "a"));
    });
    expect(String(post.reason)).toMatch(/repair/);
    expect(denial(fixture.call("true").pre)).toMatch(/repair/);
    expect(stateModule.status(fixture.root).reason).toMatch(/repair/);
    const repaired = fixture.call("node scripts/bootstrap.cjs repair", () => {
      rmSync(join(modules, "a"));
      symlinkSync(".pnpm/a@1/node_modules/a", join(modules, "a"));
    });
    expect(repaired.pre).toEqual({});
    expect(fixture.call("true").pre).toEqual({});
  });
});

describe("the environment fingerprint claims links and metadata only (R21)", () => {
  function environment() {
    const fixture = createFixture();
    const modules = join(fixture.root, "node_modules");
    mkdirSync(join(modules, ".bin"), { recursive: true });
    mkdirSync(join(modules, ".pnpm", "a@1", "node_modules", "a"), { recursive: true });
    writeFileSync(join(modules, ".pnpm", "a@1", "node_modules", "a", "index.js"), "1");
    writeFileSync(join(modules, ".bin", "tool"), "#!/bin/sh\n");
    writeFileSync(join(modules, ".modules.yaml"), "layoutVersion: 5\n");
    symlinkSync(".pnpm/a@1/node_modules/a", join(modules, "a"));
    fixture.accept();
    return { fixture, modules };
  }
  const drifted = (fixture: Fixture, effect: () => void) => /repair/.test(reasonOf(fixture.call("touch node_modules", effect).post));

  test.each([
    [
      "a link retargeted",
      (modules: string) => {
        rmSync(join(modules, "a"));
        symlinkSync("../elsewhere", join(modules, "a"));
      },
    ],
    [
      "a package link added",
      (modules: string) => {
        symlinkSync("../x", join(modules, "extra"));
      },
    ],
    [
      "a binary added to .bin",
      (modules: string) => {
        writeFileSync(join(modules, ".bin", "evil"), "x");
      },
    ],
    [
      "a binary rewritten with another size",
      (modules: string) => {
        writeFileSync(join(modules, ".bin", "tool"), "#!/bin/sh\necho evil\n");
      },
    ],
    [
      "the modules manifest touched",
      (modules: string) => {
        utimesSync(join(modules, ".modules.yaml"), new Date(1_000_000), new Date(1_000_000));
      },
    ],
    [
      "a virtual-store entry added",
      (modules: string) => {
        mkdirSync(join(modules, ".pnpm", "evil@1"));
      },
    ],
    [
      "a package directory added",
      (modules: string) => {
        mkdirSync(join(modules, "newpkg"));
      },
    ],
  ])("%s is drift", (_label, effect) => {
    const { fixture, modules } = environment();
    expect(
      drifted(fixture, () => {
        effect(modules);
      }),
    ).toBe(true);
  });

  test.each([
    [
      "a cache under a dot directory",
      (modules: string) => {
        mkdirSync(join(modules, ".vite"), { recursive: true });
        writeFileSync(join(modules, ".vite", "cache"), "x");
      },
    ],
    [
      "a dot file",
      (modules: string) => {
        writeFileSync(join(modules, ".cache-marker"), "x");
      },
    ],
  ])("%s is not drift", (_label, effect) => {
    const { fixture, modules } = environment();
    expect(
      drifted(fixture, () => {
        effect(modules);
      }),
    ).toBe(false);
  });

  test("the content of a file inside a package is not claimed: the fingerprint says nothing about global store integrity", () => {
    const { fixture, modules } = environment();
    expect(
      drifted(fixture, () => {
        writeFileSync(join(modules, ".pnpm", "a@1", "node_modules", "a", "index.js"), "tampered with different length");
      }),
    ).toBe(false);
  });
});

describe("commits, history and conflicts, for real (R17)", () => {
  const hook = (fixture: Fixture) => {
    fixture.write(".git/hooks/pre-commit", "#!/bin/sh\nsh scripts/hooks/launch.sh --event pre-commit || exit 1\n");
    chmodSync(join(fixture.root, ".git/hooks/pre-commit"), 0o755);
  };
  const tryGit = (fixture: Fixture, ...args: string[]) => spawnSync("git", ["-C", fixture.root, ...args], { env: fixture.env, encoding: "utf8" });

  test("an agent commit that would carry unapproved staged content is rejected by the commit hook", () => {
    const fixture = createFixture();
    hook(fixture);
    const head = fixture.git("rev-parse", "HEAD");
    let result: ReturnType<typeof tryGit> | undefined;
    const { post } = fixture.call("git commit -q -m sneak", () => {
      fixture.write("AGENTS.md", "# loosened\n");
      fixture.git("add", "AGENTS.md");
      result = tryGit(fixture, "commit", "-q", "-m", "sneak");
    });
    expect(result?.status).not.toBe(0);
    expect(result?.stderr).toMatch(/Unapproved protected changes are staged: AGENTS\.md/);
    expect(fixture.git("rev-parse", "HEAD")).toBe(head);
    expect(fixture.read("AGENTS.md")).toBe("# Rules\n");
    expect(String(post.reason)).toMatch(/AGENTS\.md/);
  });

  test("a person may commit whatever they approved; the hook only judges an agent's commit", () => {
    const fixture = createFixture();
    hook(fixture);
    fixture.write("AGENTS.md", "# By a person\n");
    fixture.git("add", "AGENTS.md");
    expect(tryGit(fixture, "commit", "-q", "-m", "person").status).toBe(0);
  });

  test("a plain commit after the user accepted a change commits it", () => {
    const fixture = createFixture();
    fixture.call("true");
    fixture.write("AGENTS.md", "# Accepted\n");
    expect(fixture.accept()).toBe(0);
    const { post } = fixture.call("git commit -q -m keep -- AGENTS.md", () => {
      fixture.git("add", "AGENTS.md");
      fixture.git("commit", "-q", "-m", "keep");
    });
    expect(post).toEqual({});
    expect(fixture.git("show", "HEAD:AGENTS.md")).toBe("# Accepted\n");
  });

  test("a version bump commits its own output, and only the version may differ", () => {
    const fixture = createFixture();
    const head = fixture.git("rev-parse", "HEAD");
    const bumped = PACKAGE.replace('"version": "1.0.0"', '"version": "1.0.1"');
    const { pre, post } = fixture.call("pnpm run release:bump patch", () => {
      fixture.write("package.json", bumped);
      fixture.git("commit", "-q", "-am", "bump: 1.0.1");
    });
    expect([pre, post]).toEqual([{}, {}]);
    expect(fixture.git("rev-parse", "HEAD")).not.toBe(head);
    const sneaky = createFixture();
    const sneakyHead = sneaky.git("rev-parse", "HEAD");
    const { post: blocked } = sneaky.call("pnpm run release:bump patch", () => {
      sneaky.write("package.json", JSON.stringify({ ...JSON.parse(PACKAGE), version: "1.0.1", scripts: { check: "evil" } }, null, 2));
      sneaky.git("commit", "-q", "-am", "bump");
    });
    expect(sneaky.git("rev-parse", "HEAD")).not.toBe(sneakyHead);
    expect(sneaky.read("package.json")).toBe(PACKAGE);
    expect(String(blocked.reason)).toMatch(/package\.json/);
    expect(denial(sneaky.call("true").pre)).toMatch(/unapproved|ask the user/);
  });

  test("a plumbing commit that adds protected content blocks every further call", () => {
    const fixture = createFixture();
    const { post } = fixture.call("git commit-tree sneak", () => {
      const object = spawnSync("git", ["-C", fixture.root, "hash-object", "-w", "--stdin"], {
        env: fixture.env,
        input: "allow\n",
        encoding: "utf8",
      }).stdout.trim();
      fixture.git("update-index", "--add", "--cacheinfo", `100644,${object},.codex/rules/allow.rules`);
      const tree = fixture.git("write-tree").trim();
      const commit = fixture.git("commit-tree", tree, "-p", "HEAD", "-m", "sneak").trim();
      fixture.git("update-ref", "HEAD", commit);
      fixture.git("reset", "-q", "--hard", "HEAD");
    });
    expect(String(post.reason)).toMatch(/allow\.rules/);
    expect(denial(fixture.call("true").pre)).toMatch(/ask the user/);
  });

  test("a branch switch to other metadata is accepted, a stash and its pop keep an approved change", () => {
    const fixture = createFixture();
    fixture.git("switch", "-q", "-c", "other");
    fixture.write("AGENTS.md", "# Other branch\n");
    fixture.git("commit", "-q", "-am", "other");
    fixture.git("switch", "-q", "main");
    fixture.call("true");
    expect(fixture.call("git switch other", () => fixture.git("switch", "-q", "other")).post).toEqual({});
    expect(fixture.read("AGENTS.md")).toBe("# Other branch\n");
    fixture.call("git switch main", () => fixture.git("switch", "-q", "main"));
    const manifest = JSON.stringify({ ...JSON.parse(PACKAGE), dependencies: { "left-pad": "1.3.0" } }, null, 2);
    fixture.call("pnpm run deps:add --package=left-pad@1.3.0 --group=prod", () => {
      fixture.write("package.json", manifest);
    });
    fixture.call("git stash", () => fixture.git("stash", "push", "-q"));
    expect(fixture.read("package.json")).toBe(PACKAGE);
    expect(fixture.call("git stash pop", () => fixture.git("stash", "pop", "-q")).post).toEqual({});
    expect(fixture.read("package.json")).toBe(manifest);
  });

  test("a merge that stops on a protected conflict is held, preserved, refuses accept, and clears once the user finished it", () => {
    const fixture = createFixture();
    fixture.git("switch", "-q", "-c", "other");
    fixture.write("AGENTS.md", "# From other\n");
    fixture.git("commit", "-q", "-am", "other");
    fixture.git("switch", "-q", "main");
    fixture.write("AGENTS.md", "# From main\n");
    fixture.git("commit", "-q", "-am", "main");
    fixture.call("true");
    const { post } = fixture.call("git merge other", () => {
      tryGit(fixture, "merge", "other");
    });
    expect(fixture.read("AGENTS.md")).toMatch(/<<<<<<<[\s\S]*From main[\s\S]*From other[\s\S]*>>>>>>>/);
    expect(String(post.reason)).toMatch(/could not settle: AGENTS\.md/);
    expect(fixture.git("ls-files", "-u")).toMatch(/AGENTS\.md/);
    expect(stateModule.status(fixture.root).clean).toBe(false);
    expect(denial(fixture.call("true").pre)).toMatch(/could not settle/);
    expect(fixture.accept()).toBe(1);
    expect(fixture.read("AGENTS.md")).toMatch(/<<<<<<</);
    fixture.git("merge", "--abort");
    expect(fixture.accept()).toBe(0);
    expect(stateModule.status(fixture.root)).toEqual({ clean: true });
    expect(fixture.call("true").pre).toEqual({});
  });
});

describe("a template update's merge, for real (R8, R17)", () => {
  const journals = require("../../scripts/template/journal.cjs") as typeof import("../../scripts/template/journal.cjs");
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  const blobOf = (fixture: Fixture, text: string) =>
    spawnSync("git", ["-C", fixture.root, "hash-object", "--stdin"], { input: text, encoding: "utf8" }).stdout.trim();

  /** A project whose merge of a pristine side stopped before committing, with the journal an update would have written. */
  function updating(options: { phase?: "prepared" | "ready"; journal?: boolean; extra?: Record<string, string> } = {}) {
    const fixture = createFixture({ ".template-state.json": '{ "old": true }\n', ...options.extra });
    fixture.git("switch", "-q", "-c", "pristine");
    fixture.write("tsconfig.json", '{"compilerOptions":{"strict":true,"noEmit":true}}\n');
    fixture.git("commit", "-q", "-am", "chore(template): pristine render");
    const next = fixture.git("rev-parse", "HEAD").trim();
    fixture.git("switch", "-q", "main");
    const head = fixture.git("rev-parse", "HEAD").trim();
    fixture.git("update-ref", journals.PENDING_REF, next);
    fixture.git("merge", "--no-ff", "--no-commit", "-q", "pristine");
    const before = '{ "old": true }\n';
    const after = '{ "new": true }\n';
    fixture.write(".template-state.json", after);
    fixture.git("add", ".template-state.json");
    const journal = {
      schema: journals.JOURNAL_SCHEMA,
      journalVersion: journals.JOURNAL_VERSION,
      phase: options.phase ?? "ready",
      source: { url: "file:///source", ref: "main", sha: next },
      start: { head, baseline: { commit: head, tree: fixture.git("rev-parse", "HEAD^{tree}").trim() } },
      next: { commit: next, tree: fixture.git("rev-parse", "pristine^{tree}").trim(), renderDigest: sha256("render") },
      outputDigest: sha256("output"),
      conflicted: false,
      owned: [
        {
          path: ".template-state.json",
          before: { digest: sha256(before), blob: blobOf(fixture, before) },
          after: { digest: sha256(after), blob: blobOf(fixture, after) },
        },
      ],
      pendingRef: journals.PENDING_REF,
    };
    if (options.journal !== false) {
      mkdirSync(join(fixture.root, ".git", journals.UPDATE_DIR), { recursive: true });
      writeFileSync(join(fixture.root, ".git", journals.UPDATE_DIR, journals.JOURNAL_FILE), journals.serializeJournal(journal as never));
    }
    return { fixture, head, next };
  }

  test("a clean merge no-commit the journal vouches for is accepted, and the normal merge commit then settles the guard", () => {
    const { fixture, head, next } = updating();
    expect(fixture.git("rev-parse", "MERGE_HEAD").trim()).toBe(next);
    expect(stateModule.status(fixture.root).clean).toBe(false);
    expect(fixture.accept()).toBe(0);
    expect(fixture.run("pre-commit", {}).status).toBe(0);
    fixture.git("commit", "-q", "-m", "chore(template): update");
    expect(fixture.git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")).toEqual([fixture.git("rev-parse", "HEAD").trim(), head, next]);
    expect(fixture.call("true").pre).toEqual({});
    expect(fixture.run("pre-commit", {}).status).toBe(0);
    expect(stateModule.status(fixture.root)).toEqual({ clean: true });
  });

  test("the same merge without a journal, or with an unfinished one, is still refused", () => {
    const bare = updating({ journal: false });
    expect(bare.fixture.accept()).toBe(1);
    expect(updating({ phase: "prepared" }).fixture.accept()).toBe(1);
  });

  test("a journal does not vouch for a state file someone changed, another merge head, or another operation", () => {
    const edited = updating();
    edited.fixture.write(".template-state.json", '{ "edited": true }\n');
    expect(edited.fixture.accept()).toBe(1);

    const staged = updating();
    staged.fixture.write(".template-state.json", '{ "edited": true }\n');
    staged.fixture.git("add", ".template-state.json");
    expect(staged.fixture.accept()).toBe(1);

    const foreign = updating();
    foreign.fixture.git("update-ref", journals.PENDING_REF, foreign.head);
    expect(foreign.fixture.accept()).toBe(1);

    const marker = updating();
    writeFileSync(join(marker.fixture.root, ".git", "CHERRY_PICK_HEAD"), `${marker.next}\n`);
    expect(marker.fixture.accept()).toBe(1);
  });

  test("any unmerged index stage refuses, even in a file outside the protected inventory, and the conflict is not restored away", () => {
    const { fixture } = updating({ extra: { "src/notes.txt": "base\n" } });
    fixture.git("merge", "--abort");
    fixture.git("switch", "-q", "pristine");
    fixture.write("src/notes.txt", "theirs\n");
    fixture.git("commit", "-q", "-am", "pristine notes");
    fixture.git("switch", "-q", "main");
    fixture.write("src/notes.txt", "mine\n");
    fixture.git("commit", "-q", "-am", "my notes");
    expect(spawnSync("git", ["-C", fixture.root, "merge", "--no-ff", "--no-commit", "pristine"]).status).toBe(1);
    expect(fixture.git("ls-files", "-u")).toMatch(/src\/notes\.txt/);
    expect(fixture.accept()).toBe(1);
    expect(readFileSync(join(fixture.root, "src/notes.txt"), "utf8")).toMatch(/<<<<<<</);
  });
});

describe("Git hooks, for real (R21)", () => {
  test("a hand-edited hook, a changed mode and a changed hooks path are caught", () => {
    const fixture = createFixture();
    fixture.write(".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
    chmodSync(join(fixture.root, ".git/hooks/pre-commit"), 0o755);
    fixture.accept();
    const edited = fixture.call("printf x > .git/hooks/pre-commit", () => {
      fixture.write(".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n");
    });
    expect(fixture.read(".git/hooks/pre-commit")).toBe("#!/bin/sh\nexit 0\n");
    expect(String(edited.post.reason)).toMatch(/Git hooks were changed/);
    fixture.call("chmod -x", () => {
      chmodSync(join(fixture.root, ".git/hooks/pre-commit"), 0o644);
    });
    expect(lstatSync(join(fixture.root, ".git/hooks/pre-commit")).mode & 0o777).toBe(0o755);
    fixture.call("planted", () => {
      fixture.write(".git/hooks/post-commit", "#!/bin/sh\n");
    });
    expect(existsSync(join(fixture.root, ".git/hooks/post-commit"))).toBe(false);
    const redirected = fixture.call("true", () => fixture.git("config", "core.hooksPath", "/tmp/elsewhere"));
    expect(String(redirected.post.reason)).toMatch(/core\.hooksPath changed/);
    expect(denial(fixture.call("true").pre)).toMatch(/core\.hooksPath/);
  });
});

describe("the Claude settings and the user's Codex configuration", () => {
  test("a settings change that drops the guard or disables hooks is blocked", () => {
    const fixture = createFixture();
    const settings = (hooks: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ hooks, ...extra });
    const registered = Object.fromEntries(
      ["PreToolUse", "PostToolUse", "PostToolUseFailure", "ConfigChange", "Stop"].map((event) => [
        event,
        [{ hooks: [{ type: "command", command: "scripts/hooks/launch.sh --event x" }] }],
      ]),
    );
    const check = (source: string, content: string, file = ".claude/settings.json") => {
      fixture.write(file, content);
      return fixture.run("config-change", { cwd: fixture.root, source, file_path: join(fixture.root, file) }).json;
    };
    expect(check("project_settings", settings(registered))).toEqual({});
    expect(reasonOf(check("project_settings", settings({})))).toMatch(/keep the protected-files guard/);
    expect(check("project_settings", settings(registered, { disableAllHooks: true }))).toMatchObject({ decision: "block" });
    expect(parseJson<{ disableAllHooks: boolean }>(fixture.read(".claude/settings.json")).disableAllHooks).toBe(true);
    expect(check("local_settings", settings(registered, { disableAllHooks: true, other: 1 }), ".claude/settings.local.json")).toMatchObject({
      decision: "block",
    });
    expect(parseJson(fixture.read(".claude/settings.local.json"))).toEqual({ hooks: registered, other: 1 });
    expect(reasonOf(check("project_settings", "{ not json"))).toMatch(/cannot be parsed/);
    expect(fixture.run("config-change", { cwd: fixture.root, source: "user_settings", file_path: join(fixture.root, "missing.json") }).json).toEqual({});
  });

  test("a user-level Codex configuration that disables hooks is restored", () => {
    const fixture = createFixture();
    const codex = join(fixture.env.CODEX_HOME ?? "");
    mkdirSync(codex, { recursive: true });
    writeFileSync(join(codex, "config.toml"), 'model = "gpt"\n');
    fixture.accept();
    const { post } = fixture.call(
      "printf 'hooks = false\\n' >> ~/.codex/config.toml",
      () => {
        writeFileSync(join(codex, "config.toml"), 'model = "gpt"\nhooks = false\n');
      },
      { client: "codex" },
    );
    expect(readFileSync(join(codex, "config.toml"), "utf8")).toBe('model = "gpt"\n');
    expect(String(post.reason)).toMatch(/Restored .*config\.toml/);
    writeFileSync(join(codex, "hooks.json"), "{ not json");
    fixture.call("true", () => undefined, { client: "codex" });
    expect(readFileSync(join(codex, "hooks.json"), "utf8")).toBe("{ not json");
  });
});

describe("worktrees (R17)", () => {
  test("each linked worktree has its own baseline", () => {
    const fixture = createFixture();
    fixture.call("true");
    const linked = join(area, "linked-worktree");
    fixture.git("worktree", "add", "-q", "-b", "linked", linked);
    const stateIn = (root: string) => spawnSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], { env: fixture.env, encoding: "utf8" }).stdout.trim();
    expect(stateIn(linked)).not.toBe(stateIn(fixture.root));
    const payload = { cwd: linked, tool_name: "Bash", tool_input: { command: "true" }, tool_use_id: "linked-1" };
    const saved = { ...process.env };
    Object.assign(process.env, fixture.env);
    try {
      expect(
        guardModule.main(["--event", "pre"], {
          cwd: linked,
          stdin: (() => {
            writeFileSync(join(area, "linked-input.json"), JSON.stringify(payload));
            return openSync(join(area, "linked-input.json"), "r");
          })(),
          stdout: () => undefined,
          stderr: () => undefined,
        }),
      ).toBe(0);
    } finally {
      for (const key of Object.keys(fixture.env)) if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
    }
    expect(existsSync(join(stateIn(linked), "protected-baseline", "state.json"))).toBe(true);
    expect(
      Object.keys(parseJson<{ inflight: object }>(readFileSync(join(stateIn(fixture.root), "protected-baseline", "state.json"), "utf8")).inflight),
    ).toEqual([]);
  });

  test("a nested checkout keeps its own files", () => {
    const fixture = createFixture();
    fixture.call("true");
    const nested = join(fixture.root, "vendor", "other");
    mkdirSync(nested, { recursive: true });
    spawnSync("git", ["init", "-q", nested], { env: fixture.env });
    writeFileSync(join(nested, "eslint.config.mjs"), "export default [];\n");
    writeFileSync(join(nested, ".npmrc"), "x\n");
    const { pre, post } = fixture.call("true");
    expect(pre).toEqual({});
    expect(post).toEqual({});
    expect(existsSync(join(nested, "eslint.config.mjs"))).toBe(true);
    expect(existsSync(join(nested, ".npmrc"))).toBe(true);
  });
});

describe("the stop event", () => {
  test("a drift is reported to the user once per turn", () => {
    const fixture = createFixture();
    fixture.call("true");
    fixture.write("AGENTS.md", "# By hand\n");
    expect(String(fixture.run("stop", { cwd: fixture.root }).json.reason)).toMatch(/outside an agent call: AGENTS\.md/);
    expect(String(fixture.run("stop", { cwd: fixture.root, stop_hook_active: true }).json.systemMessage)).toMatch(/AGENTS\.md/);
  });
});

describe("the relock after an approved edit, with the guard active (R11, KTD11)", () => {
  const withDependency = JSON.stringify({ ...JSON.parse(PACKAGE), dependencies: { "left-pad": "1.3.0" } }, null, 2);

  function relockHost(fixture: Fixture, transactions: string[][][]) {
    return {
      preflightErrors: () => [],
      dirtyReason: () => null,
      dirtyKind: () => null,
      recoveryCommand: () => "node scripts/bootstrap.cjs repair",
      guardRefusal: (root: string) => installState.guardRefusal(root),
      hooksRegistered: () => false,
      installHooks: () => undefined,
      guardActive: (root: string) => installState.capabilities(root).guard,
      bindNode: () => undefined,
      guardDrift: (root: string) => guardModule.approvedDrift(root),
      acceptGuard: () => 1,
      checkLock: () => ({ ok: true, output: "" }),
      removeInstallState: () => undefined,
      clearDirty: () => undefined,
      transact: ({ steps }: { steps: string[][] }) => {
        transactions.push(steps);
        return { ok: true, status: 0, violations: [], output: "", restored: false };
      },
      run: processes.run,
      readFile: (path: string) => readFileSync(path, "utf8"),
      exists: (path: string) => existsSync(path),
    } as unknown as Host;
  }
  const relock = (fixture: Fixture) => {
    const transactions: string[][][] = [];
    const err: string[] = [];
    const status = bootstrap.main(["deps-lock"], {
      root: fixture.root,
      io: { stdout: () => undefined, stderr: (text) => err.push(text) },
      host: relockHost(fixture, transactions),
    });
    return { status, err: err.join(""), transactions };
  };

  test("an approved manifest edit that is not committed yet can be relocked, while an unapproved one cannot", () => {
    const fixture = createFixture();
    expect(fixture.accept()).toBe(0);
    fixture.write("package.json", withDependency);
    const refused = relock(fixture);
    expect(refused.status).toBe(1);
    expect(refused.err).toMatch(/differ from the guard's approved baseline[\s\S]*package\.json/);
    expect(refused.transactions).toEqual([]);

    const out: string[] = [];
    const saved = { ...process.env };
    Object.assign(process.env, fixture.env);
    try {
      expect(bootstrap.main(["guard-accept"], { root: fixture.root, io: { stdout: (text) => out.push(text), stderr: (text) => out.push(text) } })).toBe(0);
    } finally {
      for (const key of Object.keys(fixture.env)) if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
    }
    expect(out.join("")).toMatch(/Accepted the current protected state: package\.json/);
    const accepted = relock(fixture);
    expect(accepted.err).toBe("");
    expect(accepted.status).toBe(0);
    expect(accepted.transactions).toHaveLength(1);
    expect(fixture.git("show", "HEAD:package.json")).toBe(PACKAGE);
  });

  test("an approved edit outside the dependency maps is still outside the relock's boundary", () => {
    const fixture = createFixture();
    fixture.accept();
    fixture.write("package.json", JSON.stringify({ ...JSON.parse(withDependency), scripts: { check: "evil" } }, null, 2));
    fixture.accept();
    const result = relock(fixture);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/outside the dependency-only boundary/);
    expect(result.transactions).toEqual([]);
  });

  test("a pending reservation, a held conflict and a missing baseline refuse the relock", () => {
    const fixture = createFixture();
    expect(relock(fixture).err).toMatch(/no approved baseline/);
    fixture.accept();
    expect(fixture.run("pre", { cwd: fixture.root, tool_name: "Bash", tool_input: { command: "pnpm run format" }, tool_use_id: "running" }).json).toEqual({});
    expect(relock(fixture).err).toMatch(/have not finished/);
    fixture.run("post", { cwd: fixture.root, tool_name: "Bash", tool_input: { command: "pnpm run format" }, tool_use_id: "running" });
    expect(relock(fixture).status).toBe(0);
  });

  test("the guard state module is the one the dependency preflight reads", () => {
    const fixture = createFixture();
    expect(installState.guardRefusal(fixture.root)).toMatch(/no approved baseline/);
    fixture.accept();
    expect(installState.guardRefusal(fixture.root)).toBeNull();
    expect(dirname(join(fixture.root, "scripts/hooks/state.cjs"))).toContain("hooks");
  });
});

describe("the real bootstrap entry binds the guard (R2, KTD15)", () => {
  const BINDING = "protected-baseline-node";
  /** A pnpm that is the pinned version and installs nothing, so the entry itself is what runs. */
  function withStubPnpm(fixture: Fixture) {
    const bin = join(fixture.root, "..", `stub-bin-${String(Math.random()).slice(2)}`);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 12.14.0; fi\nexit 0\n', { mode: 0o755 });
    return { ...fixture.env, PATH: `${bin}:/usr/bin:/bin` };
  }
  const pinned = { "package.json": JSON.stringify({ ...JSON.parse(PACKAGE), packageManager: "pnpm@12.14.0", engines: { node: "24.21.0" } }, null, 2) };
  const bootstrapEntry = (fixture: Fixture, command: string, env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [join(fixture.root, "scripts/bootstrap.cjs"), command], { cwd: fixture.root, env, encoding: "utf8" });

  test("setup binds this Node binary for the guard, outside the project, and guard-accept goes through the guard", () => {
    const fixture = createFixture(pinned, { bind: false });
    const env = withStubPnpm(fixture);
    const setup = bootstrapEntry(fixture, "setup", env);
    expect(setup.stderr).toBe("");
    expect(setup.status).toBe(0);
    expect(setup.stdout).toMatch(/Node binary bound for the protected-files guard/);
    expect(readFileSync(join(fixture.root, ".git", BINDING), "utf8").trim()).toBe(process.execPath);
    const accept = bootstrapEntry(fixture, "guard-accept", env);
    expect(accept.status).toBe(0);
    expect(accept.stdout).toMatch(/Accepted the current protected state|No protected/);
  });

  test("guard-accept starts the guard through the launcher with the bound Node, without the caller's NODE_* variables", () => {
    const fixture = createFixture(pinned, { bind: false });
    const env = withStubPnpm(fixture);
    expect(bootstrapEntry(fixture, "setup", env).status).toBe(0);
    const record = join(area, `accept-record-${fixture.root.split("/").at(-1) ?? ""}`);
    const wrapper = join(area, `bound-node-${fixture.root.split("/").at(-1) ?? ""}`);
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s|%s\\n' "\${NODE_OPTIONS-unset}" "$*" >> '${record}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    stateModule.bindNode(fixture.root, wrapper);
    const accept = bootstrapEntry(fixture, "guard-accept", { ...env, NODE_OPTIONS: "--max-old-space-size=512" });
    expect(accept.stderr).toBe("");
    expect(accept.status).toBe(0);
    const lines = readFileSync(record, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^unset\|--no-addons --no-global-search-paths --disable-proto=throw .*scripts\/hooks\/entry\.cjs --client claude --event accept$/);
  });

  test("an inactive guard is not bound and accepts nothing", () => {
    const fixture = createFixture({ ...pinned, "tooling/capabilities.json": JSON.stringify({ guard: false, hooks: false }) }, { bind: false });
    const env = withStubPnpm(fixture);
    const setup = bootstrapEntry(fixture, "setup", env);
    expect(setup.status).toBe(0);
    expect(setup.stdout).not.toMatch(/Node binary bound/);
    const accept = bootstrapEntry(fixture, "guard-accept", env);
    expect(accept.status).toBe(1);
    expect(accept.stderr).toMatch(/not active.*Nothing was accepted/s);
  });
});
