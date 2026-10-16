import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import HomePage from "../../src/app/page";

describe("home page", () => {
  test("presents one labelled section with the page heading", () => {
    render(<HomePage />);
    const section = screen.getByRole("region", { name: "Your application starts here" });
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Your application starts here" }).closest("section")).toBe(section);
  });

  test("points to the Next.js documentation without leaking the referrer", () => {
    render(<HomePage />);
    const link = screen.getByRole("link", { name: "Next.js documentation" });
    expect(link.getAttribute("href")).toBe("https://nextjs.org/docs");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});
