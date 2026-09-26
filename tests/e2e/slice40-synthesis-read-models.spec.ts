import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";

test.describe("Slice 40 Synthesis read models", () => {
  test("preserves exact support IDs across 51, 120, and 250 cross-page selections", async ({ page }) => {
    test.setTimeout(240_000);
    const unique = randomUUID().slice(0, 8);
    const titlePrefix = `Slice 40 exact ${unique}`;
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 40 selection ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    const sql = createPlaywrightTestDatabaseClient({ prepare: false });
    let fieldId = "";
    let expected: Array<{ paperId: string; paperTitle: string; extractionValueId: string; extractionRevisionId: string; sequence: number }> = [];
    try {
      const fields = await sql`insert into extraction_fields (project_id, name, field_type)
        values (${projectId}::uuid, 'Exact selection field', 'short_text') returning id`;
      fieldId = String(fields[0].id);
      await sql.begin(async (tx) => {
        await tx`insert into papers (project_id, title, authors, created_at, updated_at)
          select ${projectId}::uuid, ${titlePrefix} || ' Paper ' || lpad(n::text, 3, '0'), array['Slice 40 author'],
            '2026-09-01T00:00:00Z'::timestamptz + n * interval '1 minute',
            '2026-09-01T00:00:00Z'::timestamptz + n * interval '1 minute'
          from generate_series(1, 250) as n`;
        await tx`insert into screening_decisions (project_id, paper_id, decision)
          select ${projectId}::uuid, p.id, 'include' from papers p
          where p.project_id=${projectId}::uuid and p.title like ${`${titlePrefix} Paper %`}`;
        await tx`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at)
          select ${projectId}::uuid, p.id, 'retrieved', now() from papers p
          where p.project_id=${projectId}::uuid and p.title like ${`${titlePrefix} Paper %`}`;
        await tx`insert into full_text_screening_decisions (project_id, paper_id, decision)
          select ${projectId}::uuid, p.id, 'include' from papers p
          where p.project_id=${projectId}::uuid and p.title like ${`${titlePrefix} Paper %`}`;
        await tx`insert into extraction_values (project_id, paper_id, field_id)
          select ${projectId}::uuid, p.id, ${fieldId}::uuid from papers p
          where p.project_id=${projectId}::uuid and p.title like ${`${titlePrefix} Paper %`}`;
        await tx`insert into extraction_value_revisions
          (project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at)
          select ${projectId}::uuid, v.paper_id, v.field_id, v.id, 'short_text', 'present', 'Exact original ' || p.title, now()
          from extraction_values v join papers p on p.project_id=v.project_id and p.id=v.paper_id
          where v.project_id=${projectId}::uuid and v.field_id=${fieldId}::uuid
            and p.title like ${`${titlePrefix} Paper %`}`;
      });
      const rows = await sql`select p.id as paper_id, p.title as paper_title, v.id as extraction_value_id,
          r.id as extraction_revision_id, r.sequence
        from papers p join extraction_values v on v.project_id=p.project_id and v.paper_id=p.id
        join extraction_value_revisions r on r.project_id=v.project_id and r.extraction_value_id=v.id and r.finalized_at is not null
        where p.project_id=${projectId}::uuid and p.title like ${`${titlePrefix} Paper %`}
          and v.field_id=${fieldId}::uuid
        order by p.created_at, p.id`;
      expected = rows.map((row) => ({
        paperId: String(row.paper_id),
        paperTitle: String(row.paper_title),
        extractionValueId: String(row.extraction_value_id),
        extractionRevisionId: String(row.extraction_revision_id),
        sequence: Number(row.sequence),
      }));
      expect(expected).toHaveLength(250);
    } finally {
      // Keep the browser's app connection independent from this fixture connection.
      await sql.end();
    }

    await page.goto(`/projects/${projectId}/synthesis?fieldId=${fieldId}`);
    const form = page.locator('form[aria-label="Create Synthesis"]');
    const pager = page.getByRole("navigation", { name: "Evidence matrix pages" });
    const hiddenIds = form.locator('input[type="hidden"][name="extractionRevisionIds"]');
    const selected = new Set<string>();
    const addPaper = async (index: number) => {
      const item = expected[index - 1];
      const id = item.extractionRevisionId;
      if (selected.has(id)) return;
      await page.getByRole("checkbox", { name: `Select observation from ${item.paperTitle}` }).check();
      selected.add(id);
    };
    const addRange = async (start: number, end: number) => {
      for (let index = start; index <= end; index += 1) await addPaper(index);
    };
    const expectSelectionCount = async (count: number) => {
      await expect(hiddenIds).toHaveCount(count);
      expect(selected.size).toBe(count);
    };

    await expect(page.getByText("1–50 of 250", { exact: false })).toBeVisible();
    await addRange(1, 50);
    await expectSelectionCount(50);

    // The already selected exact revision becomes historical while page state is retained.
    const replacementClient = createPlaywrightTestDatabaseClient({ prepare: false });
    try {
      await replacementClient`insert into extraction_value_revisions
        (project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at)
        values (${projectId}::uuid, ${expected[0].paperId}::uuid, ${fieldId}::uuid, ${expected[0].extractionValueId}::uuid,
          'short_text', 'present', 'Concurrent later current value', now())`;
    } finally {
      await replacementClient.end();
    }

    await pager.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("51–100 of 250", { exact: false })).toBeVisible();
    await addPaper(51);
    await expectSelectionCount(51);
    await pager.getByRole("button", { name: "Previous" }).click();
    const currentRevisionCheckbox = page.getByRole("checkbox", { name: `Select observation from ${expected[0].paperTitle}` });
    await expect(currentRevisionCheckbox).toBeVisible();
    await expect(currentRevisionCheckbox).not.toBeChecked();
    await expect(form.locator(`input[type="hidden"][name="extractionRevisionIds"][value="${expected[0].extractionRevisionId}"]`)).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Selected Synthesis supports" })).toContainText(`Revision ${expected[0].sequence}`);

    await pager.getByRole("button", { name: "Next" }).click();
    await addRange(52, 100);
    await pager.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("101–150 of 250", { exact: false })).toBeVisible();
    await addRange(101, 120);
    await expectSelectionCount(120);
    await addRange(121, 150);
    await pager.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("151–200 of 250", { exact: false })).toBeVisible();
    await addRange(151, 200);
    await pager.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("201–250 of 250", { exact: false })).toBeVisible();
    await addRange(201, 250);
    await expectSelectionCount(250);

    const submittedIds = await hiddenIds.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value).sort());
    expect(new Set(submittedIds).size).toBe(250);
    expect(submittedIds).toEqual(expected.map((item) => item.extractionRevisionId).sort());
    await form.getByLabel("Topic or title").fill("Cross-page exact selection");
    await form.getByLabel("Synthesis statement").fill("All selected supports remain exact revision IDs across page changes.");
    await expect(page.getByRole("region", { name: "Selected Synthesis supports" }).locator(".count")).toHaveText("250");
    await form.getByRole("button", { name: "Create synthesis from selected observations" }).click();
    await expect(page).toHaveURL(/\/synthesis\/[0-9a-f-]+\?saved=created$/);

    const verify = createPlaywrightTestDatabaseClient({ prepare: false });
    try {
      const statementId = new URL(page.url()).pathname.split("/").pop()!;
      const revisionRows = await verify`select id from synthesis_revisions
        where project_id=${projectId}::uuid and synthesis_statement_id=${statementId}::uuid and finalized_at is not null
        order by sequence desc limit 1`;
      const savedRows = await verify`select extraction_revision_id from synthesis_revision_supports
        where project_id=${projectId}::uuid and synthesis_revision_id=${String(revisionRows[0].id)}::uuid
        order by extraction_revision_id`;
      expect(savedRows.map((row) => String(row.extraction_revision_id))).toEqual(expected.map((item) => item.extractionRevisionId).sort());
    } finally {
      await verify.end();
    }
  });

  test("keeps FT-excluded and archived-Field history readable and aligns edit eligibility", async ({ page }) => {
    test.setTimeout(180_000);
    const unique = randomUUID().slice(0, 8);
    const excludedTitle = `Slice 40 FT excluded ${unique}`;
    const archivedTitle = `Slice 40 archived field ${unique}`;
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 40 history ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;
    const sql = createPlaywrightTestDatabaseClient({ prepare: false });
    let statementId = "";
    let excludedRevisionId = "";
    let archivedRevisionId = "";
    let archivedFieldId = "";
    let archivedReplacementId = "";
    try {
      const ids = { excludedPaper: randomUUID(), archivedPaper: randomUUID(), excludedField: randomUUID(), archivedField: randomUUID(), excludedValue: randomUUID(), archivedValue: randomUUID(), excludedRevision: randomUUID(), archivedRevision: randomUUID(), archivedReplacement: randomUUID(), statement: randomUUID(), synthesisRevision: randomUUID(), fullTextCriterion: randomUUID() };
      await sql.begin(async (tx) => {
        await tx`insert into papers (id, project_id, title, authors) values
          (${ids.excludedPaper}::uuid, ${projectId}::uuid, ${excludedTitle}, array['Author']),
          (${ids.archivedPaper}::uuid, ${projectId}::uuid, ${archivedTitle}, array['Author'])`;
        await tx`insert into screening_decisions (project_id, paper_id, decision) values
          (${projectId}::uuid, ${ids.excludedPaper}::uuid, 'include'),
          (${projectId}::uuid, ${ids.archivedPaper}::uuid, 'include')`;
        await tx`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at) values
          (${projectId}::uuid, ${ids.excludedPaper}::uuid, 'retrieved', now()),
          (${projectId}::uuid, ${ids.archivedPaper}::uuid, 'retrieved', now())`;
        await tx`insert into full_text_screening_decisions (project_id, paper_id, decision) values
          (${projectId}::uuid, ${ids.excludedPaper}::uuid, 'include'),
          (${projectId}::uuid, ${ids.archivedPaper}::uuid, 'include')`;
        await tx`insert into extraction_fields (id, project_id, name, field_type) values
          (${ids.excludedField}::uuid, ${projectId}::uuid, 'FT eligibility field', 'short_text'),
          (${ids.archivedField}::uuid, ${projectId}::uuid, 'Archived history field', 'short_text')`;
        await tx`insert into extraction_values (id, project_id, paper_id, field_id) values
          (${ids.excludedValue}::uuid, ${projectId}::uuid, ${ids.excludedPaper}::uuid, ${ids.excludedField}::uuid),
          (${ids.archivedValue}::uuid, ${projectId}::uuid, ${ids.archivedPaper}::uuid, ${ids.archivedField}::uuid)`;
        await tx`insert into extraction_value_revisions (id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at) values
          (${ids.excludedRevision}::uuid, ${projectId}::uuid, ${ids.excludedPaper}::uuid, ${ids.excludedField}::uuid, ${ids.excludedValue}::uuid, 'short_text', 'present', 'Historical FT-excluded support', now()),
          (${ids.archivedRevision}::uuid, ${projectId}::uuid, ${ids.archivedPaper}::uuid, ${ids.archivedField}::uuid, ${ids.archivedValue}::uuid, 'short_text', 'present', 'Historical archived-field support', now())`;
        await tx`insert into full_text_screening_criteria (id, project_id, text)
          values (${ids.fullTextCriterion}::uuid, ${projectId}::uuid, 'Concurrent final exclusion')`;
        await tx`insert into synthesis_statements (id, project_id) values (${ids.statement}::uuid, ${projectId}::uuid)`;
        await tx`insert into synthesis_revisions (id, project_id, synthesis_statement_id, state, title, statement_text)
          values (${ids.synthesisRevision}::uuid, ${projectId}::uuid, ${ids.statement}::uuid, 'active', 'Historical eligibility fixture', 'Exact historical supports stay visible.')`;
        await tx`insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id) values
          (${projectId}::uuid, ${ids.synthesisRevision}::uuid, ${ids.excludedRevision}::uuid),
          (${projectId}::uuid, ${ids.synthesisRevision}::uuid, ${ids.archivedRevision}::uuid)`;
        await tx`update synthesis_revisions set finalized_at=now()
          where project_id=${projectId}::uuid and id=${ids.synthesisRevision}::uuid`;
        await tx`insert into extraction_value_revisions (id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at)
          values (${ids.archivedReplacement}::uuid, ${projectId}::uuid, ${ids.archivedPaper}::uuid, ${ids.archivedField}::uuid, ${ids.archivedValue}::uuid,
            'short_text', 'present', 'Latest value before Field archival', now())`;
        await tx`update extraction_fields set archived_at=now() where project_id=${projectId}::uuid and id=${ids.archivedField}::uuid`;
        await tx`insert into full_text_screening_decisions (project_id, paper_id, decision, exclusion_criterion_id)
          values (${projectId}::uuid, ${ids.excludedPaper}::uuid, 'exclude', ${ids.fullTextCriterion}::uuid)`;
      });
      statementId = ids.statement;
      excludedRevisionId = ids.excludedRevision;
      archivedRevisionId = ids.archivedRevision;
      archivedFieldId = ids.archivedField;
      archivedReplacementId = ids.archivedReplacement;
    } finally {
      await sql.end();
    }

    await page.goto(`/projects/${projectId}/synthesis/${statementId}`);
    const currentSupportList = page.locator(".workspace-grid > section").first();
    const excludedArticle = currentSupportList.locator("article.item").filter({ hasText: excludedTitle });
    const archivedArticle = currentSupportList.locator("article.item").filter({ hasText: archivedTitle });
    await expect(excludedArticle).toContainText("Historical FT-excluded support");
    await expect(excludedArticle).toContainText("Paper excluded");
    await expect(archivedArticle).toContainText("Historical archived-field support");
    await expect(page.getByText("Archived Field", { exact: false }).first()).toBeVisible();
    const excludedCheckbox = page.locator(`input[name="extractionRevisionIds"][value="${excludedRevisionId}"]`);
    await expect(excludedCheckbox).not.toBeChecked();
    await expect(excludedCheckbox).toBeDisabled();
    const archivedCheckbox = page.locator(`input[name="extractionRevisionIds"][value="${archivedRevisionId}"]`);
    await expect(archivedCheckbox).toBeChecked();
    await expect(archivedCheckbox).toBeEnabled();
    await expect(page.locator(`input[name="extractionRevisionIds"][value="${archivedReplacementId}"]`)).toHaveCount(0);
    await expect(page.getByText("Use current extraction", { exact: true })).toHaveCount(0);
    expect(archivedFieldId).toMatch(/[0-9a-f-]+/);
  });
});
