# Next.js application

A Next.js App Router application in TypeScript with minimal CSS, created from
[nextjs-dev-template](https://github.com/justmumu/nextjs-dev-template). It has no business logic. The
project owns its files, dependencies and version; the template only offers updates that merge with your
changes.

## Quick start

Prerequisites: Node and pnpm at the exact versions in `.node-version` and `packageManager`, Git 2.34 or
newer and the operating system's `file` command. See [Prerequisites and platforms](docs/guides/platforms.md).

```sh
node scripts/bootstrap.cjs setup
pnpm run check
pnpm run dev
```

`setup` installs the frozen dependencies and the Git hooks. `check` runs the lock, format, lint, strict
type and unit-test gates. `pnpm run build` and `pnpm run start` run the production build and server.

## Documentation

`pnpm run docs:build` builds the site from the [docs](docs/index.md) directory.

- [Getting started](docs/getting-started.md)
- [Activate the agent hosts](docs/guides/first-use.md) and [Recover a stopped workflow](docs/guides/recovery.md)
- [Updating from the template](docs/updating.md) and the [release process](docs/contributing/release-process.md)
- [Claude Code and Codex](docs/contributing/agents.md)

Contributor and agent policy lives in [AGENTS.md](AGENTS.md), shared by Claude Code and Codex.

## License and provenance

The application code is yours to license. The shared development tooling derives from
[justmumu/python-dev-template](https://github.com/justmumu/python-dev-template) (MIT, Copyright (c) 2026
justmumu); keep its notice in `tooling/LICENSE` and the attribution in `tooling/NOTICE.md`.
