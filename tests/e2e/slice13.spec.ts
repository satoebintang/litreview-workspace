import { test, expect } from "@playwright/test";

test.describe("Slice 13 full-text retrieval workflow", () => {
  test("keeps current retrieval state distinct from historical retrieval success", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Retrieval review ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    await page.getByLabel("Title", { exact: true }).fill("Retrieval study");
    await page.getByLabel("Abstract").fill("Retrieval study abstract");
    await page.getByRole("button", { name: "Add paper" }).click();
    await expect(page.getByText("Retrieval study", { exact: true }).first()).toBeVisible();

    await page.goto(`/projects/${projectId}/screening`);
    await page.getByRole("link", { name: "Start screening" }).click();
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.getByText("Decision recorded in screening history.")).toBeVisible();
    const paperId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto(`/projects/${projectId}/screening/full-text/retrieval`);
    await expect(page.locator(".screening-stat", { hasText: "not sought" }).getByText("1")).toBeVisible();
    await page.getByRole("link", { name: /Retrieval study/ }).click();
    await page.getByLabel("Outcome").selectOption("unavailable");
    await page.getByRole("button", { name: "Record attempt" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Retrieval attempt recorded" })).toBeVisible();
    await expect(page.getByText("Current state").locator("..").getByText("unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("Ever retrieved").locator("..").getByText("no", { exact: true })).toBeVisible();

    await page.getByLabel("Outcome").selectOption("retrieved");
    await page.getByRole("button", { name: "Record attempt" }).click();
    await expect(page.getByText("Current state").locator("..").getByText("retrieved", { exact: true })).toBeVisible();
    await expect(page.getByText("Ever retrieved").locator("..").getByText("yes", { exact: true })).toBeVisible();

    await page.getByLabel("Outcome").selectOption("unavailable");
    await page.getByRole("button", { name: "Record attempt" }).click();
    await expect(page.getByText("Current state").locator("..").getByText("unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("Ever retrieved").locator("..").getByText("yes", { exact: true })).toBeVisible();

    await page.goto(`/projects/${projectId}/screening/full-text/${paperId}`);
    await expect(page.getByText(/current retrieved retrieval attempt/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Include", exact: true })).toBeDisabled();

    await page.goto(`/projects/${projectId}/screening/full-text/retrieval/${paperId}`);
    await page.getByLabel("Outcome").selectOption("retrieved");
    await page.getByRole("button", { name: "Record attempt" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Retrieval attempt recorded" })).toBeVisible();
    await page.goto(`/projects/${projectId}/screening/full-text/${paperId}`);
    await expect(page.getByRole("button", { name: "Include", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Full-text decision recorded" })).toBeVisible();

    await page.goto(`/projects/${projectId}/review-flow`);
    await expect(page.locator(".screening-stat", { hasText: "Retrieval eligible" }).getByText("1")).toBeVisible();
    await expect(page.locator(".screening-stat", { has: page.getByText("Retrieved", { exact: true }) }).getByText("1", { exact: true })).toBeVisible();
    await expect(page.locator(".screening-stat", { hasText: "Ever retrieved" }).getByText("1")).toBeVisible();
    await expect(page.locator(".screening-stat", { hasText: "Finally included" }).getByText("1")).toBeVisible();

    await page.goto(`/projects/${projectId}/review-report`);
    await expect(page.getByRole("heading", { name: "Full-text Retrieval" })).toBeVisible();
    await expect(page.getByText("Papers ever retrieved successfully", { exact: true })).toBeVisible();
  });
});
