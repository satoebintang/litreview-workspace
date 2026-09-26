import { expect, type Locator, type Page } from "@playwright/test";

export async function selectEvidencePaper(page: Page, title: string, within: Page | Locator = page) {
  const picker = within.locator(".evidence-paper-picker").first();
  await picker.getByRole("searchbox").fill(title);
  await picker.getByRole("button", { name: "Search Papers" }).click();
  const result = picker.locator(".claim-support-result-row").filter({ hasText: title });
  await expect(result).toBeVisible();
  await result.getByRole("button", { name: "Select", exact: true }).click();
  await expect(result.getByRole("button", { name: "Selected", exact: true })).toBeVisible();
}
