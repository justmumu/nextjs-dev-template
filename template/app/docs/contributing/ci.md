# Continuous integration and supply chain

CI proves what local checks cannot: the production build in real browsers, the standalone output,
and a clean audit of the dependencies. Every job has a timeout, least-privilege permissions and a
concurrency group. Nothing in CI pushes to a branch, merges or deploys, and a GitHub Release is created only
when you start it by hand.

## Workflows

| File                                        | Runs on                              | Purpose                                                                                          |
| ------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `.github/workflows/ci.yml`                  | pull request, push to `main`, manual | `pnpm run check`, `pnpm run docs:build`, production build, browsers and application integration. |
| `.github/workflows/release.yml`             | release tag push, manual             | Validate a release tag read-only; publish the GitHub Release only on a manual start.             |
| `.github/workflows/dependency-audit.yml`    | weekly schedule, manual              | Report known advisories of the runtime, development and tool graphs.                             |
| `.github/workflows/template-ci.yml`         | pull request, push to `main`, manual | Belongs to the template's generator; every job is skipped in an application.                     |
| `.github/workflows/template-initialize.yml` | push to the default branch, manual   | Belongs to the first run of a repository created from the template; it does nothing here.        |

The five files are byte-for-byte what the template carries, so that creating a repository from the
template never has to change a workflow. A first job reads the role of the repository
(`node scripts/ci/context.cjs plan`) and the last job of each workflow reports a single result.

## Required checks

Require the check named **CI result** (and, if you like, **Template CI result**, which passes because its
jobs are skipped). Each is a final job that always runs and fails when a job it depends on failed or was
cancelled. There is no path filter and no matrix cell that can disappear.

## Lanes and cost

| Lane             | Where                   | Runs                                                                                                              |
| ---------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Static and unit  | Linux x64, Node 24.21.0 | `pnpm run check` and `pnpm run docs:build`, once.                                                                 |
| Production       | Linux x64, Node 24.21.0 | `pnpm run test:e2e` (one build; Chromium desktop and mobile viewport, WebKit smoke) and `pnpm run test:artifact`. |
| Dependency audit | Linux x64, weekly       | `pnpm run audit:dependencies`.                                                                                    |

There is no second Node version and no operating system × Node × browser matrix. Each job that installs dependencies records the
Node and pnpm it actually ran on and fails when they differ from the declared lane or from the project's
pins. On GitHub-hosted Ubuntu 24.04, the offline build proof needs `sudo sysctl -w
kernel.apparmor_restrict_unprivileged_userns=0` first; the workflow does it.

## Failure reports

A failed browser run keeps its traces and screenshots: the production job uploads `test-results/` as a workflow
artifact only when a step failed, keeps it for seven days and uploads nothing when the directory is absent.
A passing run keeps nothing.

## Pull requests from forks

Workflows run on the `pull_request` event, so a fork's pull request has a read-only token and no secrets. No
workflow uses `pull_request_target`, and `actions/checkout` keeps `allow-unsafe-pr-checkout` at its default of `false`.

## Supply chain

- Every `uses:` is an immutable commit SHA with the release it stands for in a comment. Dependabot
  (`.github/dependabot.yml`) proposes grouped updates for the Actions and the npm dependencies as pull
  requests; nothing merges automatically.
- `actions/setup-node` is the only cache owner of the pnpm store. CI installs with
  `pnpm install --frozen-lockfile`.
- `pnpm run audit:dependencies` runs `pnpm audit --json` for the runtime (`--prod`), development
  (`--dev`) and tool (everything installed) graphs and judges every advisory against the reviewed decisions
  in `tooling/audit-policy.json`: an advisory without a decision, a decision whose version or severity no
  longer matches, a decision past its `reviewBy` date, or an audit that could not be completed fails the
  command. It never fixes, overrides or merges. The reviewed `overrides` in `pnpm-workspace.yaml` are
  protected and shared with the template.

## Dependabot updates

Dependabot proposes weekly updates as reviewed PRs. This application has one npm dependency graph.
Family groups come before the catch-all: Vitest and coverage, ESLint and `@eslint/js`, commitlint,
Next.js and its ESLint config, and React with React DOM and their types.
Families include major updates. The catch-all groups only minor and patch updates; unmatched majors
arrive individually. Actions keep their existing group. Nothing auto-merges.

The npm entries hold TypeScript `>=7` until `typescript-eslint` and the suppression-policy compiler API
support it, and `@types/node >=25` until a reviewed Node runtime-major upgrade.
ESLint and `@eslint/js >=10` are held until the React, import and accessibility
plugins used by `eslint-config-next` accept ESLint 10.
Each hold records its removal condition beside the configuration. Re-check current peer ranges when
reviewing a change to a hold.

Version ignores also restrict security-update candidates. If an advisory's only fix lies in a held line,
reassess the hold and the required compatibility work; do not silently bypass the audit or peer checks.
`pnpm run audit:dependencies` and its reviewed policy remain in effect.

## Release validation and publication

Pushing a release tag (`vMAJOR.MINOR.PATCH`) starts `release.yml`, which checks out the default branch with its
tags, so the validator is the reviewed code of `main` and not code from the tag. It runs
`pnpm run release:validate` and keeps the changelog section as data. These jobs are read-only. The `publish` job, the only one with
`contents: write`, runs only when you start the workflow by hand from the default branch and name the tag.
See [Release process](release-process).

## Repository setup

Nothing needs a personal access token or a secret. If you automate pull requests with `GITHUB_TOKEN`,
personal repositories do not allow Actions to create or approve pull requests by default
(Settings → Actions → General), and pull requests created with that token do create workflow runs, which wait for
approval.

Supported platforms are Linux x64 (as in CI), macOS on Apple silicon and WSL2 on the distribution's Linux
filesystem. `pnpm run docs:build` needs the operating system's `file` command (its link checker identifies
extensionless pages with it); minimal container images do not always have it. Chromium (desktop and mobile
viewport) and a WebKit smoke lane are the browsers covered.
