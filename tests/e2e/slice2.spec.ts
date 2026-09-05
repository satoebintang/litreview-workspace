import { test, expect } from "@playwright/test";

test.describe("Slice 2 screening workflow", () => {
  test("collects a paper, records revisions, and preserves screening history", async ({ page }) => {
    const unique = Date.now();
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Screening review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectUrl = page.url();
    const projectId = projectUrl.match(/projects\/([0-9a-f-]+)$/)?.[1] as string;

    await page.getByLabel("Title", { exact: true }).fill("Adversarial Machine Learning in IoT");
    await page.getByLabel("Authors").fill("Ada Researcher");
    await page.getByLabel("Publication year").fill("2024");
    await page.getByLabel("Abstract").fill("This abstract studies security attacks against machine learning systems.");
    await page.getByRole("button", { name: "Add paper" }).click();
    await expect(page.getByText("Adversarial Machine Learning in IoT", { exact: true }).first()).toBeVisible();

    await page.getByRole("link", { name: /Open screening dashboard/ }).click();
    await page.getByLabel("Type").selectOption("inclusion");
    await page.getByLabel("Criterion").fill("Studies security attacks against ML systems");
    await page.getByRole("button", { name: "Add criterion" }).click();
    await page.getByLabel("Type").selectOption("exclusion");
    await page.getByLabel("Criterion").fill("Wrong population");
    await page.getByRole("button", { name: "Add criterion" }).click();

    await page.getByRole("link", { name: "Start screening" }).click();
    await expect(page.getByRole("heading", { name: "Adversarial Machine Learning in IoT" })).toBeVisible();
    await page.getByLabel("Maybe note").fill("Need to inspect methodology.");
    await page.getByRole("button", { name: "Maybe / uncertain" }).click();
    await expect(page.getByText("Decision recorded in screening history.")).toBeVisible();
    await expect(page.getByText("MAYBE", { exact: true })).toBeVisible();

    await page.getByLabel("Exclusion reason").selectOption({ label: "Wrong population" });
    await page.getByLabel("Exclusion note").fill("Population mismatch");
    await page.getByRole("button", { name: "Confirm exclusion" }).click();
    await expect(page.getByText("EXCLUDE", { exact: true })).toBeVisible();
    await expect(page.getByText("Reason: Wrong population", { exact: true })).toBeVisible();

    await page.getByLabel("Include note").fill("Abstract confirms relevance.");
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.locator(".status.screening-included")).toBeVisible();
    await expect(page.getByText("MAYBE", { exact: true })).toBeVisible();
    await expect(page.getByText("EXCLUDE", { exact: true })).toBeVisible();
    await expect(page.getByText("INCLUDE", { exact: true })).toBeVisible();
    await expect(page.getByText("3 decisions", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/screening/`));
  });
});
