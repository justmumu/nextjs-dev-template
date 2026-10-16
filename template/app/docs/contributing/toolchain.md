# Toolchain

Setup, checks, docs and builds use Node and pnpm only.

## Exact versions

Node is pinned in `.node-version` and `engines.node`, pnpm in `packageManager`. Both are
host-owned prerequisites: install exactly these versions (for example with Corepack). Dependencies
are exact, and `pnpm-lock.yaml` is frozen: `setup` and `repair` install from it and never
regenerate it. The project owns its dependency graph and its `pnpm-workspace.yaml` policy
(strict builds, no lifecycle script permissions).

## Commands

Routine work goes through `pnpm run <script>`. Flags are written `--name=value`; there is no `--`
separator and no extra flag is accepted.

| Command                                                                                           | What it does                                                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `node scripts/bootstrap.cjs setup`                                                                | Checks exact Node and pnpm and installs from the frozen lock.                           |
| `node scripts/bootstrap.cjs repair`                                                               | Rebuilds project-local `node_modules` from the frozen lock.                             |
| `pnpm run check`                                                                                  | Lock, format, lint, typecheck and unit tests with coverage; see [Unit tests](testing).  |
| `pnpm run format`, `format:check`, `lint`, `lint:fix`                                             | Prettier and ESLint; see [Static quality](static-quality).                              |
| `pnpm run typecheck`                                                                              | `next typegen`, then `tsc --noEmit` for the app and for the checked JavaScript tooling. |
| `pnpm run test:one --test=<path> [--suite=<name>]`                                                | One test file of a registered suite; focused feedback that does not replace `check`.    |
| `pnpm run test:integration [--scenario=<id>]`                                                     | Real pnpm, Git, process and filesystem scenarios.                                       |
| `pnpm run deps:add --package=<name[@version]> --group=<prod\|dev>`, `deps:remove`, `deps:upgrade` | Dependency transactions that change only the requested entry and the lock.              |
| `pnpm run docs:build`                                                                             | Builds this site and checks every internal page, asset and anchor link.                 |

`pnpm` refuses to run when the manifest and lock disagree or `node_modules` is missing; use
`node scripts/bootstrap.cjs repair`.
