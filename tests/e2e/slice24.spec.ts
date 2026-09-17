import { test, expect } from "@playwright/test";

test.describe("Slice 24 Prose revision history", () => {
  test("appends exact revisions, exposes history/comparison, and binds review to current revision", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 24 history ${Date.now()}`);
    await page.getByLabel("Research question").fill("How does exact wording evolve?");
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto(`/projects/${projectId}/manuscript`);
    await page.getByLabel("Section title").fill("Discussion");
    await page.getByRole("button", { name: "Create section" }).click();
    await page.getByLabel("New prose for Discussion").fill("Baseline wording.");
    await page.getByRole("button", { name: "+ Add prose" }).click();
    await expect(page.getByText(/Prose block · position 1 · Revision 1/)).toBeVisible();
    const proseForm = page.locator("form").filter({ has: page.getByLabel("Edit prose block 1") });
    await expect(proseForm.locator('input[name="expectedCurrentRevisionId"]')).toHaveValue(/[0-9a-f-]{36}/);
    await expect(page.getByRole("link", { name: /History/ })).toBeVisible();

    await page.getByLabel("Edit prose block 1").fill("Revised wording.");
    await page.getByRole("button", { name: "Save prose" }).click();
    await expect(page.getByText(/Prose block · position 1 · Revision 2/)).toBeVisible();
    await expect(page.getByRole("link", { name: /History \(2\)/ })).toBeVisible();

    await page.getByRole("link", { name: /History \(2\)/ }).click();
    await expect(page).toHaveURL(/\/manuscript\/prose\/[0-9a-f-]+\/history$/);
    await expect(page.getByText("Prose revision history", { exact: true })).toBeVisible();
    await expect(page.getByText("Revision 2 · Current", { exact: true })).toBeVisible();
    await expect(page.getByText("Baseline wording.", { exact: true })).toBeVisible();
    await expect(page.getByText("Revised wording.", { exact: true })).toBeVisible();
    const revisionOptions = page.locator("#prose-history-left option:not([disabled])");
    await expect(revisionOptions).toHaveCount(2);
    const leftRevision = await revisionOptions.nth(0).getAttribute("value");
    const rightRevision = await page.locator("#prose-history-right option:not([disabled])").nth(1).getAttribute("value");
    await page.locator("#prose-history-left").selectOption(leftRevision!);
    await page.locator("#prose-history-right").selectOption(rightRevision!);
    await page.getByRole("button", { name: "Compare" }).click();
    await expect(page.locator("strong").filter({ hasText: "Revision 1" })).toBeVisible();
    await expect(page.locator("strong").filter({ hasText: "Revision 2" })).toBeVisible();

    await page.goto(`/projects/${projectId}/manuscript/review`);
    await page.getByRole("link", { name: /← Manuscript composition/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/manuscript$`));
    const reviewLink = page.locator('a[href*="/manuscript/review?item="]').first();
    await reviewLink.click();
    await expect(page).toHaveURL(/\/manuscript\/review\?item=/);
    await page.getByLabel("Title").fill("Review revised wording");
    await page.getByLabel("Opening comment").fill("Check this current revision.");
    await page.getByRole("button", { name: "Open thread" }).click();
    await expect(page).toHaveURL(/\/manuscript\/review\?thread=/);
    await expect(page.getByText(/Opening Prose revision:/)).toBeVisible();
    await expect(page.getByText(/Current Prose revision:/)).toBeVisible();
  });
});
