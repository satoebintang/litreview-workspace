import { expect, test } from "@playwright/test";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";

const uuid = () => crypto.randomUUID();

test.describe("Slice 36 Claim support picker", () => {
  test("keeps exact mixed selections across pages and search, excludes stale supports, and rejects a concurrent revision", async ({ page }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => console.log("BROWSER PAGE ERROR", error.stack ?? error.message));
    page.on("console", (message) => { if (message.type() === "error") console.log("BROWSER CONSOLE ERROR", message.text()); });

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 36 Claim picker ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    const sql = createPlaywrightTestDatabaseClient({ prepare: false });
    try {
      const paperId = uuid();
      const fieldId = uuid();
      const extractionValueId = uuid();
      const extractionRevisionId = uuid();
      const statementId = uuid();
      const synthesisRevisionId = uuid();
      await sql`insert into papers (id, project_id, title, authors) values (${paperId}, ${projectId}, 'Cross-kind picker source', array['Author'])`;
      for (let index = 0; index < 21; index += 1) {
        const evidenceId = uuid();
        const createdAt = new Date(Date.now() - index * 60_000);
        await sql`insert into evidence (id, project_id, paper_id, source_text, page_number, created_at)
          values (${evidenceId}, ${projectId}, ${paperId}, ${`Picker evidence ${String(index).padStart(2, "0")} marker`}, ${index + 1}, ${createdAt})`;
      }
      await sql`insert into screening_decisions (project_id, paper_id, decision) values (${projectId}, ${paperId}, 'include')`;
      await sql`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at)
        values (${projectId}, ${paperId}, 'retrieved', now())`;
      await sql`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${projectId}, ${paperId}, 'include')`;
      await sql`insert into extraction_fields (id, project_id, name, field_type) values (${fieldId}, ${projectId}, 'Attack mechanism', 'short_text')`;
      await sql`insert into extraction_values (id, project_id, paper_id, field_id) values (${extractionValueId}, ${projectId}, ${paperId}, ${fieldId})`;
      await sql`insert into extraction_value_revisions
        (id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at)
        values (${extractionRevisionId}, ${projectId}, ${paperId}, ${fieldId}, ${extractionValueId}, 'short_text', 'present', 'A finalized observation', now())`;
      await sql`insert into synthesis_statements (id, project_id) values (${statementId}, ${projectId})`;
      await sql`insert into synthesis_revisions
        (id, project_id, synthesis_statement_id, state, title, statement_text)
        values (${synthesisRevisionId}, ${projectId}, ${statementId}, 'active', 'Exact picker synthesis', 'A finalized synthesis for exact selection.')`;
      await sql`update synthesis_revisions set finalized_at=now()
        where project_id=${projectId} and id=${synthesisRevisionId}`;

      await page.goto(`/projects/${projectId}/claims`);
      await page.getByLabel("Claim text").fill("The Claim picker preserves exact support identity.");
      await page.getByRole("button", { name: "Create unsupported claim" }).click();
      await expect(page).toHaveURL(/\/claims\/[0-9a-f-]+\?saved=created$/);
      const claimId = page.url().match(/claims\/([0-9a-f-]+)(?:\?|$)/)?.[1] as string;

      await page.goto(`/projects/${projectId}/claims/${claimId}?synthesisRevisionId=${synthesisRevisionId}`);
      await expect(page.locator(`input[type="hidden"][name="synthesisRevisionIds"][value="${synthesisRevisionId}"]`)).toHaveValue(synthesisRevisionId);
      const picker = page.locator(".support-picker");
      await expect(picker.locator(".claim-support-result-row")).toHaveCount(20);

      const firstEvidenceAdd = page.getByRole("button", { name: "Add Cross-kind picker source · page 1 to Evidence" });
      await firstEvidenceAdd.focus();
      await expect(firstEvidenceAdd).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator('input[type="hidden"][name="evidenceIds"]')).toHaveCount(1);

      const nextEvidence = page.getByRole("navigation", { name: "Evidence pages", exact: true }).getByRole("button", { name: "Next" });
      await nextEvidence.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#claim-support-results")).toContainText("page 21");
      await page.getByRole("button", { name: "Add Cross-kind picker source · page 21 to Evidence" }).click();
      await expect(page.locator('input[type="hidden"][name="evidenceIds"]')).toHaveCount(2);

      await page.getByRole("button", { name: /Extraction revisions/ }).click();
      const extractionAdd = page.getByRole("button", { name: /Add Attack mechanism · Cross-kind picker source to Extraction revisions/ });
      await expect(extractionAdd).toBeVisible();
      await extractionAdd.click();
      await expect(page.locator(`input[type="hidden"][name="extractionRevisionIds"][value="${extractionRevisionId}"]`)).toHaveValue(extractionRevisionId);

      await page.getByRole("button", { name: /Evidence/ }).first().click();
      await page.locator("#claim-support-query").fill("Picker evidence 05 marker");
      await picker.getByRole("button", { name: "Search", exact: true }).click();
      await expect(page.locator("#claim-support-results .claim-support-result-row")).toContainText("page 6");
      await expect(page.locator(".support-picker #claim-support-results legend span[tabindex='-1']")).toBeFocused();
      await expect(page.locator('.support-picker p[aria-live="polite"]')).toContainText("showing 1 to 1 of 1");
      await page.getByRole("button", { name: "Add Cross-kind picker source · page 6 to Evidence" }).click();
      await expect(page.locator('input[type="hidden"][name="evidenceIds"]')).toHaveCount(3);

      await page.getByRole("button", { name: /Extraction revisions/ }).click();
      await expect(page.getByRole("button", { name: /Remove Attack mechanism · Cross-kind picker source from Extraction revisions/ })).toBeVisible();
      await page.getByRole("button", { name: /Evidence/ }).first().click();
      await expect(page.locator("#claim-support-query")).toHaveValue("Picker evidence 05 marker");
      await expect(page.locator("#claim-support-results .claim-support-result-row")).toContainText("page 6");
      await expect(picker.locator("summary").filter({ hasText: "Selected supports: 5" })).toBeVisible();

      await page.getByRole("button", { name: "Save new Claim revision" }).click();
      await expect(page).toHaveURL(new RegExp(`/claims/${claimId}\\?saved=revised$`));
      await expect(page.locator(".support-summary")).toContainText("5 supports");
      const latestRevision = await sql`select id from claim_revisions where project_id=${projectId} and claim_id=${claimId} and finalized_at is not null order by sequence desc limit 1`;
      const revisionId = String(latestRevision[0].id);
      const savedEvidence = await sql`select evidence_id from claim_revision_evidence_supports where project_id=${projectId} and claim_revision_id=${revisionId} order by evidence_id`;
      const savedExtraction = await sql`select extraction_revision_id from claim_revision_extraction_supports where project_id=${projectId} and claim_revision_id=${revisionId}`;
      const savedSynthesis = await sql`select synthesis_revision_id from claim_revision_synthesis_supports where project_id=${projectId} and claim_revision_id=${revisionId}`;
      expect(savedEvidence).toHaveLength(3);
      expect(savedExtraction.map((row) => String(row.extraction_revision_id))).toEqual([extractionRevisionId]);
      expect(savedSynthesis.map((row) => String(row.synthesis_revision_id))).toEqual([synthesisRevisionId]);

      await page.getByRole("button", { name: "Withdraw Claim" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Withdraw Claim" }).click();
      await expect(page).toHaveURL(new RegExp(`/claims/${claimId}\\?saved=withdrawn$`));
      await sql`insert into evidence_review_decisions (project_id, evidence_id, decision)
        select ${projectId}, evidence_id, 'rejected' from claim_revision_evidence_supports
        where project_id=${projectId} and claim_revision_id=${revisionId}`;
      await sql`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${projectId}, ${paperId}, 'maybe')`;

      await page.goto(`/projects/${projectId}/claims/${claimId}?synthesisRevisionId=${synthesisRevisionId}`);
      await expect(page.getByRole("heading", { name: "Reactivate Claim" })).toBeVisible();
      await expect(page.locator('input[type="hidden"][name="evidenceIds"]')).toHaveCount(0);
      await expect(page.locator('input[type="hidden"][name="extractionRevisionIds"]')).toHaveCount(0);
      await expect(page.locator(`input[type="hidden"][name="synthesisRevisionIds"][value="${synthesisRevisionId}"]`)).toHaveValue(synthesisRevisionId);
      const historicalContext = page.locator(".historical-support-context");
      await expect(historicalContext).toContainText("kept in the snapshot and not carried forward: 5");
      await historicalContext.locator("summary").click();
      await expect(historicalContext).toContainText("no longer meets current eligibility rules");
      await expect(historicalContext).toContainText("eligible, but reactivation requires explicit selection");
      await page.getByLabel("Claim text").fill("The Claim picker preserves exact support identity after reactivation.");
      await page.getByRole("button", { name: "Reactivate Claim" }).click();
      await expect(page).toHaveURL(new RegExp(`/claims/${claimId}\\?saved=reactivated$`));
      await expect(page.locator(".support-summary")).toContainText("1 supports");

      await page.goto(`/projects/${projectId}/claims/${claimId}`);
      await page.locator("#revision-claim-text").fill("An edit with a stale expected revision is rejected.");
      const concurrentRevisionId = uuid();
      await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text)
        values (${concurrentRevisionId}, ${projectId}, ${claimId}, 'active', 'Concurrent researcher edit.')`;
      await sql`update claim_revisions set finalized_at=now()
        where project_id=${projectId} and id=${concurrentRevisionId}`;
      await page.getByRole("button", { name: "Save new Claim revision" }).click();
      await expect(page.locator(".error-banner[role='alert']")).toContainText("Claim changed while this revision was being prepared");
    } finally {
      await sql.end();
    }
  });
});
