# Toolchain

The generator and the projects it creates use Node and pnpm only. Nothing in
setup, checks, docs or builds needs Python, uv, Copier, MkDocs, Make or a
Python-based pre-commit or Commitizen.

## Exact versions

| Tool                                     | Version                  | Where it is pinned                 |
| ---------------------------------------- | ------------------------ | ---------------------------------- |
| Node                                     | 24.21.0                  | `.node-version`, `engines.node`    |
| pnpm                                     | 12.14.0                  | `packageManager`                   |
| Next.js / React / React DOM              | 16.4.1 / 19.3.0 / 19.3.0 | `tooling/versions.json` (app seed) |
| TypeScript                               | 6.0.3                    | `tooling/versions.json`            |
| ESLint / eslint-config-next              | 9.39.5 / 16.4.1          | `tooling/versions.json` (app seed) |
| Vitest / Playwright                      | 5.0.5 / 1.64.1           | `tooling/versions.json`            |
| typescript-eslint / @eslint/js / globals | 8.71.2 / 9.39.5 / 16.4.0 | `tooling/versions.json`            |
| Prettier                                 | 3.9.10                   | `tooling/versions.json`            |
| VitePress / hyperlink                    | 1.6.4 / 5.0.4            | `tooling/versions.json`            |

`tooling/versions.json` is the reviewed source. The root `package.json` projects
its `root` section; a test fails when they drift. Node and pnpm are host-owned
prerequisites: install exactly these versions (for example with Corepack).
No runtime picks another version for you, and `devEngines.runtime` is not used.

## Why these versions

Chosen from registry engines/peers and proven with a real Next.js fixture
(strict peers, `next build`, `tsc`, ESLint, Vitest, Playwright, frozen reinstall):

- TypeScript 6.0.3, not 7.x: `typescript-eslint` (required by `eslint-config-next`)
  supports TypeScript `<6.1.0`.
- ESLint 9.39.5, not 10.x: `eslint-plugin-import`, `eslint-plugin-jsx-a11y` and
  `eslint-plugin-react` (via `eslint-config-next@16.4.1`) do not accept ESLint 10.
- React DOM 19.3.0, not 19.3.1: 19.3.1 requires a `react@^19.3.1` that is not published.
- typescript-eslint 8.71.2 is the newest release older than the 24-hour release-age limit that accepts
  TypeScript 6.0.3 and ESLint 9; `@eslint/js` follows ESLint, and `globals` 16.4.0 is the version
  `eslint-config-next@16.4.1` uses.
- `@types/node` 24.x matches the Node 24 runtime.
- VitePress 1.6.4 is the newest stable release (2.x is alpha only); hyperlink 5.0.4 is the newest
  release. Both go through the same exact-pin and frozen-lock rules. Their dependencies bring two
  build scripts that are denied (`allowBuilds`): `esbuild` (its prebuilt platform binary is used) and
  `core-js` (its script only prints a banner). hyperlink pulls in the deprecated `request`; it only
  reads local files here (`--internal`), and the audit report names it.
- `unrs-resolver` build scripts are denied (`allowBuilds`); its prebuilt native
  binary is used. A dependency that needs a source build fails the install.

Next.js and eslint-config-next use 16.4.1: the first cold-cache test rejected
16.4.2 because it was younger than pnpm's default 24-hour release-age limit.
The [16.4.2 release notes](https://github.com/vercel/next.js/releases/tag/v16.4.2)
list Turbopack and documentation fixes. No release-age exception was added.
The rendered application is tested with a fresh package store and cache.

Re-run the fixture proof when any pin changes. Pins are exact; ranges are rejected.

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

| Command                                                                                                              | Status                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/bootstrap.cjs setup`                                                                                   | Checks exact Node and pnpm, installs from the frozen lock. Hooks are not installed yet (the installer arrives later).                                                                                                                                                                                    |
| `node scripts/bootstrap.cjs repair`                                                                                  | Rebuilds project-local `node_modules` from the frozen lock and clears the incomplete-install marker. Never regenerates a manifest or lock; the global store is untouched.                                                                                                                                |
| `node scripts/bootstrap.cjs deps-lock`                                                                               | Relocks and installs after a dependency-manifest edit that was approved separately. Refuses any protected difference from the committed `HEAD`.                                                                                                                                                          |
| `pnpm run check`                                                                                                     | Frozen lock consistency (checked read-only on a disposable copy of the metadata; registry metadata missing from the cache may be fetched, a stale lock never passes), format, lint, typecheck, unit tests. Unit tests run per suite with coverage thresholds; see [Unit tests and coverage](testing.md). |
| `pnpm run format`, `format:check`, `lint`, `lint:fix`                                                                | Prettier and ESLint with the project's own configuration; see [Static quality](static-quality.md).                                                                                                                                                                                                       |
| `pnpm run typecheck`                                                                                                 | Generator: `tsc --noEmit`. Application: managed-block check, `next typegen`, then `tsc` for the app and for the checked-JS tooling.                                                                                                                                                                      |
| `pnpm run test:one --test=<path> [--suite=<name>] [--name=<literal>]`                                                | One test file of a registered suite, optionally one literal test name; see [Unit tests and coverage](testing.md).                                                                                                                                                                                        |
| `pnpm run test:integration [--scenario=<id>]`                                                                        | The integration suite: real pnpm, Git, process and filesystem scenarios.                                                                                                                                                                                                                                 |
| `pnpm run deps:add --package=<name[@version]> --group=<prod\|dev>`, `deps:remove`, `deps:upgrade [--package=<name>]` | Dependency transactions.                                                                                                                                                                                                                                                                                 |
| `pnpm run template:create --name=<name> --owner=<login> --dest=<path>`, `template:seed:refresh`                      | Generator only.                                                                                                                                                                                                                                                                                          |
| `pnpm run docs:build`                                                                                                | VitePress build, then hyperlink over every emitted HTML file (offline, internal only); see [Getting started](../getting-started).                                                                                                                                                                        |
| `pnpm run dev`, `build`, `start`                                                                                     | Applications only: Next.js development server, production build and production server. A managed Next.js agent-rules block in `AGENTS.md` or `CLAUDE.md` is refused first.                                                                                                                               |
| `pnpm run test:e2e`, `test:artifact`                                                                                 | Production browser tests and the standalone artifact proof in a disposable fixture; see [Production browser and standalone tests](production-tests). In the generator they render an application first.                                                                                                  |
| `pnpm run test:permissions`                                                                                          | The host-declaration policy tests, then the installed Codex CLI's own evaluation of the publishing rules. Without a Codex CLI it says so explicitly; that is not a pass. A project without the permission tests fails.                                                                                   |

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
no approval. Once the guard capability is registered in `tooling/capabilities.json`, it
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

`tooling/versions.json` lists the generator's reviewed tool pins. Changing one is a
reviewed tooling change; `deps:add`, `deps:remove` and `deps:upgrade` refuse it before
running anything. `deps:upgrade` without a name is the whole set or nothing: while a pin is
a dependency it is refused with the pin names, and other dependencies are upgraded one at a
time with `--package=<name>`. Any other dependency is ordinary: the pin contract checks that the pins hold, not that
the dependency set is exactly the pins, so adding one does not break the checks.
Generated applications carry no pin file and are not restricted this way.

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
