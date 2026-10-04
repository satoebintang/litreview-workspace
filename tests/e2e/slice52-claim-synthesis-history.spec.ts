import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { resolvePlaywrightTestDatabaseUrl } from "./playwright-database";

test.describe("Slice 52 bounded Claim and Synthesis histories", () => {
  test("pages each stream, restores exact snapshots, scopes audit links, and clears continuation state after writes", async ({ page }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(30_000);
    const unique = randomUUID();
    const database = createDb(resolvePlaywrightTestDatabaseUrl());
    const services = createReviewServices(database.db);

    try {
      const project = await services.createProject({ title: `Slice 52 history ${unique}` });
      const otherProject = await services.createProject({ title: `Slice 52 foreign project ${unique}` });
      const paperA = await services.addPaper(project.id, { title: "Slice 52 Paper A" });
      const paperB = await services.addPaper(project.id, { title: "Slice 52 Paper B" });
      for (const paper of [paperA, paperB]) {
        await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
        await services.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
        await services.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
      }
      const evidenceA = await services.recordEvidence(project.id, { paperId: paperA.id, sourceText: "Exact source passage from Paper A.", pageNumber: 3 });
      const evidenceB = await services.recordEvidence(project.id, { paperId: paperB.id, sourceText: "Exact source passage from Paper B.", pageNumber: 5 });
      const field = await services.createExtractionField(project.id, { name: "Slice 52 outcome", fieldType: "short_text" });
      const extractionA = await services.reviseExtractionValue(project.id, paperA.id, field.id, { value: "Outcome A", evidenceIds: [evidenceA.id] });
      const extractionB = await services.reviseExtractionValue(project.id, paperB.id, field.id, { value: "Outcome B", evidenceIds: [evidenceB.id] });
      const synthesis = await services.createSynthesisStatement(project.id, {
        title: "Slice 52 topic",
        statementText: "Old exact synthesis wording.",
        extractionRevisionIds: [extractionA.id, extractionB.id],
      });
      const evidenceSetName = `Slice 52 pinned Evidence Set ${unique}`;
      const evidenceSet = (await services.createEvidenceSet(project.id, { name: evidenceSetName })).set;
      let evidenceSetRevisionId = (await services.getEvidenceSet(project.id, evidenceSet.id)).currentRevision.id;
      for (const evidence of [evidenceA, evidenceB]) {
        const added = await services.addEvidenceToSet(project.id, evidenceSet.id, {
          evidenceId: evidence.id,
          expectedRevisionId: evidenceSetRevisionId,
        });
        evidenceSetRevisionId = added.revision.id;
      }
      const preparation = await services.createSynthesisPreparation(project.id, {
        evidenceSetId: evidenceSet.id,
        expectedRevisionId: evidenceSetRevisionId,
        extractionFieldId: field.id,
      });
      await services.replaceSynthesisPreparationSelections(project.id, preparation.id, {
        extractionRevisionIds: [extractionA.id, extractionB.id],
      });
      await services.updateSynthesisPreparation(project.id, preparation.id, {
        targetSynthesisStatementId: synthesis.statement.id,
      });
      const currentSynthesis = await services.finalizeSynthesisPreparation(project.id, preparation.id, {
        title: "Slice 52 topic",
        statementText: "Current exact synthesis wording.",
        researcherNote: "Current exact synthesis note.",
      });
      const [leftExtractionId, rightExtractionId] = [extractionA.id, extractionB.id].sort();
      const oldInterpretation = await services.appendSynthesisInterpretation(project.id, synthesis.statement.id, currentSynthesis.revision.id, {
        convergenceState: "contradictory",
        summary: "Older exact interpretation snapshot.",
        researcherNote: "Older interpretation researcher note.",
        limitations: [{ category: "reporting", body: "Historical reporting limitation." }],
        questions: [{ body: "Historical research question." }],
        contradictions: [{ leftExtractionRevisionId: leftExtractionId, rightExtractionRevisionId: rightExtractionId, note: "The observations point in different directions." }],
      });
      const currentInterpretation = await services.appendSynthesisInterpretation(project.id, synthesis.statement.id, currentSynthesis.revision.id, {
        convergenceState: "mixed",
        summary: "Current interpretation summary.",
        limitations: [],
        questions: [],
        contradictions: [],
      });

      const claim = await services.createClaim(project.id, { claimText: "Old exact Claim wording." });
      const currentClaim = await services.createClaimRevision(project.id, claim.id, {
        claimText: "Current exact Claim wording.",
        expectedCurrentRevisionId: claim.revision.id,
        supports: [
          { kind: "evidence", evidenceId: evidenceA.id },
          { kind: "extractionRevision", extractionRevisionId: extractionA.id },
          { kind: "synthesisRevision", synthesisRevisionId: currentSynthesis.revision.id },
        ],
      });
      const nonFinalizedClaimRevisionId = randomUUID();
      await database.db.execute(sql`
        insert into claim_revisions (id, project_id, claim_id, state, claim_text)
        values (${nonFinalizedClaimRevisionId}::uuid, ${project.id}::uuid, ${claim.id}::uuid, 'active', 'Unfinalized exact Claim revision')
      `);
      const foreignClaim = await services.createClaim(project.id, { claimText: "Foreign Claim scope." });
      const foreignStatement = await services.createSynthesisStatement(project.id, { statementText: "Foreign statement scope.", extractionRevisionIds: [extractionA.id] });

      const claimHistoryPath = `/projects/${project.id}/claims/${claim.id}/history?pageSize=1`;
      await page.goto(claimHistoryPath);
      await expect(page.getByRole("heading", { name: "Claim revision history" })).toBeVisible();
      await expect(page.locator("article.item").first()).toContainText("Current exact Claim wording.");
      const claimNextHref = await page.getByRole("link", { name: "Next Claim history page →" }).getAttribute("href");
      expect(claimNextHref).toBeTruthy();
      const claimCursor = new URL(claimNextHref!, "http://127.0.0.1:3000").searchParams.get("cursor");
      expect(claimCursor).toBeTruthy();
      await page.locator("article.item").first().getByRole("link", { name: "Open exact Claim revision →" }).click();
      await expect(page.getByRole("heading", { name: "Current exact Claim wording." })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Direct Evidence supports" })).toBeVisible();
      const exactClaimEvidence = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Direct Evidence supports" }) });
      await expect(exactClaimEvidence.locator(".quote").filter({ hasText: "Exact source passage from Paper A." })).toBeVisible();
      const exactSynthesisSupport = page.locator("article.item").filter({ hasText: "Current exact synthesis wording." });
      await expect(exactSynthesisSupport).toContainText("Slice 52 topic");
      await expect(exactSynthesisSupport).toContainText("Current exact synthesis note.");
      await expect(exactSynthesisSupport.locator(".nested-support").filter({ hasText: "Slice 52 Paper A" })).toContainText("Outcome A");

      await page.goto(claimNextHref!);
      await expect(page.locator("article.item").first()).toContainText("Old exact Claim wording.");
      await page.locator("article.item").first().getByRole("link", { name: "Open exact Claim revision →" }).click();
      await expect(page.getByRole("heading", { name: "Old exact Claim wording." })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Direct Evidence supports" })).toBeVisible();
      await expect(page.locator(".empty").filter({ hasText: "No direct Evidence supports were recorded." })).toBeVisible();

      const wrongClaimCursorResponse = await page.goto(`/projects/${project.id}/claims/${foreignClaim.id}/history?pageSize=1&cursor=${encodeURIComponent(claimCursor!)}`);
      expect(wrongClaimCursorResponse?.status()).toBe(404);
      const wrongClaimRevisionResponse = await page.goto(`/projects/${project.id}/claims/${foreignClaim.id}/revisions/${currentClaim.revision.id}`);
      expect(wrongClaimRevisionResponse?.status()).toBe(404);
      const crossProjectClaimRevisionResponse = await page.goto(`/projects/${otherProject.id}/claims/${claim.id}/revisions/${currentClaim.revision.id}`);
      expect(crossProjectClaimRevisionResponse?.status()).toBe(404);
      const nonFinalizedClaimRevisionResponse = await page.goto(`/projects/${project.id}/claims/${claim.id}/revisions/${nonFinalizedClaimRevisionId}`);
      expect(nonFinalizedClaimRevisionResponse?.status()).toBe(404);
      const malformedClaimRevisionResponse = await page.goto(`/projects/${project.id}/claims/${claim.id}/revisions/not-a-uuid`);
      expect(malformedClaimRevisionResponse?.status()).toBe(404);

      const synthesisPath = `/projects/${project.id}/synthesis/${synthesis.statement.id}`;
      await page.goto(synthesisPath);
      await expect(page.getByRole("heading", { name: "Paginated synthesis history · oldest first" })).toBeVisible();
      await expect(page.locator(".synthesis-statement").filter({ hasText: "Current exact synthesis wording." })).toBeVisible();

      const synthesisHistoryPath = `${synthesisPath}/history?pageSize=1`;
      await page.goto(synthesisHistoryPath);
      await expect(page.getByRole("heading", { name: "Paginated synthesis history · oldest first" })).toBeVisible();
      await expect(page.locator("article.item").first()).toContainText("Old exact synthesis wording.");
      await expect(page.locator("article.item").first()).not.toContainText("Preparation context");
      await expect(page.getByRole("heading", { name: "Current revision" })).toBeVisible();
      const synthesisNextHref = await page.getByRole("link", { name: "Next oldest-first history page →" }).getAttribute("href");
      expect(synthesisNextHref).toBeTruthy();
      const synthesisCursor = new URL(synthesisNextHref!, "http://127.0.0.1:3000").searchParams.get("cursor");
      expect(synthesisCursor).toBeTruthy();
      await page.goto(synthesisNextHref!);
      await expect(page.locator("article.item").first()).toContainText("Current exact synthesis wording.");
      const preparedRevisionRow = page.locator("article.item").first();
      await expect(preparedRevisionRow).toContainText("Preparation context: Evidence Set “Slice 52 pinned Evidence Set");
      await expect(preparedRevisionRow).toContainText("…” · pinned composition sequence");
      const wrongStatementCursorResponse = await page.goto(`/projects/${project.id}/synthesis/${foreignStatement.statement.id}/history?pageSize=1&cursor=${encodeURIComponent(synthesisCursor!)}`);
      expect(wrongStatementCursorResponse?.status()).toBe(404);

      const exactSynthesisPath = `${synthesisPath}/revisions/${currentSynthesis.revision.id}`;
      await page.goto(exactSynthesisPath);
      await expect(page.getByText(evidenceSetName, { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Current interpretation snapshot" })).toBeVisible();
      await expect(page.locator(".synthesis-statement").filter({ hasText: "Current interpretation summary." })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Interpretation history" })).toBeVisible();
      const interpretationTimeline = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Interpretation history" }) });
      await expect(interpretationTimeline.locator("article.item").first()).toContainText("Current interpretation summary.");

      const interpretationHistoryPath = `${exactSynthesisPath}/interpretations/history?pageSize=1`;
      await page.goto(interpretationHistoryPath);
      await expect(page.getByRole("heading", { name: "Interpretation snapshot history" })).toBeVisible();
      await expect(page.locator("article.item").first()).toContainText("Current interpretation summary.");
      await expect(page.getByRole("link", { name: "Open exact current snapshot →" })).toBeVisible();
      const currentSnapshotSummary = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Current interpretation" }) });
      await expect(currentSnapshotSummary).not.toContainText("Current interpretation summary.");
      const interpretationNextHref = await page.getByRole("link", { name: "Next interpretation history page →" }).getAttribute("href");
      expect(interpretationNextHref).toBeTruthy();
      const interpretationCursor = new URL(interpretationNextHref!, "http://127.0.0.1:3000").searchParams.get("cursor");
      expect(interpretationCursor).toBeTruthy();
      await page.goto(interpretationNextHref!);
      await expect(page.locator("article.item").first()).toContainText("Older exact interpretation snapshot.");
      await page.locator("article.item").first().getByRole("link", { name: "Open exact interpretation →" }).click();
      await expect(page.getByRole("heading", { name: "contradictory interpretation" })).toBeVisible();
      await expect(page.getByText("Older exact interpretation snapshot.", { exact: true })).toBeVisible();
      await expect(page.getByText("Historical reporting limitation.", { exact: true })).toBeVisible();
      await expect(page.getByText("Historical research question.", { exact: true })).toBeVisible();
      await expect(page.getByText("Slice 52 Paper A", { exact: true })).toBeVisible();
      await expect(page.getByText("Slice 52 Paper B", { exact: true })).toBeVisible();

      const wrongInterpretationRevisionResponse = await page.goto(`${synthesisPath}/revisions/${foreignStatement.revision.id}/interpretations/${oldInterpretation.id}`);
      expect(wrongInterpretationRevisionResponse?.status()).toBe(404);
      const wrongInterpretationProjectResponse = await page.goto(`/projects/${otherProject.id}/synthesis/${synthesis.statement.id}/revisions/${currentSynthesis.revision.id}/interpretations/${currentInterpretation.id}`);
      expect(wrongInterpretationProjectResponse?.status()).toBe(404);
      const malformedInterpretationResponse = await page.goto(`${exactSynthesisPath}/interpretations/not-a-uuid`);
      expect(malformedInterpretationResponse?.status()).toBe(404);

      // Writes started from a URL carrying continuation state return to page one.
      await page.goto(`${synthesisPath}?cursor=${encodeURIComponent(synthesisCursor!)}`);
      await page.locator("#revision-text").fill("Synthesis writer after continuation.");
      await page.getByRole("button", { name: "Save new synthesis revision" }).click();
      await expect(page).toHaveURL(new RegExp(`${synthesisPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?saved=revised(?:&|$)`));
      expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
      await expect(page.getByText("New synthesis revision saved.")).toBeVisible();

      await page.goto(`${exactSynthesisPath}?cursor=${encodeURIComponent(interpretationCursor!)}`);
      await page.locator("#summary").fill("Interpretation writer after continuation.");
      await page.getByRole("button", { name: "Record interpretation snapshot" }).click();
      await expect(page).toHaveURL(new RegExp(`${exactSynthesisPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?saved=interpretation$`));
      expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
      await expect(page.getByRole("status").filter({ hasText: "Interpretation snapshot saved successfully." })).toBeVisible();

      const claimPath = `/projects/${project.id}/claims/${claim.id}`;
      await page.goto(`${claimPath}?cursor=${encodeURIComponent(claimCursor!)}`);
      await page.locator("#revision-claim-text").fill("Claim writer after continuation.");
      await page.getByRole("button", { name: "Save new Claim revision" }).click();
      await expect(page).toHaveURL(new RegExp(`${claimPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?saved=revised$`));
      expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
      await expect(page.getByRole("status").filter({ hasText: "New Claim revision saved." })).toBeVisible();

      await page.goto(`${claimPath}?cursor=${encodeURIComponent(claimCursor!)}`);
      await page.getByRole("button", { name: "Withdraw Claim" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Withdraw Claim" }).click();
      await expect(page).toHaveURL(new RegExp(`${claimPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?saved=withdrawn$`));
      expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
      const withdrawnRevisionRow = page.locator(".history-item").first();
      await expect(withdrawnRevisionRow).toContainText("Withdrawn");
      await withdrawnRevisionRow.getByRole("link", { name: "Open exact Claim revision →" }).click();
      await expect(page.getByRole("heading", { name: "Claim withdrawn" })).toBeVisible();
      await expect(page.locator(".empty").filter({ hasText: "No direct Evidence supports were recorded." })).toBeVisible();

      await page.goto(`${claimPath}?cursor=${encodeURIComponent(claimCursor!)}`);
      await page.locator("#reactivate-claim-text").fill("Reactivated without implicitly restoring historical support.");
      await page.getByRole("button", { name: "Reactivate Claim" }).click();
      await expect(page).toHaveURL(new RegExp(`${claimPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?saved=reactivated$`));
      expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
      await expect(page.getByRole("status").filter({ hasText: "Claim reactivated with an explicit support snapshot." })).toBeVisible();
      await expect(page.locator(".support-summary")).toContainText("0 supports");
    } finally {
      await database.client.end();
    }
  });
});
