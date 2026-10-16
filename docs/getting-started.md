# Getting started

## Prerequisites

Node 24.21.0 and pnpm 12.14.0, installed exactly; see [Toolchain](contributing/toolchain). Nothing
else is required: no Python, uv, Copier, MkDocs, Make or Python-based hooks.

## Set up the generator

```sh
node scripts/bootstrap.cjs setup
pnpm run check
```

`setup` installs from the frozen lock. `check` runs the lock, format, lint, type and unit-test gates.

## Create a project locally

```sh
pnpm run template:create --name=my-app --owner=my-login --dest=../my-app
```

The destination must be a new directory. Nothing is published.

## Build this documentation

```sh
pnpm run docs:build
```

The build fails on a broken internal page, asset or `#anchor` link. Set `DOCS_BASE` (for example
`/repo-name/`) to build for a site served below a path; external links are not checked.

## Later work

Adopting the template into an existing repository, template updates, recovery and releases are
not documented yet.
