import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { guardPolicy, inventory } from "../../support/guard-repo.ts";

const policy = createRequire(import.meta.url)("../../../scripts/hooks/policy.cjs") as typeof import("../../../scripts/hooks/policy.cjs");

describe("reading a shell command without running it", () => {
  test.each([
    ["pnpm run format", ["pnpm", "run", "format"]],
    ["  a   b\tc ", ["a", "b", "c"]],
    ["echo 'a b' \"c d\" e\\ f", ["echo", "a b", "c d", "e f"]],
    ['echo "quote \\" inside \\$x"', ["echo", 'quote " inside $x']],
    ["a && b | c", ["a", "&&", "b", "|", "c"]],
    ["cat>file", ["cat", ">", "file"]],
    ["a;b", ["a", ";", "b"]],
    ["", []],
  ])("%s", (command, words) => {
    expect(policy.shellWords(command)).toEqual(words);
  });

  test.each(["echo 'open", 'echo "open', "echo trailing\\", 'echo "also open \\'])("malformed quoting yields no words: %s", (command) => {
    expect(policy.shellWords(command)).toEqual([]);
  });

  test("only a command with no evaluation, chaining or redirection is simple", () => {
    expect(policy.simpleWords("git commit -m 'a b'")).toEqual(["git", "commit", "-m", "a b"]);
    for (const command of ["a && b", "a; b", "a | b", "a > b", "echo $(x)", "echo `x`", "echo $HOME", "echo {a,b}", "a\nb", "", "   ", "echo 'open"]) {
      expect(policy.simpleWords(command), command).toBeNull();
    }
  });

  test("quoted data and heredoc bodies are not executable text, but code handed to a shell is", () => {
    expect(policy.executableText("echo 'git commit --no-verify'")).toBe("echo ''");
    expect(policy.executableText('rg "SKIP=1" docs')).toBe("rg '' docs");
    expect(policy.executableText("cat > n.md <<'EOF'\nSKIP=1 git commit -n\nEOF")).toBe("cat > n.md <<''");
    expect(policy.executableText("bash -c 'git commit --no-verify'")).toContain("--no-verify");
    expect(policy.executableText("eval 'x'")).toContain("'x'");
    expect(policy.executableText('echo "$(git commit --no-verify -m x)"')).toContain("--no-verify");
    expect(policy.executableText('echo "`git commit --no-verify`"')).toContain("--no-verify");
    expect(policy.executableText("echo '$(git commit --no-verify)'")).toBe("echo ''");
    expect(policy.executableText("cat <<EOF\n$(git commit --no-verify)\nEOF")).toContain("--no-verify");
    expect(policy.executableText("cat <<'EOF'\n$(git commit --no-verify)\nEOF")).toBe("cat <<''");
    expect(policy.executableText("node -e 'require(\"x\")'")).toContain("require");
  });

  test("a command runs a guard file only when it executes one", () => {
    for (const command of [
      "node scripts/hooks/guard.cjs --event accept",
      "bash scripts/hooks/launch.sh",
      "./scripts/hooks/launch.sh",
      "node -e 'require(\"./scripts/hooks/state.cjs\")'",
      "env scripts/hooks/guard.cjs",
    ])
      expect(policy.runsGuard(command), command).toBe(true);
    for (const command of [
      "cat scripts/hooks/guard.cjs",
      "rg launch.sh docs",
      "echo 'node scripts/hooks/guard.cjs'",
      "cat > n.md <<'EOF'\nnode scripts/hooks/guard.cjs\nEOF",
      "echo scripts/hooks/state.cjs",
    ])
      expect(policy.runsGuard(command), command).toBe(false);
    expect(policy.runsGuard("'unterminated scripts/hooks/guard.cjs")).toBe(true);
  });

  test("git commands are classified by their subcommand, and commit-tree is not a commit", () => {
    expect(policy.gitKind(["git", "commit", "-m", "x"])).toBe("commit");
    for (const sub of ["switch", "checkout", "pull", "merge", "rebase", "reset", "restore", "stash", "cherry-pick"])
      expect(policy.gitKind(["git", sub])).toBe("history");
    expect(policy.gitKind(["gh", "pr", "checkout", "1"])).toBe("history");
    expect(policy.gitKind(["git", "commit-tree", "x"])).toBeNull();
    expect(policy.gitKind(["git", "log"])).toBeNull();
    expect(policy.gitKind(["git"])).toBeNull();
    expect(policy.gitKind(["ls"])).toBeNull();
  });
});

