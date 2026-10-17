# Activate the agent hosts

A checkout is protected only after three separate things are true: its files are committed, `setup` has
bound a Node binary and installed the Git hooks, and each agent host has been told to trust the project's
hook declarations. None of them grants the next, and none of them accepts an arbitrary change.

## 1. Start from a clean committed baseline

The guard's first baseline comes from committed `HEAD`. On its first ordinary tool call it records the
protected files only when they match `HEAD`; a dirty protected tree is refused with a request for a person
to reconcile it. Review the protected diff, commit it with the normal hooks, and only then start an agent.

A project made from the template, locally or through the GitHub template workflow, already has this state: a pristine
commit and an enrollment commit. See [Getting started](../getting-started).

## 2. Run setup in a terminal

```sh
node scripts/bootstrap.cjs setup
```

`setup` checks the exact Node and pnpm, installs from the frozen lock, binds the Node binary the guard
launcher uses, and installs the declared `pre-commit`, `commit-msg` and `pre-push` hooks when
`tooling/capabilities.json` enables them. It does not trust anything in a host, and it never runs
`guard-accept`. If the declared agent plugins are enabled and the `claude` and `codex` CLIs exist, it also
installs them in project scope; without those CLIs it succeeds and says nothing was installed.

Never answer a refusal by running an unconditional `guard-accept`. It accepts the protected diff that
exists at that moment, so read `git diff` first.

## 3. Trust the project in each host

**Claude Code.** Open the repository root in a fresh session and accept project trust. `/memory` shows the
imported `AGENTS.md`; `/permissions` shows `acceptEdits` and the protected-file ask rules.

**Codex.** Use a CLI release that supports project hooks. Open and trust the repository, then review and
enable the project hooks in `/hooks`. Trust is tied to the exact hook configuration, so review it again
whenever `.codex/hooks.json` changes. Start a fresh session and confirm that the approval policy is
`on-request` and the reviewer is `user`. In a linked Git worktree Codex takes hook registration from the
main checkout; inspect the source `/hooks` shows.

The template writes no user-global trust or settings. A session that was running before the files existed,
or before they changed, does not acquire the new hooks or permissions; start a fresh one.

## When retrust or setup is needed again

| Change                                                      | What to do                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `.codex/hooks.json` or `.claude/settings.json` hook entries | Review and trust again in the host, then start a fresh session        |
| `tooling/capabilities.json` or a hook installer change      | `node scripts/bootstrap.cjs setup` again                              |
| A different Node binary or a moved checkout                 | `node scripts/bootstrap.cjs setup`, which binds the new path          |
| A template update that changed protected files              | Review, `guard-accept`, `repair`, commit; see [Updating](../updating) |

A checkout whose launcher has no bound Node refuses the agent's tool calls with a message saying so; the
end of a turn only reports it.

## What a working activation looks like

In a fresh trusted session an ordinary source edit passes without a prompt. A change to a protected file
that no approved route made is restored after the call, and the agent is told why. Publishing commands and
`guard-accept` ask you every time. These are behaviors of the real hosts: the repository's own tests drive
the registered commands with recorded hook payloads and the Codex rules with its policy engine, which
shows the declarations are correct but cannot stand in for a prompt in a live session, so confirm one in
yours.
