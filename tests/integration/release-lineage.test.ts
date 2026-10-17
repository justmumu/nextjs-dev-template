import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { capture, scratchArea } from "../support/project.ts";
import { commit, fixtureEnv as releaseEnv, git, hostAt, write } from "../support/release-fixture.ts";
import { generatorCopy, hostFor, initialize, inputsOf, passing, stateModule } from "../support/template-fixture.ts";
import { accept, advance, lineage, runIn } from "../support/template-lineage.ts";

// The changelog of applications made by both creation routes, whose history carries template snapshot
// commits and, after an update, a second snapshot. Generator-only: it needs the generator's fixtures.
const require = createRequire(import.meta.url);
const release = require("../../scripts/release.cjs") as typeof import("../../scripts/release.cjs");
const changelog = require("../../scripts/release/changelog.cjs") as typeof import("../../scripts/release/changelog.cjs");
const scratch = scratchArea("release-lineage-");
const { source, createApp, previewFile, applyPreview } = lineage(scratch.area);

describe("the changelog of an application with a template lineage", () => {
  const viaBothRoutes = [
    ["the local route (B0, E0)", false],
    ["the GitHub copy route (O, B0, E0)", true],
  ] as const;

  test.each(viaBothRoutes)(
    "%s leaves out snapshots and template history and keeps merged feature commits",
    async (_name, copied) => {
      const env = releaseEnv(scratch.area);
      const gen = source(env, {});
      const name = copied ? "release-copied" : "release-local";
      let app: string;
      if (copied) {
        const dir = generatorCopy(scratch.area, name, env);
        git(dir, ["commit", "--amend", "-q", "-m", "feat: template headline"], env);
        const sink = capture();
        const done = await initialize.initializeCopy({
          host: hostFor(env, { run: passing }),
          io: sink.io,
          isCancelled: () => false,
          root: dir,
          inputs: inputsOf(gen),
          answers: { name: "made-app", owner: "made-owner" },
        });
        if (done !== 0) throw new Error(sink.err());
        app = dir;
      } else {
        app = await createApp(name, gen, env);
      }

      write(app, "src/cosmetic.ts", "export const cosmetic = 1;\n");
      write(app, ".template-state.json", `${JSON.stringify(stateModule.parseState(readFileSync(join(app, ".template-state.json"), "utf8")))}\n`);
      commit(app, env, "feat: feature alongside state formatting");

      // A feature branch with two commits, merged the way a pull request is.
      git(app, ["switch", "-q", "-c", "feature/orders"], env);
      write(app, "src/orders.ts", "export const orders = 1;\n");
      commit(app, env, "feat(orders): list the orders");
      write(app, "src/orders.ts", "export const orders = 2;\n");
      commit(app, env, "fix(orders): sort the orders");
      git(app, ["switch", "-q", "main"], env);
      git(app, ["merge", "-q", "--no-ff", "feature/orders", "-m", "Merge pull request: orders"], env);

      // A template update (a second snapshot) and the person's merge of it.
      advance(
        gen,
        env,
        { "template/app/next.config.ts": `${readFileSync(join(gen, "template/app/next.config.ts"), "utf8")}// from the template\n` },
        "feat: template change",
      );
      const preview = await previewFile(app, env, gen);
      const applied = await applyPreview(app, env, gen, preview.path);
      expect(applied.status, applied.err).toBe(0);
      expect(accept(app).status).toBe(0);
      git(app, ["commit", "-q", "--no-edit"], env);
      expect(runIn(app, "resume").status).toBe(0);

      write(app, "src/after.ts", "export const after = 1;\n");
      commit(app, env, "feat: work after the update");

      const state = stateModule.parseState(readFileSync(join(app, ".template-state.json"), "utf8"));
      const lineageOf = changelog.snapshotLineage(hostAt(app, env).host.git, app);
      expect(lineageOf.baselines).toHaveLength(2);
      expect(lineageOf.baselines).toContain(state.baseline.commit);
      for (const id of lineageOf.baselines) expect(lineageOf.excluded.has(id)).toBe(true);

      git(app, ["switch", "-q", "-c", "release/one"], env);
      await release.bump(hostAt(app, env).host, "patch");
      const text = readFileSync(join(app, "CHANGELOG.md"), "utf8");
      expect(text).toMatch(/## v0\.0\.1 \(2026-10-17\)/);
      expect(text).toMatch(/list the orders/);
      expect(text).toMatch(/sort the orders/);
      expect(text).toMatch(/work after the update/);
      expect(text).toMatch(/feature alongside state formatting/);
      expect(lineageOf.enrollments).toHaveLength(1);
      expect(text).not.toMatch(/template headline|copy of the template|pristine|enroll|template change|update to|Merge/);
      expect(JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as { version: string }).toMatchObject({ version: "0.0.1" });
      expect(accept(app).status).toBe(0);
      expect(git(app, ["status", "--porcelain"], env)).toBe("");
    },
    240_000,
  );

  test("an unverified baseline tree stops history filtering", async () => {
    const env = releaseEnv(scratch.area);
    const gen = source(env, {});
    const app = await createApp("invalid-baseline", gen, env);
    const state = stateModule.parseState(readFileSync(join(app, ".template-state.json"), "utf8"));
    write(app, ".template-state.json", stateModule.serializeState({ ...state, baseline: { ...state.baseline, tree: "0".repeat(40) } }));
    commit(app, env, "chore: inconsistent baseline");
    expect(() => changelog.snapshotLineage(hostAt(app, env).host.git, app)).toThrow(/baseline.*tree|tree.*state/);
  });
});
