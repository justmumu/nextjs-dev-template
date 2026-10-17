# Git hooks and agent hosts

Three Git hooks and the declarations of the two agent hosts (Claude Code and Codex) follow one policy:
`tooling/policy.json` lists the protected files and the approved commands, and the host settings are
checked against it by `pnpm run test:permissions`.

## The hooks

`node scripts/bootstrap.cjs setup` installs `pre-commit`, `commit-msg` and `pre-push` once hook
registration is activated for the project in `tooling/capabilities.json`; until then setup says that no
hook was installed. The installer asks Git where hooks live, so linked worktrees share one set and a
configured `core.hooksPath` is honored and never changed. It replaces only hook files it wrote itself: a
hook of any other origin stops the installation before anything is changed, and a failure part-way restores
every hook as it was. Running setup again changes nothing.

| Hook         | What it does                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | Asks the protected-files guard about staged protected files, runs lint-staged on the staged files, then the lock check and the type check when the staged paths make them relevant. |
| `commit-msg` | Checks the message with commitlint: a Conventional Commit header of at most 72 characters. Merge commits stay possible.                                                             |
| `pre-push`   | Runs `pnpm run check` and `pnpm run docs:build` once each, and stops the push at the first failure.                                                                                 |

lint-staged runs one reviewed configuration (`tooling/hooks/staged.mjs`), passed explicitly so no nested
configuration is picked up. It keeps its defaults: unstaged hunks of a partially staged file are hidden
while the tasks run and restored afterwards, fixes made by ESLint and Prettier are staged again, and Git is
restored when a task fails. The very first commit has no history to back up, and lint-staged says so. The
lock and type checks run after lint-staged on the working tree, so an unstaged edit elsewhere can affect
them. Hooks are never skipped: `--no-verify`, `SKIP=`, `HUSKY=` and changing `core.hooksPath` are refused
by the guard, and the checks above are what `pnpm run check` runs again in CI.

## Agent hosts

Both hosts share `AGENTS.md`. The declarations are:

- `.claude/settings.json` registers the guard on every tool that can write files, on failed calls, on
  settings changes and on the end of a turn, asks before editing every protected file and directory, and
  allows only the documented `pnpm run` scripts and three exact bootstrap subcommands.
- `.codex/hooks.json` registers the guard on shell commands and patches and on the end of a turn;
  `.codex/rules/publishing.rules` makes pushes, pull-request creation and merging, version bumps, release
  tags and `guard-accept` ask the user every time. Codex runs without an operating-system sandbox.

A registered command refuses when the guard launcher is missing or has no machine-bound Node; the end of a
turn only reports it. Codex trusts a project's hooks by their hash: review them in `/hooks` after cloning
and whenever they change. Setup also installs the declared Compound Engineering plugin in project scope
when the `claude` and `codex` CLIs exist, restores the tracked Claude settings byte for byte, and succeeds
without any agent CLI.

`pnpm run test:permissions` runs the policy tests and then asks the installed Codex CLI to evaluate the
publishing rules. Without a Codex CLI it says so explicitly; the real evaluation did not run and is not a
pass.

## Limits

The guard restores and reports; it is not an operating-system sandbox and does not prove that installed
dependencies are intact. It does not cover workflow files, which belong to review and CI.
