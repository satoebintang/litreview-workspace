import { expect, type Page } from "@playwright/test";

export async function addManualPaper(page: Page): Promise<string> {
  const paperTitle = await page.getByLabel("Title", { exact: true }).inputValue();
  const projectId = await page.locator('form[data-testid="manual-paper-form"] input[name="projectId"]').inputValue();
  await page.getByRole("button", { name: "Review possible duplicates" }).click();
  const review = page.getByTestId("manual-paper-review");
  await expect(review).toBeVisible();
  const acknowledgement = review.getByRole("checkbox");
  if (await acknowledgement.count()) await acknowledgement.check();
  await review.getByRole("button", { name: "Add Paper" }).click();

  const paperLink = page.getByRole("link", { name: paperTitle, exact: true });
  await expect(paperLink).toBeVisible();
  const href = await paperLink.getAttribute("href");
  const match = href?.match(/^\/projects\/([0-9a-f-]+)\/papers\/([0-9a-f-]+)\/documents$/i);
  if (!match || match[1] !== projectId) {
    throw new Error(`The created Paper was not listed under Project ${projectId}`);
  }
  return match[2];
}
