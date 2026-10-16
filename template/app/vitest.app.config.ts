import { suiteConfig } from "./tooling/vitest/suite.ts";

export default suiteConfig("app", { setupFiles: ["tests/setup/app.ts"], oxc: { jsx: { runtime: "automatic" } } });
