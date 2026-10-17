import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { settled, watchBrowserErrors } from "./support";

test("the home page renders and hydrates without browser errors", { tag: "@smoke" }, async ({ page }) => {
  const problems = watchBrowserErrors(page);
  const response = await page.goto("/");
  await settled(page);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Application");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Your application starts here" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("an unknown route renders the not-found page with a way back", { tag: "@smoke" }, async ({ page }) => {
  const problems = watchBrowserErrors(page);
  const response = await page.goto("/there-is-no-such-page");
  await settled(page);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  // The browser reports the missing document itself as a failed resource load; nothing else may be reported.
  expect(problems.filter((problem) => !problem.includes("404"))).toEqual([]);
  await page.getByRole("link", { name: "Go to the home page" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Your application starts here" })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const [name, path] of [
    ["home page", "/"],
    ["not-found page", "/there-is-no-such-page"],
  ] as const) {
    test(`the ${name} has no automatically detectable accessibility violations in the ${colorScheme} scheme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto(path);
      await settled(page);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(violations.map(({ id, nodes }) => `${id} (${String(nodes.length)})`)).toEqual([]);
    });
  }
}

test("the keyboard reaches the skip link first, with a visible focus indicator, and it moves to the content", async ({ page }) => {
  await page.goto("/");
  await settled(page);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  const box = await skip.boundingBox();
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  const outline = await skip.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Next.js documentation" })).toBeFocused();
});

test("the not-found page's link is reachable and operable by keyboard", async ({ page }) => {
  await page.goto("/there-is-no-such-page");
  await settled(page);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const back = page.getByRole("link", { name: "Go to the home page" });
  await expect(back).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Your application starts here" })).toBeVisible();
});
