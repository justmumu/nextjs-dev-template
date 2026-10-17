# Toolchain

The generator and the projects it creates use Node and pnpm only. Nothing in
setup, checks, docs or builds needs Python, uv, Copier, MkDocs, Make or a
Python-based pre-commit or Commitizen.

## Exact versions

| Dependency graph      | Version authority                                        |
| --------------------- | -------------------------------------------------------- |
| Generator tools       | Root `package.json` and `pnpm-lock.yaml`                 |
| Application seed      | `template/app/package.json` and its own `pnpm-lock.yaml` |
| Generated application | Its own `package.json` and `pnpm-lock.yaml`              |

Package versions live only in their manifest and lock. `tooling/versions.json` keeps the Node and
pnpm metadata, the explicit `root.reviewedTools` name list and `seed.deniedBuilds`. A dependency
update does not require copying its version into that file. The root and seed graphs can move independently.

Node and pnpm are host-owned prerequisites: install the exact versions in `.node-version` and
`packageManager`. The runtime metadata must agree with those declarations and `engines.node`.
No runtime picks another version for you, and `devEngines.runtime` is not used.

## Supported update lines

- TypeScript stays below 7 until `typescript-eslint` supports it and the suppression-policy rule has
  a supported compiler API. A TypeScript 7 migration is separate work.
- ESLint and `@eslint/js` stay below 10 in the seed and generated apps until the React, import and
  accessibility plugins used by `eslint-config-next` accept that major. The generator has no such peer
  restriction; its ESLint updates must still pass checks for both the generator and rendered application.
- `@types/node` stays on the Node 24 runtime line. Reassess the hold with a runtime-major upgrade.
- Coupled packages such as Next.js and its ESLint config are reviewed together. Other majors, including
  `globals`, are assessed separately. No version is considered compatible solely because a bot proposes it.

