import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import NotFound from "../../src/app/not-found";

describe("not-found page", () => {
  test("says the page does not exist and links back to the home page", () => {
    render(<NotFound />);
    expect(screen.getByRole("region", { name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to the home page" }).getAttribute("href")).toBe("/");
  });
});
