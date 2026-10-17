# Getting started

## Prerequisites

Node 24.21.0 and pnpm 12.14.0, installed exactly; see [Toolchain](contributing/toolchain). Nothing
else is required: no Python, uv, Copier, MkDocs, Make or Python-based hooks.

## Set up the generator

```sh
node scripts/bootstrap.cjs setup
pnpm run check
```

`setup` installs from the frozen lock. `check` runs the lock, format, lint, type and unit-test gates.

## Create a project locally

```sh
pnpm run template:create --name=my-app --owner=my-login --dest=../my-app
```

The destination must be missing or an empty directory, with no symlink in its path, and the
generator checkout must be committed, and no file the render reads may be changed or hidden from Git
with `assume-unchanged` or `skip-worktree`: the revision it records for the project has to be true. Git
must be able to name an author and a committer, because the enrollment commit is yours.

Creation validates before it writes. The rendered application is first built in a disposable
staging copy with a committed baseline of its own: `setup`, `check`, `docs:build` and `build`
all have to pass, and then the production server (`next start`) has to start on a loopback port of
this run and answer an HTML page (a startup smoke, not a browser test; the server is always stopped
again). The smoke recognises its own server by a per-run nonce file that exists only in the staging
copy's `public/` directory, from before the build until the smoke ends: another program listening
on the port is never taken for it and is left alone. None of the steps may change a rendered file, including its permissions, or leave one behind. If a step fails,
the destination is untouched. The browser and standalone proofs (`test:e2e`, `test:artifact`) are
CI gates and are not part of creation. Staging runs the project's own `setup`, so a project whose
profile enables the agent plugins runs that optional step there too.

Only then is the destination written, with its own Git history and no remote:

1. a _pristine_ commit of exactly the rendered files, made by the generator's own provenance identity
   (`nextjs-dev-template`, a noreply address) without running any hook, because the project has none yet;
2. an _enrollment_ commit on top of it, made by you, with your identity and your hooks, that adds
   `.template-state.json`.

`.template-state.json` records the pristine commit and tree, the generator revision, a digest of
the answers and of the rendered tree, and the manifest protocol. It is a protected file and never
part of a pristine tree. Updates merge from the pristine commits, so keep both commits.

The new project has no hooks, no `node_modules` and no machine path. Run
`node scripts/bootstrap.cjs setup` in it as the explicit next step; that installs the frozen
dependencies and establishes its own hooks and guard binding.

If the enrollment commit is rejected (an identity problem or a hook), creation reports failure. The
pristine commit and the state file stay in the project, nothing is removed, and committing
`.template-state.json` completes the enrollment. If recording the pristine commit itself fails,
the files and the repository that this call made are taken back, but only while the repository is
still the empty one it made. If someone committed, created a ref or staged something there
meanwhile, nothing is removed, and the message says so.

## Create a project from a GitHub template copy

A repository GitHub makes from the template has one commit, the _copied commit_, that exists nowhere
else. `node scripts/template/initialize.cjs --name=<name> --owner=<login>` converts that copy in
place; the workflow that runs it belongs to the release work. Before anything is staged it refuses a
copy that is not an uninitialized template copy (it needs `tooling/template-sentinel.json`), has
uncommitted or staged changes, tracked files hidden with `assume-unchanged` or `skip-worktree`,
an ignored path the application would write onto, a tracked symlink or submodule on a path it
writes, a workflow that would differ from the copy's own in bytes or mode, or an `origin` that is
not the repository named by `--owner` and `--name`. The template's own repository
(`justmumu/nextjs-dev-template`, over any spelling of its URL) is refused whatever the answers name. The same staging validation runs, and the
repository is checked again afterwards: a moved `HEAD` or a changed file stops it before any write.

The files are then installed over the copy's from a backup. The pristine commit is a child of the
copied commit, so that commit stays in the history, and the enrollment commit follows. The state
records it as `github-template-copy`: it is the copy's own commit, not a revision of the template,
and nothing looks it up. If the installation fails part-way, every file is put back (the index and `HEAD` are only
written once the pristine commit exists, so they need no restoring); if even that fails, the backup
is kept, the exact paths are named, and `git checkout <copied commit> -- .` restores the copy.
The rollback only touches what it can prove it wrote: a file replaced by a link or by another file,
a path whose parent directory was replaced or turned into a link, or a file that a failed write
left in a state it cannot account for is never written through, restored over or deleted. Its path
is named and left as it is, and the backup is kept. The pristine tree is built in a private index,
and `HEAD` moves only from the copied commit while the index is still what it was. If someone
commits or stages in the copy meanwhile, the installation is not undone over their work: `HEAD`,
the index and the files stay as they are, the backup is kept, and the message names it. The
enrollment commit refuses, and reports it, when anything but `.template-state.json` is staged or
`HEAD` is no longer the pristine commit.

The converted project does not carry the initialization command: `scripts/template/initialize.cjs`
is part of the generator, not of the application, so it is gone once the files are installed. If
the enrollment commit is then rejected (an identity problem or a hook), nothing is run again. Fix
the cause and make the commit yourself:

```sh
git add .template-state.json
git commit -m "chore(template): enroll project in template updates"
```

This is the same recovery as for a local project. Whether a repository still needs initializing is
decided by the sentinel `tooling/template-sentinel.json`, which the converted tree does not have.

Both routes give the same application tree for the same answers. Limits: creation does not call
GitHub, create a repository, push or publish anything; the template's own checkout is guarded only
by the sentinel and the `origin` check, so do not run the initialization in it.

## Build this documentation

```sh
pnpm run docs:build
```

The build fails on a broken internal page, asset or `#anchor` link. Set `DOCS_BASE` (for example
`/repo-name/`) to build for a site served below a path; external links are not checked.

## Later work

Adopting the template into an existing repository, applying updates, recovery and releases are
not documented yet. Previewing an update is: see [Updating from the template](updating).
