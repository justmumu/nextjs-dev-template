# Toolchain

The generator and the projects it creates use Node and pnpm only. Nothing in
setup, checks, docs or builds needs Python, uv, Copier, MkDocs, Make or a
Python-based pre-commit or Commitizen.

## Exact versions

| Tool | Version | Where it is pinned |
| --- | --- | --- |
| Node | 24.21.0 | `.node-version`, `engines.node` |
| pnpm | 12.14.0 | `packageManager` |
| Next.js / React / React DOM | 16.4.2 / 19.3.0 / 19.3.0 | `tooling/versions.json` (app seed) |
| TypeScript | 6.0.3 | `tooling/versions.json` |
| ESLint / eslint-config-next | 9.39.5 / 16.4.2 | `tooling/versions.json` (app seed) |
| Vitest / Playwright | 5.0.5 / 1.64.1 | `tooling/versions.json` |

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
  `eslint-plugin-react` (via `eslint-config-next@16.4.2`) do not accept ESLint 10.
- React DOM 19.3.0, not 19.3.1: 19.3.1 requires a `react@^19.3.1` that is not published.
- `@types/node` 24.x matches the Node 24 runtime.
- `unrs-resolver` build scripts are denied (`allowBuilds`); its prebuilt native
  binary is used. A dependency that needs a source build fails the install.

Re-run the fixture proof when any pin changes. Pins are exact; ranges are rejected.

## Graph ownership

The root `package.json` and `pnpm-lock.yaml` belong to the generator. The app seed
owns its own manifest and lock and is not a workspace member (`pnpm-workspace.yaml`
has no `packages`). Generated projects never use `workspace:*`, parent overrides or
generator `node_modules`. pnpm 12 locks may contain several YAML documents; do not
parse them by hand.

## Verify this foundation

```sh
node scripts/toolchain.cjs verify
```

This needs only Node and pnpm. It checks the exact versions, runs
`pnpm install --frozen-lockfile`, then `pnpm run test:one` for the toolchain
contract and the no-Python integration test. `test:one` is focused feedback and
does not replace the full gates added by later units.

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
