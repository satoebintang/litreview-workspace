import { test, expect } from "@playwright/test";

test.describe("Slice 12 full-text eligibility screening", () => {
  test("keeps title/abstract and full-text stages separate and derives final inclusion", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Full-text review ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    for (const title of ["Eligible study", "Excluded study"]) {
      await page.getByLabel("Title", { exact: true }).fill(title);
      await page.getByLabel("Abstract").fill(`${title} abstract`);
      await page.getByRole("button", { name: "Add paper" }).click();
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
    }

    await page.goto(`/projects/${projectId}/screening`);
    await page.getByRole("link", { name: "Start screening" }).click();
    await page.getByRole("button", { name: "Include", exact: true }).click();
    const firstPaperId = new URL(page.url()).pathname.split("/").pop()!;
    const next = await page.getByRole("link", { name: "Next →" }).getAttribute("href");
    await page.goto(next!);
    await page.getByRole("button", { name: "Include", exact: true }).click();
    const secondPaperId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto(`/projects/${projectId}/screening/full-text`);
    await page.getByLabel("Criterion").fill("Wrong population at full text");
    await page.getByRole("button", { name: "Add full-text criterion" }).click();
    await expect(page.getByText("Wrong population at full text", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".screening-stat", { hasText: "awaiting" }).getByText("2")).toBeVisible();

    await page.goto(`/projects/${projectId}/screening/full-text/retrieval/${firstPaperId}`);
    await page.getByRole("button", { name: "Record attempt" }).click();
    await expect(page.getByText("Retrieval attempt recorded.")).toBeVisible();
    await page.goto(`/projects/${projectId}/screening/full-text/${firstPaperId}`);
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.getByText("Full-text decision recorded in screening history.")).toBeVisible();
    await page.goto(`/projects/${projectId}/screening/full-text/retrieval/${secondPaperId}`);
    await page.getByRole("button", { name: "Record attempt" }).click();
    await expect(page.getByText("Retrieval attempt recorded.")).toBeVisible();
    await page.goto(`/projects/${projectId}/screening/full-text/${secondPaperId}`);
    await page.getByLabel("Exclusion reason").selectOption({ label: "Wrong population at full text" });
    await page.getByRole("button", { name: "Confirm exclusion" }).click();
    await expect(page.getByText("Full-text decision recorded in screening history.")).toBeVisible();

    await page.goto(`/projects/${projectId}/review-flow`);
    await expect(page.locator(".screening-stat", { hasText: "Full-text eligible" }).getByText("2")).toBeVisible();
    await expect(page.locator(".screening-stat", { hasText: "Finally included" }).getByText("1")).toBeVisible();
    await page.goto(`/projects/${projectId}/review-report`);
    await expect(page.getByRole("heading", { name: "Title/Abstract Screening" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Full-text Eligibility" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Final eligibility" })).toBeVisible();
    const fullTextEligibilitySection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Full-text Eligibility" }) });
    await expect(fullTextEligibilitySection.getByText("Wrong population at full text", { exact: true })).toBeVisible();
  });
});
