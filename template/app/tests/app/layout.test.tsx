import { screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import RootLayout from "../../src/app/layout";
import HomePage from "../../src/app/page";

// The root layout renders <html> and <body>, which cannot live inside the container Testing Library
// renders into. The server markup is parsed as a document and its body is moved into the test page.
function renderDocument() {
  const parsed = new DOMParser().parseFromString(
    `<!DOCTYPE html>${renderToStaticMarkup(
      <RootLayout>
        <HomePage />
      </RootLayout>,
    )}`,
    "text/html",
  );
  document.body.replaceChildren(...parsed.body.childNodes);
  return parsed;
}

describe("root layout", () => {
  test("declares the document language", () => {
    expect(renderDocument().documentElement.lang).toBe("en");
  });

  test("offers a skip link that targets the one main landmark holding the page", () => {
    renderDocument();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    const main = screen.getByRole("main");
    expect(skip.getAttribute("href")).toBe(`#${main.id}`);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(main.querySelector("h1")?.textContent).toBe("Your application starts here");
  });
});