describe("the command grammar", () => {
  const words = (command: string) => policy.simpleWords(command);
  const route = (command: string) => policy.matchCommand(guardPolicy, words(command))?.id ?? null;

  test.each([
    ["pnpm run format", "format"],
    ["pnpm run lint:fix", "lint-fix"],
    ["pnpm run deps:add --package=left-pad --group=prod", "deps-add"],
    ["pnpm run deps:add --group=dev --package=@types/node@24.19.2", "deps-add"],
    ["pnpm run deps:add --package=left-pad@latest --group=dev", "deps-add"],
    ["pnpm run deps:remove --package=@scope/name --group=dev", "deps-remove"],
    ["pnpm run deps:upgrade", "deps-upgrade"],
    ["pnpm run deps:upgrade --package=left-pad", "deps-upgrade"],
    ["node scripts/bootstrap.cjs deps-lock", "deps-lock"],
    ["node scripts/bootstrap.cjs setup", "setup"],
    ["node scripts/bootstrap.cjs repair", "repair"],
    ["node scripts/bootstrap.cjs guard-accept", "guard-accept"],
    ["pnpm run release:bump patch", "release-bump"],
    ["pnpm run release:bump minor", "release-bump"],
    ["pnpm run release:bump major", "release-bump"],
    ["pnpm run release:tag", "release-tag"],
  ])("%s is the %s route", (command, id) => {
    expect(route(command)).toBe(id);
  });

  test.each([
    "pnpm run",
    "pnpm run format --write",
    "pnpm run format extra",
    "pnpm format",
    "pnpm run deps:add --package=left-pad",
    "pnpm run deps:add --package=left-pad --group=prod --group=dev",
    "pnpm run deps:add --package=left-pad --group=peer",
    "pnpm run deps:add --package=left-pad --group=prod --save-exact",
    "pnpm run deps:add --package=git+https://x/y.git --group=prod",
    "pnpm run deps:add --package=../x --group=prod",
    "pnpm run deps:add --package=left-pad@^1 --group=prod",
    "pnpm run deps:remove --package=left-pad@1.0.0 --group=prod",
    "pnpm run deps:remove --package=-g --group=prod",
    "pnpm run deps:upgrade --package=left-pad@2",
    "pnpm run deps:upgrade --all",
    "pnpm run release:bump",
    "pnpm run release:bump prerelease",
    "pnpm run release:bump patch minor",
    "pnpm run release:bump --patch",
    "pnpm run release:tag v1",
    "node scripts/bootstrap.cjs",
    "node scripts/bootstrap.cjs setup --frozen-lockfile=false",
    "node scripts/bootstrap.cjs setup && echo",
    "node ./scripts/bootstrap.cjs setup",
    "node --require ./x scripts/bootstrap.cjs setup",
    "sudo pnpm run format",
    "npx pnpm run format",
  ])("%s is not a route", (command) => {
    expect(route(command)).toBeNull();
  });

  test("a command with no words or an evaluated form is no route", () => {
    expect(policy.matchCommand(guardPolicy, null)).toBeNull();
  });

  test("a policy declaration with a missing or foreign member is refused rather than reinterpreted", () => {
    const good = { commands: [] };
    expect(policy.parseGuardPolicy(good).commands).toEqual([]);
    for (const bad of [null, {}, { ...good, commands: [{ id: "x" }] }, { commands: "no" }, { ...good, commands: [{ id: 1, argv: [], allowance: "none" }] }])
      expect(() => policy.parseGuardPolicy(bad)).toThrow(/tooling\/policy\.json/);
  });
});

