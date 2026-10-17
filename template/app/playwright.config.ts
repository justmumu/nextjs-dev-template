import { defineConfig, devices } from "@playwright/test";

// `pnpm run test:e2e` builds the application once, serves that build on a port it owns and tells
// this file where. The browser lanes never start a server themselves.
const baseURL = process.env.E2E_BASE_URL;
if (baseURL === undefined) {
  throw new Error("E2E_BASE_URL is not set: run the browser tests with `pnpm run test:e2e`, which builds and serves the application first.");
}

const lanes = {
  "chromium-desktop": { ...devices["Desktop Chrome"] },
  "chromium-mobile": { ...devices["Pixel 7"] },
  // WebKit proves rendering and hydration in a second engine; the keyboard and fixture specifications run in Chromium.
  "webkit-smoke": { ...devices["Desktop Safari"] },
};

export default defineConfig({
  testDir: "./tests/e2e",
  forbidOnly: true,
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  // Traces and screenshots exist only for a failure and are written to the ignored test-results directory.
  outputDir: "test-results",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  // All three lanes are required; no setting narrows them. A browser that cannot launch fails its lane.
  projects: Object.entries(lanes).map(([name, use]) => ({
    name,
    use,
    ...(name === "webkit-smoke" ? { grep: /@smoke/ } : {}),
  })),
});
