# Continuous integration and supply chain

CI proves the contracts that local checks cannot: the production build in real browsers, the
generator's creation, update and recovery flows, and a reviewed audit of the dependencies. Every job
has a timeout, least-privilege permissions and a concurrency group. Nothing in CI pushes to a branch,
merges, deploys or publishes a release by itself, except the
two documented, narrowly permitted workflows below.

## Workflows

| File                                        | Runs on                              | Purpose                                                                                                       |
| ------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                  | pull request, push to `main`, manual | Static gates, unit tests and coverage, documentation, production build, browsers and application integration. |
| `.github/workflows/template-ci.yml`         | pull request, manual                 | Generator integration.                                                                                        |
| `.github/workflows/template-initialize.yml` | push to the default branch, manual   | First run of a repository created from the template: convert it, prove it, publish once.                      |
| `.github/workflows/release.yml`             | release tag push, manual             | Validate a release tag read-only; publish the GitHub Release only on a manual start.                          |
| `.github/workflows/dependency-audit.yml`    | weekly schedule, manual              | Report known advisories of the runtime, development and tool graphs.                                          |

The workflows are the same files, byte for byte and in file mode, in this generator and in every
application. A first job (`plan`) runs `node scripts/ci/context.cjs plan`, which reads
`tooling/project-role.json` and the template sentinel; the jobs that belong to one role are skipped
in the other. This is also why GitHub's initialization of a copy never has to change a workflow
file (see below). Template CI runs on pull requests and manual dispatch; it does not repeat
generator integration after the pull request is merged into `main`.

## Required checks

Require the checks named **CI result** and **Template CI result**. Each is a final job that always
runs and fails when any job it depends on failed or was cancelled; a job skipped because it belongs
to the other role passes. No workflow uses a path filter or a matrix whose cells can disappear, so a
required check never goes missing because a job was skipped.

## Lanes and cost

| Lane                    | Where                        | Runs                                                                                                              |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Static and unit         | Linux x64, Node 24.21.0      | `pnpm run check` and `pnpm run docs:build`, once.                                                                 |
| Production              | Linux x64, Node 24.21.0      | `pnpm run test:e2e` (one build; Chromium desktop and mobile viewport, WebKit smoke) and `pnpm run test:artifact`. |
| Application integration | Linux x64, Node 24.21.0      | `pnpm run test:integration` in applications: dependencies, hooks, repair and release scenarios.                   |
| Generator integration   | Linux x64, Node 24.21.0      | `pnpm run test:integration`: create, update, fresh-clone, recovery, release and infrastructure.                   |
| Dependency audit        | Linux x64, weekly and manual | `pnpm run audit:dependencies`.                                                                                    |

There is no Node 22 lane and no operating system × Node × browser matrix: the template supports the
one declared Node version, and the static checks run once, not in every cell. Each job that installs dependencies records the
Node and pnpm it actually ran on (`node scripts/ci/context.cjs toolchain --lane=24`) and fails when
they differ from the declared lane or from the project's pins. Browser coverage is Chromium (desktop
and mobile viewport) and a WebKit smoke lane; no other browser or architecture is claimed.

Network-requiring steps (dependency and browser installation) are separate from the
network-independent build proof, which runs offline in an unprivileged network namespace. On
GitHub-hosted Ubuntu 24.04 that needs one documented step first:
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.

The production job also runs the generator's `test:integration --suite=browser-integration`
after browser installation. Those scenarios are excluded from the separate non-browser integration
job, so a fresh runner never inherits an assumption about another job's browser cache.

## Failure reports

A failed browser run keeps its traces and screenshots: the production job, and the first-run initialization job
of a repository made from the template, upload `test-results/` as a workflow artifact only when a step failed,
keep it for seven days and upload nothing when the directory is absent. A passing run keeps nothing. In the
generator, `pnpm run test:e2e` renders its application in a disposable fixture; when the browser command
fails it copies only the fixture's `test-results/` into the generator's ignored `test-results/` before the
fixture, its installed dependencies and its processes are removed. If that copy fails, the command says so,
keeps the browser command's own exit status and still removes everything it owns.

## Pull requests from forks

Workflows run on the `pull_request` event, which gives a pull request from a fork a read-only token and
no secrets. No workflow uses `pull_request_target`, no job checks out untrusted code with a write
token, and `actions/checkout` keeps `allow-unsafe-pr-checkout` at its default of `false`. Credentials
are not persisted into the checkout, except in the initialization job that has to push.

## Supply chain

- **Pinned actions.** Every `uses:` is an immutable commit SHA with the release it stands for in a
  comment: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `pnpm/action-setup` v6.1.0,
  `actions/upload-artifact` v7.0.2 and `actions/download-artifact` v8.0.2. Dependabot proposes updates
  as one grouped, reviewed pull request; a human merges it.
- **One cache owner.** `actions/setup-node` caches the pnpm store (`package-manager-cache` is off);
  `pnpm/action-setup` does not cache.
- **Frozen installs.** CI installs with `pnpm install --frozen-lockfile` and never uses `latest`, `npx`
  or `dlx`. The Node and pnpm versions come from `.node-version` and `package.json`.
- **Dependabot** (`.github/dependabot.yml`) groups npm updates for the root and the application seed,
  and the Actions updates. It never merges anything; the protected dependency policy still decides
  what a reviewed update may change.
- **Audit.** See below.

## First-run initialization

