# Changelog

All notable changes of this repository are recorded here by `pnpm run release:bump`.

## v0.0.2 (2026-10-17)

### Bug Fixes

- **agents:** ship Codex plugin defaults to generated projects 67e67ef
- **deps:** allow independent manifest and lock updates 6b4700c
- **docs:** keep the update guide link valid in generated projects 12aba1f
- **testing:** preserve PNPM_HOME for offline fixtures (U1) 5fcefd3
- **tooling:** satisfy ESLint 10 assignment checks ef0fd55

## v0.0.1 (2026-10-17)

### Features

- add scoped testing and coverage gates (U5) 0c3e60f
- add the minimal Next.js app and strict static gates (U4) a1c12ce
- add transactional development and dependency commands (U3) f2aead2
- **ci:** verify template and application workflows c8e7910
- **docs:** add strict VitePress documentation gates a1f4b07
- **guard:** bind call completion and recover state locks 1363b96
- **guard:** protect project configuration with Node 41d2782
- **hooks:** enforce Git gates and agent host parity e9c7a81
- **release:** prepare and validate reviewed releases 12dd039
- render deterministic independent application seeds (U2) a9aeb68
- **template:** apply updates with recoverable merge journals f766031
- **template:** create and enroll projects transactionally efac337
- **template:** finish guarded adoption and review fixes (U16) 16b70c9
- **template:** preview updates against persistent lineage e1e6d70
- **testing:** verify production browsers and portable artifacts f58778f

### Bug Fixes

- **deps:** validate locks with missing policy metadata a3a7b12
- **testing:** isolate reviewed workspace fixtures 2e9f5ff
