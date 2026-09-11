import { test, expect } from "@playwright/test";

test.describe("Slice 17 Evidence Sets", () => {
  test("creates an empty set, adds Evidence without changing provenance, and archives it", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Evidence Set review ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    await page.getByLabel("Title", { exact: true }).fill("Evidence Set study");
    await page.getByRole("button", { name: "Add paper" }).click();
    await expect(page.getByText("Evidence Set study", { exact: true }).first()).toBeVisible();
    await page.getByLabel("Paper").selectOption({ label: "Evidence Set study" });
    await page.getByLabel("Verbatim source passage").fill("An exact passage retained in the set");
    await page.getByLabel("Page number").fill("6");
    await page.getByRole("button", { name: "Record evidence" }).click();
    await expect(page.getByRole("status")).toHaveText("Evidence recorded with source provenance.");

    await page.goto(`/projects/${projectId}/evidence-sets`);
    await page.getByLabel("Name").fill("Primary outcomes");
    await page.getByLabel("Purpose or theme").fill("Compare exact passages");
    await page.getByRole("button", { name: "Create Evidence Set" }).click();
    await expect(page).toHaveURL(/\/evidence-sets\/[0-9a-f-]+\?saved=created$/);
    const setId = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByText("Evidence Set created.", { exact: true })).toBeVisible();
    await expect(page.getByText("This set is empty. Add Evidence below.", { exact: true })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Primary outcomes (renamed)");
    await page.getByLabel("Purpose or theme", { exact: true }).fill("Compare exact passages across Papers");
    await page.getByRole("button", { name: "Save metadata" }).click();
    await expect(page.getByRole("status")).toHaveText("Evidence Set metadata saved.");

    await page.goto(`/projects/${projectId}/evidence`);
    await page.getByRole("link", { name: "Open Evidence detail →" }).click();
    await expect(page).toHaveURL(/\/evidence\/[0-9a-f-]+$/);
    await page.locator("#evidence-set").selectOption(setId);
    await page.getByRole("button", { name: "Add to set" }).click();
    await expect(page.getByRole("status")).toHaveText("Evidence Set membership saved.");
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/evidence-sets/${setId}\\?saved=member$`));

    await page.goto(`/projects/${projectId}/evidence-sets/${setId}`);
    await expect(page.getByRole("article").getByText(/An exact passage retained in the set/)).toBeVisible();
    await page.getByLabel("Append note").fill("  Compare this passage with the next study  ");
    await page.getByRole("button", { name: "Append set note" }).click();
    await expect(page.getByRole("status")).toHaveText("Evidence Set annotation saved.");
    await expect(page.getByText("Compare this passage with the next study", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Archive and freeze set" }).click();
    await expect(page.getByRole("status")).toHaveText("Evidence Set archived and frozen.");
    await expect(page.getByText("This set is frozen. Its composition and annotations remain readable, but no changes are allowed.", { exact: true })).toBeVisible();
    await expect(page.getByText("created · sequence 1 · 0 active", { exact: true })).toBeVisible();
    await expect(page.getByText("added · sequence 2 · 1 active", { exact: true })).toBeVisible();
  });
});
