# Development rules

This is the planning bootstrap for `justmumu/nextjs-dev-template`.
The application, generator, development commands, Git hooks and protected-files guard
are not implemented yet. Do not claim their checks or protection are active.
The implementation plan lives under `.compound-engineering/artifacts/plans/`.
Implementation begins only when the user asks to execute the plan.

This file is the shared policy for contributors, Claude Code and Codex.
Host-specific instructions reference it instead of maintaining another copy.
The implementation must carry the development and approval rules of
`justmumu/python-dev-template` into the Next.js template, as specified in the plan.
All project tooling must use the JavaScript/TypeScript ecosystem. Preserve the
source template's behavioral rules, not its Python tools or runtime dependencies.
The implementation will expose routine checks through `pnpm run` scripts;
dependency-free Node entrypoints will own initial setup and environment recovery.
The sibling Python repository is a read-only reference for this work.

## Git and publishing

Work on a feature branch, never commit directly to `main`. Codex branches use
`codex/short-description`. Use Conventional Commits with subjects at most
72 characters. Do not bypass Git hooks. Use a GitHub noreply email for both
author and committer; verify commit metadata before publishing. Do not copy
the template owner's Git identity into generated projects.

Ask before each push, opening or merging a PR, version bump, release tag or
deployment. Approval covers only the named action. Use a regular merge commit,
never squash. Repository creation does not authorize a push. Use plain Git and
GitHub commands so publishing rules can recognize them.

## Compound Engineering and notes

Both host configurations enable Compound Engineering. Its team configuration
and example are copied from the Python template. Core development must work
without the plugin. Artifacts belong under `.compound-engineering/artifacts/`;
private research and working notes belong in the gitignored `.private/` directory.
Reserve `docs/` for the public documentation website.

Write reports, summaries and handoffs through the `ce-noslop` skill.
When clarification is necessary, ask visibly in the conversation and wait for
the answer; do not use asynchronous background questions.

## Planning bootstrap limits

No test suite or development command facade exists at this stage. Validate planning artifacts
and configuration directly, but do not invent successful application checks.
The plan defines when tooling is installed, when protected configuration is
activated and which approval routes apply afterwards. Do not register hooks
that reference files which have not been implemented.
