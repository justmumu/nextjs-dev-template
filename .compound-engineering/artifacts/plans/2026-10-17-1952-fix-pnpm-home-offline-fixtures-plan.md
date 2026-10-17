---
title: Preserve the CI package store for offline fixtures - Plan
type: fix
date: 2026-10-17
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Preserve the CI package store for offline fixtures - Plan

## Goal Capsule

- **Objective:** Generated projects complete their production browser and standalone artifact checks using the package store populated during CI setup.
- **Means:** Preserve the caller's PNPM_HOME through fixture environment cleaning (KTD1).
- **Authority:** User requirements and AGENTS.md govern execution; requirements govern behavior, KTDs govern implementation, and units override neither.
- **Execution:** One bounded code change with focused regression coverage, followed by CI verification. Codex prepares the protected-file patch; the user applies and accepts it. Stop dependent work if the guard rejects the change or the diagnosis is contradicted.
- **Delivery:** Add this fix to the existing codex/codex-plugin-defaults branch and the same forthcoming PR as the plugin-defaults change. Publishing remains the user's decision.

## Product Contract

### Summary

Preserve CI's package-store selection when production fixtures install their dependencies offline.
The shared helper change reaches newly generated projects and existing projects through the normal template update.

### Problem Frame

In [downstream run 39063024595](https://github.com/rootvane/ninjarumor-web/actions/runs/39063024595), the production job exposes PNPM_HOME, but its fixture installation fails with ERR_PNPM_NO_OFFLINE_TARBALL for is-regexp@1.0.0.
The artifact step is skipped after the e2e failure.
The shared cleanEnv helper removes PNPM_HOME before harness.cjs invokes pnpm.
The user reports a pnpm 12.14.0 experiment confirming that removing this variable changes the store path; the CI log establishes the failure but does not itself print both resolved store paths.

### Requirements

**Environment behavior**

- R1. cleanEnv preserves a defined PNPM_HOME unchanged, including when no explicit npm or pnpm store-dir override exists.
- R2. Existing filtering of unrelated package-manager and ambient variables, undefined-value omission, explicit store/browser exceptions, telemetry defaults, and caller overrides remain intact.
- R3. Fixture installation retains both --frozen-lockfile and --offline, and production build network isolation remains intact.

**Delivery and acceptance**

- R4. Both newly generated projects and ordinary downstream template updates receive the shared helper fix and its unit regression coverage.
- R5. CI production browser and standalone artifact checks both execute successfully with PNPM_HOME selecting the populated store; a skipped artifact step is not acceptance evidence.

## Planning Contract

- KTD1. **Extend the existing KEPT allowlist with PNPM_HOME.** The existing case-insensitive exception pattern is the right boundary for R1; no general PNPM_* passthrough is needed. Owner: scripts/testing/environment.cjs.
- KTD2. **Cover the missing store selector in the existing unit suite.** Add PNPM_HOME preservation coverage in tests/unit/production/environment.test.ts, including an input without explicit store-dir configuration. Keep existing harness assertions for frozen offline installation as evidence for R3.
- KTD3. **Use existing template distribution.** tooling/template-manifest.json already copies both changed files from the generator root. scripts/template/preview.cjs does not classify environment.cjs as an update-engine file, so no manifest, seed duplicate, or engine migration change is needed for R4.
- KTD4. **Keep this as a supplemental plan.** The reviewed plugin-defaults plan remains unchanged: .compound-engineering/artifacts/plans/2026-10-17-1921-fix-codex-plugin-defaults-plan.md. Preserve its implementation while preparing the combined PR.

Changing pnpm versions, changing CI cache configuration, adding online fallback, and introducing another store-warming path are outside this fix: none addresses the lost environment variable.

## Implementation Units

### U1. Preserve the store selector and prove the regression

- **Goal / requirements:** Implement R1–R4 using KTD1–KTD3.
- **Files:** scripts/testing/environment.cjs; tests/unit/production/environment.test.ts.
- **Approach:** Extend the existing environment fixture and assertions without adding a new abstraction. Prepare the exact protected script diff for the user to apply under AGENTS.md. Do not request application while another mutating tool call is pending.
- **Execution note:** Establish the failing PNPM_HOME regression before applying the helper fix.
- **Test scenarios:**
  - Given PNPM_HOME and no explicit store-dir variable, cleaning returns the same PNPM_HOME value.
  - Given PNPM_HOME alongside package-manager script metadata and ambient application variables, cleaning preserves the selector while existing forbidden-variable assertions still pass.
  - Existing undefined-input and caller-override cases retain their behavior.
- **Verification:** The environment suite passes after failing for the missing selector before the fix. Existing harness tests still require frozen offline installation. Confirm the existing root-copy mapping distributes the changed files without additional production edits.

### U2. Verify production consumers and prepare the combined PR

- **Goal / requirements:** Prove R5 while retaining R3; preserve the plugin-defaults work under KTD4.
- **Dependencies:** U1.
- **Files:** No additional source changes expected. Evidence comes from .github/workflows/ci.yml, scripts/testing/harness.cjs, and the resulting production job.
- **Approach:** Use the existing production CI path, whose setup populates the store before fixture creation. Ensure the run exercises PNPM_HOME store selection without an explicit store-dir override masking it. Record the run URL and outcomes for each production step.
- **Test scenario:** With the PNPM_HOME-selected store populated during setup, a newly rendered application's production browser and artifact checks complete their offline fixture installations and pass.
- **Verification:** Both production steps execute and succeed. An unrelated CI failure remains separately identified and does not justify weakening offline installation or claiming R5 complete.

## Verification Contract

Use the repository's test:one dispatcher for tests/unit/production/environment.test.ts and the existing tests/unit/production/harness.test.ts assertions during development.
Git hooks own routine formatting, lint, type, lock, protected-file checks, and the pre-push check/docs:build gates; do not duplicate passing gates.
The existing test:e2e and test:artifact CI steps are the production acceptance evidence for U2.
If publication is still awaiting approval, report local verification separately and leave CI acceptance pending.
Downstream consumers obtain the fix from the published template revision through the existing update workflow; the user applies that update in their own terminal.

## Definition of Done

- U1's regression demonstrates the original failure and passes with the allowlist fix; R2–R4 remain satisfied.
- U2 provides successful, non-skipped CI evidence for both production checks as required by R5.
- The combined PR contains the plugin-defaults change and this fix without unrelated changes or abandoned experiments.
