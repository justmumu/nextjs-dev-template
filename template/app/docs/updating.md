# Updating from the template

This project was created from the Next.js development template and records, in the committed
`.template-state.json`, which pristine snapshot of the template it started from. A template update is
a normal three-way Git merge between that snapshot, the next pristine snapshot and your own commits.
Your edits, your dependencies, your application version and your local ignored files are never
replaced by a snapshot.

Only the preview exists so far. Applying an update, resolving its conflicts and recovering an
interrupted update are not available yet, so nothing here changes your project.

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
5. writes the result to `.git/template-update/preview.json` (replaced each time) and removes the
   throwaway directories.

It previews the committed `HEAD`; uncommitted work is not part of it. Run it again after you commit.

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

## What the preview is bound to

The preview file records the `HEAD`, the committed state, the answers, the installed update engine
(every file of it that reads fetched data), the source commit and a digest of the merge result.
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
  engine has to be upgraded first; nothing from the source is run.

Nothing from the fetched source is ever executed by a preview: not its scripts, not its Git hooks,
not its package lifecycle commands. Executable content reaches your project only as ordinary merged
changes that you review.

## Limits

- The update source is the template's public repository over the network, using your Git
  configuration for credentials and proxies.
- An update that changes the dependency set needs the usual review of `package.json` and the lock;
  the preview shows that those files change, not whether the result installs.
- The preview was verified with Git 2.34 on Linux. Other platforms are not verified.
