# Production browser and standalone tests

Two commands prove what unit tests cannot: that the production build of the application works in
real browsers, and that its standalone output runs without the project. Both build in a disposable
fixture copy, never in your working tree, and both are run by CI; run them locally before changing
anything that affects rendering, routing, error handling or the build.

| Command                  | What it proves                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test:e2e`      | One production build, served by `next start`, is exercised by Chromium (desktop and mobile viewport) and a WebKit smoke lane.                                                 |
| `pnpm run test:artifact` | The `output: "standalone"` variant of the fixture, relocated outside the project and served without development-only dependencies, answers with its static and public assets. |

Neither command takes arguments. In the generator they render an application into a scratch
directory, install it from its frozen lock, run the application's own command there and remove it.
The starter application does not use standalone output; only the artifact fixture does.

## Prerequisites

The commands install fixture dependencies from the package store. Node, pnpm and browser binaries must be available beforehand:

1. `node scripts/bootstrap.cjs setup` installs the project from its frozen lock. The fixture is
   installed with `pnpm install --frozen-lockfile --offline` from the same package store, so the store
   must be warm; the command says so when it is not.
2. Install the browsers of the pinned Playwright version once. In an application:
   `node node_modules/@playwright/test/cli.js install chromium webkit`. A cached browser of another
   version does not count: Playwright asks for the revision its own version pins. On Linux the browsers
   also need system libraries (`install-deps` installs them and needs administrator rights). WebKit
   needs more of them than Chromium (for example GTK 4 and libavif).

`test:e2e` always runs all three lanes: Chromium desktop, Chromium mobile and the WebKit smoke lane.
No setting narrows them (a `E2E_BROWSERS` variable of your shell is ignored). A browser that cannot
launch because its engine or system libraries are missing fails its lane and the command; that is a
missing prerequisite, never a passing subset.

The offline build proof needs Linux with unprivileged user and network namespaces: `unshare`
(util-linux) and `ip` (iproute2) installed, and namespace creation permitted for your user. Without
them both commands stop before staging anything and exit non-zero, saying what is missing. They
are not run without the proof; `pnpm run build` is not affected.

## What `test:e2e` runs

- The fixture is the application plus routes that exist only in the fixture: an asynchronous server
  component, a route that fails on its first render, an environment page and a readiness route.
  None of them is part of the application's source.
- The build runs once, and every lane reuses it. The server is started on a free loopback port as
  the leader of its own process group and is considered ready only when it answers a per-run nonce,
  so an unrelated server on the same port is never mistaken for it and never signalled. A port
  collision, a start failure and a timeout stop the group that was started and nothing else.
- Specifications (`tests/e2e/`): the home page and an unknown route render and hydrate without
  console or page errors; axe finds no WCAG 2 A/AA violation in the light and dark colour schemes;
  the keyboard reaches the skip link first with a visible focus indicator and then the content; the
  error boundary shows a generic message, no response or page carries the error detail, and
  **Try again** renders the page again from the server; an asynchronous server component renders.
- Traces and screenshots exist only for a failed test and are written to the ignored
  `test-results/` directory. In the generator the application is a disposable fixture, so a failed
  `pnpm run test:e2e` copies that directory to the generator's own ignored `test-results/` before the fixture
  is removed; a passing run copies nothing.

## The build and the environment

The fixture copies project files, including PostCSS/Browserslist configuration, `.npmrc`, local
configuration imports and data. It preserves file modes and refuses symlinks or special files.
It omits `.git`, `.private`, `.claude`, `.codex`, `.compound-engineering`, `node_modules`,
`.pnpm-store`, `.next`, `out`, `coverage`, `playwright-report`, `test-results`, `.cache`,
`.temp`, `next-env.d.ts`, `.DS_Store`, `*.tsbuildinfo` and `.env`/`.env.*` at every depth.
Fixture routes and the standalone configuration transform are applied after that copy.

The generator also carries browser harness integration tests and negative controls. Run
`pnpm run test:integration --suite=browser-integration` with the same browser prerequisites.
CI runs this suite in the production job after installing the pinned browsers; the ordinary
`test:integration` suite needs no browser executables.

- The production build runs without outbound network: on Linux in an unprivileged network
  namespace with only loopback raised, after a probe in the same kind of namespace showed that an
  outward connection fails and loopback works. Where a namespace cannot be created (another
  operating system, `unshare` or `ip` missing, user namespaces restricted) the command fails with
  what is missing instead of building online. The application uses system fonts and needs no external service to build.
- Children run as production: `NODE_ENV`, `NEXT_*`, `PORT`, `HOSTNAME` and the package manager's
  injected `npm_*`/`pnpm_*` variables of the calling shell are removed, and the fixture is staged
  without any `.env*` file of your checkout, so a local `.env.local` cannot change a result.
- A `NEXT_PUBLIC_*` variable referenced directly is fixed into the client bundle at build time;
  other variables are read by the server at run time. The harness builds with one set of values and
  starts the server with another to show both, and checks that no server-only value reaches the
  client files. The values are compared without being printed.

## What `test:artifact` runs

The fixture is built with `output: "standalone"`. Next.js leaves `public/` and `.next/static` out
of that output, so the harness copies them in, moves the result to a new scratch directory, deletes
the fixture and its `node_modules`, and then checks that:

- no development-only dependency of the project is in the artifact's runtime tree and no parent of the
  artifact holds a `node_modules` through which one could be found;
- `node server.js` serves the page, every script and stylesheet it references, and the favicon;
- an artifact built without `public/` and `.next/static` fails the same check (a negative control; a
  check that cannot fail fails the command).

## Manual screen-reader checklist

Automated checks find only a part of the accessibility problems. Before a release, with a screen
reader (VoiceOver, NVDA or Orca) on the production build:

- the page title and the main heading are announced when a page opens;
- the landmarks (`main`, and the skip link before it) are listed and operable;
- the not-found page and the error message are announced, and **Try again** is reachable by keyboard;
- every control has an understandable name, and focus is never lost after an action.

## Limits

These commands do not deploy anything, do not prove behaviour on other operating systems, and do
not replace the manual checklist. The offline proof is Linux only: on another platform both commands
fail, by design, rather than build online.

## Interrupting a run

`Ctrl-C` (SIGINT) or SIGTERM stops the run: nothing further is started, every tool it started
(install, build, Playwright and its browsers) and every server, including one that is still
starting, is asked to stop through its own process group, forced after a grace period, and the
scratch directories are removed. The command then exits non-zero (130 for SIGINT, 143 for SIGTERM).
Only process groups the run created are signalled.

One process owns the interrupts of each command, and it returns only after its cleanup:

- In an application, `pnpm run test:e2e` and `test:artifact` run the harness inside the project
  dispatcher process itself, which stops its tools (five seconds' grace, then forced).
- In the generator, the dispatcher renders the application into a scratch directory and runs the
  application's command as a group of its own. On an interrupt it asks that group to stop, waits up
  to thirty seconds for the application to clean up its own tools, forces it only after that,
  and removes the scratch directory.

Delivery is the boundary of this guarantee. The signal must reach the project dispatcher: a
terminal's `Ctrl-C` signals the whole foreground process group, which includes `pnpm` and the
dispatcher, and a signal sent directly to the dispatcher process works too. A SIGTERM sent to the
`pnpm` process alone is not forwarded to the script by pnpm 12.14.0, so it neither cancels nor
cleans up the run; in CI, cancel the process group (or the job), never only the `pnpm` pid. Nothing
in the project works around this behaviour of the package manager.
