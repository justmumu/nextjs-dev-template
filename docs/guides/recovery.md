# Recover a stopped workflow

Each recovery below runs on Node alone and needs no `node_modules`, so it works when a conflicted
`package.json` or a damaged install has broken `pnpm run`. They are for a person at a terminal while no
agent session is running; agents have no standing permission for them.

## Dependencies or the install

`pnpm run` refuses to start with an incomplete or missing install (`verifyDepsBeforeRun` stays on). Run:

```sh
node scripts/bootstrap.cjs repair
```

It rebuilds the project's `node_modules` from the frozen lock and clears the incomplete-install marker. It
never rewrites a manifest or a lock. If the repair fails the environment is not trusted and the state is not
treated as clean. After an approved edit of the dependency manifest use `node scripts/bootstrap.cjs deps-lock`.

## A template update

```sh
node scripts/template/update.cjs inspect
node scripts/template/update.cjs resume
node scripts/template/update.cjs abort
```

`inspect` changes nothing, `resume` goes on from where the update stopped, and `abort` restores the files
the updater owns and ends the merge. See [Updating from the template](../updating) for the full flow and
its refusals.

An update lock named `update.lock` inside the Git administrative directory is created exclusively and
never removed because of its age. If a command was killed and left it, check that no update command runs
and remove that one file yourself.

## The guard

The protected-files guard keeps a short state lock and, separately, reservations for tool calls that have
started and not finished. If a killed process left the lock behind, stop every agent session of that
worktree and run:

```sh
node scripts/hooks/recover-lock.cjs
```

It needs an interactive terminal. It shows what it found and, once you type `recover`, removes only the
lock and half-written state files, keeping a journal of what it moved. It never accepts or deletes the approved baseline or a pending
call, and age alone never frees anything. A call whose completion evidence is gone stays pending; the
guard does not guess that its process died.

When the guard reports that protected state changed outside an agent call, ask whether you made the change.
Review the exact diff and keep it with `node scripts/bootstrap.cjs guard-accept`, or restore the files
yourself. A recovery that changed protected files outside an agent call shows up as the same kind of drift.

## A release in progress

If the formatter, the lock check or a hook fails during `pnpm run release:bump`, the prepared version and
changelog and any later edits are kept. Inspect them and finish through the normal hooks; do not run the
bump again over pending changes. See [Release process](../contributing/release-process).

## A bound Node that is gone

If the guard launcher says no Node binary is bound or the bound one no longer exists, run
`node scripts/bootstrap.cjs setup` with the pinned Node.
