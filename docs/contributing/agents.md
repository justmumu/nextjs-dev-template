# Claude Code and Codex

Both agents work on the same project and run the same checks. There is no separate source tree for
each agent, and neither host is required: the project builds, checks and releases without either agent. See the
[toolchain prerequisites](toolchain) for Node, pnpm, Git and required operating-system tools.

## Files and responsibilities

| File                            | Responsibility                                                            |
| ------------------------------- | ------------------------------------------------------------------------- |
| `AGENTS.md`                     | Shared commands, quality, navigation, Git and approval rules              |
| `CLAUDE.md`                     | Imports `AGENTS.md` for Claude                                            |
| `.claude/settings.json`         | Claude permissions, guard hooks and plugin preferences                    |
| `.codex/config.toml`            | Codex approval routing and plugin preferences                             |
| `.codex/hooks.json`             | Codex hook registration                                                   |
| `.codex/rules/publishing.rules` | Codex prompt rules for publishing commands                                |
| `scripts/hooks/`                | The protected-files guard for both hosts, plain Node with no dependencies |
| `tooling/policy.json`           | The one inventory of protected files and approved commands                |
| `tooling/capabilities.json`     | Whether the guard and the Git hooks are active for this project           |
| `.compound-engineering/`        | Compound Engineering settings and committed artifacts                     |
| `compound-packs/`               | Project rules that Compound Engineering cites                             |

The host declarations are checked against `tooling/policy.json` by `pnpm run test:permissions`.
Activating them in a checkout, trusting them in each host and recovering from a stopped session are in
[Activate the agent hosts](../guides/first-use) and [Recover a stopped workflow](../guides/recovery).

## Everyday permissions

| Operation                            | Claude Code                                                 | Codex                                              |
| ------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------- |
| Read a protected file                | Allowed                                                     | Allowed                                            |
| Edit ordinary source, tests or docs  | Automatic                                                   | Automatic                                          |
| Run the listed development commands  | Allowed by the project rules                                | Automatic                                          |
| Dependency changes                   | `pnpm run deps:add`, `deps:remove`, `deps:upgrade`          | The same commands                                  |
| Formatter and lint fixes             | `pnpm run format`, `lint:fix`; the guard accepts the result | The same commands                                  |
| Edit a protected file directly       | Edit or Write asks you; the approved edit is accepted       | `apply_patch` is refused; you apply the exact diff |
| Keep a change the guard reverted     | `node scripts/bootstrap.cjs guard-accept`, which asks you   | The same command; the publishing rules prompt you  |
| Publish (push, PR, merge, bump, tag) | Always asks you                                             | Prompt rules ask you                               |

Routine work uses the documented `pnpm run` scripts, never the tools behind them with other flags.
`pnpm run test:one --test=<path> [--name=<literal>]` selects one test; it is feedback and does not
replace `check`. The pre-push hook runs `pnpm run check` and `pnpm run docs:build`, so a passing hook is
not repeated by hand before a pull request. CI runs `pnpm run test:integration`; run only the relevant
scenario locally (`--scenario=<id>`) when developing an integration test or its harness.

For a direct change to a protected file, the agent prepares the exact diff and asks for approval.
Approve that specific change once. Claude Code's approved Edit or Write is a separate, allowed route
that the guard keeps. Its pre-tool hook asks from the protected inventory, including alternate
configuration names, nested overrides, seed files and resolved symlink targets. Codex has no such
route, so you apply the diff yourself. Do not save a blanket
shell or interpreter exemption, and do not edit `AGENTS.md` as a way around the write gate.

Publishing asks in both hosts, every time. Claude Code's permission rules ask before `git push`,
`gh pr create`, `gh pr merge`, `pnpm run release:bump` and `pnpm run release:tag`. In a trusted
project, `.codex/rules/publishing.rules` holds the matching Codex prompt rules and
`approvals_reviewer = "user"` sends each prompt to you. The rules match plain command prefixes: a form
such as `git -C <dir> push` is not matched, so the guard refuses it; an untrusted project does not
load the rules, and a user-level `approval_policy = "never"` or `--ignore-rules` disables them.
`pnpm run test:permissions` evaluates each rule with an installed Codex CLI; without one it says the
real evaluation did not run, which is not a pass.

