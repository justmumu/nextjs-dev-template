import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { scratchArea } from "../support/project.ts";
import { commit, fixtureEnv, git, head, hook, hostAt, root, status, tags, write } from "../support/release-fixture.ts";

// The release commands on real Git: a bump through real hooks, the refusals that must leave nothing
// behind, the tag of a reviewed merge, and the identity audit over real commit objects. Nothing is
// pushed, published or deployed.
const require = createRequire(import.meta.url);
const release = require("../../scripts/release.cjs") as typeof import("../../scripts/release.cjs");
const changelog = require("../../scripts/release/changelog.cjs") as typeof import("../../scripts/release/changelog.cjs");
const scratch = scratchArea("release-");
const at = (local: string, domain: string) => `${local}@${domain}`;
const prettier = join(root, "node_modules/prettier/bin/prettier.cjs");

/** A generator-role project with a history of its own, on the release branch. */
function project(extra: { version?: string } = {}) {
  const env = fixtureEnv(scratch.area);
  const dir = scratch.project();
  write(dir, "package.json", `${JSON.stringify({ name: "fixture-app", version: extra.version ?? "0.0.0", private: true, scripts: {} }, null, 2)}\n`);
  write(dir, "tooling/project-role.json", `${JSON.stringify({ role: "generator" })}\n`);
  copyFileSync(join(root, "tooling/policy.json"), join(dir, "tooling/policy.json"));
  copyFileSync(join(root, ".prettierrc.json"), join(dir, ".prettierrc.json"));
  write(dir, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  git(dir, ["init", "-q", "-b", "main"], env);
  git(dir, ["config", "commit.gpgsign", "false"], env);
  git(dir, ["config", "tag.gpgsign", "false"], env);
  commit(dir, env, "feat: inherited feature");
  git(dir, ["switch", "-q", "-c", "release/first"], env);
  write(dir, "app.js", "export const app = 1;\n");
  commit(dir, env, "feat: application feature");
  return { dir, env };
}

/** The reviewed merge of the current branch into main, as a pull request would leave it, and a fetch of it. */
function mergeReviewed(dir: string, env: NodeJS.ProcessEnv) {
  const branch = git(dir, ["branch", "--show-current"], env).trim();
  git(dir, ["switch", "-q", "main"], env);
  git(dir, ["merge", "-q", "--no-ff", branch, "-m", "Merge reviewed release"], env);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"], env);
}

describe("release:bump on real Git", () => {
  test("writes the version and a changelog section, commits only those through the hooks, and never tags", async () => {
    const { dir, env } = project();
    write(dir, "pnpm-workspace.yaml", "strictDepBuilds: true\n");
    commit(dir, env, "fix(core): repair the core");
    const before = head(dir, env);
    const lockBefore = readFileSync(join(dir, "pnpm-lock.yaml"), "utf8");
    const { host, sink } = hostAt(dir, env);

    await release.bump(host, "patch");

    expect(git(dir, ["log", "-1", "--format=%s"], env).trim()).toBe("chore: bump version to v0.0.1");
    expect(git(dir, ["rev-parse", "HEAD~1"], env).trim()).toBe(before);
    expect(git(dir, ["diff", "--name-only", "HEAD~1"], env).trim().split("\n")).toEqual(["CHANGELOG.md", "package.json"]);
    expect(git(dir, ["diff", "--numstat", "HEAD~1", "--", "package.json"], env).trim()).toBe("1\t1\tpackage.json");
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).toMatchObject({ version: "0.0.1" });
    expect(readFileSync(join(dir, "pnpm-lock.yaml"), "utf8")).toBe(lockBefore);
    expect(readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8")).toBe("strictDepBuilds: true\n");
    const text = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(text).toMatch(/^# Changelog\n\n## v0\.0\.1 \(2026-10-17\)\n/);
    expect(text).toMatch(/### Features[\s\S]*application feature/);
    expect(text).toMatch(/### Bug Fixes[\s\S]*\*\*core:\*\* repair the core/);
    expect(text).not.toMatch(/bump version/);
    expect(tags(dir, env)).toBe("");
    expect(status(dir, env)).toBe("");
    expect(sink.out()).toMatch(/Release v0\.0\.1 prepared on release\/first/);
    const check = spawnSync(process.execPath, [prettier, "--check", "--log-level=warn", "CHANGELOG.md"], { cwd: dir, env, encoding: "utf8" });
    expect(check.status, check.stdout + check.stderr).toBe(0);
  });

  test("a consecutive release keeps the earlier section and only its own commits", async () => {
    const { dir, env } = project();
    await release.bump(hostAt(dir, env).host, "patch");
    mergeReviewed(dir, env);
    git(dir, ["tag", "-a", "v0.0.1", "-m", "v0.0.1"], env);
    git(dir, ["switch", "-q", "-c", "release/second"], env);
    write(dir, "app.js", "export const app = 2;\n");
    commit(dir, env, "fix: correct the application");
    await release.bump(hostAt(dir, env).host, "minor");
    const text = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    expect(text).toMatch(/## v0\.1\.0 \(2026-10-17\)[\s\S]*correct the application[\s\S]*## v0\.0\.1 \(2026-10-17\)[\s\S]*application feature/);
    const section = changelog.extractSection(text, "v0.1.0");
    expect(section).not.toMatch(/application feature|inherited feature/);
  });

  test.each([
    ["main", (dir: string, env: NodeJS.ProcessEnv) => git(dir, ["switch", "-q", "main"], env), /feature branch/],
    ["a detached head", (dir: string, env: NodeJS.ProcessEnv) => git(dir, ["checkout", "-q", "--detach"], env), /feature branch/],
    [
      "a tracked edit",
      (dir: string) => {
        write(dir, "app.js", "// edit\n");
      },
      /clean working tree/,
    ],
    [
      "an untracked file",
      (dir: string) => {
        write(dir, "new.js", "// new\n");
      },
      /clean working tree/,
    ],
    [
      "a staged file",
      (dir: string, env: NodeJS.ProcessEnv) => {
        write(dir, "new.js", "// new\n");
        git(dir, ["add", "new.js"], env);
      },
      /clean working tree/,
    ],
    [
      "an assume-unchanged edit",
      (dir: string, env: NodeJS.ProcessEnv) => {
        git(dir, ["update-index", "--assume-unchanged", "app.js"], env);
        write(dir, "app.js", "// hidden\n");
      },
      /index flags/,
    ],
    [
      "a skip-worktree edit",
      (dir: string, env: NodeJS.ProcessEnv) => {
        git(dir, ["update-index", "--skip-worktree", "app.js"], env);
        write(dir, "app.js", "// hidden\n");
      },
      /index flags/,
    ],
    [
      "an existing tag",
      (dir: string, env: NodeJS.ProcessEnv) => git(dir, ["tag", "-a", "v0.0.1", "-m", "exists"], env),
      /Tag v0\.0\.1 already exists; no files changed/,
    ],
  ])("refuses %s before it writes anything", async (_name, arrange, message) => {
    const { dir, env } = project();
    arrange(dir, env);
    const manifest = readFileSync(join(dir, "package.json"), "utf8");
    const state = status(dir, env);
    const tagged = tags(dir, env);
    const at = head(dir, env);
    await expect(release.bump(hostAt(dir, env).host, "patch")).rejects.toThrow(message);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(manifest);
    expect(existsSync(join(dir, "CHANGELOG.md"))).toBe(false);
    expect(status(dir, env)).toBe(state);
    expect(tags(dir, env)).toBe(tagged);
    expect(head(dir, env)).toBe(at);
  });

  test("refuses a shallow clone", async () => {
    const { dir, env } = project();
    const clone = join(scratch.area, "shallow-clone");
    git(scratch.area, ["clone", "-q", "--depth", "1", "--branch", "release/first", `file://${dir}`, clone], env);
    await expect(release.bump(hostAt(clone, env).host, "patch")).rejects.toThrow(/full Git history/);
    expect(existsSync(join(clone, "CHANGELOG.md"))).toBe(false);
  });

  test("a segment outside patch, minor and major is refused before the repository is read", async () => {
    const { dir, env } = project();
    await expect(release.bump(hostAt(dir, env).host, "prerelease")).rejects.toThrow(/patch, minor or major/);
    expect(status(dir, env)).toBe("");
  });

  test.each(["pre-commit", "commit-msg"])(
    "a failing %s hook preserves prepared files and edits made by the hook without committing or tagging",
    async (name) => {
      const { dir, env } = project();
      hook(
        dir,
        env,
        name,
        `printf '%s\\n' '{"name":"fixture-app","version":"0.0.1","userNote":"keep this edit"}' > package.json\necho "hook says no" >&2\nexit 1`,
      );
      const at = head(dir, env);
      const sink = hostAt(dir, env);
      const failure = await release.bump(sink.host, "patch").then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toMatch(/hook says no|failed/);
      expect(head(dir, env)).toBe(at);
      expect(tags(dir, env)).toBe("");
      expect(status(dir, env)).not.toBe("");
      expect(existsSync(join(dir, "CHANGELOG.md"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; userNote: string }).toMatchObject({
        version: "0.0.1",
        userNote: "keep this edit",
      });
    },
  );

  test.each(["generation", "lock check", "head advance"])("a concurrent change during %s is preserved outside the release commit", async (when) => {
    const { dir, env } = project();
    const before = head(dir, env);
    const { host } = hostAt(dir, env);
    const generate = host.generate;
    const change = () => {
      write(dir, "app.js", "export const app = 'concurrent user work';\n");
      git(dir, ["add", "--", "app.js"], env);
      if (when === "head advance") git(dir, ["commit", "-q", "-m", "feat: concurrent work"], env);
    };
    if (when === "lock check")
      host.checkLock = () => {
        change();
        return { ok: true, output: "" };
      };
    else
      host.generate = async (input) => {
        const text = await generate(input);
        change();
        return text;
      };

    await expect(release.bump(host, "patch")).rejects.toThrow(/changed|clean working tree/);

    expect(readFileSync(join(dir, "app.js"), "utf8")).toContain("concurrent user work");
    if (when === "head advance") {
      expect(git(dir, ["log", "-1", "--format=%s"], env).trim()).toBe("feat: concurrent work");
      expect(existsSync(join(dir, "CHANGELOG.md"))).toBe(false);
    } else {
      expect(git(dir, ["show", "HEAD:app.js"], env)).toBe("export const app = 1;\n");
      expect(git(dir, ["diff", "--cached", "--name-only"], env).trim()).toBe("app.js");
      if (when === "generation") expect(head(dir, env)).toBe(before);
      else expect(git(dir, ["diff", "--name-only", "HEAD~1", "HEAD"], env).trim().split("\n")).toEqual(["CHANGELOG.md", "package.json"]);
    }
    expect(tags(dir, env)).toBe("");
  });

  test("a hook that dirties the tree after the commit is reported, and the commit and the tree stay as they are", async () => {
    const { dir, env } = project();
    hook(dir, env, "post-commit", "printf '// hook change\\n' >> app.js");
    const failure = await release.bump(hostAt(dir, env).host, "patch").then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/clean working tree/);
    expect(git(dir, ["log", "-1", "--format=%s"], env).trim()).toBe("chore: bump version to v0.0.1");
    expect(tags(dir, env)).toBe("");
  });

  test("a lock that no longer matches stops the bump and leaves prepared files for inspection", async () => {
    const { dir, env } = project();
    const at = head(dir, env);
    await expect(release.bump(hostAt(dir, env, { lock: false }).host, "patch")).rejects.toThrow(/pnpm-lock\.yaml/);
    expect(head(dir, env)).toBe(at);
    expect(status(dir, env)).not.toBe("");
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).toMatchObject({ version: "0.0.1" });
  });
});

describe("the tag of a reviewed merge", () => {
  /** A prepared release whose reviewed merge also carries a change made after the bump. */
  async function reviewedRelease() {
    const { dir, env } = project();
    await release.bump(hostAt(dir, env).host, "patch");
    write(dir, "app.js", "export const app = 'corrected during review';\n");
    commit(dir, env, "fix: address release review");
    mergeReviewed(dir, env);
    return { dir, env, merge: head(dir, env) };
  }

  test("is annotated, sits on the merge commit, and is judged by the repository alone", async () => {
    const { dir, env, merge } = await reviewedRelease();
    const { host, sink } = hostAt(dir, env);
    await release.tag(host);
    expect(git(dir, ["cat-file", "-t", "refs/tags/v0.0.1"], env).trim()).toBe("tag");
    expect(git(dir, ["rev-parse", "v0.0.1^{commit}"], env).trim()).toBe(merge);
    expect(git(dir, ["show", "v0.0.1:app.js"], env)).toContain("corrected during review");
    expect(sink.out()).toMatch(/git push origin v0\.0\.1/);

    // Main moves on: the old release is still valid, and its notes are only its own section.
    write(dir, "later.js", "export const later = 1;\n");
    commit(dir, env, "feat: later development");
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"], env);
    const notes = join(scratch.area, "notes.md");
    release.validate(hostAt(dir, env).host, { tag: "v0.0.1", notes });
    expect(readFileSync(notes, "utf8")).toMatch(/^## v0\.0\.1 \(2026-10-17\)\n[\s\S]*application feature/);
    expect(readFileSync(notes, "utf8")).not.toMatch(/^# Changelog/m);

    // A second publication of the same tag does not replace it.
    await expect(release.tag(hostAt(dir, env).host)).rejects.toThrow(/clean working tree|from main|regular merge|Tag v0\.0\.1 already exists/);
    expect(git(dir, ["rev-parse", "v0.0.1^{commit}"], env).trim()).toBe(merge);
  });

  test.each([
    [
      "a feature branch",
      (dir: string, env: NodeJS.ProcessEnv) => {
        git(dir, ["switch", "-q", "-c", "release/other"], env);
      },
      /from main/,
    ],
    [
      "a stale main",
      (dir: string, env: NodeJS.ProcessEnv) => {
        git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD~1"], env);
      },
      /origin\/main/,
    ],
    [
      "a head that is not a merge",
      (dir: string, env: NodeJS.ProcessEnv) => {
        write(dir, "next.js", "export const next = 1;\n");
        commit(dir, env, "feat: unreviewed next change");
        git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"], env);
      },
      /regular merge commit/,
    ],
    [
      "a dirty tree",
      (dir: string) => {
        write(dir, "scratch.js", "// scratch\n");
      },
      /clean working tree/,
    ],
    [
      "an existing tag",
      (dir: string, env: NodeJS.ProcessEnv) => {
        git(dir, ["tag", "-a", "v0.0.1", "HEAD~1", "-m", "existing"], env);
      },
      /Tag v0\.0\.1 already exists/,
    ],
  ])("%s creates no tag", async (_name, arrange, message) => {
    const { dir, env } = await reviewedRelease();
    arrange(dir, env);
    const before = tags(dir, env);
    await expect(release.tag(hostAt(dir, env).host)).rejects.toThrow(message);
    expect(tags(dir, env)).toBe(before);
  });

  test("a version with no changelog section creates no tag", async () => {
    const { dir, env } = await reviewedRelease();
    write(dir, "package.json", readFileSync(join(dir, "package.json"), "utf8").replace("0.0.1", "0.0.2"));
    commit(dir, env, "fix: mismatch the version");
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"], env);
    await expect(release.tag(hostAt(dir, env).host)).rejects.toThrow(/regular merge commit|exactly one section for v0\.0\.2/);
    expect(tags(dir, env)).toBe("");
  });

  test.each([
    ["a lightweight tag", "lightweight", /annotated tag/],
    ["an unreachable tag", "unreachable", /not reachable from origin\/main/],
    ["a mismatched version", "version", /version must match/],
    ["a missing exact section", "section", /exactly one section for v0\.0\.1/],
  ])("validation refuses %s", async (_name, kind, message) => {
    const { dir, env } = project();
    await release.bump(hostAt(dir, env).host, "patch");
    if (kind === "section") {
      write(dir, "CHANGELOG.md", "# Changelog\n\n## v0.0.10\n\nWrong version.\n");
      commit(dir, env, "docs: wrong release notes");
    }
    mergeReviewed(dir, env);
    const tag = kind === "version" ? "v0.0.2" : "v0.0.1";
    git(dir, kind === "lightweight" ? ["tag", tag] : ["tag", "-a", tag, "-m", tag], env);
    if (kind === "unreachable") git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD~1"], env);
    expect(() => {
      release.validate(hostAt(dir, env).host, { tag });
    }).toThrow(message);
  });

  test("validation refuses an annotated tag on an ordinary main commit", async () => {
    const { dir, env } = project();
    await release.bump(hostAt(dir, env).host, "patch");
    git(dir, ["tag", "-a", "v0.0.1", "-m", "v0.0.1"], env);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"], env);
    expect(() => {
      release.validate(hostAt(dir, env).host, { tag: "v0.0.1" });
    }).toThrow(/reviewed.*merge/);
  });

  test.each([false, true])("validation refuses a feature tag after merge, with review changes=%s", async (reviewChanges) => {
    const { dir, env } = project();
    await release.bump(hostAt(dir, env).host, "patch");
    git(dir, ["tag", "-a", "v0.0.1", "-m", "premature"], env);
    if (reviewChanges) {
      write(dir, "app.js", "export const app = 'corrected during review';\n");
      commit(dir, env, "fix: address release review");
    }
    mergeReviewed(dir, env);
    expect(() => {
      release.validate(hostAt(dir, env).host, { tag: "v0.0.1" });
    }).toThrow(/reviewed.*merge/);
  });
});

describe("the identity audit on real commit objects", () => {
  test("user and bot noreply identities pass; an ordinary address stops the tag without being printed", async () => {
    const { dir, env } = project();
    const identity = (name: string, email: string) => ({
      ...env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    });
    await release.bump(hostAt(dir, env).host, "patch");
    write(dir, "user.js", "export const user = 1;\n");
    commit(dir, identity("A User", at("12345+a-user", "users.noreply.github.com")), "feat: by a noreply user");
    write(dir, "bot.js", "export const bot = 1;\n");
    commit(dir, identity("github-actions[bot]", at("41898282+github-actions[bot]", "users.noreply.github.com")), "feat: by the template bot");
    mergeReviewed(dir, env);
    await release.tag(hostAt(dir, env).host);
    expect(tags(dir, env)).toBe("v0.0.1");

    // The same history with one ordinary address in the author and another in the committer.
    git(dir, ["tag", "-d", "v0.0.1"], env);
    git(dir, ["switch", "-q", "-c", "release/private"], env);
    write(dir, "private.js", "export const secret = 1;\n");
    git(dir, ["add", "-A"], env);
    git(dir, ["commit", "-q", "-m", "feat: by someone with a private address"], {
      ...env,
      GIT_AUTHOR_EMAIL: at("private.person", "example.com"),
      GIT_COMMITTER_EMAIL: at("other.private", "example.org"),
    });
    git(dir, ["switch", "-q", "main"], env);
    git(dir, ["merge", "-q", "--no-ff", "release/private", "-m", "Merge private"], env);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"], env);
    const { host, sink } = hostAt(dir, env);
    const failure = await release.tag(host).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/author e-mail is not a GitHub noreply address/);
    expect(failure?.message).toMatch(/committer e-mail is not a GitHub noreply address/);
    expect(`${failure?.message ?? ""}${sink.out()}${sink.err()}`).not.toMatch(/private\.person|other\.private|example\.(com|org)/);
    expect(tags(dir, env)).toBe("");
  });
});

describe("the public commands", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(root, "scripts/development.cjs"), ...args], { cwd: root, env: { ...process.env, INIT_CWD: root }, encoding: "utf8" });

  test("release:bump needs exactly one of patch, minor and major, and says so before touching anything", () => {
    const files = ["package.json", "CHANGELOG.md"].map((file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : null));
    for (const args of [["release:bump"], ["release:bump", "prerelease"], ["release:bump", "patch", "minor"], ["release:bump", "--segment=patch"]]) {
      const result = run(...args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toMatch(/patch, minor or major/);
    }
    expect(["package.json", "CHANGELOG.md"].map((file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : null))).toEqual(files);
  });

  test("release:tag takes no argument and release:validate only --tag and --notes", () => {
    expect(run("release:tag", "now").status).toBe(2);
    expect(run("release:validate", "--force=1").status).toBe(2);
    expect(run("release:validate", "--tag=latest").status).toBe(2);
  });
});
