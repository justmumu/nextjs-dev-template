# Documentation

This application is developed with Node and pnpm; Git and the operating system's `file` command are the
only other prerequisites (see [Prerequisites and platforms](guides/platforms)). This site describes the
commands it ships with.

- [Getting started](getting-started) installs the project and runs its checks.
- [Activate the agent hosts](guides/first-use) and [Recover a stopped workflow](guides/recovery) cover
  the first use of the guard and Git hooks and the way out of a stopped one.
- [Claude Code and Codex](contributing/agents) states what the protected-files guard does and does not cover.
- [Toolchain](contributing/toolchain) lists the exact versions and the commands.
- [Static quality](contributing/static-quality) and [Unit tests and coverage](contributing/testing)
  describe the gates behind `pnpm run check`.
- [Pull request checklist](contributing/pr-checklist) lists what a change must satisfy.

[Updating from the template](updating) covers preview, apply and recovery.
[Release process](contributing/release-process) covers version preparation and reviewed tags.
