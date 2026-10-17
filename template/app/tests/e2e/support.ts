import type { Page } from "@playwright/test";

/** The errors the browser reports while a page loads and hydrates; an empty list means a clean page. */
export function watchBrowserErrors(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => {
    problems.push(`page error: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()}`);
  });
  return problems;
}

/** Resolves after the browser painted a frame following the load event, by which time hydration has run or reported its error. */
export async function settled(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}
