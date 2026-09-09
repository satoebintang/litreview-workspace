import { test, expect } from "@playwright/test";

test.describe("Slice 10 deduplication and review flow", () => {
  test("adjudicates same and different work pairs and updates derived flow", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Dedup review ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;
    await page.goto(`/projects/${projectId}/protocol`);

    await page.getByLabel("Strategy name").fill("Dedup search");
    await page.getByLabel("Exact query").fill("intervention AND outcome");
    await page.getByRole("button", { name: "Save strategy" }).click();
    await page.getByLabel("Reported result count").fill("10");
    await page.getByRole("button", { name: "Record immutable run" }).click();
    await page.getByLabel("Reported result count").fill("12");
    await page.getByRole("button", { name: "Record immutable run" }).click();

    const runOptions = page.getByLabel("Search run").locator("option");
    const runOne = await runOptions.filter({ hasText: "Run 1" }).getAttribute("value");
    const runTwo = await runOptions.filter({ hasText: "Run 2" }).getAttribute("value");
    const recordSource = page.locator("#record-source");
    const sourceId = await recordSource.locator("option").first().getAttribute("value");
    expect(runOne).toBeTruthy();
    expect(runTwo).toBeTruthy();
    expect(sourceId).toBeTruthy();

    await page.getByLabel("Search run").selectOption(runOne!);
    await recordSource.selectOption(sourceId!);
    await page.getByLabel("Source record ID").fill("A");
    await page.getByLabel("Title", { exact: true }).fill("Intervention outcomes");
    await page.getByLabel("DOI").fill("10.1000/shared-work");
    await page.getByRole("button", { name: "Add retrieved record" }).click();
    await expect(page.getByText(/Protocol updated/)).toBeVisible();
    await expect(page.getByLabel("Source record ID optional")).toHaveValue("");
    await page.getByLabel("Search run").selectOption(runTwo!);
    await recordSource.selectOption(sourceId!);
    await page.getByLabel("Source record ID").fill("B");
    await page.getByLabel("Title", { exact: true }).fill("Intervention outcomes (database copy)");
    await page.getByLabel("DOI").fill("https://doi.org/10.1000/shared-work");
    await page.getByRole("button", { name: "Add retrieved record" }).click();
    await expect(page.getByText(/Protocol updated/)).toBeVisible();
    await expect(page.getByLabel("Source record ID optional")).toHaveValue("");

    await page.goto(`/projects/${projectId}/deduplication`);
    await expect(page.getByText("Intervention outcomes", { exact: true })).toBeVisible();
    await expect(page.getByText("DOI", { exact: true }).first()).toBeVisible();
    const pairHref = await page.getByRole("link", { name: "Inspect pair →" }).first().getAttribute("href");
    expect(pairHref).toBeTruthy();
    await page.goto(pairHref!);
    await expect(page.getByRole("heading", { name: "Candidate evidence" })).toBeVisible();
    await page.getByRole("button", { name: "Create from Record A" }).click();
    await expect(page.getByText("Deduplication decision recorded.")).toBeVisible();
    await page.goto(`/projects/${projectId}/deduplication`);
    await expect(page.getByText("No unresolved duplicate candidates.")).toBeVisible();
    await page.goto(`/projects/${projectId}/review-flow`);
    await expect(page.locator(".screening-stat", { hasText: "Resolved records" }).getByText("2")).toBeVisible();

    await page.goto(`/projects/${projectId}/protocol`);
    await page.getByLabel("Search run").selectOption(runOne!);
    await recordSource.selectOption(sourceId!);
    await page.getByLabel("Source record ID").fill("C");
    await page.getByLabel("Title", { exact: true }).fill("Unrelated study");
    await page.getByLabel("Publication year").fill("2022");
    await page.getByRole("button", { name: "Add retrieved record" }).click();
    await expect(page.getByText(/Protocol updated/)).toBeVisible();
    await expect(page.getByLabel("Source record ID optional")).toHaveValue("");
    await page.getByLabel("Search run").selectOption(runTwo!);
    await recordSource.selectOption(sourceId!);
    await page.getByLabel("Source record ID").fill("D");
    await page.getByLabel("Title", { exact: true }).fill("Unrelated study");
    await page.getByLabel("Publication year").fill("2022");
    await page.getByRole("button", { name: "Add retrieved record" }).click();
    await expect(page.getByText(/Protocol updated/)).toBeVisible();
    await expect(page.getByLabel("Source record ID optional")).toHaveValue("");

    await page.goto(`/projects/${projectId}/deduplication`);
    const unrelated = page.locator("article.item", { hasText: "Unrelated study" }).first();
    await unrelated.getByRole("button", { name: "Different work" }).click();
    await expect(page).toHaveURL(/\/deduplication\//);
    await expect(page.getByText("Deduplication decision recorded.")).toBeVisible();
    await page.goto(`/projects/${projectId}/deduplication`);
    await expect(page.getByText("No unresolved duplicate candidates.")).toBeVisible();

    await page.goto(`/projects/${projectId}/screening`);
    await page.getByRole("link", { name: "Start screening" }).click();
    await page.locator('form:has(input[name="decision"][value="include"]) button[type="submit"]').click();
    await expect(page.getByText("Decision recorded in screening history.")).toBeVisible();
    await page.goto(`/projects/${projectId}/review-flow`);
    await expect(page.locator(".screening-stat", { hasText: "Included" }).getByText("1")).toBeVisible();
    await page.goto(`/projects/${projectId}/review-report`);
    await expect(page.getByRole("heading", { name: "Review Flow Report" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Search Identification" })).toBeVisible();
    await expect(page.getByText("Results reported by recorded searches", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Full-text Eligibility" })).toBeVisible();
    await page.getByText("Results reported by recorded searches", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Contributors" })).toBeVisible();
    await expect(page.getByText("searchRun", { exact: true }).first()).toBeVisible();
    await page.goto(`/projects/${projectId}/review-report`);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download Markdown" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("review-flow-report.md");
    const exportPath = await download.path();
    expect(exportPath).toBeTruthy();
  });
});