describe("refusing a switch-off", () => {
  const reason = (command: string) => {
    const words = policy.simpleWords(command);
    return policy.switchOffReason(command, { words, route: policy.matchCommand(guardPolicy, words), kind: words ? policy.gitKind(words) : null });
  };

  test("a user-approved goal is refused unless it is exactly the standalone route", () => {
    expect(reason("node scripts/bootstrap.cjs guard-accept")).toBeNull();
    expect(reason("pnpm run release:bump patch")).toBeNull();
    expect(reason("pnpm run release:tag")).toBeNull();
    expect(reason("node scripts/bootstrap.cjs guard-accept; true")).toMatch(/guard-accept.*standalone/);
    expect(reason("pnpm run release:tag && echo")).toMatch(/release:tag.*standalone/);
    expect(reason("pnpm release:bump")).toMatch(/release:bump/);
  });

  test.each([
    "git -C /tmp/project push origin HEAD",
    "git -c advice.pushUpdateRejected=false push",
    "gh --repo owner/repo pr create --fill",
    "gh --repo=owner/repo pr merge 1 --merge",
    "env FOO=bar git push",
    "git push && true",
    "true; gh pr create --fill",
    'sh -c "git push"',
  ])("refuses publication outside the prompted standalone form: %s", (command) => {
    expect(reason(command)).toMatch(/standalone.*user is asked/);
  });

  test.each(["git push origin HEAD", "gh pr create --fill", "gh pr merge 1 --merge"])("keeps the prompted publishing form: %s", (command) => {
    expect(reason(command)).toBeNull();
  });

  test.each(['printf "%s" "git -C /tmp/project push"', "cat <<'EOF'\ngh --repo owner/repo pr create\nEOF"])(
    "publication mentioned as data is not executed: %s",
    (command) => {
      expect(reason(command)).toBeNull();
    },
  );

  test("a plain commit is the only commit that is not refused", () => {
    expect(reason("git commit -q -m x")).toBeNull();
    expect(reason("git -C . commit -q -m x")).toMatch(/standalone/);
    expect(reason("git commit -q -m x && true")).toMatch(/standalone/);
  });

  test("a message that merely mentions a switch-off is not one", () => {
    expect(reason('git commit -m "use --no-verify never"')).toBeNull();
  });
});

describe("tool paths (R16)", () => {
  const isProtected = (relative: string) => inventory.isProtectedFile(relative) || inventory.isShadowOverride(relative);
  const target = (raw: string, cwd = "/p", real: (absolute: string) => string = (absolute) => absolute) =>
    policy.protectedTarget("/p", raw, cwd, real, isProtected);

  test("an absolute, relative, backslashed or upper-case spelling of a protected path is the protected path", () => {
    expect(target("/p/package.json")).toBe("package.json");
    expect(target("package.json")).toBe("package.json");
    expect(target("src/../package.json")).toBe("package.json");
    expect(target("scripts\\hooks\\guard.cjs")).toBe("scripts/hooks/guard.cjs");
    expect(target("Package.json")).toBe("Package.json");
    expect(target("../package.json", "/p/src")).toBe("package.json");
    expect(target("src/.npmrc")).toBe("src/.npmrc");
  });

  test("a link to a protected file is the protected file, and ordinary or foreign paths are not", () => {
    expect(target("docs/link.md", "/p", (absolute) => (absolute === "/p/docs/link.md" ? "/p/AGENTS.md" : absolute))).toBe("AGENTS.md");
    expect(target("src/app.ts")).toBeNull();
    expect(target("/etc/package.json")).toBeNull();
    expect(target("")).toBeNull();
    expect(target("..", "/p")).toBeNull();
    expect(target("/p")).toBeNull();
  });

  test("every path of an apply_patch body is inspected, source and destination", () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts\n*** Delete File: c.ts\n*** Move to: d.ts\n*** End Patch";
    expect(policy.patchPaths(patch)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(policy.patchPaths("nothing")).toEqual([]);
  });
});

