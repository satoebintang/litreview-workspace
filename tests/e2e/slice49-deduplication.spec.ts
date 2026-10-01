import { expect, test } from "@playwright/test";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { resolvePlaywrightTestDatabaseUrl } from "./playwright-database";

test("Slice 49 pages the live deduplication queue, audits history, and corrects mappings", async ({ page }) => {
  test.setTimeout(180_000);
  const database = createDb(resolvePlaywrightTestDatabaseUrl());
  const services = createReviewServices(database.db);
  const suffix = Date.now();

  try {
    const project = await services.createProject({ title: `Slice 49 Deduplication ${suffix}` });
    const source = (await services.listSearchSources(project.id))[0];
    expect(source).toBeTruthy();
    const strategy = await services.createSearchStrategy(project.id, {
      searchSourceId: source!.id,
      name: `Slice 49 strategy ${suffix}`,
      queryText: "slice 49 deduplication queue",
    });
    const createRun = (offset: number) => services.createSearchRun(project.id, {
      searchSourceId: source!.id,
      sourceKeySnapshot: source!.sourceKey,
      sourceDisplayNameSnapshot: source!.displayName,
      strategyId: strategy.id,
      queryText: strategy.queryText,
      reportedResultCount: 10,
      executedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, offset)),
    });
    const [runA, runB] = await Promise.all([createRun(0), createRun(1)]);
    const strong: Array<{ id: string; title: string }> = [];
    for (let index = 1; index <= 8; index += 1) {
      const title = index <= 2 ? "Normalized shared-work title" : `DOI-only strong candidate ${index}`;
      const record = await services.createRetrievedRecord(project.id, {
        searchRunId: index % 2 === 0 ? runB.id : runA.id,
        searchSourceId: source!.id,
        sourceRecordId: index <= 2 ? "shared-source-record" : `strong-source-${index}`,
        title,
        authors: [`Author ${index} A`, `Author ${index} B`, `Author ${index} C`, `Author ${index} D`],
        abstract: index === 1 ? "Full audit abstract retained on the exact pair page." : null,
        doi: "10.4900/slice49-shared-doi",
        publicationYear: index <= 2 ? 2021 : null,
        retrievedAt: new Date(Date.UTC(2026, 0, 2, 0, index)),
      });
      strong.push({ id: record.id, title });
    }
    const possibleA = await services.createRetrievedRecord(project.id, {
      searchRunId: runA.id,
      searchSourceId: source!.id,
      sourceRecordId: "possible-source-a",
      title: "Title year only candidate",
      authors: ["Possible Author A"],
      publicationYear: 2020,
      retrievedAt: new Date("2026-01-03T00:00:00Z"),
    });
    const possibleB = await services.createRetrievedRecord(project.id, {
      searchRunId: runB.id,
      searchSourceId: source!.id,
      sourceRecordId: "possible-source-b",
      title: "Title year only candidate",
      authors: ["Possible Author B"],
      publicationYear: 2020,
      retrievedAt: new Date("2026-01-03T00:00:01Z"),
    });

    const queueUrl = `/projects/${project.id}/deduplication`;
    let pairUrl = `${queueUrl}/${strong[0]!.id}/${strong[1]!.id}`;
    await page.goto(`/projects/not-a-uuid/deduplication`);
    expect(page.url()).toContain("/projects/not-a-uuid/deduplication");
    const invalidProjectResponse = await page.request.get("/projects/not-a-uuid/deduplication");
    expect(invalidProjectResponse.status()).toBe(404);
    const invalidRecordResponse = await page.request.get(`${queueUrl}/not-a-uuid/${strong[0]!.id}`);
    expect(invalidRecordResponse.status()).toBe(404);

    await page.goto(queueUrl);
    let queueItems = page.locator("article.item");
    await expect(queueItems).toHaveCount(25);
    let multiSignalPair = queueItems.filter({ hasText: "same source record ID" }).first();
    if (await multiSignalPair.count() === 0) {
      await page.getByRole("link", { name: /Next page/ }).click();
      queueItems = page.locator("article.item");
      await expect(queueItems).toHaveCount(4);
      multiSignalPair = queueItems.filter({ hasText: "same source record ID" }).first();
    }
    await expect(multiSignalPair).toHaveCount(1);
    await expect(multiSignalPair.getByText("strong candidate", { exact: true })).toBeVisible();
    const firstReasons = multiSignalPair.locator(".item-row .item-meta");
    await expect(firstReasons).toContainText("DOI");
    await expect(firstReasons).toContainText("same source record ID");
    await expect(firstReasons).toContainText("title + year");
    const previewAuthors = multiSignalPair.locator(".nested-support").filter({ hasText: "Author 1 A" });
    await expect(previewAuthors).toContainText("Author 1 A, Author 1 B, Author 1 C");
    await expect(previewAuthors).not.toContainText("Author 1 D");
    pairUrl = (await multiSignalPair.getByRole("link", { name: /Inspect pair/ }).getAttribute("href"))!;
    expect(pairUrl).toBeTruthy();
    await page.goto(pairUrl);
    await expect(page.getByRole("heading", { name: "Candidate evidence" })).toBeVisible();
    await expect(page.getByText("Full audit abstract retained on the exact pair page.", { exact: true })).toBeVisible();
    await expect(page.locator(".nested-support").filter({ hasText: "Author 1 A, Author 1 B, Author 1 C, Author 1 D" })).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Decision history" })).toBeVisible();
    await page.getByRole("button", { name: "Create from Record A" }).click();
    await expect(page.getByText("Deduplication decision recorded.")).toBeVisible();
    await expect(page.getByText("Same-work adjudicated and canonically resolved.")).toBeVisible();
    const currentPaperMatch = page.getByText(/^Current Paper: [0-9a-f-]+$/).first();
    await expect(currentPaperMatch).toBeVisible();
    const currentPaperId = (await currentPaperMatch.textContent())!.replace("Current Paper: ", "");

    await page.goto(queueUrl);
    queueItems = page.locator("article.item");
    await expect(queueItems).toHaveCount(25);
    const mappedQueueItems = queueItems.filter({ hasText: `Current Paper: ${currentPaperId}` });
    await expect(mappedQueueItems).not.toHaveCount(0);
    await page.getByRole("link", { name: /Next page/ }).click();
    await expect(page).toHaveURL(/\/deduplication\?pageSize=25&cursor=/);
    queueItems = page.locator("article.item");
    await expect(queueItems).toHaveCount(3);
    await expect(queueItems.nth(0).getByText("strong candidate", { exact: true })).toBeVisible();
    await expect(queueItems.nth(1).getByText("strong candidate", { exact: true })).toBeVisible();
    const possibleItem = queueItems.nth(2);
    await expect(possibleItem.getByText("possible candidate", { exact: true })).toBeVisible();
    await expect(possibleItem.locator(".item-row .item-meta")).toContainText("title + year");
    await expect(possibleItem).toContainText("Title year only candidate");
    await possibleItem.getByRole("button", { name: "Different work" }).click();
    await expect(page.getByText("Deduplication decision recorded.")).toBeVisible();
    await page.goto(queueUrl);
    await page.getByRole("link", { name: /Next page/ }).click();
    await expect(page.locator("article.item")).toHaveCount(2);
    await expect(page.getByText("Title year only candidate", { exact: false })).toHaveCount(0);

    const existingPaper = await services.addPaper(project.id, {
      title: `Slice 49 existing-Paper target ${suffix}`,
      authors: ["Existing Paper Author"],
    });
    await page.goto(queueUrl);
    queueItems = page.locator("article.item");
    let sameExistingPairUrl: string | null = null;
    for (let index = 0; index < await queueItems.count(); index += 1) {
      const candidate = queueItems.nth(index);
      const sides = candidate.locator(".nested-support");
      if (await sides.count() === 2
        && await sides.nth(0).getByText("Unmatched", { exact: true }).count() === 1
        && await sides.nth(1).getByText("Unmatched", { exact: true }).count() === 1) {
        sameExistingPairUrl = await candidate.getByRole("link", { name: /Inspect pair/ }).getAttribute("href");
        break;
      }
    }
    expect(sameExistingPairUrl).toBeTruthy();
    if (!sameExistingPairUrl) throw new Error("No visible unresolved pair had two unmatched records");
    await page.goto(sameExistingPairUrl);
    const existingPaperSearch = page.getByLabel("Search Papers for same-work canonical paper");
    await existingPaperSearch.fill(existingPaper.title);
    await page.getByRole("button", { name: "Browse Papers" }).click();
    const existingPaperResult = page.locator(".claim-support-result-row").filter({ hasText: existingPaper.title });
    await expect(existingPaperResult).toBeVisible();
    await existingPaperResult.getByRole("button", { name: "Select" }).click();
    await page.getByRole("button", { name: "Same work and link to Paper" }).click();
    await expect(page.getByText("Deduplication decision recorded.")).toBeVisible();
    await expect(page.getByText("Same-work adjudicated and canonically resolved.")).toBeVisible();
    await expect(page.locator(".nested-support").first()).toContainText(`Current Paper: ${existingPaper.id}`);
    await expect(page.locator(".nested-support").nth(1)).toContainText(`Current Paper: ${existingPaper.id}`);
    await page.goto(queueUrl);
    await expect(page.locator(`a[href="${sameExistingPairUrl}"]`)).toHaveCount(0);

    const longNote = "Slice 49 complete audit note. ".repeat(30);
    for (let index = 1; index <= 20; index += 1) {
      await services.confirmSameWork(project.id, strong[0]!.id, strong[1]!.id, index === 20 ? longNote : `History event ${index}`);
    }
    await page.goto(pairUrl);
    const historySection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Decision history" }) });
    await expect(historySection).toHaveCount(1);
    const historyItems = historySection.locator(".item-list .item");
    const firstHistoryCount = await historyItems.count();
    expect(firstHistoryCount).toBeGreaterThan(0);
    expect(firstHistoryCount).toBeLessThanOrEqual(20);
    await historySection.getByRole("link", { name: /Next page/ }).click();
    await expect(page).toHaveURL(/historyPageSize=20&historyCursor=/);
    const nextHistorySection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Decision history" }) });
    const nextHistoryItems = nextHistorySection.locator(".item-list .item");
    const nextHistoryCount = await nextHistoryItems.count();
    expect(nextHistoryCount).toBeGreaterThan(0);
    expect(nextHistoryCount).toBeLessThanOrEqual(20);
    const completeNoteEvent = nextHistoryItems.filter({ hasText: "Slice 49 complete audit note." });
    await expect(completeNoteEvent).toHaveCount(1);
    await completeNoteEvent.getByRole("link", { name: /View complete note/ }).click();
    await expect(page.getByRole("heading", { name: "Complete decision note" })).toBeVisible();
    await expect(page.locator("pre")).toHaveText(longNote);

    const alreadyMappedIds = new Set([
      ...pairUrl.split("/").slice(-2),
      ...sameExistingPairUrl.split("/").slice(-2),
    ].map((id) => id.toLowerCase()));
    const correctionRecords = strong.filter((record) => !alreadyMappedIds.has(record.id.toLowerCase()));
    if (correctionRecords.length < 2) throw new Error("Correction fixture requires two records that remain unmapped");
    const [correctionLeft, correctionRight] = correctionRecords.slice(0, 2).map((record) => record.id).sort();
    await services.linkRetrievedRecord(project.id, correctionLeft, currentPaperId);
    await services.linkRetrievedRecord(project.id, correctionRight, currentPaperId);
    // Reproduce a pre-existing inconsistent audit state so the released correction UI is exercised.
    await database.client.unsafe("alter table retrieved_record_deduplication_decisions disable trigger retrieved_record_deduplication_decision_consistency");
    try {
      await database.client.unsafe(
        `insert into retrieved_record_deduplication_decisions
          (project_id, left_retrieved_record_id, right_retrieved_record_id, decision, note)
         values ($1::uuid, $2::uuid, $3::uuid, 'different_work', 'Legacy mapping requires correction')`,
        [project.id, correctionLeft, correctionRight],
      );
    } finally {
      await database.client.unsafe("alter table retrieved_record_deduplication_decisions enable trigger retrieved_record_deduplication_decision_consistency");
    }
    const consistencyTrigger = await database.client.unsafe<{ tgenabled: string }[]>(
      `select tgenabled from pg_trigger
       where tgrelid = 'retrieved_record_deduplication_decisions'::regclass
         and tgname = 'retrieved_record_deduplication_decision_consistency'`,
    );
    expect(consistencyTrigger[0]?.tgenabled).toBe("O");
    const correctionTarget = await services.addPaper(project.id, {
      title: `Slice 49 correction target ${suffix}`,
      authors: ["Correction Author"],
    });
    await page.goto(`${queueUrl}/${correctionLeft}/${correctionRight}`);
    await expect(page.getByRole("heading", { name: "Correct the shared mapping" })).toBeVisible();
    const correctionSearch = page.getByLabel("Search Papers for different-work correction target");
    await correctionSearch.fill(correctionTarget.title);
    await page.getByRole("button", { name: "Browse Papers" }).click();
    const correctionResult = page.locator(".claim-support-result-row").filter({ hasText: correctionTarget.title });
    await expect(correctionResult).toBeVisible();
    await correctionResult.getByRole("button", { name: "Select" }).click();
    await page.getByRole("button", { name: "Correct mapping + Different work" }).click();
    await expect(page.getByText("Deduplication decision recorded.")).toBeVisible();
    await expect(page.locator(".nested-support").first()).toContainText(`Current Paper: ${correctionTarget.id}`);
    await expect(page.locator(".nested-support").nth(1)).toContainText(`Current Paper: ${currentPaperId}`);

    expect(possibleA.id).not.toBe(possibleB.id);
  } finally {
    await database.client.end();
  }
});
