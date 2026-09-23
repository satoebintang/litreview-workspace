import { expect, type Page } from "@playwright/test";

export async function addManualPaper(page: Page) {
  await page.getByRole("button", { name: "Review possible duplicates" }).click();
  const review = page.getByTestId("manual-paper-review");
  await expect(review).toBeVisible();
  const acknowledgement = review.getByRole("checkbox");
  if (await acknowledgement.count()) await acknowledgement.check();
  await review.getByRole("button", { name: "Add Paper" }).click();
}
