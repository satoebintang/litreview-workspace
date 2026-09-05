import { test, expect } from "@playwright/test";

test.describe("Slice 3 structured extraction", () => {
  test("configures a field, records revision-specific provenance, and derives progress", async ({ page }) => {
    const unique = Date.now();
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Extraction review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = page.url().match(/projects\/([0-9a-f-]+)$/)?.[1] as string;

    await page.getByLabel("Title", { exact: true }).fill("Poisoning Attacks in Vision Models");
    await page.getByLabel("Authors").fill("Ada Researcher");
    await page.getByLabel("Abstract").fill("A study of data poisoning attacks.");
    await page.getByRole("button", { name: "Add paper" }).click();

    await page.getByLabel("Paper").selectOption({ label: "Poisoning Attacks in Vision Models" });
    await page.getByLabel("Verbatim source passage").fill("We introduce poisoned samples into five percent of the training data.");
    await page.getByLabel("Page number").fill("7");
    await page.getByRole("button", { name: "Record evidence" }).click();

    await page.getByRole("link", { name: /Open screening dashboard/ }).click();
    await page.getByRole("link", { name: "Start screening" }).click();
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.locator(".status.screening-included")).toBeVisible();

    await page.goto(`/projects/${projectId}/extraction`);
    await page.getByLabel("Field name").fill("Attack technique");
    await page.getByLabel("Field type").selectOption("single_select");
    await page.getByRole("checkbox", { name: /Required field/ }).check();
    await page.getByRole("button", { name: "Add extraction field" }).click();
    await page.getByLabel("New option for Attack technique").fill("Data poisoning");
    await page.getByRole("button", { name: "Add option" }).click();
    await expect(page.getByText("Extraction option saved.")).toBeVisible();
    await page.getByLabel("New option for Attack technique").fill("Evasion");
    await page.getByRole("button", { name: "Add option" }).click();
    await expect(page.getByText("Extraction option saved.")).toBeVisible();

    await page.getByRole("link", { name: /Poisoning Attacks in Vision Models/ }).click();
    const field = page.locator(".extraction-value").filter({ hasText: "Attack technique" });
    await field.getByLabel("Structured value").selectOption({ label: "Data poisoning" });
    await field.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByText("Extraction revision saved.")).toBeVisible();
    await expect(field.getByText("○ Not yet grounded")).toBeVisible();

    await field.getByLabel(/Page 7/).check();
    await field.getByRole("button", { name: "Save new revision" }).click();
    await expect(field.getByText("● Grounded")).toBeVisible();

    await field.getByLabel("Structured value").selectOption({ label: "Evasion" });
    await field.getByRole("button", { name: "Save new revision" }).click();
    await expect(field.getByText("Evasion", { exact: true }).last()).toBeVisible();
    await field.getByText("Revision history (3)", { exact: true }).click();
    await expect(field.getByText("Revision 1", { exact: true })).toBeVisible();
    await expect(field.getByText("Revision 2", { exact: true })).toBeVisible();
    await expect(field.getByText("Revision 3", { exact: true })).toBeVisible();
    await expect(page.getByText("1 / 1 required · 100%", { exact: true })).toBeVisible();
  });
});