The Codex rules also prompt for the plain history commands that can replace protected files:
`git switch`, `checkout`, `pull`, `merge`, `rebase`, `reset`, `restore`, `stash`, `cherry-pick` and
`gh pr checkout`. Claude Code declares the same approval boundary.

## Protected-files guard

`scripts/hooks/guard.cjs` is plain Node with no dependencies. Both hosts call it around every agent
tool call, and it starts with the Node binary that `setup` bound to the checkout, so a broken
`node_modules` cannot disable it. It keeps the configuration that defines the project's checks and
permissions from changing without you.

### What it does

For each worktree it keeps a last-approved baseline in `protected-baseline/` inside the Git
administrative directory. After a tool call it compares the protected files with that baseline and then:

- restores protected files that no approved route changed,
- removes newly created files that would shadow a root configuration,
- unstages protected content nobody approved, and
- tells the agent that writing these files is forbidden: use the commands or ask you.

| Host        | Events                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `PreToolUse`, `PostToolUse`, `PostToolUseFailure` on `Bash\|Monitor\|PowerShell\|Edit\|Write\|MultiEdit\|NotebookEdit\|mcp__.*`, plus `ConfigChange` and `Stop` |
| Codex       | `PreToolUse` and `PostToolUse` on `Bash\|apply_patch`, plus `Stop`                                                                                              |

At the end of a turn, `Stop` reports any drift once.

### Protected files

`tooling/policy.json` is the inventory:

- the package manifest, the lock, `pnpm-workspace.yaml`, `.npmrc`, `.node-version`, `.nvmrc`,
  `.template-state.json`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.prettierignore`,
  `.eslintignore`, `.npmignore`, `AGENTS.md` and `CLAUDE.md`;
- tool and framework configuration: pnpmfiles, `tsconfig*.json`, `next.config.*`, ESLint, Prettier,
  Vitest, Playwright, PostCSS, lint-staged and commitlint configuration, and the documentation
  configuration;
- the directories `scripts/`, `tooling/`, `.claude/`, `.codex/`, `.githooks/` and `.husky/`.

A configuration file of those kinds below the root, which would shadow the root one, is removed when it
appears, except below `template/` and `tests/fixtures/`.

### Approved routes

A change to a protected file stays only if it arrives through one of these:

- An exact, literal, foreground command from the project root, with only its declared arguments:
  `pnpm run format`, `pnpm run lint:fix`, `pnpm run deps:add`, `deps:remove`, `deps:upgrade`,
  `node scripts/bootstrap.cjs deps-lock`, `setup`, `repair` and, with your approval each time,
  `guard-accept`, `pnpm run release:bump patch|minor|major` and `pnpm run release:tag`. A prefix, a
  chain or an expansion is not a route.
- A plain standalone `git commit`. The guard refuses a commit chained with other commands or built with
  `$(...)`; write the message to a file and use `git commit -F <file>`.
- Plain `git switch`, `checkout`, `pull`, `merge`, `rebase`, `reset`, `restore`, `stash` and
  `cherry-pick`, and `gh pr checkout`, which ask you first, when the resulting files match the new
  `HEAD`.
- A Claude Code Edit or Write on a protected file that you approved through the ask rules. In Codex,
  `apply_patch` on a protected file is refused: you make the change.

### Refused before running

The guard refuses commands that switch checks off: `--no-verify` and `git commit -n`, `SKIP=` and
`HUSKY=`, anything that touches `core.hooksPath`, `GIT_CONFIG_*` variables, running the guard directly
or touching its baseline, and a user-approved goal combined with other goals or variables, which would
skip your approval. Patterns are matched against what the shell runs: quoted text and heredoc bodies
are not executable text, but code handed to `sh -c` or `eval` is.

### Changes made outside an agent call

If you edit a protected file in an editor, or a write lands after its call ended, the next agent call is
refused with a request to ask you whether you made the change. If you want to keep it, review the exact
diff and run `node scripts/bootstrap.cjs guard-accept` yourself; an agent must never run it to get past a
refusal. The guard does not undo a change it did not see being made: to drop it, restore the file
yourself, and agent calls resume once it matches the baseline again. On the very first run the protected
files must match the committed `HEAD`, so a dirty protected tree is never accepted as a baseline; commit
or restore it first.

### Commits and history

A commit made through an agent call is checked by the `pre-commit` hook, which fails when it stages
protected content nobody approved. A commit you make outside an agent call passes. A commit that
carries unapproved protected content, made with Git plumbing, blocks further agent calls until you
resolve it. A call that moves `HEAD` without an approved route also stops further calls and is not
reconciled silently.

When a merge, rebase or cherry-pick leaves protected files conflicted or unfinished, the guard does not
restore them. It leaves them as they are and blocks further agent calls until you resolve the conflict,
finish the operation and run `guard-accept`.

### Installed dependencies and Git hooks

The guard also watches the environment that runs the checks. A dependency command may change only the
requested dependency entry and the lock; any other change is restored and the install is marked
incomplete until `node scripts/bootstrap.cjs repair` rebuilds `node_modules` from the frozen lock. The
guard does not hash the installed packages. The Git hooks are fingerprinted, and a change outside `setup`
is restored.

### Agent and user settings

The Claude `ConfigChange` event blocks project settings that drop the guard hooks and settings that set
`disableAllHooks`. A shell change in an agent call that disables Codex hooks or untrusts the project in
the user's Codex configuration is restored; your own edits between calls are kept.

### Parallel calls

A call that can change protected state (an approved command, a protected edit or a history command) runs
alone. Another call started meanwhile is refused with a request to retry after it finishes. The post-call
check runs when the last running call ends.

A call finishes only by its own completion: the session, turn and call identity must match. A yielded
response from a still-running process, the passage of time or a repeated callback does not finish it, and
the guard does not infer process death from elapsed time. When evidence of completion is missing, the call
stays pending and the guard says so.

### Limits

The guard is a safeguard against mistakes, not an operating-system sandbox and not a security boundary.

- It cannot stop an agent that deliberately rewrites the guard. Such a change shows in `git diff`;
  review it.
- Workflow files under `.github/workflows` are not protected; review and CI catch changes there.
- Neither agent runs in a sandbox: they have unrestricted network access and can write outside the
  repository. The guard protects only the files listed above, the Git hooks and the user-level hook
  settings.
- An edit inside an already-installed package in `node_modules` is not fingerprinted.
- A write to another worktree surfaces only on that worktree's next call.
- Your own `!` commands and cancelled calls fire no tool events. Their effects surface at the next agent
  call as changes made outside a call.
- Mutex and state files are local-filesystem files. Linux, macOS and WSL2 on the Linux filesystem are
  supported; network file systems and native Windows are not.
- A running session keeps the hooks and permissions it started with. A new hook registration or runtime
  binding needs setup and a fresh session; see [Activate the agent hosts](../guides/first-use).

## Compound Engineering

The generator and generated projects ship the same Codex plugin defaults in `.codex/config.toml`:

```toml
[features]
remote_plugin = false

