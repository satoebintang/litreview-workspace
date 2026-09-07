import { test, expect } from "@playwright/test";

test.describe("Slice 9 protocol and search acquisition", () => {
  test("records an immutable run, preserves acquisition metadata, and resolves a canonical Paper", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Search review ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;
    await page.goto(`/projects/${projectId}/protocol`);

    await page.getByLabel("Identifier").fill("RQ1");
    await page.getByLabel("Question").fill("Which interventions are effective?");
    await page.getByRole("button", { name: "Add research question" }).click();
    await expect(page.getByText("Which interventions are effective?", { exact: true })).toBeVisible();

    await page.getByLabel("Strategy name").fill("Broad search");
    await page.getByLabel("Exact query").fill("  intervention AND outcome  ");
    await page.getByLabel("Optional filters").fill("Year: 2020-2026");
    await page.getByRole("button", { name: "Save strategy" }).click();
    await expect(page.locator(".item-title", { hasText: "Broad search" }).first()).toBeVisible();

    await page.getByLabel("Reported result count").fill("42");
    await page.getByRole("button", { name: "Record immutable run" }).click();
    await expect(page.getByRole("link", { name: /Run \d+/ })).toBeVisible();
    await page.getByRole("link", { name: /Run \d+/ }).first().click();
    await expect(page.getByText("Immutable snapshot", { exact: true })).toBeVisible();
    await expect(page.getByText("intervention AND outcome", { exact: false })).toBeVisible();

    await page.goto(`/projects/${projectId}/protocol`);
    await page.getByLabel("Source record ID").fill("record-1");
    await page.getByLabel("Title", { exact: true }).fill("Intervention outcomes");
    await page.getByRole("button", { name: "Add retrieved record" }).click();
    await expect(page.getByText(/Protocol updated/)).toBeVisible();
    await page.getByRole("link", { name: /Run \d+/ }).first().click();
    await page.getByRole("button", { name: "Create Paper from record" }).click();
    await expect(page.getByText(/Paper created and linked/)).toBeVisible();
    await expect(page.getByText("linked", { exact: true })).toBeVisible();
  });
});
