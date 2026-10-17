// @ts-check
"use strict";
// The environment the production harnesses give every child: production, not test; no package
// manager overrides from the invoking `pnpm run`; no stray application variables of the caller.
// Local `.env*` files never reach a fixture because the fixture is staged without them (stage.cjs).

/** Variables the invoking pnpm and npm inject for a script; a child pnpm must read its own project configuration instead. */
const PACKAGE_MANAGER = /^(?:npm_|pnpm_|PNPM_|NPM_)/i;
/** Variables that change how Node.js resolves modules or how Next.js behaves and what it embeds; the harness sets the ones it needs itself. */
const AMBIENT = /^(?:NODE_ENV|NODE_PATH|NEXT_|PORT$|HOSTNAME$|FIXTURE_|E2E_|PLAYWRIGHT_)/;
/** The caller's own choices that a fixture must still find: where the package store and the browsers are. The set of browser lanes is never one of them. */
const KEPT = /^(?:(?:npm|pnpm)_config_store_dir|PLAYWRIGHT_BROWSERS_PATH)$/i;

/**
 * @param {NodeJS.ProcessEnv} base the invoking environment
 * @param {Record<string, string>} [extra] values the harness sets itself
 * @returns {NodeJS.ProcessEnv}
 */
function cleanEnv(base, extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && (KEPT.test(name) || !(PACKAGE_MANAGER.test(name) || AMBIENT.test(name)))) env[name] = value;
  }
  return { ...env, NEXT_TELEMETRY_DISABLED: "1", ...extra };
}

module.exports = { cleanEnv };
