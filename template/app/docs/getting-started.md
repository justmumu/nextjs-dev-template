# Getting started

## Prerequisites

Node and pnpm at the exact versions in `.node-version` and `packageManager`; see
[Toolchain](contributing/toolchain).

## Set up

```sh
node scripts/bootstrap.cjs setup
pnpm run check
```

`setup` installs from the frozen lock. `check` runs the lock, format, lint, type and unit-test gates.

## Build this documentation

```sh
pnpm run docs:build
```

The build fails on a broken internal page, asset or `#anchor` link. Set `DOCS_BASE` (for example
`/repo-name/`) to build for a site served below a path; external links are not checked.

## Updates and releases

[Updating from the template](updating) describes preview, apply and recovery.
[Release process](contributing/release-process) describes version preparation and reviewed tags.
