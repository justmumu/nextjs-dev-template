# Development rules

These rules apply to contributors, Claude Code and Codex working on `justmumu/nextjs-dev-template`, the
generator of the JavaScript-only Next.js development template. Host-specific files reference this policy
instead of maintaining a second copy. The Python template it was derived from is behavior reference only
(`tooling/upstream-policy.json` records the revision); all project tooling is JavaScript and TypeScript on
Node and pnpm.

## Environment and commands

Install Node and pnpm at the exact versions in `.node-version` and `packageManager`; Git and the
operating system's `file` command are also needed (see `docs/guides/platforms.md`). Run
`node scripts/bootstrap.cjs setup` once to install the locked dependencies and the Git hooks. Setup
needs only Node, so it also works when `node_modules` is missing or damaged. Use the `pnpm run` scripts
below for routine development; each is a literal call to a protected Node dispatcher that selects the tools
and arguments. Change dependencies only through the `deps:*` scripts. Do not install dependencies with
another package manager.

- `pnpm run check`: lock consistency, formatting, lint, strict typing and unit tests with coverage.
  The pre-push hook runs this gate.
- `pnpm run format`, `pnpm run lint:fix`, `pnpm run typecheck`: individual checks and fixes.
- `pnpm run deps:add`, `deps:remove` and `deps:upgrade` (see `docs/contributing/toolchain.md` for their
  `--package` and `--group` flags): change dependencies and the lock.
- `node scripts/bootstrap.cjs deps-lock`: relock after a user-approved dependency manifest edit.
- `node scripts/bootstrap.cjs repair`: rebuild `node_modules` from the frozen lock. It is the way out of
  an incomplete install; `pnpm run` refuses to start until then and that refusal is never switched off.
- `pnpm run test:one --test=<path> [--name=<literal>]`: focused feedback on one test file. It does not
  replace `check` or apply the suite-wide coverage thresholds.
- `pnpm run test:integration [--scenario=<id>]`: real tool, Git, hook, release and update scenarios. CI
  runs them; run one locally only when developing an integration test or its harness, and select the
  relevant scenario instead of rerunning the whole matrix.
- `pnpm run test:permissions`: the agent policy tests plus the real Codex execpolicy checks when a Codex
  CLI is installed; without one it reports that those checks did not run.
- `pnpm run template:create --name=<name> --owner=<login> --dest=<path>` and `pnpm run template:seed:refresh`:
  create a project from this checkout and refresh the application seed's lock. They exist only in the
  generator.
- `pnpm run docs:build`: build the documentation with strict link and anchor checks.
- `pnpm run test:e2e` and `pnpm run test:artifact`: the generator has no Next.js application of its own, so
  they render one from the seed into a disposable fixture, install it from its frozen lock and run the
  application's own production build, browser and standalone proofs there. CI runs them; the reports of a
  failed browser run are kept in the ignored `test-results/`.

Classify tests by their scope and the real components they exercise, not by their duration. A short
integration test still belongs with the integration scenarios, and async server components and the
production build are proven by the build and browser tests, not by unit coverage.

Git hooks own routine verification. Pre-commit formats and lints the changed files and checks the
protected files and the lock. Commit-msg checks the Conventional Commit message. Pre-push runs
`pnpm run check` and `pnpm run docs:build`, but not the integration tests. Do not repeat a passing hook gate
by hand before a PR or after each edit; use focused checks while developing or diagnosing a change.

Do not replace these scripts with direct `vitest`, `tsc`, `eslint` or `prettier` calls, alternate
configurations or flags that weaken a check. If a routine action lacks a script, propose adding one. Tool
invocations inside the scripts and test harnesses are implementation details, not alternate workflows.

## Protected configuration and approvals

Neither agent runs in an operating-system sandbox. A guard hook (`scripts/hooks/guard.cjs`, plain Node with
no dependencies) runs around every Claude Code and Codex tool call and protects the files that define this
project's rules and tooling: package manifests and locks, `pnpm-workspace.yaml`, `.npmrc`, `.node-version`,
tool and framework configuration (TypeScript, Next.js, ESLint, Prettier, Vitest, Playwright, PostCSS,
lint-staged, commitlint), `scripts/`, `tooling/`, `.claude/`, `.codex/`, `.template-state.json`,
`AGENTS.md` and `CLAUDE.md`, and the application seed below `template/app/`. `tooling/policy.json` is the
full inventory. It also removes new files that
would shadow a root configuration, such as a nested `.npmrc`, ESLint or Vitest configuration.

Reading protected files is always allowed. Routine source, test and documentation edits proceed within the
user's task without repeated confirmation.

Agents do not write protected files directly. After each call the guard restores any change that no
approved route made, removes shadow configuration files and unstages unapproved staged content, then says
why. The approved routes are:

- the exact plain commands `pnpm run format`, `pnpm run lint:fix`, `pnpm run deps:add|deps:remove|deps:upgrade`
  with their declared arguments, `node scripts/bootstrap.cjs deps-lock`, `setup` and `repair`, run from the
  project root in the foreground. A prefix, a chain, a background run or a shell expansion is not a route;
- a plain standalone `git commit`, so the hooks run. The guard refuses a commit chained with other
  commands or built with `$(...)`; write the message to a file and use `git commit -F <file>`;
- plain `git switch`, `checkout`, `pull`, `merge`, `rebase`, `reset`, `restore`, `stash`, `cherry-pick`
  and `gh pr checkout`, which ask the user first;
- a Claude Code Edit or Write on a protected file, which asks the user first. Prepare the exact diff before
  asking; an approval covers that change. Codex cannot make approved edits and cannot edit protected files
  directly: prepare the concrete diff and ask the user to apply it.

