import { test, expect } from "@playwright/test";

test.describe("Slice 6 manuscript workspace", () => {
  test("composes exact ClaimRevisions and derives a deduplicated bibliography", async ({ page }) => {
    const unique = Date.now();
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Manuscript review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    for (const [title, passage] of [["First study", "First study supports the claim."], ["Second study", "Second study supports the claim."]] as const) {
      await page.getByLabel("Title", { exact: true }).fill(title);
      await page.getByRole("button", { name: "Add paper" }).click();
      await page.getByLabel("Paper").selectOption({ label: title });
      await page.getByLabel("Verbatim source passage").fill(passage);
      await page.getByLabel("Page number").fill("1");
      await page.getByRole("button", { name: "Record evidence" }).click();
    }

    const claims = [
      ["First claim", "First study supports the claim."],
      ["Second claim", "Second study supports the claim."],
    ] as const;
    for (const [claimText, passage] of claims) {
      await page.goto(`/projects/${projectId}/claims`);
      await page.getByLabel("Claim text").fill(claimText);
      await page.getByRole("button", { name: "Create unsupported claim" }).click();
      await expect(page).toHaveURL(/\/claims\/[0-9a-f-]+\?saved=created$/);
      const option = page.locator("#link-evidence option").filter({ hasText: passage }).first();
      await page.getByLabel("Evidence passage").selectOption(await option.getAttribute("value") as string);
      await page.getByRole("button", { name: "Link evidence" }).click();
      await expect(page.getByText("supported", { exact: true })).toBeVisible();
    }

    await page.goto(`/projects/${projectId}/manuscript`);
    await page.getByLabel("Section title").fill("Introduction");
    await page.getByRole("button", { name: "Create section" }).click();
    await page.getByLabel("Section title").fill("Discussion");
    await page.getByRole("button", { name: "Create section" }).click();
    await expect(page.getByRole("heading", { name: "Introduction" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Discussion" })).toBeVisible();

    const sectionSelect = page.getByLabel("Section", { exact: true });
    const revisionSelect = page.getByLabel("Finalized active ClaimRevision");
    await sectionSelect.selectOption({ label: "Introduction" });
    await revisionSelect.selectOption(await revisionSelect.locator("option").filter({ hasText: "First claim" }).first().getAttribute("value") as string);
    await page.getByRole("button", { name: "Place exact revision" }).click();
    await sectionSelect.selectOption({ label: "Discussion" });
    await revisionSelect.selectOption(await revisionSelect.locator("option").filter({ hasText: "Second claim" }).first().getAttribute("value") as string);
    await page.getByRole("button", { name: "Place exact revision" }).click();

    await expect(page.getByRole("heading", { name: "Bibliography candidates" })).toBeVisible();
    await expect(page.getByText("First study", { exact: true })).toBeVisible();
    await expect(page.getByText("Second study", { exact: true })).toBeVisible();
    await expect(page.getByText("Paper-ID deduplicated · derived order")).toBeVisible();
    await expect(page.getByText(/citation numbers: 1/)).toBeVisible();
    await expect(page.getByText(/citation numbers: 2/)).toBeVisible();

    await expect(page.getByRole("button", { name: "Reverse section order" })).toBeVisible();
  });
});
