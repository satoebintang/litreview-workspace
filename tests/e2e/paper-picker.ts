import { expect, type Locator, type Page } from "@playwright/test";

export async function selectPaper(title: string, within: Page | Locator) {
  const nestedPickers = within.locator(".paper-picker");
  const picker = await nestedPickers.count() > 0 ? nestedPickers.first() : within as Locator;
  await picker.getByRole("searchbox").fill(title);
  await picker.getByRole("button", { name: /^(Browse|Search) Papers$/ }).click();
  const result = picker.locator(".claim-support-result-row").filter({ hasText: title });
  await expect(result).toBeVisible();
  const selectionButton = result.getByRole("button");
  await expect(selectionButton).toHaveCount(1);
  if (await selectionButton.getAttribute("aria-pressed") !== "true") await selectionButton.click();
  await expect(selectionButton).toHaveAttribute("aria-pressed", "true");
}
