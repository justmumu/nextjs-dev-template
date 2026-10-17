# Development rules

This is the shared policy for contributors, Claude Code and Codex. Host-specific files reference it
instead of keeping another copy.

## Commands

Routine work goes through `pnpm run <script>`; do not call the tools behind them with other flags.

- `pnpm run check` runs the lock check, format check, lint, strict typing and unit tests with coverage.
- `pnpm run format`, `pnpm run lint:fix` and `pnpm run typecheck` fix or check one aspect.
- `pnpm run test:one --test=<path> [--name=<literal>]` runs one test file for quick feedback; it does not replace `check`.
- `pnpm run test:integration [--scenario=<id>]` runs the integration scenarios, `pnpm run test:permissions` the agent permission tests.
- `pnpm run deps:add`, `deps:remove` and `deps:upgrade` are the only way to change dependencies.
- `pnpm run docs:build` builds the documentation and checks every internal link.
- `node scripts/bootstrap.cjs setup` prepares a checkout, `repair` rebuilds the installed dependencies from the frozen lock.

## Protected files

Package manifests and locks, tool and framework configuration, the scripts and tooling directories,
this file and the host settings under `.claude/` and `.codex/` are protected. The protected-files guard
restores changes that no approved command made. Agents do not edit these files directly: show the exact
diff and ask the user to apply it, then the user accepts it with `node scripts/bootstrap.cjs guard-accept`.
The guard is a safeguard against mistakes, not an operating-system sandbox and not a guarantee that
installed dependencies are intact.

## Git and publishing

Work on a feature branch, never commit directly to `main`. Codex branches use `codex/short-description`.
Use Conventional Commits with subjects at most 72 characters. Git hooks check staged files on commit,
the message on commit-msg, and `check` plus `docs:build` before a push. Do not bypass Git hooks.

Ask before each push, opening or merging a PR, version bump, release tag or deployment. Approval covers
only the named action. Use a regular merge commit, never squash. Use plain `git` and `gh` commands so
publishing rules can recognize them.

## Compound Engineering and notes

Both host configurations enable Compound Engineering. Core development works without the plugin.
Artifacts belong under `.compound-engineering/artifacts/`; private working notes belong in the gitignored
`.private/` directory. Reserve `docs/` for the public documentation website.

## Next.js documentation

Before writing or changing Next.js code, read the guide for the installed version in
`node_modules/next/dist/docs/` instead of relying on memory; the APIs and file conventions differ between
versions. This text is maintained by hand: the template sets `agentRules: false`, so `next dev` never
writes its own block into this file, and a managed Next.js block found here fails the typecheck until it
is migrated explicitly.
