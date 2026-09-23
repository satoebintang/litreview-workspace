import { createHash, randomUUID } from "node:crypto";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";
import { expect, test } from "@playwright/test";


async function getTestDbClient() {
  return createPlaywrightTestDatabaseClient({ prepare: false });
}

test.describe("Slice 31 batch AI extraction orchestration", () => {
  test("previews, processes, reviews, accepts, and resumes an immutable batch", async ({ page }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(30_000);

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 31 browser batch ${Date.now()}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;
    const sql = await getTestDbClient();
    const paperOneId = randomUUID();
    const paperTwoId = randomUUID();
    const outcomeFieldId = randomUUID();
    const noCandidateFieldId = randomUUID();
    const clearedFieldId = randomUUID();
    const clearedValueId = randomUUID();
    const clearedRevisionId = randomUUID();
    const papers = [
      { id: paperOneId, title: "Batch candidate paper", text: "The study reports 42 participants." },
      { id: paperTwoId, title: "Batch no-candidate paper", text: "The study reports no usable outcome." },
    ];
    const fields = [
      { id: outcomeFieldId, name: "Outcome", sortOrder: 0 },
      { id: noCandidateFieldId, name: "No candidate", sortOrder: 1 },
      { id: clearedFieldId, name: "Cleared", sortOrder: 2 },
    ];
    const documents = papers.map((paper) => ({ paper, id: randomUUID(), extractionId: randomUUID(), pageId: randomUUID() }));
    const items = [
      { paperId: paperOneId, fieldId: outcomeFieldId, idempotencyKey: randomUUID() },
      { paperId: paperTwoId, fieldId: noCandidateFieldId, idempotencyKey: randomUUID() },
      { paperId: paperOneId, fieldId: clearedFieldId, idempotencyKey: randomUUID() },
    ];
    try {
      await sql.begin(async (tx) => {
        for (const paper of papers) {
          await tx`insert into papers (id, project_id, title, abstract) values (${paper.id}::uuid, ${projectId}::uuid, ${paper.title}, ${`${paper.title} abstract`})`;
          await tx`insert into screening_decisions (project_id, paper_id, decision) values (${projectId}::uuid, ${paper.id}::uuid, 'include')`;
          await tx`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at) values (${projectId}::uuid, ${paper.id}::uuid, 'retrieved', now())`;
          await tx`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${projectId}::uuid, ${paper.id}::uuid, 'include')`;
        }
        for (const field of fields) await tx`insert into extraction_fields (id, project_id, name, field_type, required, sort_order) values (${field.id}::uuid, ${projectId}::uuid, ${field.name}, 'short_text', true, ${field.sortOrder})`;
        for (const { paper, id, extractionId, pageId } of documents) {
          const bytes = Buffer.from(`%PDF-1.7\n${paper.id}`);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          await tx`insert into full_text_documents (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256) values (${id}::uuid, ${projectId}::uuid, ${paper.id}::uuid, ${`projects/${projectId}/papers/${paper.id}/documents/${id}/source.pdf`}, ${`${paper.title}.pdf`}, 'application/pdf', ${bytes.byteLength}, ${sha256})`;
          await tx`insert into paper_full_text_preferences (project_id, paper_id, full_text_document_id) values (${projectId}::uuid, ${paper.id}::uuid, ${id}::uuid)`;
          await tx`insert into document_text_extractions (id, project_id, paper_id, full_text_document_id, extractor_key, extractor_version, algorithm_version, status, page_count, character_count, started_at, completed_at) values (${extractionId}::uuid, ${projectId}::uuid, ${paper.id}::uuid, ${id}::uuid, 'fixture', '1', '1', 'succeeded', 1, ${Array.from(paper.text).length}, now(), now())`;
          await tx`insert into document_text_extraction_pages (id, project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count) values (${pageId}::uuid, ${projectId}::uuid, ${paper.id}::uuid, ${extractionId}::uuid, 1, 'succeeded', ${paper.text}, ${Array.from(paper.text).length})`;
        }
        await tx`insert into extraction_values (id, project_id, paper_id, field_id) values (${clearedValueId}::uuid, ${projectId}::uuid, ${paperOneId}::uuid, ${clearedFieldId}::uuid)`;
        await tx`insert into extraction_value_revisions (id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, finalized_at) values (${clearedRevisionId}::uuid, ${projectId}::uuid, ${paperOneId}::uuid, ${clearedFieldId}::uuid, ${clearedValueId}::uuid, 'short_text', 'cleared', now())`;
      });

      const itemsJson = JSON.stringify(items);
      await page.goto(`/projects/${projectId}/extraction/batches/new`);
      await page.locator("#batch-items").fill(itemsJson);
      await page.locator('input[name="externalTransmissionAcknowledged"]').first().check();
      await page.getByRole("button", { name: "Preview eligibility" }).click();
      await expect(page).toHaveURL(/previewHash=/);
      await expect(page.getByRole("status")).toContainText("Preview: 3 cells · 2 executable");
      const previewHash = new URL(page.url()).searchParams.get("previewHash");
      expect(previewHash).toMatch(/^[0-9a-f]{64}$/);

      await page.locator("#batch-items-confirm").fill(itemsJson);
      await page.locator('input[name="externalTransmissionAcknowledged"]').nth(1).check();
      await page.getByRole("button", { name: "Create batch" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/extraction/batches/[0-9a-f-]+$`));
      const batchId = new URL(page.url()).pathname.split("/").pop()!;
      await expect(page.locator(".workspace-header").getByText(/3 cells · .* · Active/)).toBeVisible();
      expect(await sql`select count(*)::int as count from extraction_value_revisions where project_id=${projectId}::uuid and field_id=${clearedFieldId}::uuid`).toEqual([{ count: 1 }]);
      expect(await sql`select count(*)::int as count from ai_extraction_requests where project_id=${projectId}::uuid`).toEqual([{ count: 0 }]);
      await expect(page.getByText("An existing cleared value was found.", { exact: false })).toBeVisible();
      await expect(page.getByRole("link", { name: "Continue in the individual extraction workflow." })).toHaveAttribute("href", `/projects/${projectId}/extraction/${paperOneId}`);

      await page.getByRole("button", { name: "Process next two" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/extraction/batches/${batchId}$`));
      await expect(page.locator(".status").filter({ hasText: "Suggestion ready" })).toBeVisible();
      await expect(page.locator(".status").filter({ hasText: "No candidate" })).toBeVisible();
      expect(await sql`select count(*)::int as count from ai_extraction_requests where project_id=${projectId}::uuid`).toEqual([{ count: 2 }]);
      expect(await sql`select count(*)::int as count from ai_extraction_dispatches where project_id=${projectId}::uuid`).toEqual([{ count: 2 }]);
      expect(await sql`select count(*)::int as count from extraction_value_revisions where project_id=${projectId}::uuid and field_id in (${outcomeFieldId}::uuid, ${noCandidateFieldId}::uuid)`).toEqual([{ count: 0 }]);

      const outcomeItem = page.locator("article.item").filter({ hasText: "Batch candidate paper" });
      await outcomeItem.getByRole("link", { name: /Review AI suggestion/ }).click();
      await expect(page.getByRole("heading", { name: "Outcome" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit & accept" })).toBeVisible();
      await page.locator('form.extraction-form input[name="value"]').last().fill("42 participants");
      await page.locator('form.extraction-form textarea[name="researcherNote"]').fill("Accepted from the reviewed batch suggestion.");
      const acceptedSuggestionUrl = new URL(page.url());
      acceptedSuggestionUrl.search = "?saved=accepted";
      await page.getByRole("button", { name: "Edit & accept" }).click();
      await expect(page).toHaveURL(acceptedSuggestionUrl.toString());
      await expect(page.getByText("AI suggestion accepted as a new canonical extraction revision.")).toBeVisible();
      expect(await sql`select count(*)::int as count from extraction_value_revisions where project_id=${projectId}::uuid and paper_id=${paperOneId}::uuid and field_id=${outcomeFieldId}::uuid`).toEqual([{ count: 1 }]);

      await page.goto(`/projects/${projectId}/extraction/batches/${batchId}`);
      await expect(page.locator(".status").filter({ hasText: "Accepted" })).toBeVisible();
      await expect(page.locator("span.status").filter({ hasText: "No candidate" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Continue in the individual extraction workflow." })).toHaveAttribute("href", `/projects/${projectId}/extraction/${paperOneId}`);
      const requestCount = await sql`select count(*)::int as count from ai_extraction_requests where project_id=${projectId}::uuid`;
      await page.reload();
      expect(await sql`select count(*)::int as count from ai_extraction_requests where project_id=${projectId}::uuid`).toEqual(requestCount);
      expect(await sql`select count(*)::int as count from ai_extraction_dispatches where project_id=${projectId}::uuid`).toEqual([{ count: 2 }]);
    } finally {
      await sql.end();
    }
  });
});
