# Release process

A release is a version in `package.json`, a section in `CHANGELOG.md`, a reviewed merge into `main` and
an annotated `vMAJOR.MINOR.PATCH` tag on that merge. Three commands carry it, in this repository and in
every project created from the template. None of them pushes, opens a pull request, merges, publishes to
npm or deploys: each of those is a separate step that needs your own approval, and an approval for one
step does not cover the next.

| Step | Command                                     | Where                     | Result                                              |
| ---- | ------------------------------------------- | ------------------------- | --------------------------------------------------- |
| 1    | `pnpm run release:bump patch\|minor\|major` | a feature branch          | one `chore: bump version to vX.Y.Z` commit          |
| 2    | `node scripts/bootstrap.cjs setup`          | the release branch        | pnpm's installed project version matches the bump   |
| 3    | push, pull request, review, regular merge   | you, with your approval   | the release is reviewed and on `main`               |
| 4    | `node scripts/bootstrap.cjs setup`          | updated `main`            | the installed metadata matches the reviewed version |
| 5    | `pnpm run release:tag`                      | `main` at `origin/main`   | a local annotated tag on the merge commit           |
| 6    | `git push origin vX.Y.Z`                    | you, with your approval   | the tag is public                                   |
| -    | `pnpm run release:validate`                 | anywhere with the history | proves a tag; writes no tag and publishes nothing   |

`|` in the first command separates the three accepted words; it is not a shell pipe. Any other word, a
missing word or a second word is a usage error.

## Versions

The live version of a project is the `version` field of its own `package.json`. A project created from
the template starts at `0.0.0`; the template never writes its own release version into a project, and a
template update never changes the version of an application. Only plain `MAJOR.MINOR.PATCH` versions are
bumped; a pre-release or build-metadata version is refused.

## Prepare a release

```sh
git switch -c release/next
pnpm run release:bump minor
node scripts/bootstrap.cjs setup
```

pnpm records the project's version during installation. After a bump or a branch switch that changes
that version, `setup` refreshes this ignored installation metadata from the frozen lock. Until then,
pnpm can refuse commands with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`. Keep that check enabled. The bump
changes only release files; the existing setup command owns installation and guard reconciliation.

The bump refuses, before it writes anything, when:

- the repository is not at the project root, or its history is shallow (`git fetch --unshallow`);
- the branch is `main`, `master` or a detached head;
- the working tree or the index has any change, including untracked files, or a tracked file carries
  `assume-unchanged` or `skip-worktree`, which would hide a change;
- the tag for the next version already exists.

When it passes, it writes the next version into the one `"version"` line of `package.json` and a new
section above the earlier ones in `CHANGELOG.md`, formats the changelog, checks that the frozen
`pnpm-lock.yaml` still matches, and commits exactly those two files with the project's own Git hooks
active. Dependencies, scripts, the lock and the workspace file are not touched. If the formatter, the
lock check or a hook fails, the prepared files and any later edits stay visible for inspection; the
command does not restore old bytes over work it cannot own. Inspect `git diff` and `git diff --cached`,
resolve the failure, and review the prepared version and changelog before committing them through the
normal hooks. Do not rerun the bump over those pending changes. Concurrently staged application files
are never included in the release commit. A hook that changes the tree after the commit is reported
and the commit stays. The bump never creates a tag.

## The changelog

The section is written by `conventional-changelog` with the Conventional Commits preset, from the commits
since the project's latest release tag, or, before its first release, since the enrollment commit of an
application or the first commit of this repository. Commit types `feat`, `fix`, `perf` and `revert` are
listed; `docs`, `chore`, `test` and the other maintenance types are not. Merge commits are not listed, but
the commits they brought in are, so work merged through branches and pull requests is kept.

An application made from the template carries the template's pristine snapshot commits in its history.
They are recognized by the commit ids recorded in committed `.template-state.json` files. Each baseline
is checked against its actual ancestry, tree and original answers before history is filtered. The
snapshots, their ancestors and the initial enrollment commit are excluded. Later application commits
that also edit the state file remain eligible. A tag that belongs to template commits is not taken for
the application's latest release.

## Tag the reviewed merge

After the pull request has been merged with a regular merge commit, update `main`, run
`node scripts/bootstrap.cjs setup`, then run `pnpm run release:tag`. It refuses unless:

- the branch is `main` and `HEAD` is exactly `origin/main` (fetch first);
- `HEAD` is a merge commit and the working tree is clean;
- `package.json` and `CHANGELOG.md` agree: the changelog has exactly one section whose heading is the
  tag of the manifest's version (`v0.0.1` never matches `v0.0.10`);
- the tag does not exist yet, and published tags are never replaced.

Then it creates a local annotated tag on `HEAD` and prints the push command. A tag is never created on a
feature branch, on a stale `main`, or on a commit that is not the reviewed merge.

## Validate a tag

```sh
pnpm run release:validate --tag=v0.0.1 --notes=release-notes.md
```

Without `--tag`, the tag of the manifest's version is validated. A valid release tag is annotated on a
regular merge commit on the first-parent line of `origin/main`. Its `package.json` names that version
and its changelog has exactly one matching section. An earlier feature commit cannot substitute for
the merge even when their trees match. A valid release stays valid after `main` moves on. With
`--notes`, the section is written to that file as plain text for a publishing step to use as data.

## What is not here

- No npm publication or deployment: the commands only prepare, tag and validate. `release.yml` validates a
  pushed tag with the validator code of the trusted `main` and keeps the
  notes as data; its `publish` job creates the GitHub Release only when started by hand (see
  [CI and supply chain](ci)).
- No standalone changelog command and no way to choose another changelog boundary: the bump owns both.
- No rewriting of installation URLs in the documentation, which the Python template's release script did
  for its own package; this template has no installable package.
- No acceptance of a tag made on a feature branch because its tree happens to equal the merge: a release
  needs the reviewed merge identity.
