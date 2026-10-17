# Next.js development template

A generator for a JavaScript-only Next.js project with one set of development rules. Everything runs on
Node and pnpm, with Git and the operating system's `file` command as the only other prerequisites; see
[Prerequisites and platforms](guides/platforms). This site documents the generator itself; a generated
application carries its own site for the commands it has.

- [Getting started](getting-started) installs the generator and runs its checks.
- [Activate the agent hosts](guides/first-use) and [Recover a stopped workflow](guides/recovery) cover
  the first use of the guard and Git hooks and the way out of a stopped one.
- [Claude Code and Codex](contributing/agents) states what the protected-files guard does and does not cover.
- [Toolchain](contributing/toolchain) lists the exact versions and the command contract.
- [Static quality](contributing/static-quality) and [Unit tests and coverage](contributing/testing)
  describe the gates behind `pnpm run check`.
- [Pull request checklist](contributing/pr-checklist) lists what a change must satisfy.

[Updating from the template](updating) covers preview, apply and recovery.
[Release process](contributing/release-process) covers version preparation and reviewed tags.
