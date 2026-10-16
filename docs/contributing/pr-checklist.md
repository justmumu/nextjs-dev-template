# Pull request checklist

## Before opening

- The change builds on a feature branch, never directly on `main`.
- `pnpm run check` passes; a gate that already passed on the same commit is not repeated.
- `pnpm run docs:build` passes when documentation changed.
- New behavior has a test that fails without it.

## Commit messages

Use `type: summary` or `type(scope): summary`.

- Allowed types: `feat`, `fix`, `docs`, `chore`, `ci`, `refactor`, `test`, `style`, `build`, `perf`, `revert`.
- The first line is at most 72 characters and does not end with a period.
- Merge with a regular merge commit.
- Commit author and committer use a GitHub noreply address.
