import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { resolvePlaywrightTestDatabaseUrl } from "./playwright-database";
import { selectPaper } from "./paper-picker";

async function seedProtocolRun(recordTitles: string[], includeSharedDoi = false) {
  const database = createDb(resolvePlaywrightTestDatabaseUrl());
  const services = createReviewServices(database.db);
  const suffix = randomUUID();
  try {
    const project = await services.createProject({ title: `Slice 43 selector ${suffix}` });
    const firstPaper = await services.addPaper(project.id, { title: `Selector Paper A ${suffix}`, authors: ["First Author"], publicationYear: 2020 });
    const secondPaper = await services.addPaper(project.id, { title: `Selector Paper B ${suffix}`, authors: ["Second Author"], publicationYear: 2021 });
    const [source] = await services.listSearchSources(project.id);
    if (!source) throw new Error("Seed Project has no active search source");
    const strategy = await services.createSearchStrategy(project.id, {
      searchSourceId: source.id,
      name: `Selector strategy ${suffix}`,
      queryText: `selector fixture ${suffix}`,
    });
    const run = await services.createSearchRun(project.id, {
      searchSourceId: source.id,
      sourceKeySnapshot: source.sourceKey,
      sourceDisplayNameSnapshot: source.displayName,
      strategyId: strategy.id,
      queryText: strategy.queryText,
      filtersTextSnapshot: strategy.filtersText,
      reportedResultCount: recordTitles.length,
      executedAt: new Date(),
    });
    const records = [];
    for (const [index, title] of recordTitles.entries()) {
      records.push(await services.createRetrievedRecord(project.id, {
        searchRunId: run.id,
        searchSourceId: source.id,
        sourceRecordId: `selector-${index}-${suffix}`,
        title,
        authors: ["Retrieved Author"],
        doi: includeSharedDoi ? "10.1000/slice43-shared" : undefined,
        retrievedAt: new Date(),
      }));
    }
    return { projectId: project.id, runId: run.id, records, firstPaper, secondPaper };
  } finally {
    await database.client.end();
  }
}

test.describe("Slice 43 canonical Paper selection", () => {
  test("links and relinks protocol records with exact titles and a Project-wide exclusion", async ({ page }) => {
    const recordTitle = `Protocol selector record ${randomUUID()}`;
    const fixture = await seedProtocolRun([recordTitle]);
    await page.goto(`/projects/${fixture.projectId}/protocol/runs/${fixture.runId}`);

    const retrievedRecords = page.locator("section.card.section-card").filter({ hasText: "Retrieved records" });
    const record = retrievedRecords.locator("article.item").filter({ hasText: recordTitle }).first();
    const linkForm = record.locator("form").nth(1);
    await selectPaper(fixture.firstPaper.title, linkForm);
    await linkForm.getByRole("button", { name: "Link existing Paper" }).click();
    await expect(page).toHaveURL(new RegExp(`/protocol/runs/${fixture.runId}\\?saved=linked$`));
    await expect(record.getByText(`Current Paper: ${fixture.firstPaper.title}`)).toBeVisible();

    const relinkForm = record.locator("form").nth(1);
    const relinkButton = relinkForm.getByRole("button", { name: "Relink", exact: true });
    await expect(relinkButton).toBeDisabled();
    const relinkPicker = relinkForm.locator(".paper-picker");
    await relinkPicker.getByRole("searchbox").fill(fixture.firstPaper.title);
    await relinkPicker.getByRole("button", { name: "Browse Papers" }).click();
    await expect(relinkPicker.locator(".claim-support-result-row")).toHaveCount(0);
    await expect(relinkPicker.getByText("No Papers match this title search.")).toBeVisible();

    await selectPaper(fixture.secondPaper.title, relinkForm);
    await expect(relinkButton).toBeEnabled();
    await relinkButton.click();
    await expect(page).toHaveURL(new RegExp(`/protocol/runs/${fixture.runId}\\?saved=relinked$`));
    await expect(record.getByText(`Current Paper: ${fixture.secondPaper.title}`)).toBeVisible();

    const history = page.locator("section.card.section-card").filter({ hasText: "Match history" });
    const historyRecord = history.locator("article.item").filter({ hasText: recordTitle });
    await expect(historyRecord).toContainText(`linked → ${fixture.firstPaper.title}`);
    await expect(historyRecord).toContainText(`unlinked → ${fixture.firstPaper.title}`);
    await expect(historyRecord).toContainText(`linked → ${fixture.secondPaper.title}`);
  });

  test("keeps 50 record pickers unloaded until explicit keyboard search and gives each input a unique ID", async ({ page }) => {
    const suffix = randomUUID();
    const titles = Array.from({ length: 50 }, (_, index) => `Multi selector record ${index + 1} ${suffix}`);
    const fixture = await seedProtocolRun(titles);
    const postRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") postRequests.push(request.url());
    });
    await page.goto(`/projects/${fixture.projectId}/protocol/runs/${fixture.runId}`);

    const pickers = page.locator(".paper-picker");
    const searchboxes = pickers.getByRole("searchbox");
    await expect(pickers).toHaveCount(50);
    await expect(page.locator(".evidence-paper-results")).toHaveCount(0);
    const ids = await searchboxes.evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement).id));
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);

    await searchboxes.first().focus();
    await searchboxes.nth(25).focus();
    await searchboxes.last().focus();
    await page.waitForTimeout(100);
    expect(postRequests).toHaveLength(0);
    await expect(page.locator(".evidence-paper-results")).toHaveCount(0);

    const firstPicker = pickers.first();
    const firstSearch = firstPicker.getByRole("searchbox");
    await firstSearch.fill(fixture.firstPaper.title);
    await firstSearch.press("Enter");
    const firstResult = firstPicker.locator(".claim-support-result-row").filter({ hasText: fixture.firstPaper.title });
    await expect(firstResult).toBeVisible();
    await expect(firstPicker.getByRole("status")).toContainText("showing 1–1 of 1 Papers");
    const selectButton = firstResult.getByRole("button", { name: "Select", exact: true });
    await selectButton.focus();
    await selectButton.press("Enter");
    await expect(firstPicker.locator('input[type="hidden"][name="paperId"]')).toHaveValue(fixture.firstPaper.id);
    await expect(firstPicker.locator(".evidence-paper-selection")).toContainText(`Selected Paper: ${fixture.firstPaper.title}`);

    await firstSearch.fill("x".repeat(201));
    await firstSearch.press("Enter");
    await expect(firstPicker.getByRole("alert")).toContainText("cannot exceed 200 Unicode code points");
  });

  test("uses the picker for same-work resolution and keeps empty selection required", async ({ page }) => {
    const suffix = randomUUID();
    const fixture = await seedProtocolRun([`Retrieved copy A ${suffix}`, `Retrieved copy B ${suffix}`], true);
    const [left, right] = fixture.records;
    await page.goto(`/projects/${fixture.projectId}/deduplication/${left.id}/${right.id}`);

    const resolveForm = page.locator("form").filter({ hasText: "Same work and link to Paper" });
    await resolveForm.getByRole("button", { name: "Same work and link to Paper" }).click();
    await expect(resolveForm.getByRole("alert")).toContainText("Select a Paper for same-work canonical paper");
    await selectPaper(fixture.firstPaper.title, resolveForm);
    await resolveForm.getByRole("button", { name: "Same work and link to Paper" }).click();
    await expect(page).toHaveURL(/\?saved=same_work_resolved$/);
    await expect(page.getByText("Both records already resolve to the same Paper.")).toBeVisible();
  });
});
