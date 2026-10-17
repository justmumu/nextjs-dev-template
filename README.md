# Next.js Development Template

A generator for a JavaScript/TypeScript-only Next.js project with one set of development rules. It
carries the quality gates, protected-files guard, Git hooks and approval rules of
[python-dev-template](https://github.com/justmumu/python-dev-template) into a general-purpose App Router
project without business logic: no authentication, database, payments, state framework or product flow.

Everything uses Node, pnpm and Git. The generator, the generated application, the documentation build, the
guard and the hooks need no Python, uv, Copier, MkDocs or Make.

## Quick start

Prerequisites: Node 24.21.0, pnpm 12.14.0, Git 2.34 or newer and the operating system's `file` command.
See [Prerequisites and platforms](docs/guides/platforms.md).

```sh
node scripts/bootstrap.cjs setup
pnpm run check
pnpm run template:create --name=my-app --owner=my-login --dest=../my-app
```

Or use **Use this template** on GitHub: the first push of the copy runs the
`template-initialize.yml` workflow, which converts it into an application with the same files. Both routes
give an application with its own dependencies, version and Git history, and a record of the template
revision it started from so that later template updates merge your changes with the template's.

In the new project, run `node scripts/bootstrap.cjs setup`, then `pnpm run check`.

## Documentation

The site is built by `pnpm run docs:build` from the [docs](docs/index.md) directory:

- [Getting started](docs/getting-started.md): creation, both routes.
- [Activate the agent hosts](docs/guides/first-use.md) and [Recover a stopped workflow](docs/guides/recovery.md).
- [Updating from the template](docs/updating.md) and the [release process](docs/contributing/release-process.md).
- [Claude Code and Codex](docs/contributing/agents.md): what the guard protects and what it does not.

Contributor and agent policy lives in [AGENTS.md](AGENTS.md), shared by Claude Code and Codex. Both hosts
enable the same optional Compound Engineering plugin and team preferences as the Python template; core
development works without it. Private research stays in the gitignored `.private/` directory.

## Provenance and license

The development rules, guard behavior and workflow of the shared tooling derive from
[justmumu/python-dev-template](https://github.com/justmumu/python-dev-template) at revision
`7f8da69c6f9f69e4fc4d1547c712fb8ef1f1d0b7`, which is MIT licensed, Copyright (c) 2026 justmumu. The source
revision and the behaviors carried over are recorded in `tooling/upstream-policy.json`. The full notice is in
[LICENSE](LICENSE), and every generated application carries it with that attribution in `tooling/LICENSE`
and `tooling/NOTICE.md`.
