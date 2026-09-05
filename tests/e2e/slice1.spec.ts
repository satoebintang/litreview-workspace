import { test, expect } from "@playwright/test";

test.describe("Slice 1 provenance workflow", () => {
  test("creates a project, captures evidence, and audits a claim", async ({ page }) => {
    const unique = Date.now();
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Sleep review ${unique}`);
    await page.getByLabel("Research question").fill("How does sleep affect academic performance?");
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { name: `Sleep review ${unique}` })).toBeVisible();

    await page.getByLabel("Title", { exact: true }).fill("Sleep duration and grades");
    await page.getByLabel("Authors").fill("Ada Researcher, Ben Scholar");
    await page.getByLabel("Publication year").fill("2024");
    await page.getByRole("button", { name: "Add paper" }).click();
    await expect(page.locator(".item-title").filter({ hasText: "Sleep duration and grades" })).toBeVisible();

    await page.getByLabel("Paper").selectOption({ label: "Sleep duration and grades" });
    await page.getByLabel("Verbatim source passage").fill("Students who sleep longer show improved academic performance.");
    await page.getByLabel("Page number").fill("12");
    await page.getByRole("button", { name: "Record evidence" }).click();
    await expect(page.getByText("Evidence recorded with source provenance.")).toBeVisible();

    await page.getByLabel("New claim").fill("Longer sleep is associated with improved academic performance.");
    await page.getByRole("button", { name: "Create claim" }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/claims\/[0-9a-f-]+$/);
    await expect(page.getByText("unsupported", { exact: true })).toBeVisible();
    await expect(page.getByText("This claim has no supporting evidence yet.")).toBeVisible();

    const evidenceOption = page.locator("#link-evidence option").nth(1);
    await page.getByLabel("Evidence passage").selectOption(await evidenceOption.getAttribute("value") as string);
    await page.getByRole("button", { name: "Link evidence" }).click();
    await expect(page.getByText("supported", { exact: true })).toBeVisible();
    await expect(page.getByText("Students who sleep longer show improved academic performance.").first()).toBeVisible();
    await expect(page.getByText("Page 12", { exact: true })).toBeVisible();
    await expect(page.getByText("Sleep duration and grades", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Unlink" }).click();
    await expect(page.getByText("unsupported", { exact: true })).toBeVisible();
    await expect(page.getByText("This claim has no supporting evidence yet.")).toBeVisible();
  });

  test("preserves exact source text submitted through the browser workflow", async ({ page }) => {
    const unique = Date.now();
    const sourceText = "  Students who sleep longer show improved academic performance.  ";

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Whitespace review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);

    await page.getByLabel("Title", { exact: true }).fill("Sleep duration and grades");
    await page.getByRole("button", { name: "Add paper" }).click();
    await expect(page.locator(".item-title").filter({ hasText: "Sleep duration and grades" })).toBeVisible();

    await page.getByLabel("Paper").selectOption({ label: "Sleep duration and grades" });
    await page.getByLabel("Verbatim source passage").fill(sourceText);
    await page.getByLabel("Page number").fill("12");
    await page.getByRole("button", { name: "Record evidence" }).click();
    await expect(page.getByText("Evidence recorded with source provenance.")).toBeVisible();

    expect(await page.locator(".quote").first().textContent()).toBe(`“${sourceText}”`);
  });
});
