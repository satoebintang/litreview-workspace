import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { resolvePlaywrightTestDatabaseUrl } from "./playwright-database";

async function seedRun(options: { count?: number; suffix?: string } = {}) {
  const database = createDb(resolvePlaywrightTestDatabaseUrl());
  const services = createReviewServices(database.db);
  const suffix = options.suffix ?? randomUUID();
  try {
    const project = await services.createProject({ title: `Slice 46 acquisition ${suffix}` });
    const source = (await services.listSearchSources(project.id))[0]!;
    const strategy = await services.createSearchStrategy(project.id, { searchSourceId: source.id, name: `Strategy ${suffix}`, queryText: `exact acquisition query ${suffix}`, filtersText: "2018–2026" });
    const run = await services.createSearchRun(project.id, { searchSourceId: source.id, sourceKeySnapshot: source.sourceKey, sourceDisplayNameSnapshot: source.displayName, strategyId: strategy.id, queryText: strategy.queryText, filtersTextSnapshot: strategy.filtersText, reportedResultCount: options.count ?? 0, executedAt: new Date("2026-02-03T04:05:06Z"), notes: `run notes ${suffix}` });
    const records = [] as Array<{ id: string; title: string; sourceRecordId: string }>;
    for (let index = 0; index < (options.count ?? 0); index += 1) {
      const title = `Retrieved ${index + 1} ${suffix}`;
      const sourceRecordId = `source-${index + 1}-${suffix}`;
      const record = await services.createRetrievedRecord(project.id, { searchRunId: run.id, searchSourceId: source.id, sourceRecordId, title, authors: ["Ada Author", "Ben Author", "Cy Author", "Dee Author"], publicationYear: 2024, venue: "Journal of Search", abstract: `Abstract ${suffix}`, doi: `10.7000/${index + 1}-${suffix}`, url: `https://example.org/${index + 1}`, rawCitation: `Raw citation ${suffix}`, retrievedAt: new Date("2026-02-03T04:05:06Z") });
      records.push({ id: record.id, title, sourceRecordId });
    }
    const paper = await services.addPaper(project.id, { title: `Canonical paper ${suffix}`, authors: ["Canonical Author"], publicationYear: 2024 });
    return { projectId: project.id, sourceId: source.id, strategyId: strategy.id, runId: run.id, records, paperId: paper.id, paperTitle: paper.title, sourceDisplayName: source.displayName, sourceKey: source.sourceKey, queryText: strategy.queryText, suffix };
  } finally { await database.client.end(); }
}

async function createExtraRuns(projectId: string, count: number, suffix: string) {
  const database = createDb(resolvePlaywrightTestDatabaseUrl());
  const services = createReviewServices(database.db);
  try {
    const source = (await services.listSearchSources(projectId))[0]!;
    const strategy = (await services.listSearchStrategies(projectId))[0]!;
    for (let index = 0; index < count; index += 1) {
      await services.createSearchRun(projectId, { searchSourceId: source.id, sourceKeySnapshot: source.sourceKey, sourceDisplayNameSnapshot: source.displayName, strategyId: strategy.id, queryText: strategy.queryText, filtersTextSnapshot: strategy.filtersText, reportedResultCount: index, executedAt: new Date("2026-02-03T04:05:06Z"), notes: `extra ${suffix} ${index}` });
    }
  } finally { await database.client.end(); }
}