describe("what a finished call may have changed", () => {
  const route = (command: string) => policy.matchCommand(guardPolicy, policy.simpleWords(command));
  const allowance = (command: string, failed = false, background = false) =>
    policy.allowanceFor({ route: route(command), kind: null, edit: null, client: "claude", failed, background });

  test("each route allows exactly its own scope", () => {
    expect(allowance("pnpm run format").files).toBe("format");
    expect(allowance("pnpm run lint:fix").files).toBe("lint-fix");
    expect(allowance("pnpm run deps:add --package=a --group=dev")).toMatchObject({
      files: "dependencies",
      environment: "change",
      hooks: false,
      head: false,
      accept: false,
    });
    expect(allowance("node scripts/bootstrap.cjs deps-lock").files).toBe("dependencies");
    expect(allowance("node scripts/bootstrap.cjs setup")).toMatchObject({ files: "none", environment: "change", hooks: true });
    expect(allowance("node scripts/bootstrap.cjs repair")).toMatchObject({ files: "none", environment: "rebuild" });
    expect(allowance("node scripts/bootstrap.cjs guard-accept")).toMatchObject({ files: "none", accept: true });
    expect(allowance("pnpm run release:bump patch")).toMatchObject({ files: "version", head: true });
    expect(allowance("pnpm run release:tag")).toMatchObject({ files: "none", head: false, accept: false });
  });

  test("a failed call changes nothing in the environment and accepts nothing", () => {
    expect(allowance("pnpm run deps:add --package=a --group=dev", true).environment).toBe("none");
    expect(allowance("node scripts/bootstrap.cjs repair", true).environment).toBe("none");
    expect(allowance("node scripts/bootstrap.cjs guard-accept", true).accept).toBe(false);
  });

  test("a background call, an unknown command and an edit of ordinary source have no allowance", () => {
    expect(allowance("pnpm run format", false, true).files).toBe("none");
    expect(allowance("echo hi").files).toBe("none");
    expect(policy.allowanceFor({ route: null, kind: "commit", edit: null, client: "codex", failed: false, background: false })).toMatchObject({
      files: "format",
      head: true,
      client: "codex",
    });
    expect(policy.allowanceFor({ route: null, kind: "history", edit: null, client: "claude", failed: false, background: false })).toMatchObject({
      files: "history",
      head: true,
    });
    expect(policy.allowanceFor({ route: null, kind: null, edit: "AGENTS.md", client: "claude", failed: false, background: false })).toMatchObject({
      files: "none",
      edit: "AGENTS.md",
    });
  });
});

