import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// React reports state updates outside act() unless the environment says it is a test environment.
// Testing Library only sets this itself when Vitest globals are enabled, and they are not.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});
