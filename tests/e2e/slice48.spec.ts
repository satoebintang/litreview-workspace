import { test, expect, type Page } from "@playwright/test";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";

async function getTestDbClient() {
  return createPlaywrightTestDatabaseClient({ prepare: false });
}

const uuid = () => crypto.randomUUID();

async function createProjectWithQuestion(page: Page, title: string) {
  await page.goto("/");
  await page.getByLabel("Project title").fill(`${title} ${Date.now()}`);
  await page.getByRole("button", { name: /Create project/ }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  const projectId = new URL(page.url()).pathname.split("/").pop()!;
  await page.goto(`/projects/${projectId}/protocol`);
  await page.getByLabel("Identifier").fill("RQ1");
  await page.getByLabel("Question").fill("Which evidence answers this review question?");
  await page.getByRole("button", { name: "Add research question" }).click();
  const sql = await getTestDbClient();
  const [row] = await sql`select id from research_questions where project_id=${projectId} and identifier='RQ1' limit 1`;
  return { projectId, questionId: String(row.id), sql };
}

test.describe("Slice 48 bounded Research Question browser", () => {
  test("paginates the matrix, lazily searches literal link targets, and refreshes stale picker cursors", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const duplicateKeyWarnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning" && message.text().includes("same key")) duplicateKeyWarnings.push(message.text());
    });
    const { projectId, questionId, sql } = await createProjectWithQuestion(page, "Slice 48 bounded matrix");
    try {
      await sql`
        insert into research_questions (project_id, identifier, label, sort_order, archived_at)
        select ${projectId}, 'RQX' || lpad(n::text, 2, '0'), 'Matrix question ' || lpad(n::text, 2, '0'), n,
          case when n=54 then now() else null end
        from generate_series(1,54) n
      `;
      await sql`
        insert into extraction_fields (project_id, name, field_type)
        select ${projectId}, case when n=1 then 'Literal 100%_ picker field' else 'Picker field ' || n::text end, 'short_text'
        from generate_series(1,55) n
      `;
      const [literalField] = await sql`select id from extraction_fields where project_id=${projectId} and name='Literal 100%_ picker field'`;

      await page.goto(`/projects/${projectId}/research-questions`);
      await expect(page.getByRole("heading", { name: "Traceability Matrix" })).toBeVisible();
      await expect(page.getByText("54 active · 1 archived")).toBeVisible();
      await page.getByRole("button", { name: "Next page" }).click();
      await expect(page.locator("tr", { hasText: "Matrix question 54" })).toContainText("Archived");
      await page.getByLabel("Show").selectOption("archived");
      await expect(page.locator("tr", { hasText: "Matrix question 54" })).toHaveCount(1);
      await expect(page.locator("tbody tr")).toHaveCount(1);

      await page.goto(`/projects/${projectId}/research-questions/${questionId}`);
      const extractionSection = page.locator("section", { hasText: "Extraction Fields" });
      await expect(extractionSection.locator("select[name='fieldId']")).toHaveCount(0);
      await extractionSection.getByRole("button", { name: "Browse fields" }).click();
      await page.getByLabel("Search by label").fill("%_");
      await extractionSection.getByRole("button", { name: "Search" }).click();
      await extractionSection.locator("select[name='fieldId']").selectOption(String(literalField.id));
      await extractionSection.locator("input[name='note']").fill("Literal search selected this exact field");
      await extractionSection.getByRole("button", { name: "Link field" }).click();
      await expect(page.getByText("Traceability link updated.")).toBeVisible();

      const refreshedLedger = page.locator("section", { hasText: "Extraction Fields" });
      await refreshedLedger.getByRole("link", { name: "Literal 100%_ picker field" }).click();
      await expect(page.getByRole("heading", { name: "Event History" })).toBeVisible();
      await expect(page.getByText("Literal search selected this exact field")).toBeVisible();
      await page.getByRole("button", { name: "Load included Paper coverage" }).click();
      await expect(page.getByText("No finally included Papers currently have a coverage row for this Field.")).toBeVisible();
      await sql`insert into research_question_extraction_field_events (project_id, research_question_id, extraction_field_id, action, note) values (${projectId}, ${questionId}, ${literalField.id}, 'unlinked', 'Later direct unlink for refresh')`;
      await page.getByRole("button", { name: "Refresh exact target" }).click();
      await expect(page.getByText("Currently unlinked", { exact: true })).toBeVisible();
      await expect(page.getByText("Later direct unlink for refresh")).toBeVisible();
      expect(duplicateKeyWarnings).toEqual([]);
      await page.getByRole("link", { name: "Back to Question workspace" }).click();

      const pickerSection = page.locator("section", { hasText: "Extraction Fields" });
      await pickerSection.getByRole("button", { name: "Browse fields" }).click();
      const [concurrentField] = await sql`select id from extraction_fields where project_id=${projectId} and name <> 'Literal 100%_ picker field' order by id limit 1`;
      await sql`insert into research_question_extraction_field_events (project_id, research_question_id, extraction_field_id, action) values (${projectId}, ${questionId}, ${concurrentField.id}, 'linked')`;
      await pickerSection.getByRole("button", { name: "Next candidates" }).click();
      await expect(pickerSection.locator(".curation-warning-box[role='alert']")).toContainText("Refresh picker");
      await pickerSection.getByRole("button", { name: "Refresh picker" }).click();
      await expect(pickerSection.locator("select[name='fieldId']")).toBeVisible();
    } finally {
      await sql.end();
    }
  });

  test("retains cross-page exact Claim and Synthesis selections through search and finalizes a bounded snapshot", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const { projectId, questionId, sql } = await createProjectWithQuestion(page, "Slice 48 Answer selection");
    try {
      const paperId = uuid();
      const evidenceId = uuid();
      const fieldId = uuid();
      const valueId = uuid();
      const extractionRevisionId = uuid();
      await sql`insert into papers (id, project_id, title) values (${paperId}, ${projectId}, 'Slice 48 supported context paper')`;
      await sql`insert into evidence (id, project_id, paper_id, source_text, page_number) values (${evidenceId}, ${projectId}, ${paperId}, 'One evidence passage supports the test candidates.', 1)`;
      await sql`insert into extraction_fields (id, project_id, name, field_type) values (${fieldId}, ${projectId}, 'Slice 48 synthesis field', 'short_text')`;
      await sql`insert into extraction_values (id, project_id, paper_id, field_id) values (${valueId}, ${projectId}, ${paperId}, ${fieldId})`;
      await sql`insert into extraction_value_revisions (id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at) values (${extractionRevisionId}, ${projectId}, ${paperId}, ${fieldId}, ${valueId}, 'short_text', 'present', 'Observed synthesis source', now())`;
      for (let index = 1; index <= 27; index += 1) {
        const statementId = uuid();
        const revisionId = uuid();
        await sql`insert into synthesis_statements (id, project_id) values (${statementId}, ${projectId})`;
        await sql`insert into synthesis_revisions (id, project_id, synthesis_statement_id, state, title, statement_text) values (${revisionId}, ${projectId}, ${statementId}, 'active', ${`Cross-page synthesis context ${index}`}, ${`Synthesis statement ${index} supports measured outcome.`})`;
        await sql`insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id) values (${projectId}, ${revisionId}, ${extractionRevisionId})`;
        await sql`update synthesis_revisions set finalized_at=now() where project_id=${projectId} and id=${revisionId}`;
        await sql`insert into research_question_synthesis_statement_events (project_id, research_question_id, synthesis_statement_id, action) values (${projectId}, ${questionId}, ${statementId}, 'linked')`;
      }

      for (let index = 1; index <= 27; index += 1) {
        const claimId = uuid();
        const revisionId = uuid();
        await sql`insert into claims (id, project_id) values (${claimId}, ${projectId})`;
        await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${revisionId}, ${projectId}, ${claimId}, 'active', ${`Context claim ${index}`})`;
        await sql`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${projectId}, ${revisionId}, ${evidenceId})`;
        await sql`update claim_revisions set finalized_at=now() where project_id=${projectId} and id=${revisionId}`;
        await sql`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${projectId}, ${questionId}, ${claimId}, 'linked')`;
      }

      await page.goto(`/projects/${projectId}/research-questions/${questionId}`);
      const answerWorkspace = page.getByTestId("answer-workspace");
      await page.getByLabel("Researcher-authored Answer").fill("Two exact Claim revisions and two Synthesis revisions answer the question.");
      await answerWorkspace.getByRole("button", { name: "Browse Claim candidates" }).click();
      const claimSection = answerWorkspace.getByRole("heading", { name: "Claim contexts", exact: true }).locator("xpath=ancestor::section[1]");
      const candidates = claimSection.locator('[data-testid="answer-candidate-checkbox"]');
      await expect(candidates).toHaveCount(25);
      const firstClaimRevisionIds = await candidates.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).dataset.revisionId));
      await candidates.first().check();
      await answerWorkspace.getByRole("button", { name: "Next claim" }).click();
      const nextCandidates = claimSection.locator('[data-testid="answer-candidate-checkbox"]');
      await expect(nextCandidates).toHaveCount(2);
      const nextClaimRevisionIds = await nextCandidates.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).dataset.revisionId));
      expect(firstClaimRevisionIds).not.toContain(nextClaimRevisionIds[0]);
      await nextCandidates.first().check();

      await answerWorkspace.getByLabel("Search claim labels").fill("Context claim 2");
      await answerWorkspace.getByRole("button", { name: "Search" }).click();
      await expect(answerWorkspace.locator('input[type="hidden"][name="claimRevisionIds"]')).toHaveCount(2);
      await expect(answerWorkspace.getByText("2 Claim · 0 Synthesis", { exact: true })).toBeVisible();

      await answerWorkspace.getByRole("button", { name: "Browse Synthesis candidates" }).click();
      const synthesisSection = answerWorkspace.getByRole("heading", { name: "Synthesis contexts", exact: true }).locator("xpath=ancestor::section[1]");
      const synthesisCandidates = synthesisSection.locator('[data-testid="answer-candidate-checkbox"]');
      await expect(synthesisCandidates).toHaveCount(25);
      const firstSynthesisRevisionIds = await synthesisCandidates.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).dataset.revisionId));
      await synthesisCandidates.first().check();
      await answerWorkspace.getByRole("button", { name: "Next synthesis" }).click();
      const laterSynthesisCandidates = synthesisSection.locator('[data-testid="answer-candidate-checkbox"]');
      await expect(laterSynthesisCandidates).toHaveCount(2);
      const nextSynthesisRevisionIds = await laterSynthesisCandidates.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).dataset.revisionId));
      expect(firstSynthesisRevisionIds).not.toContain(nextSynthesisRevisionIds[0]);
      await laterSynthesisCandidates.first().check();
      await answerWorkspace.getByLabel("Search synthesis labels").fill("Cross-page synthesis context 2");
      await answerWorkspace.getByRole("button", { name: "Search" }).last().click();
      await expect(answerWorkspace.locator('input[type="hidden"][name="synthesisRevisionIds"]')).toHaveCount(2);
      await expect(answerWorkspace.getByText("2 Claim · 2 Synthesis", { exact: true })).toBeVisible();
      await answerWorkspace.getByRole("button", { name: "Finalize Answer snapshot" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/research-questions/${questionId}/answers/[0-9a-f-]+\\?saved=answer$`));
      await expect(page.getByTestId("answer-snapshot-page")).toBeVisible();
      await expect(page.getByText(/Synthesis statement \d+ supports measured outcome\./)).toHaveCount(2);

      const answerId = new URL(page.url()).pathname.split("/").pop()!;
      const [claimContext] = await sql`select claim_id, claim_revision_id from research_question_answer_claim_contexts where project_id=${projectId} and research_question_id=${questionId} and answer_id=${answerId} order by sort_order, claim_revision_id limit 1`;
      for (let index = 1; index <= 10; index += 1) {
        const historyAnswerId = uuid();
        await sql.begin(async (tx) => {
          await tx`insert into research_question_answers (id, project_id, research_question_id, answer_text, researcher_note) values (${historyAnswerId}, ${projectId}, ${questionId}, ${`Additional bounded history snapshot ${index}`}, null)`;
          await tx`insert into research_question_answer_claim_contexts (project_id, research_question_id, answer_id, claim_id, claim_revision_id, sort_order) values (${projectId}, ${questionId}, ${historyAnswerId}, ${claimContext.claim_id}, ${claimContext.claim_revision_id}, 0)`;
          await tx`update research_question_answers set finalized_at=now() where project_id=${projectId} and id=${historyAnswerId}`;
        });
      }
      await page.goto(`/projects/${projectId}/research-questions/${questionId}`);
      await expect(page.getByTestId("answer-history-row")).toHaveCount(10);
      await expect(page.getByText("Additional bounded history snapshot 10", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Next Answers" }).click();
      await expect(page.getByTestId("answer-history-row")).toHaveCount(1);
      await expect(page.getByText("Two exact Claim revisions and two Synthesis revisions answer the question.", { exact: true })).toBeVisible();
    } finally {
      await sql.end();
    }
  });

  test("replaces every typed ledger page and pages finally included Paper coverage", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const { projectId, questionId, sql } = await createProjectWithQuestion(page, "Slice 48 typed ledger paging");
    try {
      await sql.begin(async (tx) => {
        for (let index = 1; index <= 26; index += 1) {
          const fieldId = uuid();
          const setId = uuid();
          const statementId = uuid();
          const claimId = uuid();
          const paperId = uuid();
          await tx`insert into extraction_fields (id, project_id, name, field_type) values (${fieldId}, ${projectId}, ${`Paged Field ${String(index).padStart(2, "0")}`}, 'short_text')`;
          await tx`insert into research_question_extraction_field_events (project_id, research_question_id, extraction_field_id, action) values (${projectId}, ${questionId}, ${fieldId}, 'linked')`;
          await tx`insert into evidence_sets (id, project_id, name) values (${setId}, ${projectId}, ${`Paged Evidence Set ${String(index).padStart(2, "0")}`})`;
          await tx`insert into evidence_set_composition_revisions (project_id, evidence_set_id, operation_kind, target_membership_id, move_direction, head_membership_id, tail_membership_id) values (${projectId}, ${setId}, 'created', null, null, null, null)`;
          await tx`insert into research_question_evidence_set_events (project_id, research_question_id, evidence_set_id, action) values (${projectId}, ${questionId}, ${setId}, 'linked')`;
          await tx`insert into synthesis_statements (id, project_id) values (${statementId}, ${projectId})`;
          await tx`insert into research_question_synthesis_statement_events (project_id, research_question_id, synthesis_statement_id, action) values (${projectId}, ${questionId}, ${statementId}, 'linked')`;
          await tx`insert into claims (id, project_id) values (${claimId}, ${projectId})`;
          await tx`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${projectId}, ${questionId}, ${claimId}, 'linked')`;

          await tx`insert into papers (id, project_id, title) values (${paperId}, ${projectId}, ${`Coverage pagination Paper ${String(index).padStart(2, "0")}`})`;
          await tx`insert into screening_decisions (project_id, paper_id, decision) values (${projectId}, ${paperId}, 'include')`;
          await tx`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at) values (${projectId}, ${paperId}, 'retrieved', now())`;
          await tx`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${projectId}, ${paperId}, 'include')`;
        }
      });

      await page.goto(`/projects/${projectId}/research-questions/${questionId}`);
      const ledgers = [
        "Extraction Fields",
        "Evidence Sets",
        "Synthesis Statements",
        "Manuscript Claims",
      ];
      for (const heading of ledgers) {
        const ledger = page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) }).first();
        const firstPage = ledger.locator("article");
        await expect(firstPage).toHaveCount(25);
        const firstPageIds = await ledger.locator("article code").allTextContents();
        await ledger.getByRole("button", { name: "Next page" }).click();
        await expect(ledger.locator("article")).toHaveCount(1);
        const nextPageIds = await ledger.locator("article code").allTextContents();
        expect(firstPageIds).not.toContain(nextPageIds[0]);
      }

      const fields = page.locator("section").filter({ has: page.getByRole("heading", { name: "Extraction Fields", exact: true }) }).first();
      const exactFieldHref = await fields.locator("article a").first().getAttribute("href");
      expect(exactFieldHref).toBeTruthy();
      await page.goto(exactFieldHref!);
      const coverage = page.locator("section").filter({ has: page.getByRole("heading", { name: "Finally included Paper coverage", exact: true }) }).first();
      await coverage.getByRole("button", { name: "Load included Paper coverage" }).click();
      await expect(coverage.locator("article")).toHaveCount(25);
      const firstCoveragePageIds = await coverage.locator("article code").allTextContents();
      await coverage.getByRole("button", { name: "Next Papers" }).click();
      await expect(coverage.locator("article")).toHaveCount(1);
      const lastCoveragePaperId = (await coverage.locator("article code").allTextContents())[0];
      expect(firstCoveragePageIds).not.toContain(lastCoveragePaperId);
      await expect(coverage).toContainText("no_finalized_revision");
    } finally {
      await sql.end();
    }
  });

  test("resets exact Field coverage on client navigation between same-Question targets at one epoch", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(30_000);
    const duplicateKeyWarnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning" && message.text().includes("same key")) duplicateKeyWarnings.push(message.text());
    });
    const { projectId, questionId, sql } = await createProjectWithQuestion(page, "Slice 48 exact Field state key");
    try {
      const fieldAId = uuid();
      const fieldBId = uuid();
      const paperId = uuid();
      const valueId = uuid();
      const revisionId = uuid();
      await sql`insert into extraction_fields (id, project_id, name, field_type) values (${fieldAId}, ${projectId}, 'Field A with data', 'short_text')`;
      await sql`insert into extraction_fields (id, project_id, name, field_type) values (${fieldBId}, ${projectId}, 'Field B without data', 'short_text')`;
      await sql`insert into research_question_extraction_field_events (project_id, research_question_id, extraction_field_id, action) values (${projectId}, ${questionId}, ${fieldAId}, 'linked')`;
      await sql`insert into research_question_extraction_field_events (project_id, research_question_id, extraction_field_id, action) values (${projectId}, ${questionId}, ${fieldBId}, 'linked')`;
      await sql`insert into papers (id, project_id, title) values (${paperId}, ${projectId}, 'Only Field A coverage Paper')`;
      await sql`insert into screening_decisions (project_id, paper_id, decision) values (${projectId}, ${paperId}, 'include')`;
      await sql`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at) values (${projectId}, ${paperId}, 'retrieved', now())`;
      await sql`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${projectId}, ${paperId}, 'include')`;
      await sql`insert into extraction_values (id, project_id, paper_id, field_id) values (${valueId}, ${projectId}, ${paperId}, ${fieldAId})`;
      await sql`insert into extraction_value_revisions (id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at) values (${revisionId}, ${projectId}, ${paperId}, ${fieldAId}, ${valueId}, 'short_text', 'present', 'Only A exact value', now())`;
      const [before] = await sql`select traceability_epoch::text as epoch from research_questions where project_id=${projectId} and id=${questionId}`;

      await page.goto(`/projects/${projectId}/research-questions/${questionId}`);
      const ledger = page.locator("section", { hasText: "Extraction Fields" });
      await ledger.getByRole("link", { name: "Field A with data" }).click();
      await expect(page.getByRole("heading", { name: /Extraction Field · Field A with data/ })).toBeVisible();
      await page.getByRole("button", { name: "Load included Paper coverage" }).click();
      await expect(page.getByText("Only Field A coverage Paper", { exact: true })).toBeVisible();
      await expect(page.getByText("Only A exact value", { exact: true })).toBeVisible();

      await page.getByRole("link", { name: "Back to Question workspace" }).click();
      await page.locator("section", { hasText: "Extraction Fields" }).getByRole("link", { name: "Field B without data" }).click();
      await expect(page.getByRole("heading", { name: /Extraction Field · Field B without data/ })).toBeVisible();
      await expect(page.getByText(/no current included-Paper data/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Load included Paper coverage" })).toBeVisible();
      await expect(page.getByText("Only A exact value", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Load included Paper coverage" }).click();
      await expect(page.getByText("Only Field A coverage Paper", { exact: true })).toBeVisible();
      await expect(page.getByText(/no_finalized_revision/)).toBeVisible();
      await expect(page.getByText("Only A exact value", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Event History" })).toBeVisible();
      const [after] = await sql`select traceability_epoch::text as epoch from research_questions where project_id=${projectId} and id=${questionId}`;
      expect(after.epoch).toBe(before.epoch);
      expect(duplicateKeyWarnings).toEqual([]);
    } finally {
      await sql.end();
    }
  });
});
