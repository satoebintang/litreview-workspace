import { createHash, randomUUID } from "node:crypto";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";
import { expect, test } from "@playwright/test";


async function getTestDbClient() {
  return createPlaywrightTestDatabaseClient({ prepare: false });
}

test.describe("Slice 26 AI extraction proposal boundary", () => {
  test("keeps a proposal outside canonical extraction until edit-and-accept", async ({ page }) => {
    const sql = await getTestDbClient();
    const projectId = randomUUID();
    const paperId = randomUUID();
    const fieldId = randomUUID();
    const documentId = randomUUID();
    const extractionId = randomUUID();
    const pageId = randomUUID();
    const requestId = randomUUID();
    const requestPageId = randomUUID();
    const resultId = randomUUID();
    const groundingId = randomUUID();
    const text = "The intervention included 42 participants.";
    const quote = "42 participants";
    const quoteIndex = text.indexOf(quote);
    const startOffset = Array.from(text.slice(0, quoteIndex)).length;
    const endOffset = startOffset + Array.from(quote).length;
    const bytes = Buffer.from("%PDF-1.7\nfixture");
    const documentHash = createHash("sha256").update(bytes).digest("hex");
    const pageHash = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    try {
      await sql.begin(async (tx) => {
        await tx`insert into projects (id, title) values (${projectId}::uuid, 'Slice 26 browser proposal')`;
        await tx`insert into papers (id, project_id, title) values (${paperId}::uuid, ${projectId}::uuid, 'AI proposal study')`;
        await tx`insert into screening_decisions (project_id, paper_id, decision) values (${projectId}::uuid, ${paperId}::uuid, 'include')`;
        await tx`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at) values (${projectId}::uuid, ${paperId}::uuid, 'retrieved', now())`;
        await tx`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${projectId}::uuid, ${paperId}::uuid, 'include')`;
        await tx`insert into extraction_fields (id, project_id, name, description, field_type, required, sort_order) values (${fieldId}::uuid, ${projectId}::uuid, 'Participants', 'Reported sample size', 'short_text', true, 0)`;
        await tx`insert into full_text_documents (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256, storage_state, staged_storage_key) values (${documentId}::uuid, ${projectId}::uuid, ${paperId}::uuid, ${`projects/${projectId}/papers/${paperId}/documents/${documentId}/source.pdf`}, 'study.pdf', 'application/pdf', ${bytes.byteLength}, ${documentHash}, 'ready', null)`;
        await tx`insert into paper_full_text_preferences (project_id, paper_id, full_text_document_id) values (${projectId}::uuid, ${paperId}::uuid, ${documentId}::uuid)`;
        await tx`insert into document_text_extractions (id, project_id, paper_id, full_text_document_id, extractor_key, extractor_version, algorithm_version, status, page_count, character_count, started_at, completed_at) values (${extractionId}::uuid, ${projectId}::uuid, ${paperId}::uuid, ${documentId}::uuid, 'fixture', '1', '1', 'succeeded', 1, ${Array.from(text).length}, now(), now())`;
        await tx`insert into document_text_extraction_pages (id, project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count) values (${pageId}::uuid, ${projectId}::uuid, ${paperId}::uuid, ${extractionId}::uuid, 1, 'succeeded', ${text}, ${Array.from(text).length})`;
        await tx`insert into ai_extraction_requests (id, project_id, paper_id, extraction_field_id, full_text_document_id, document_text_extraction_id, idempotency_key, intent_hash, field_name_snapshot, field_description_snapshot, field_type, option_snapshot, provider, configured_model, configured_reasoning_effort, prompt_version, response_schema_version, grounding_resolver_version, context_selection_version, source_character_count, source_byte_size, page_manifest_hash, external_transmission_acknowledged, disclosure_version, finalized_at) values (${requestId}::uuid, ${projectId}::uuid, ${paperId}::uuid, ${fieldId}::uuid, ${documentId}::uuid, ${extractionId}::uuid, ${randomUUID()}::uuid, ${"a".repeat(64)}, 'Participants', 'Reported sample size', 'short_text', '[]'::jsonb, 'openai', 'gpt-5.6-luna', 'low', 'extraction-suggestion-v1', 'extraction-suggestion-response-v1', 'exact-page-quote-v1', 'selected-pages-v1', ${Array.from(text).length}, ${Buffer.byteLength(text, "utf8")}, ${"b".repeat(64)}, true, 'openai-extraction-transmission-v1', now())`;
        await tx`insert into ai_extraction_request_pages (id, project_id, request_id, page_id, paper_id, full_text_document_id, document_text_extraction_id, page_number, page_ordinal, text_sha256, character_count, byte_size) values (${requestPageId}::uuid, ${projectId}::uuid, ${requestId}::uuid, ${pageId}::uuid, ${paperId}::uuid, ${documentId}::uuid, ${extractionId}::uuid, 1, 0, ${pageHash}, ${Array.from(text).length}, ${Buffer.byteLength(text, "utf8")})`;
        await tx`insert into ai_extraction_results (id, project_id, request_id, outcome, provider_diagnostic, candidate_state, text_value, explanation, configured_model, finalized_at) values (${resultId}::uuid, ${projectId}::uuid, ${requestId}::uuid, 'succeeded', 'success', 'present', ${quote}, 'The sample size is stated in the page.', 'gpt-5.6-luna', now())`;
        await tx`insert into ai_extraction_result_groundings (id, project_id, request_id, result_id, page_id, page_number, start_offset, end_offset, locator_quote, source_text) values (${groundingId}::uuid, ${projectId}::uuid, ${requestId}::uuid, ${resultId}::uuid, ${pageId}::uuid, 1, ${startOffset}, ${endOffset}, ${quote}, ${quote})`;
      });

      await page.goto(`/projects/${projectId}/extraction/${paperId}`);
      const field = page.locator(".extraction-value").filter({ hasText: "Participants" });
      await expect(field.getByText("Not yet extracted", { exact: true })).toBeVisible();

      await page.goto(`/projects/${projectId}/extraction/${paperId}/suggestions/${requestId}`);
      await expect(page.locator(".current-observation").filter({ hasText: "Suggested value:" })).toContainText(quote);
      await page.getByRole("textbox", { name: "Edited value" }).fill("43 participants");
      await page.getByRole("button", { name: "Edit & accept" }).click();
      await expect(page.getByRole("status")).toContainText("AI suggestion accepted");
      await expect(page.locator(".current-observation").filter({ hasText: "Suggested value:" })).toContainText(quote);

      await page.goto(`/projects/${projectId}/extraction/${paperId}`);
      const acceptedField = page.locator(".extraction-value").filter({ hasText: "Participants" });
      await expect(acceptedField.locator(".current-observation")).toContainText("43 participants");
      await acceptedField.getByText(/Revision history/).click();
      await expect(acceptedField.locator(".history-evidence").filter({ hasText: quote })).toBeVisible();
    } finally {
      await sql.end();
    }
  });
});
