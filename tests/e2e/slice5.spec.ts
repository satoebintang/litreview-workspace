import { test, expect } from "@playwright/test";
import { addManualPaper } from "./manual-paper";
import { selectEvidencePaper } from "./evidence-paper-picker";

test.describe("Slice 5 manuscript Claims", () => {
  test("creates, grounds, revises, and withdraws a Claim while retaining history", async ({ page }) => {
    const unique = Date.now();
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Claims review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;
    await page.goto(`/projects/${projectId}/papers`);

    await page.getByLabel("Title", { exact: true }).fill("Grounded study");
    await addManualPaper(page);
    await expect(page.getByText("Grounded study", { exact: true }).first()).toBeVisible();
    await page.goto(`/projects/${projectId}/evidence`);
    await selectEvidencePaper(page, "Grounded study", page.getByRole("region", { name: "Record Evidence" }));
    await page.getByLabel("Verbatim source passage").fill("The observed result was significant.");
    await page.getByLabel("Page number", { exact: true }).fill("7");
    await page.getByRole("button", { name: "Record evidence" }).click();

    await page.goto(`/projects/${projectId}/claims`);
    await page.getByLabel("Claim text").fill("The observed result was significant.");
    await page.getByRole("button", { name: "Create unsupported claim" }).click();
    await expect(page).toHaveURL(/\/claims\/[0-9a-f-]+\?saved=created$/);
    await expect(page.getByText("unsupported", { exact: true })).toBeVisible();

    const evidenceOption = page.locator("#link-evidence option").nth(1);
    await page.getByLabel("Evidence passage").selectOption(await evidenceOption.getAttribute("value") as string);
    await page.getByRole("button", { name: "Link evidence" }).click();
    await expect(page.getByText("supported", { exact: true })).toBeVisible();
    await expect(page.getByText("1 grounded", { exact: true })).toBeVisible();
    await expect(page.getByText("The observed result was significant.", { exact: false }).first()).toBeVisible();

    await page.getByRole("button", { name: "Withdraw Claim" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Withdraw Claim" }).click();
    await expect(page).toHaveURL(/saved=withdrawn$/);
    await expect(page.getByText("withdrawn", { exact: true })).toBeVisible();
    await expect(page.getByText(/Complete Claim history/)).toBeVisible();
    await expect(page.getByText("3 revisions", { exact: true })).toBeVisible();
  });
});
