import { expect, test } from "@playwright/test";

import { settled } from "./support";

// These routes exist only in the harness's disposable fixture, never in the application.
const SECRETS = ["FIXTURE-SECRET-DETAIL", "hunter2", "10.0.0.7", "postgres://"];

test("an async server component renders its awaited content", async ({ page }) => {
  await page.goto("/fixture/async");
  await settled(page);
  await expect(page.getByRole("heading", { level: 1, name: "Async fixture" })).toBeVisible();
  await expect(page.getByText("Async server content")).toBeVisible();
});

test("the error boundary shows a generic message, leaks no detail, and retry renders the page again from the server", async ({ page }) => {
  const reading: Promise<string>[] = [];
  page.on("response", (response) => {
    // A body the browser can no longer provide has nothing left to leak.
    reading.push(response.text().catch(() => ""));
  });
  await page.goto(`/fixture/error?key=${crypto.randomUUID()}`);
  await settled(page);
  const alert = page.getByRole("alert", { name: "Something went wrong" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Something went wrong");
  await expect(alert).toContainText("The page could not be displayed. You can try again.");

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Recovered fixture" })).toBeVisible();
  await expect(alert).toBeHidden();

  const shown = [await page.content(), ...(await Promise.all(reading))];
  for (const secret of SECRETS)
    expect(
      shown.some((text) => text.includes(secret)),
      `a response or the page carries the fixture error detail ${SECRETS.indexOf(secret).toString()}`,
    ).toBe(false);
});
