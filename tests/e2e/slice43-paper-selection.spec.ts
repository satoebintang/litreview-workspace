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
    const duplicateCandidate = includeSharedDoi
      ? await services.addPaper(project.id, { title: `DOI candidate ${suffix}`, doi: "10.1000/slice43-shared", publicationYear: 2024 })
      : null;
    return { projectId: project.id, runId: run.id, records, firstPaper, secondPaper, duplicateCandidate };
  } finally {
    await database.client.end();
  }
}

test.describe("Slice 43 canonical Paper selection", () => {
  test("links, relinks, and unlinks from one exact RetrievedRecord with a Project-wide exclusion", async ({ page }) => {
    const recordTitle = `Protocol selector record ${randomUUID()}`;
    const fixture = await seedProtocolRun([recordTitle], true);
    const recordId = fixture.records[0]!.id;
    const recordUrl = `/projects/${fixture.projectId}/protocol/runs/${fixture.runId}/records/${recordId}`;
    await page.goto(recordUrl);

    const matchSection = page.locator("section.card.section-card").filter({ hasText: "Current Paper match" });
    const linkForm = matchSection.locator("form").nth(1);
    await selectPaper(fixture.firstPaper.title, linkForm);
    await linkForm.getByRole("button", { name: "Link Paper" }).click();
    await expect(page).toHaveURL(new RegExp(`/protocol/runs/${fixture.runId}/records/${recordId}\\?saved=linked$`));
    await expect(matchSection.getByText(fixture.firstPaper.title)).toBeVisible();
    await expect(page.locator("section.card.section-card").filter({ hasText: "Duplicate candidates" })).toContainText(fixture.duplicateCandidate!.title);

    const relinkForm = matchSection.locator("form").nth(1);
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
    await expect(page).toHaveURL(new RegExp(`/protocol/runs/${fixture.runId}/records/${recordId}\\?saved=relinked$`));
    await expect(matchSection.getByText(fixture.secondPaper.title)).toBeVisible();

    const history = page.locator("section.card.section-card").filter({ hasText: "Match history" });
    await expect(history).toContainText(fixture.firstPaper.title);
    await expect(history).toContainText(fixture.secondPaper.title);
    await matchSection.getByRole("button", { name: "Unlink current Paper" }).click();
    await expect(page).toHaveURL(new RegExp(`/protocol/runs/${fixture.runId}/records/${recordId}\\?saved=unlinked$`));
    await expect(matchSection.getByText("unmatched")).toBeVisible();
  });

  test("keeps the 50-row RetrievedRecord ledger free of row-level PaperPickers", async ({ page }) => {
    const suffix = randomUUID();
    const titles = Array.from({ length: 50 }, (_, index) => `Multi selector record ${index + 1} ${suffix}`);
    const fixture = await seedProtocolRun(titles);
    await page.goto(`/projects/${fixture.projectId}/protocol/runs/${fixture.runId}`);

    const pickers = page.locator(".paper-picker");
    await expect(pickers).toHaveCount(0);
    await expect(page.locator("section.card.section-card").filter({ hasText: "RetrievedRecords" }).locator("a.item")).toHaveCount(50);
    await expect(page.locator(".evidence-paper-results")).toHaveCount(0);
    await page.getByRole("link", { name: new RegExp(titles[0]!) }).click();
    await expect(page.locator(".paper-picker")).toHaveCount(1);
    await expect(page.locator(".paper-picker").getByRole("searchbox")).toBeVisible();
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