A repository created from this template starts as a copy with one commit and the sentinel
`tooling/template-sentinel.json`. `template-initialize.yml` runs on the first push to the default
branch of that repository and:

1. installs the copy's dependencies from the frozen lock, without installing hooks or the guard;
2. sets the commit identity to `github-actions[bot]` with its noreply address
   `41898282+github-actions[bot]@users.noreply.github.com`;
3. runs `node scripts/template/initialize.cjs` with the repository's name, owner and description, which
   validates the application in staging, converts the copy and enrolls it (see
   [Getting started](../getting-started));
4. installs the application's dependencies and finishes the production proof itself (`test:e2e` and
   `test:artifact`), because a push made with the workflow's `GITHUB_TOKEN` does not start other workflows;
5. pushes the converted history to the default branch once. A rejected push fails the job; nothing is
   forced, and the copy on GitHub stays as it was.

The workflow needs no personal access token and no secret, and it changes no workflow file, which
is why the token's push is accepted: the files the render would put under `.github/workflows/` are
checked byte for byte and by mode against the copy's before anything is written. Without the sentinel
(every application, every later run, and this generator's own repository) the workflow does nothing.

The default branch must accept a push from `github-actions[bot]`. It creates no pull request, so
the repository setting that lets Actions create pull requests is not needed. If you later automate pull
requests with `GITHUB_TOKEN`, note that personal repositories do not allow Actions to create or approve
pull requests by default (Settings → Actions → General), and that pull requests created with that token
do create workflow runs, which wait for approval.

## Release validation and publication

Pushing a release tag (`vMAJOR.MINOR.PATCH`) starts `release.yml`, which checks out the default branch
with its tags, so the validator is the reviewed code of `main` and not code from the tag. It runs
`pnpm run release:validate` with the tag, writes the notes to a file and keeps them as an artifact.
This job has read-only permissions.

Creating the GitHub Release is a different act. The `publish` job runs only when the workflow is
started by hand from the default branch with the tag as its input, after validation passed, and it is the
only job with `contents: write`. It passes the tag and the notes file to `gh release create` as data.

## Dependency audit

`pnpm run audit:dependencies` (weekly, and on demand) runs `pnpm audit --json` for the runtime
(`--prod`), development (`--dev`) and tool (everything installed) graphs of the project and, in
this generator, of the application seed. It judges every advisory against the reviewed decisions in
`tooling/audit-policy.json`. It fails when an advisory has no decision, when a decision's installed
version, dependency path or severity no longer matches, when a decision's review date has passed, or when an audit could
not be completed. A failed audit is never reported as clean. It never fixes, overrides, opens a pull
request or merges.

**Fixed.** Two reviewed `overrides` in `pnpm-workspace.yaml` lift the old `form-data` (2.1.x, 2.3.x) and `qs`
(6.5.x) that `hyperlink` pulls in to the patched `2.5.6` and `6.16.1` of the same major lines, closing
GHSA-fjxv-7rqg-78g4, GHSA-hmw2-7cc7-3qxx, GHSA-6rw7-vpxm-498p and GHSA-4mjr-xmp4-gh2g. The selectors
match only the old ranges. The root and the seed carry the same block; dependency commands never change it.

**Reviewed, not fixed.** The remaining advisories are all in the development graph and have no
compatible fix without an unverified major upgrade or override, which is not applied to lower a count. Each
decision names the dependency path, why that path is not reachable here, the remediation and
the date to review again (`reviewBy`):

| Package                                    | Advisories                                                                         | Why the path is not reached                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `request`, `tough-cookie`, `uuid`          | GHSA-p8p7-x288-28g6, GHSA-72xf-g2v4-qvf3, GHSA-w5hq-g745-h8pq                      | `hyperlink` runs with `--internal` on local files; no HTTP request is made. `request` calls only `uuid/v4` without a buffer. |
| `html-minifier`, `postcss-selector-parser` | GHSA-pfq8-rq6v-vf5m, GHSA-rj75-hqrm-r3gf                                           | They run only in `assetgraph`'s `minify()`, which `hyperlink` never calls.                                                   |
| `vite`, `esbuild`                          | GHSA-4w7w-66w2-5vf9, GHSA-v6wh-96g9-6wx3, GHSA-fx2h-pf6j-xcff, GHSA-67mh-4wv8-2f99 | Development-server issues; `docs:build` is `vitepress build`, and no `dev`, `serve` or `preview` command is exposed.         |
| `@tootallnate/once`                        | GHSA-vpq2-c234-7xj6                                                                | The flaw requires an AbortSignal; the installed `http-proxy-agent` does not pass one.                                        |
| `braces`                                   | GHSA-vfj7-8cjw-p6xm                                                                | `@next/eslint-plugin-next` expands globs only for `next.rootDir`, which no ESLint configuration sets.                        |

A contract test fails if a decision's premises change (a documentation dev server, a
`rootDir` setting, a URL passed to the link checker). Deleting a decision does not suppress anything: the
audit then fails until the advisory is fixed or reviewed again.

## Supported platforms

CI covers Linux x64 (GitHub-hosted Ubuntu 24.04). Linux ARM64 is exercised locally by maintainers;
Linux ARM64 and macOS have no CI coverage. WSL2 is supported on the distribution's Linux filesystem,
without a separate release acceptance requirement. Native Windows, other browsers and other
architectures are not supported. `pnpm run docs:build` needs the operating system's `file` command
(its link checker identifies extensionless pages with it); minimal container images do not always have it.