The guard refuses commands that switch checks off: `--no-verify`, `git commit -n`, `SKIP=`, `HUSKY=`,
`core.hooksPath`, `GIT_CONFIG_*`, running the guard or touching its baseline directly, and a user-approved
goal (`guard-accept`, `release:bump`, `release:tag`) combined with other goals or variables. A call that
moves `HEAD` without an approved route, or a merge, rebase or cherry-pick that leaves protected files
conflicted, stops further agent calls for the user to resolve. Calls that may change protected files run
alone; when the guard says another call is running, retry after it finishes. A long-running dev server does
not give any call permission to change protected files.

When the guard reports that protected state changed outside an agent call, stop and ask the user whether
they made the change. If they want to keep it, they review the exact diff and run
`node scripts/bootstrap.cjs guard-accept` themselves; never run it to get past a refusal on your own. When
it reports changed installed dependencies, run `node scripts/bootstrap.cjs repair`; if the repair fails, the
environment is not trusted. A template update is applied by the user in their own terminal, not by an agent.

Do not substitute a script, symlink, chained shell command or edited configuration to get around the guard,
and never weaken checks merely to make them pass. Hook, permission and guard changes are policy changes that
need user authorization. The guard is a guardrail against mistakes, not a security boundary, and it is
not an operating-system sandbox. It does not prove that installed dependencies are intact; see
[agent setup and limitations](docs/contributing/agents.md) for how it works and what it does not cover.

## Quality and code navigation

Use focused regression tests for behavior changes and fix root causes. Prefer `pnpm run lint:fix` safe
fixes before manual changes. A lint or type suppression must name its rule, carry a reason and cover the
narrowest line or block; a file-wide or reasonless suppression fails the lint gate. Details are in
[Static quality](docs/contributing/static-quality.md).

Prefer LSP for definitions, references and renames when the current host exposes it. Otherwise use `rg` and
inspect the relevant files and call sites; the commit hook runs the type check for TypeScript changes. Never
claim an LSP check ran when the tool is unavailable. Before changing a signature or renaming a symbol, find
and inspect its usages. Host diagnostic errors are blockers when provided; the explicit checks work on both
hosts.

## Git and releases

Every change ships through a feature branch and PR. Never commit or push directly to `main`. Use
`codex/short-description` for Codex branches; otherwise use `type/short-description`. Commits follow
Conventional Commits with subjects of at most 72 characters. Do not bypass Git hooks. Use a GitHub noreply
email for both author and committer and verify the actual commit metadata before publishing.

Before a PR, follow the [checklist](docs/contributing/pr-checklist.md) and make sure the pre-push gates
passed; no duplicate manual run is required. Merge with a regular merge commit, never squash. A version bump
also goes through a PR: `pnpm run release:bump patch|minor|major` prepares the release commit without a tag.
After review and merge, update `main` and run `pnpm run release:tag` to annotate the reviewed merge, then
push that tag. Follow the [release process](docs/contributing/release-process.md).

Publishing is the user's decision each time. Ask before every `git push`, opening a PR, merging,
`pnpm run release:bump`, `pnpm run release:tag`, pushing a tag and deployment; an earlier approval covers only
the action it named, and a skill that publishes does not change this. Commit on the feature branch, report
what is ready and let the user choose between more development and publishing; batch related changes into
one PR. Claude Code enforces this through its permission rules, and Codex through
`.codex/rules/publishing.rules`, which prompts before these commands and `guard-accept` in a trusted project.
Codex matches only the plain forms, so never publish with prefixes such as `git -C <dir> push`.

## Optional skills and private working notes

Both hosts enable Compound Engineering from the project settings. It is optional: core development works
without the plugin or either CLI. Use installed skills when they help.

Compound Engineering writes its artifacts under `.compound-engineering/artifacts/`. The `solutions/` tree
there holds documented solutions to past problems, organized by category with YAML frontmatter; it is worth
searching when working in an area it covers.

After a solved, verified problem, offer once to invoke the `ce-compound` skill at the completion checkpoint
only when the work produced durable project reasoning that is not readily recoverable from the final code,
tests, types, comments or existing documentation, and losing it would plausibly cause recurrence, material
risk or substantial rediscovery. Apply this counterfactual: if the learning document disappeared, would a
future engineer reading the final implementation still be likely to repeat the mistake or redo substantial
investigation? If not, do not offer. Completion, effort and diff size alone are not enough. Offer at the
checkpoint so a qualifying learning can ship in the PR that produced it, and only where the repository
treats captured learnings as tracked, committed knowledge.

Write every report, summary or handoff to the user through the `ce-noslop` skill. This applies when you are
the top-level agent writing to the user, not when you are a subagent reporting to its caller. Do not apply it
to code, config, verbatim quotes or text the user asked to post as written.

Private working notes stay in the gitignored `.private/` directory. The tracked `docs/` tree is the public
documentation website, not a private planning area. The reviewed implementation plan under
`.compound-engineering/artifacts/plans/` is immutable; do not edit it to match what was built.

## Next.js documentation

The generator root has no Next.js dependency, so it has no `node_modules/next/dist/docs/`. Before writing or
changing the application seed under `template/app/`, install an application rendered from it (create one with
`pnpm run template:create`; the fixtures of `test:e2e` are removed when the run ends) and read the guide for the installed
version in that application's `node_modules/next/dist/docs/` instead of relying on memory; the APIs and file
conventions differ between versions. The emitted application's own `AGENTS.md` points at its own installed
copy. This text is maintained by hand: the template sets `agentRules: false`, so `next dev` never writes its
own block into these files, and a managed Next.js block found in an application's `AGENTS.md` or `CLAUDE.md`
fails its typecheck until it is migrated explicitly.
