// @ts-check
"use strict";
// Routes that exist only in disposable fixtures. The starter application stays synchronous and free
// of environment access; these routes prove framework behavior (an async server component, error
// recovery, build-time and runtime environment) in a production build and are never emitted into the
// application's own source.

const READY = `export const dynamic = "force-dynamic";

// Answers with this run's nonce so the harness can tell its own server from any other on the port.
export function GET() {
  return new Response(process.env.E2E_NONCE ?? "");
}
`;

const ASYNC_PAGE = `export const dynamic = "force-dynamic";

async function load(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return "Async server content";
}

export default async function AsyncFixturePage() {
  const content = await load();
  return (
    <section aria-labelledby="async-title">
      <h1 id="async-title">Async fixture</h1>
      <p>{content}</p>
    </section>
  );
}
`;

const ERROR_PAGE = `export const dynamic = "force-dynamic";

// The first render for a key fails on the server; a later render for the same key succeeds.
const seen = new Set<string>();

export default async function ErrorFixturePage({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { key = "default" } = await searchParams;
  if (!seen.has(key)) {
    seen.add(key);
    throw new Error("FIXTURE-SECRET-DETAIL postgres://admin:hunter2@10.0.0.7:5432/app");
  }
  return (
    <section aria-labelledby="recovered-title">
      <h1 id="recovered-title">Recovered fixture</h1>
      <p>The server rendered this page again after the retry.</p>
    </section>
  );
}
`;

const ENV_PAGE = `import { PublicValue } from "./public-value";

export const dynamic = "force-dynamic";

export default function EnvironmentFixturePage() {
  return (
    <section aria-labelledby="env-title">
      <h1 id="env-title">Environment fixture</h1>
      <p data-testid="server">{process.env.FIXTURE_SERVER_ONLY ?? "unset"}</p>
      <PublicValue />
    </section>
  );
}
`;

const PUBLIC_VALUE = `"use client";

const dynamicName = "NEXT_PUBLIC_FIXTURE_PUBLIC";

export function PublicValue() {
  return (
    <>
      <p data-testid="public">{process.env.NEXT_PUBLIC_FIXTURE_PUBLIC ?? "unset"}</p>
      <p data-testid="dynamic">{process.env[dynamicName] ?? "unset"}</p>
    </>
  );
}
`;

/** @param {"production" | "artifact"} kind @returns {Record<string, string>} fixture source files by project-relative path */
function fixtureFiles(kind) {
  /** @type {Record<string, string>} */
  const files = { "src/app/e2e-ready/route.ts": READY };
  if (kind === "production") {
    files["src/app/fixture/async/page.tsx"] = ASYNC_PAGE;
    files["src/app/fixture/error/page.tsx"] = ERROR_PAGE;
    files["src/app/fixture/env/page.tsx"] = ENV_PAGE;
    files["src/app/fixture/env/public-value.tsx"] = PUBLIC_VALUE;
  }
  return files;
}

const OPTION = "typedRoutes: true,";

/**
 * The application's own Next.js configuration with the standalone output added, so the artifact is
 * built from the configuration the application really has.
 * @param {string} config the text of next.config.ts
 * @returns {string}
 */
function standaloneConfig(config) {
  if (config.split(OPTION).length !== 2) throw new Error(`next.config.ts no longer contains exactly one \`${OPTION}\`; update the standalone fixture`);
  return config.replace(OPTION, `${OPTION}\n  output: "standalone",`);
}

module.exports = { fixtureFiles, standaloneConfig };
