# Unit tests and coverage

Tests are classified by what they really touch, not by how long they take. The suites are
described once in `scripts/core/testing.cjs`; the Vitest configurations, the focused-test command
and the coverage gate all read that description, and a contract test
(`tests/contracts/coverage-policy.test.ts`) fails when a test file belongs to no suite or a
configuration drifts from it.

| Suite            | Selects                                                   | Environment | Measured coverage scope                                          |
| ---------------- | --------------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| `infrastructure` | `tests/unit/**/*.test.ts`, `tests/contracts/**/*.test.ts` | Node        | `scripts/**/*.cjs` and `tooling/eslint/suppression-policy.mjs`   |
| `app`            | `tests/app/**/*.test.{ts,tsx}`                            | jsdom       | `src/**/*.{ts,tsx}`                                              |
| `integration`    | `tests/integration/**/*.test.ts`                          | Node        | none; real pnpm, Git, Next.js, ESLint and filesystem interaction |

A test is an integration test when a real collaborator is part of what it proves: it starts a
process (a package manager, Git, Next.js, ESLint, a Node child or a stand-in executable), installs
dependencies, or relies on what a real filesystem does (rollback, symlinks, permissions, deleting
and recreating files). Such tests never run in the default unit run, however fast they are. A unit
test judges decisions with collaborators that live in the test's own process: pure functions on
plain data, and orchestration that receives its collaborators as arguments. The shipped scripts take
them where a decision sits between effects: the dependency transaction takes a `system` and the
snapshot and rollback a `disk`, `bootstrap.cjs` and `dependencies.cjs` take a `host`, the
dispatcher takes `tools`, and `runLogged` takes the function that starts the process. A fixture file
that a function only reads as its input is data, not a collaborator. Real interaction is proved by
the integration tests (`tests/integration/`, run with `pnpm run test:integration`), which
exercise the same scripts against real tools and a real disk.
The in-memory disk (`tests/support/memory-disk.ts`) answers only the calls a snapshot and a rollback
make; it is not a mocking framework and gets no behavior beyond those calls.

## Commands

| Command | What it does |
| --------------------------------------------------------------------- |
| `pnpm run check` | Includes the `unit` gate: every measured suite runs on its own with coverage. The gate fails when any suite fails or measures nothing. |
| `pnpm run test:one --test=<path> [--suite=<name>] [--name=<literal>]` | One existing test file of a registered suite (`.test.ts`, and `.test.tsx` in the `app` suite). `--suite` must agree with the file. An unknown path or suite, or a file no suite selects, is refused (exit 2) before Vitest starts. Vitest's own file filter is a substring of the path, so the command does not use it: it selects the file by its absolute module id through Vitest's Node API in the suite's configuration and runs only that file, whatever lookalikes (`a.test.ts` beside `a.test.tsx`, or a nested path ending the same way) exist; a lookalike is not even loaded. A `--name` that matches no test exits 2 instead of passing with everything skipped. `--name` is a literal test name, never a pattern. No other runner flag is accepted. |
| `pnpm run test:integration [--scenario=<id>]` | The `integration` suite, or one scenario: the name of a file under `tests/integration/`. |

`test:one` is quick feedback and does not replace `check`.

## Coverage

- Vitest applies coverage to the whole process, not to a project, so each measured suite runs as its
  own invocation with its own configuration (`vitest.<suite>.config.ts`). Lines, branches, functions
  and statements must each be at least **80%** in every suite; a surplus in one suite never makes up
  for a shortfall in another. The application and the infrastructure are therefore held separately.
- The scope is an explicit `include`, so an eligible file that no test imports still counts as
  uncovered code. Tests (`*.test.*`, `*.spec.*`, `__tests__`), declarations (`*.d.ts`), generated and
  reported output and dependency trees are excluded wherever they sit (`NOT_PRODUCT` in
  `scripts/core/testing.cjs`), because Vitest 5 applies no such default to an explicit `include`.
- A scope that matches no file, or measures no lines or statements, fails the gate. Vitest alone
  reports such a scope as "Unknown%" and exits successfully, so the gate reads the JSON summary too.
  A scope without a single branch is legitimate (straight-line components).
- Reports are written to `coverage/<suite>/` (ignored by Git) and removed before each run, so a
  report from an earlier run cannot satisfy the gate.
- Framework code that Vitest cannot measure, such as an async server component, is not covered by
  a unit test and is not counted as unit coverage. If a file must be excluded, it is named by exact
  path in the suite's `exclusions` with a reason and the existing end-to-end or build test that
  proves it instead (`tests/e2e/` or `tests/integration/`); a directory or a pattern is refused,
  and `src/app` is never excluded as a whole. There are no exclusions today: the page, layout,
  not-found and error components are synchronous and are tested in jsdom.

## Application tests

`tests/app/` tests the real components with Testing Library's semantic queries (roles, names and
landmarks): the home page, the root layout's skip link and `main` landmark, the not-found page's way
back, and the error boundary, which announces the failure as an alert, calls `retry` (which fetches and
renders the failed segment again; `reset` would only clear the error and show the failed result again)
when asked to try again and never prints the error message, digest or details. Asynchronous server components and
production behavior are proved by real build and browser tests, not by calling them as functions:
see [Production browser and standalone tests](production-tests).