describe("field-level scopes (KTD11)", () => {
  const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
  const manifest = (extra: Record<string, unknown> = {}) => ({
    name: "a",
    version: "1.0.0",
    scripts: { check: "x" },
    dependencies: {},
    devDependencies: {},
    ...extra,
  });
  const accepts = (scope: Parameters<typeof policy.scopeAccepts>[0], path: string, before: Buffer | null, after: Buffer | null) =>
    policy.scopeAccepts(scope, path, before, after);

  test("dependencies: only the dependency maps and the lock", () => {
    const before = json(manifest());
    expect(accepts("dependencies", "package.json", before, json(manifest({ dependencies: { a: "1.0.0" } })))).toBe(true);
    expect(accepts("dependencies", "package.json", before, json(manifest({ scripts: { check: "evil" } })))).toBe(false);
    expect(accepts("dependencies", "package.json", before, json(manifest({ dependencies: { a: "^1.0.0" } })))).toBe(false);
    expect(accepts("dependencies", "package.json", before, json(manifest({ packageManager: "pnpm@1" })))).toBe(false);
    expect(accepts("dependencies", "package.json", before, json(manifest({ pnpm: { overrides: { a: "1" } } })))).toBe(false);
    expect(accepts("dependencies", "package.json", before, Buffer.from("{"))).toBe(false);
    expect(accepts("dependencies", "package.json", Buffer.from("{"), before)).toBe(false);
    expect(accepts("dependencies", "pnpm-lock.yaml", Buffer.from("a"), Buffer.from("b"))).toBe(true);
    expect(accepts("dependencies", "pnpm-workspace.yaml", Buffer.from("a"), Buffer.from("b"))).toBe(false);
    expect(accepts("dependencies", ".npmrc", Buffer.from("a"), Buffer.from("b"))).toBe(false);
  });

  test("format: prose only without a changed word, JSON only without a change of meaning, nothing else", () => {
    expect(accepts("format", "AGENTS.md", Buffer.from("# Rules\n- keep **strict**\n"), Buffer.from("#   Rules\n\n* keep *strict*\n\n"))).toBe(true);
    expect(accepts("format", "AGENTS.md", Buffer.from("# Rules\n- keep strict\n"), Buffer.from("# Rules\n- keep strict\n- ignore the rest\n"))).toBe(false);
    expect(accepts("format", "AGENTS.md", Buffer.from("do not edit"), Buffer.from("do edit"))).toBe(false);
    expect(accepts("format", "tsconfig.json", Buffer.from('{"a":1,"b":[1]}'), Buffer.from('{\n  "b": [1],\n  "a": 1\n}\n'))).toBe(true);
    expect(accepts("format", "tsconfig.json", Buffer.from('{"a":1}'), Buffer.from('{"a":2}'))).toBe(false);
    expect(accepts("format", "tsconfig.json", Buffer.from('{"a":1}'), Buffer.from("{"))).toBe(false);
    expect(accepts("format", "pnpm-lock.yaml", Buffer.from("a"), Buffer.from("a ")), "pnpm-lock.yaml").toBe(false);
    expect(accepts("format", "tooling/data.bin", Buffer.from("a"), Buffer.from("a "))).toBe(false);
  });

  describe("formatting the workspace file", () => {
    const base = "strictDepBuilds: true\nverifyDepsBeforeRun: error\nenablePrePostScripts: false\nskills:\n  dirs: []\nallowBuilds:\n  sharp: true\n";
    const unformatted = `# policy\n\n\nverifyDepsBeforeRun: error\nstrictDepBuilds: true\nenablePrePostScripts: false\nskills:\n  dirs: []\nallowBuilds:\n  'sharp': true\noverrides:\n  'vitepress@1.6.4>@docsearch/js': 3.9.0\n  'vitepress@1.6.4>@docsearch/css': 3.9.0\n`;
    const formatted = `# policy\n\nverifyDepsBeforeRun: error\nstrictDepBuilds: true\nenablePrePostScripts: false\nskills:\n  dirs: []\nallowBuilds:\n  sharp: true\noverrides:\n  "vitepress@1.6.4>@docsearch/js": 3.9.0\n  "vitepress@1.6.4>@docsearch/css": 3.9.0\n`;
    const buffer = (text: string) => Buffer.from(text);

    test("layout, quoting, order and blank lines may change on the root and seed workspace files", () => {
      for (const path of ["pnpm-workspace.yaml", "template/app/pnpm-workspace.yaml"]) {
        expect(accepts("format", path, buffer(unformatted), buffer(formatted)), path).toBe(true);
        expect(accepts("format", path, buffer(base), buffer(base)), path).toBe(true);
      }
    });

    test("a different policy value, key, build permission or override is refused however it is laid out", () => {
      for (const after of [
        formatted.replace("strictDepBuilds: true", "strictDepBuilds: false"),
        formatted.replace("sharp: true", "sharp: false"),
        formatted.replace("sharp: true", "sharp: true\n  evil: true"),
        formatted.replace('3.9.0\n  "vitepress@1.6.4>@docsearch/css"', '3.8.2\n  "vitepress@1.6.4>@docsearch/css"'),
        formatted.replace(/overrides:[\s\S]*/, ""),
        formatted + "packageExtensions: {}\n",
        formatted.replace("  dirs: []", "  dirs: [x]"),
      ])
        expect(accepts("format", "pnpm-workspace.yaml", buffer(unformatted), buffer(after)), after).toBe(false);
    });

    test("a file outside the canonical subset, before or after, is not vouched for", () => {
      expect(accepts("format", "pnpm-workspace.yaml", buffer("allowBuilds:\n    sharp: true\n"), buffer("allowBuilds:\n  sharp: true\n"))).toBe(false);
      expect(accepts("format", "pnpm-workspace.yaml", buffer(base), buffer("allowBuilds:\n    sharp: true\n"))).toBe(false);
    });
  });

  test("format and lint:fix rewrite the file types their own tools rewrite, and no others", () => {
    for (const path of [
      "scripts/example.cjs",
      "scripts/x.mjs",
      "eslint.config.mjs",
      "tooling/a.ts",
      "tooling/a.tsx",
      "scripts/a.js",
      "docs/.vitepress/config/theme.css",
      ".husky/rules.yaml",
      ".githooks/ci.yml",
      "docs/index.html",
    ]) {
      expect(accepts("format", path, Buffer.from("const x=1;"), Buffer.from("const x = 1;\n")), path).toBe(true);
    }
    for (const path of ["scripts/example.cjs", "eslint.config.mjs", "tooling/a.ts", "tooling/a.tsx", "scripts/a.js"]) {
      expect(accepts("lint-fix", path, Buffer.from("var x=1;"), Buffer.from("const x = 1;\n")), path).toBe(true);
    }
    for (const path of ["AGENTS.md", "tsconfig.json", "package.json", "pnpm-workspace.yaml", "docs/.vitepress/config/theme.css", "pnpm-lock.yaml"]) {
      expect(accepts("lint-fix", path, Buffer.from("{}"), Buffer.from("{ }")), path).toBe(false);
    }
  });

  test("a scoped tool never changes a mode or a link: the executable bit and symlinks keep the route from covering a change", () => {
    const window = [{ files: "format" as const, edit: null, environment: "none" as const, hooks: false, head: false, accept: false, client: "claude" }];
    const change = {
      path: "scripts/run.cjs",
      before: Buffer.from("a"),
      after: Buffer.from("a "),
      beforeId: "H",
      afterId: "H2",
      committedId: null,
      history: [],
    };
    expect(policy.fileAllowed(window, change)).toBe(true);
    expect(policy.fileAllowed(window, { ...change, beforeId: "H:x", afterId: "H2" })).toBe(false);
    expect(policy.fileAllowed(window, { ...change, beforeId: "H", afterId: "H2:x" })).toBe(false);
    expect(policy.fileAllowed(window, { ...change, beforeId: "H:x", afterId: "H2:x" })).toBe(true);
    expect(policy.fileAllowed(window, { ...change, beforeId: "symlink:a", afterId: "H2" })).toBe(false);
    expect(policy.fileAllowed(window, { ...change, afterId: "symlink:a" })).toBe(false);
  });

  test("version: package.json differing in its version alone", () => {
    const before = json(manifest());
    expect(accepts("version", "package.json", before, json(manifest({ version: "1.0.1" })))).toBe(true);
    expect(accepts("version", "package.json", before, json(manifest({ version: "1.1.0-rc.1" })))).toBe(true);
    expect(accepts("version", "package.json", before, json(manifest({ version: "next" })))).toBe(false);
    expect(accepts("version", "package.json", before, json(manifest({ version: "1.0.1", dependencies: { a: "1.0.0" } })))).toBe(false);
    expect(accepts("version", "package.json", before, json(manifest({ version: "1.0.1", scripts: {} })))).toBe(false);
    expect(accepts("version", "package.json", json({ name: "a" }), json({ name: "a", version: "1.0.0" }))).toBe(false);
    expect(accepts("version", "package.json", before, Buffer.from("{"))).toBe(false);
    expect(accepts("version", "tsconfig.json", before, json(manifest({ version: "1.0.1" })))).toBe(false);
  });

  test("a deletion or a creation is never a scoped change, and the none and history scopes grant nothing here", () => {
    for (const scope of ["dependencies", "format", "version", "none", "history"] as const) {
      expect(accepts(scope, "package.json", Buffer.from("{}"), null)).toBe(false);
      expect(accepts(scope, "package.json", null, Buffer.from("{}"))).toBe(false);
    }
    expect(accepts("none", "AGENTS.md", Buffer.from("a"), Buffer.from("b"))).toBe(false);
    expect(accepts("history", "AGENTS.md", Buffer.from("a"), Buffer.from("b"))).toBe(false);
  });

  test("the window decides: an exact edit, a committed or approved history id, or a scope", () => {
    const allowance = (partial: Partial<Parameters<typeof policy.fileAllowed>[0][number]>) => ({
      files: "none" as const,
      edit: null,
      environment: "none" as const,
      hooks: false,
      head: false,
      accept: false,
      client: "claude",
      ...partial,
    });
    const change = { path: "AGENTS.md", before: Buffer.from("a"), after: Buffer.from("a  "), beforeId: "A", afterId: "B", committedId: "C", history: ["H"] };
    expect(policy.fileAllowed([], change)).toBe(false);
    expect(policy.fileAllowed([allowance({ edit: "AGENTS.md" })], change)).toBe(true);
    expect(policy.fileAllowed([allowance({ edit: "other" })], change)).toBe(false);
    expect(policy.fileAllowed([allowance({ files: "history" })], change)).toBe(false);
    expect(policy.fileAllowed([allowance({ files: "history" })], { ...change, afterId: "C" })).toBe(true);
    expect(policy.fileAllowed([allowance({ files: "history" })], { ...change, afterId: "H" })).toBe(true);
    expect(policy.fileAllowed([allowance({ files: "format" })], change)).toBe(true);
    expect(policy.fileAllowed([allowance({ files: "none" }), allowance({ files: "format" })], change)).toBe(true);
  });
});
