# Updating from the template

A project created from this template records, in its committed
`.template-state.json`, which pristine snapshot of the template it started from. A template update is
a normal three-way Git merge between that snapshot, the next pristine snapshot and your own commits.
Your edits, your dependencies, your application version and your local ignored files are never
replaced by a snapshot.

A template update is previewed, applied by a person, resolved, accepted by the guard and committed as an
ordinary merge commit; an interrupted one can be inspected, resumed or aborted using its recorded state.

The commands belong to the created project (`pnpm run template:preview`, `pnpm run template:apply`);
this generator checkout does not have them. What follows describes what a project's commands do.

## Preview an update

```sh
pnpm run template:preview --ref=<ref>
```

`<ref>` is a branch, a tag or a full commit id of the template's public repository,
`https://github.com/justmumu/nextjs-dev-template.git`. There is no other source and no flag to
choose one. The ref is resolved to a full commit id once, and that id is what the preview is about.

The preview never touches your `HEAD`, your index, your refs, your tags or your files. It:

1. proves the lineage from the committed state (see below);
2. fetches only that one ref into a throwaway repository, without tags, hooks or any other branch;
3. reads the template's manifest as data and renders the next pristine snapshot with the answers the
   project was created from (never from your current `package.json`), as a commit whose only parent is
   your current baseline;
4. clones your repository fully into a throwaway directory and merges that snapshot there with Git's
   own `merge --no-ff --no-commit --no-overwrite-ignore`, with no stash and no blanket
   "ours"/"theirs" resolution;
5. writes the result to `template-update/preview.json` inside the Git administrative directory (replaced each time), prints its path, and removes the
   throwaway directories.

It previews the committed `HEAD` of the project; uncommitted work is not part of it.

The result is one of `clean` (the merge went through), `conflicted`, or `current` (the template has
not changed since your baseline). It lists every path the merge changes and, for each conflict, the
kind and which sides hold the path: the base, yours and the template's.

| Conflict kind    | What happened                                                              |
| ---------------- | -------------------------------------------------------------------------- |
| `content`        | both sides changed the same lines of a text file                           |
| `binary`         | both sides changed a binary file                                           |
| `add/add`        | both sides added the same path with different content                      |
| `modify/delete`  | one side changed a file the other deleted                                  |
| `rename/delete`  | the template renamed a file you deleted                                    |
| `file/directory` | the template has a file where you have a directory, or the other way round |

Conflicts are read from the unmerged entries of the merge's index, not from conflict markers, so a
file that merely contains text that looks like markers is not reported.

## Apply an update

