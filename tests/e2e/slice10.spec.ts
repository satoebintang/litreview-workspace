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

    const runHref = async (sequence: number) => {
      const href = await page.getByRole("link", { name: new RegExp(`Run ${sequence} ·`) }).getAttribute("href");
      expect(href).toBeTruthy();
      return href!;
    };
    const runOne = await runHref(1);
    const runTwo = await runHref(2);
    const addRecord = async (href: string, input: { sourceId: string; title: string; doi?: string; year?: string }) => {
      await page.goto(href);
      await page.getByLabel("Source record ID optional").fill(input.sourceId);
      await page.getByLabel("Title", { exact: true }).fill(input.title);
      if (input.doi) await page.getByLabel("DOI").fill(input.doi);
      if (input.year) await page.getByLabel("Publication year").fill(input.year);
      await page.getByRole("button", { name: "Add retrieved record" }).click();
      await expect(page).toHaveURL(/\/records\/[0-9a-f-]+\?saved=record/);
      await expect(page.getByText("RetrievedRecord added.", { exact: true })).toBeVisible();
    };

    await addRecord(runOne, { sourceId: "A", title: "Intervention outcomes", doi: "10.1000/shared-work" });
    await addRecord(runTwo, { sourceId: "B", title: "Intervention outcomes (database copy)", doi: "https://doi.org/10.1000/shared-work" });

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

    await addRecord(runOne, { sourceId: "C", title: "Unrelated study", year: "2022" });
    await addRecord(runTwo, { sourceId: "D", title: "Unrelated study", year: "2022" });

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