test.describe("Slice 46 scalable acquisition review", () => {
  test("pages 51 SearchRuns and keeps the original source/query snapshot after configuration changes", async ({ page }) => {
    const fixture = await seedRun();
    await createExtraRuns(fixture.projectId, 50, fixture.suffix);
    const database = createDb(resolvePlaywrightTestDatabaseUrl());
    const services = createReviewServices(database.db);
    try {
      await services.updateSearchSource(fixture.projectId, fixture.sourceId, { displayName: `Renamed ${fixture.suffix}` });
      await services.updateSearchStrategy(fixture.projectId, fixture.strategyId, { queryText: `changed ${fixture.suffix}` });
    } finally { await database.client.end(); }

    await page.goto(`/projects/${fixture.projectId}/protocol`);
    const ledger = page.locator("section.card.section-card").filter({ hasText: "SearchRun ledger" });
    await expect(ledger.locator("a.item")).toHaveCount(50);
    await ledger.getByRole("link", { name: "Next 50 SearchRuns" }).click();
    await expect(ledger.locator("a.item")).toHaveCount(1);
    await ledger.locator("a.item").click();
    await expect(page.getByRole("heading", { name: new RegExp(fixture.sourceDisplayName) })).toBeVisible();
    await expect(page.getByText(fixture.queryText, { exact: true })).toBeVisible();
    await expect(page.getByText(`changed ${fixture.suffix}`, { exact: true })).toHaveCount(0);
  });

  test("pages 51 RetrievedRecords, searches an exact source ID, and opens full detail", async ({ page }) => {
    const fixture = await seedRun({ count: 51 });
    await page.goto(`/projects/${fixture.projectId}/protocol/runs/${fixture.runId}`);
    const ledger = page.locator("section.card.section-card").filter({ hasText: "RetrievedRecords" });
    await expect(ledger.locator("a.item")).toHaveCount(50);
    await ledger.getByRole("link", { name: "Next RetrievedRecords page" }).click();
    await expect(ledger.locator("a.item")).toHaveCount(1);
    const expectedLastRecord = [...fixture.records].sort((left, right) => right.id.localeCompare(left.id))[50]!;
    await expect(ledger.locator("a.item")).toContainText(expectedLastRecord.title);

    await page.goto(`/projects/${fixture.projectId}/protocol/runs/${fixture.runId}`);
    const search = page.locator("form").filter({ has: page.getByRole("button", { name: "Search records" }) });
    await search.getByLabel("Search field").selectOption("sourceRecordId");
    await search.getByLabel("Exact search").fill(fixture.records[0]!.sourceRecordId);
    await search.getByRole("button", { name: "Search records" }).click();
    await expect(ledger.locator("a.item")).toHaveCount(1);
    await ledger.locator("a.item").click();
    await expect(page.getByRole("heading", { name: fixture.records[0]!.title })).toBeVisible();
    await expect(page.getByText("Raw citation", { exact: true })).toBeVisible();
    await expect(page.getByText("https://example.org/1", { exact: true })).toBeVisible();
  });

  test("creates a RetrievedRecord from its exact run, creates its Paper, and preserves the complete export", async ({ page }) => {
    const fixture = await seedRun();
    await page.goto(`/projects/${fixture.projectId}/protocol/runs/${fixture.runId}`);
    await expect(page.locator("select[name='searchSourceId']")).toHaveCount(0);
    await page.getByLabel("Source record ID").fill(`manual-${fixture.suffix}`);
    await page.getByLabel("Title", { exact: true }).fill(`Manual retrieved ${fixture.suffix}`);
    await page.getByLabel("Authors").fill("Manual Author, Second Author");
    await page.getByRole("button", { name: "Add retrieved record" }).click();
    await expect(page).toHaveURL(new RegExp(`/protocol/runs/${fixture.runId}/records/[0-9a-f-]+\\?saved=record$`));
    await expect(page.locator("section.card.section-card").filter({ hasText: "Run and source provenance" })).toContainText(fixture.sourceDisplayName);
    await page.getByRole("button", { name: "Create Paper from record" }).click();
    await expect(page).toHaveURL(/\?saved=paper&paperId=/);
    await expect(page.locator("section.card.section-card").filter({ hasText: "Current Paper match" })).toContainText(`Manual retrieved ${fixture.suffix}`);

    await page.goto(`/projects/${fixture.projectId}/review-report`);
    await expect(page.getByRole("link", { name: "Open Protocol ledger →" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download complete Markdown" })).toBeVisible();
    const exportResponse = await page.request.get(`/projects/${fixture.projectId}/review-report/export`);
    expect(exportResponse.ok()).toBe(true);
    const markdown = await exportResponse.text();
    expect(markdown).toContain("## Immutable SearchRun Appendix");
    expect(markdown).toContain(fixture.queryText);
    expect(markdown).toContain("### Run ");
  });

  test("renders a valid empty SearchRun without a RetrievedRecord page", async ({ page }) => {
    const fixture = await seedRun();
    await page.goto(`/projects/${fixture.projectId}/protocol/runs/${fixture.runId}`);
    await expect(page.getByText("No RetrievedRecords match this search.")).toBeVisible();
    await expect(page.locator(".paper-picker")).toHaveCount(0);
  });
});