Applying is a person's command, run in your own terminal while no agent session is running. Agents
have no standing permission for it (`template:apply` and `node scripts/template/update.cjs` are in
no host's allow list), because applying is what turns a reviewed preview into changes to protected
files.

```sh
pnpm run template:apply --preview="<path printed by template:preview>"
```

The preview file is only a claim; it is not a receipt. Apply fetches the same ref from the
template's public repository again and builds the whole preview again from your project as it is
now. It goes ahead only if the new preview is equal, in meaning, to the file: the source commit, the
installed engine, the lineage, the pristine snapshot and the merge result are all recomputed, so
editing `source.url`, a digest or a result in the file cannot authorize another source or another
result. A stale or edited preview is refused with the reasons and changes nothing.

Apply also refuses when the tracked files differ from `HEAD` (staged or not), when Git is told to
ignore changes to a tracked file, when a merge, rebase, cherry-pick or revert is in progress, when
another update is in progress, or when the guard shows an agent call that has not finished. Untracked
and ignored files are never touched: the merge runs with `--no-ff --no-commit --no-overwrite-ignore`.

When it goes ahead it:

1. builds the next pristine snapshot in your repository (no ref moves) and keeps it alive with the
   reference `refs/template-update/pending` until the update is finished;
2. writes a journal, `.git/template-update/journal.json`, with the old and new state and the
   updater-owned files;
3. runs the native merge and stops before committing. Nothing is stashed and no side is chosen
   wholesale;
4. writes the new `.template-state.json` (same enrollment, baseline moved to the new snapshot, the
   chosen template revision under `upstream`) and stages it, so that the state and the merge are
   one reviewed commit.

`HEAD` does not move.

## Resolve, accept, repair, commit

1. If the merge stopped on conflicts, resolve them with your usual tools and `git add` each path.
   Git's unmerged index entries are what counts as unresolved. Conflicts in `package.json` or the
   lock are real conflicts like any other.
2. Review the diff of the protected files (`git diff --cached`).
3. Run `node scripts/bootstrap.cjs guard-accept` after reviewing the exact diff. Agent permission rules require your approval for each invocation; running it yourself is the approval. It refuses while any index entry
   is still unmerged (protected or not), refuses a merge, rebase, cherry-pick or revert that is not
   this update's, and accepts the merge only while the journal shows it is exactly the update that was
   applied: same `HEAD`, same merge head and pending snapshot, the new state staged as written.
   The guard's baseline and its other machine-local state are kept; only the protected diff you
   reviewed is accepted.
4. `node scripts/bootstrap.cjs repair` when dependencies changed. If the repair fails, the new
   environment is not trusted.
5. `pnpm run check`, then `git commit`: an ordinary merge commit with your hooks. Its parents are
   your `HEAD` and the new snapshot, so the next update has the new baseline.
   The pre-commit hook rejects conflict markers and whitespace errors that are still staged
   (`git diff --cached --check`), also after `git add` has cleared the unmerged entries.
6. `node scripts/template/update.cjs resume` removes the update's journal and pending reference once
   the merge commit exists, including after later application commits (the next `template:apply` does it too). Nothing is ever removed because
   of its age.

## Recover

```sh
node scripts/template/update.cjs inspect
node scripts/template/update.cjs resume
node scripts/template/update.cjs abort
```

These three are for a person at a terminal. They run on Node alone: they do not read
`package.json`, do not need `node_modules` and start no package manager, so they work when a
conflicted `package.json` or lock has broken `pnpm run`. Only the installed engine files below
`scripts/` are loaded.

- `inspect` changes nothing. It reports the phase, `HEAD`, the merge waiting, the unmerged paths and
  whether each file the updater owns is as it wrote it.
- `resume` goes on where an interrupted update stopped and never merges twice: a second resume on an
  applied update says so and does nothing. It refuses if native `git merge --abort` already ended that merge; use the updater’s `abort` to finish the bookkeeping. It also finishes the bookkeeping after your merge commit.
- `abort` restores the updater-owned file, ends the merge with Git's own `merge --abort` and removes
  the journal and the pending reference. It keeps a copy of what it replaced until it has succeeded;
  if it fails, the backup, the journal and the pending reference stay.

A pending reference that points to another commit is retained and reported; restore its ownership before retrying recovery.

None of them overwrites a file the updater owns that someone else changed (the state file's content
must be either its original or the one the updater wrote); they refuse and say so. One command runs at a
time (`template-update/update.lock` inside the Git administrative directory, created exclusively). A command that was killed leaves the
lock; remove it yourself once you have checked that no update command is running.

After a recovery that changed protected files outside an agent call, the guard reports the difference
as drift; reconcile it with `guard-accept` after you have looked at it. The guard is a set of local
checks, not an OS sandbox, and it does not hash installed dependencies.

## Engine upgrades are separate

The update engine is the set of files that read fetched data, build the result or carry out and undo
an update, plus the loader the recovery entry starts them with. They are listed by `ENGINE_FILES` in
`scripts/template/preview.cjs`, and a change to any of them makes an existing preview stale.

An update never carries them: if the merge would change one of those files, apply refuses with
`engine-upgrade-required` and nothing is run, nothing is changed. Upgrade the engine as its own
reviewed protected change: fetch the template revision, review the diff of those files, commit them
yourself (with `guard-accept`), and then make a fresh preview. The old preview is never carried over
an engine change.

Other protected files, including the guard's own code, update like any other file, with the acceptance
above.

## What the preview is bound to

The preview file records the `HEAD`, the committed state, the answers, the installed update engine
(every file of it; see Engine upgrades below), the source commit and a digest of the merge result.
When any of them changes the preview is stale and has to be made again; a preview is never
adjusted.

## When it refuses

A refusal changes nothing, exits with status 1 and names the reason. A new baseline is never guessed.

- the clone is shallow: fetch the full history first (`git fetch --unshallow`);
- `HEAD` has no committed `.template-state.json`, or it is unreadable;
- the baseline commit is missing from the repository, is not an ancestor of `HEAD` (history was
  rewritten), or does not have the tree the state records;
- the answers recovered from the baseline are not the ones the state recorded;
- the ref is not a plain ref name or cannot be fetched;
- the state or the source uses a manifest protocol this installed engine does not support. The
  engine has to be upgraded first (see Engine upgrades are separate); nothing from the source is run.

Nothing from the fetched source is ever executed by a preview: not its scripts, not its Git hooks,
not its package lifecycle commands. Executable content reaches your project only as ordinary merged
changes that you review.

## Limits

- The update source is the template's public repository over the network, using your Git
  configuration for credentials and proxies.
- An update that changes the dependency set needs the usual review of `package.json` and the lock;
  the preview shows that those files change, not whether the result installs.
- Applying and recovery run on local Linux, macOS and WSL file systems; network file systems and
  native Windows are not supported.
- The preview was verified with Git 2.34 on Linux. Other platforms are not verified.