[plugins._default]
enabled = false

[plugins."compound-engineering@compound-engineering-plugin"]
enabled = true
```

The remote catalog is disabled, and plugins without an explicit enablement are disabled by default.
Compound Engineering stays explicitly enabled through its declared Git marketplace. Other explicit
plugin choices and skills installed independently are outside this default. These project settings
require a trusted checkout and a fresh Codex session; an already-running session's skill list does
not verify a configuration change. Check the effective settings and loaded plugins in your client.

Existing projects receive these settings by [updating from a published template ref](../updating#codex-plugin-defaults).

Compound Engineering is optional. Its shipped `.compound-engineering/config.yaml` sends plans and
brainstorm approaches to Opus, implementation units to a Sonnet worker with a Codex fallback, and
cross-model reviews to Codex. Without a sandbox, its detached jobs keep running after the call that
started them. Review diffs, and on fallback implementation code, go to OpenAI whenever the `codex` CLI
is installed. To keep a project's code away from it, set `cross_model_review_mode: off` and
`work_engine_mode: off` in the untracked `.compound-engineering/config.local.yaml`.

## Verify and troubleshoot

```sh
pnpm run test:permissions
```

runs the isolated policy tests and then evaluates each publishing rule with an installed Codex CLI. The
extra tests make no model or API request and do not alter project files. Codex's legacy
`sandbox_mode` settings, CLI `--sandbox` switches and managed policies can override the repository's
configuration; check the active session rather than assuming the repository setting won.

Browser, remote MCP, connector and already-running shell interactions have their own controls; never
use them to bypass a required approval. See
[Claude permissions](https://code.claude.com/docs/en/permissions).