See [Continuous integration](ci#dependabot-updates) for grouping and hold removal rules.
All updates keep strict peers, the 24-hour release-age limit, reviewed overrides and frozen installs.
The build scripts of `esbuild`, `core-js` and `unrs-resolver` remain denied where declared in the
workspace policy. The prebuilt native binaries are used; a dependency that needs a source build fails.
The documentation link checker uses `hyperlink --internal` on local files, and its dependencies remain
subject to the reviewed [audit decisions](ci#dependency-audit).

Package pins stay exact. Existing CI checks the rendered application's install, static gates, production
build and browser behavior when the seed or shared tooling changes.

## Graph ownership

The root `package.json` and `pnpm-lock.yaml` belong to the generator. The app seed
owns its own manifest and lock and is not a workspace member (`pnpm-workspace.yaml`
has no `packages`). Generated projects never use `workspace:*`, parent overrides or
generator `node_modules`. pnpm 12 locks may contain several YAML documents; do not
parse them by hand.

## Commands

Routine work goes through `pnpm run <script>`; each script is a literal call to a
Node dispatcher (`scripts/development.cjs`, `scripts/dependencies.cjs`). Flags are
written `--name=value`; there is no `--` separator and no extra flag is accepted.
The scripts are defined once in `scripts/development.cjs` and projected into the
generator and application `package.json` files; a test fails on drift.

| Command                                                                                                              | Status                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/bootstrap.cjs setup`                                                                                   | Checks exact Node and pnpm, installs from the frozen lock, binds the guard's Node binary and installs the Git hooks.                                                                                                                                                                                                   |
| `node scripts/bootstrap.cjs repair`                                                                                  | Rebuilds project-local `node_modules` from the frozen lock and clears the incomplete-install marker. Never regenerates a manifest or lock; the global store is untouched.                                                                                                                                              |
| `node scripts/bootstrap.cjs deps-lock`                                                                               | Relocks and installs after a dependency-manifest edit that was approved separately. Refuses any protected difference from the committed `HEAD`.                                                                                                                                                                        |
| `pnpm run audit:dependencies`                                                                                        | Read-only report of the known advisories of the runtime, development and tool graphs (and the application seed) against the reviewed decisions in `tooling/audit-policy.json`; fails on an unreviewed advisory, an expired review or an incomplete audit, and never fixes or merges. See [CI and supply chain](ci.md). |
| `pnpm run check`                                                                                                     | Frozen lock consistency (checked read-only on a disposable copy of the metadata; registry metadata missing from the cache may be fetched, a stale lock never passes), format, lint, typecheck, unit tests. Unit tests run per suite with coverage thresholds; see [Unit tests and coverage](testing.md).               |
| `pnpm run format`, `format:check`, `lint`, `lint:fix`                                                                | Prettier and ESLint with the project's own configuration; see [Static quality](static-quality.md).                                                                                                                                                                                                                     |
| `pnpm run typecheck`                                                                                                 | Generator: `tsc --noEmit`. Application: managed-block check, `next typegen`, then `tsc` for the app and for the checked-JS tooling.                                                                                                                                                                                    |
| `pnpm run test:one --test=<path> [--suite=<name>] [--name=<literal>]`                                                | One test file of a registered suite, optionally one literal test name; see [Unit tests and coverage](testing.md).                                                                                                                                                                                                      |
| `pnpm run test:integration [--scenario=<id>]`                                                                        | The non-browser integration suite: real pnpm, Git, process and filesystem scenarios.                                                                                                                                                                                                                                   |
| `pnpm run deps:add --package=<name[@version]> --group=<prod\|dev>`, `deps:remove`, `deps:upgrade [--package=<name>]` | Dependency transactions.                                                                                                                                                                                                                                                                                               |
| `pnpm run template:create --name=<name> --owner=<login> --dest=<path>`, `template:seed:refresh`                      | Generator only; see [Getting started](../getting-started).                                                                                                                                                                                                                                                             |
| `pnpm run template:apply --preview=<path>`                                                                           | Applications only, run by a person: proves a preview again, then leaves the native merge uncommitted for review; agents have no allowance for it. See [Updating from the template](../updating).                                                                                                                       |
| `node scripts/template/update.cjs inspect\|abort\|resume`                                                            | Applications only, run by a person: look at, undo or go on with an update in progress. Node alone; works with a broken `package.json` and no `node_modules`.                                                                                                                                                           |
| `pnpm run template:preview --ref=<ref>`                                                                              | Applications only: previews a template update as a native merge in a disposable clone and changes nothing in the project; see [Updating from the template](../updating).                                                                                                                                               |
| `pnpm run release:bump patch\|minor\|major`, `release:tag`, `release:validate`                                       | Reviewed releases: prepare a version commit without a tag, annotate the reviewed merge, validate a tag; none pushes or publishes. See [Release process](release-process).                                                                                                                                              |
| `pnpm run docs:build`                                                                                                | VitePress build, then hyperlink over every emitted HTML file (offline, internal only); see [Getting started](../getting-started).                                                                                                                                                                                      |
| `pnpm run dev`, `build`, `start`                                                                                     | Applications only: Next.js development server, production build and production server. A managed Next.js agent-rules block in `AGENTS.md` or `CLAUDE.md` is refused first.                                                                                                                                             |
| `pnpm run test:e2e`, `test:artifact`                                                                                 | Production browser tests and the standalone artifact proof in a disposable fixture; see [Production browser and standalone tests](production-tests). In the generator they render an application first.                                                                                                                |
| `pnpm run test:permissions`                                                                                          | The host-declaration policy tests, then the installed Codex CLI's own evaluation of the publishing rules. Without a Codex CLI it says so explicitly; that is not a pass. A project without the permission tests fails.                                                                                                 |

pnpm keeps `verifyDepsBeforeRun: error`. After a dependency-manifest edit, or with
`node_modules` missing, `pnpm run` refuses to start; use `bootstrap.cjs repair` or
`deps-lock`, which need no `node_modules`. Pre/post scripts are disabled
(`enablePrePostScripts: false`).

## Dependency changes

A dependency command may change only the requested dependency map entry and the lock.
Before pnpm runs, the protected surface is snapshotted. `scripts/core/protected.cjs` is its
single inventory (the protected-files guard extends the same module): the manifest, lock
and workspace file, `.npmrc`, `.node-version`, `AGENTS.md`, `CLAUDE.md`, pnpmfiles and
static tool configuration (TypeScript, Next.js, ESLint, Prettier, Vitest, Playwright,
PostCSS, docs configuration), `scripts/`, `tooling/`, agent settings, `.githooks/`, and
shadow overrides (a `.npmrc`, workspace, pnpmfile or lint/format/test configuration file
anywhere below the root, except in `template/` and `tests/fixtures/`). Git configuration and
hooks are snapshotted through the paths Git itself resolves, so a linked worktree's
hooks and configuration (which live under the main repository, not under a `.git`
directory of the root) are covered too. The result is judged from the files, not from
pnpm's exit code or a script's report: any other change, or any failure, restores those
bytes (a replaced symlink is unlinked and recreated, never followed; file modes are kept)
and marks the install incomplete (`node_modules/.template-environment-dirty`). An accepted
result must also pass a frozen-lock check, so a manifest edited after pnpm's own write is
rejected. Every routine command then refuses to run until `bootstrap.cjs repair` succeeds. A lifecycle script that rewrites
`scripts.check`, a build-permission placeholder written by pnpm, `permissions.build`,
`scriptShell`, `shellEmulator` and pnpmfile hooks are never accepted as part of a
dependency change. A package that newly needs a build gets a review message naming it;
no permission is adopted. Specifiers are literal: a package name with an exact version or
dist-tag, never a URL, range or alias. Versions are saved exact. `.npmrc` credentials stay
outside the repository and are masked in command output.

`deps-lock` assumes the manifest edit was approved and reconciled elsewhere; it grants
no approval. With the guard capability registered in `tooling/capabilities.json`, it
also requires `scripts/hooks/state.cjs` to export `status(root)` answering `{ clean: true }`
for a coherent baseline with no pending reservation or conflict. Anything else (a missing
module, a throw, any other answer) refuses.

If a relock fails (for example the store is unreachable), the approved manifest bytes stay,
the lock is restored and the install stays marked incomplete with `kind=deps-lock`. `repair`
refuses a stale lock and says so; the same `deps-lock` can be run again once the failure
is fixed. It repeats every check (committed baseline, unchanged protected files, the
dependency-only boundary) and clears the marker only after the frozen install succeeds.
Any other incomplete install must be repaired first.

### Reviewed pins versus ordinary dependencies

`tooling/versions.json` lists the generator's reviewed tool names; `package.json` supplies their exact
versions. The dependency command snapshots those versions before running pnpm. Changing one is a
reviewed tooling change; `deps:add`, `deps:remove` and `deps:upgrade` refuse it before
running anything. `deps:upgrade` without a name is the whole set or nothing: while a pin is
a dependency it is refused with the pin names, and other dependencies are upgraded one at a
time with `--package=<name>`. Any other dependency is ordinary: the pin contract checks that the pins hold, not that
the dependency set is exactly the pins, so adding one does not break the checks.
A reviewed version change edits the manifest through the approved route and relocks with
`node scripts/bootstrap.cjs deps-lock`. Seed changes use `pnpm run template:seed:refresh`, which resolves
the seed manifest in a disposable directory and replaces its lock only on success. Dependabot supplies
the manifest and lock together; its proposal is reviewed through the same PR gates.
Generated applications carry no reviewed-name file and are not restricted this way.

### Workspace policy parser

`pnpm-workspace.yaml` is read with a deliberately narrow, dependency-free parser (bootstrap
cannot use a YAML library). It accepts full-line comments, top-level `key: scalar` lines and
one level of two-space-indented `key: scalar` children, with plain or quoted names. Anything
else (quoted top-level keys, flow maps other than `{}`/`[]`, lists, anchors, aliases, tags,
block scalars, inline comments, tabs, duplicate keys, unknown top-level keys) fails the
policy instead of being skipped.

### Package manager preflight

The preflight runs `pnpm --version` with Corepack network access off and
`pmOnFail=ignore`, so it reports the installed manager and never downloads or switches to the
version a project names; a mismatch is an expected/found error. Project configuration is not
changed for this.

## Verify this foundation

```sh
node scripts/bootstrap.cjs setup
pnpm run typecheck
pnpm run test:one --test=tests/unit/commands.test.ts
pnpm run test:integration --scenario=dependencies
```

Node and pnpm are the only prerequisites. `test:one` is focused feedback and does not
replace the full gates added by later units.

## Behaviour mapping from the Python template

`tooling/upstream-policy.json` records the source revision
`7f8da69c6f9f69e4fc4d1547c712fb8ef1f1d0b7` and the format of the mapping from
source behaviour to JS owner and test. The source is a behaviour reference only;
nothing from it is executed or imported. Entries are added by the units that
port each behaviour.

## Commit identity

Commits in this repository use a GitHub noreply address for author and committer.
That is local Git configuration; no template file stores an owner e-mail, and
generated projects never receive one.
