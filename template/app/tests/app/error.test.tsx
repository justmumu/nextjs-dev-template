import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import ErrorBoundary from "../../src/app/error";

function failure() {
  return Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:5432 password=hunter2"), { digest: "digest-4711" });
}

describe("error boundary", () => {
  test("announces the failure as an alert", () => {
    render(<ErrorBoundary error={failure()} retry={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toContain("Something went wrong");
  });

  test("never shows the error message, its digest or its details", () => {
    render(<ErrorBoundary error={failure()} retry={vi.fn()} />);
    const shown = document.body.textContent;
    for (const secret of ["ECONNREFUSED", "10.0.0.7", "hunter2", "digest-4711"]) expect(shown).not.toContain(secret);
  });

  test("tries again exactly once per click through the retry callback", () => {
    const retry = vi.fn();
    render(<ErrorBoundary error={failure()} retry={retry} />);
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
