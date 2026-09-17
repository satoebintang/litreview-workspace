import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgres://litreview:litreview@127.0.0.1:5432/litreview";

async function getTestDbClient() {
  const markerPath = path.resolve(process.cwd(), ".ai", "playwright-db.json");
  if (fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (marker.adminUrl && marker.databaseName) {
        const base = marker.adminUrl.replace(/\/[^/]+$/, "");
        return postgres(`${base}/${marker.databaseName}`, { max: 1, prepare: false });
      }
    } catch {
      // Fall through to the configured test database.
    }
  }
  return postgres(process.env.DATABASE_URL || DEFAULT_DATABASE_URL, { max: 1, prepare: false });
}

const uuid = () => crypto.randomUUID();

type ClaimFixture = { claimId: string; revisionId: string; evidenceId: string };

async function addClaim(sql: postgres.Sql, projectId: string, paperId: string, index: number): Promise<ClaimFixture> {
  const claimId = uuid();
  const revisionId = uuid();
  const evidenceId = uuid();
  await sql`insert into evidence (id, project_id, paper_id, source_text, page_number) values (${evidenceId}, ${projectId}, ${paperId}, ${`Evidence passage ${index}`}, ${index})`;
  await sql`insert into claims (id, project_id) values (${claimId}, ${projectId})`;
  await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${revisionId}, ${projectId}, ${claimId}, 'active', ${`Claim ${index} states the supported finding.`})`;
  await sql`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${projectId}, ${revisionId}, ${evidenceId})`;
  await sql`update claim_revisions set finalized_at = now() where project_id = ${projectId} and id = ${revisionId}`;
  return { claimId, revisionId, evidenceId };
}

async function addSynthesisFixture(sql: postgres.Sql, projectId: string, paperId: string, questionId: string) {
  const fieldId = uuid();
  const extractionValueId = uuid();
  const extractionRevisionId = uuid();
  const statementId = uuid();
  const revisionId = uuid();
  await sql`insert into extraction_fields (id, project_id, name, field_type) values (${fieldId}, ${projectId}, 'Slice 22 observation', 'short_text')`;
  await sql`insert into extraction_values (id, project_id, paper_id, field_id) values (${extractionValueId}, ${projectId}, ${paperId}, ${fieldId})`;
  await sql`insert into extraction_value_revisions (id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at) values (${extractionRevisionId}, ${projectId}, ${paperId}, ${fieldId}, ${extractionValueId}, 'short_text', 'present', 'Observed synthesis input', now())`;
  await sql`insert into synthesis_statements (id, project_id) values (${statementId}, ${projectId})`;
  await sql`insert into synthesis_revisions (id, project_id, synthesis_statement_id, state, title, statement_text) values (${revisionId}, ${projectId}, ${statementId}, 'active', 'Synthesis context', 'Exact synthesis context.')`;
  await sql`insert into synthesis_revision_supports (project_id, synthesis_revision_id, extraction_revision_id) values (${projectId}, ${revisionId}, ${extractionRevisionId})`;
  await sql`update synthesis_revisions set finalized_at = now() where project_id = ${projectId} and id = ${revisionId}`;
  await sql`insert into research_question_synthesis_statement_events (project_id, research_question_id, synthesis_statement_id, action) values (${projectId}, ${questionId}, ${statementId}, 'linked')`;
  return { statementId, revisionId };
}

async function addSynthesisOnlyAnswer(sql: postgres.Sql, projectId: string, questionId: string, statementId: string, revisionId: string) {
  const answerId = uuid();
  await sql.begin(async (tx) => {
    await tx`insert into research_question_answers (id, project_id, research_question_id, answer_text, researcher_note) values (${answerId}, ${projectId}, ${questionId}, 'Synthesis-only answer text.', 'Synthesis note stays context-only.')`;
    await tx`insert into research_question_answer_synthesis_contexts (project_id, research_question_id, answer_id, synthesis_statement_id, synthesis_revision_id, sort_order) values (${projectId}, ${questionId}, ${answerId}, ${statementId}, ${revisionId}, 0)`;
    await tx`update research_question_answers set finalized_at = now() where project_id = ${projectId} and id = ${answerId}`;
  });
  return answerId;
}

async function answerAndTraceabilityRows(sql: postgres.Sql, projectId: string, questionId: string) {
  const answers = await sql`
    select id, sequence, answer_text, researcher_note, finalized_at
    from research_question_answers
    where project_id = ${projectId} and research_question_id = ${questionId}
    order by sequence, id
  `;
  const claimContexts = await sql`
    select answer_id, claim_id, claim_revision_id, sort_order
    from research_question_answer_claim_contexts
    where project_id = ${projectId} and research_question_id = ${questionId}
    order by answer_id, sort_order, claim_revision_id
  `;
  const synthesisContexts = await sql`
    select answer_id, synthesis_statement_id, synthesis_revision_id, sort_order
    from research_question_answer_synthesis_contexts
    where project_id = ${projectId} and research_question_id = ${questionId}
    order by answer_id, sort_order, synthesis_revision_id
  `;
  const traceability = await sql`
    select sequence, claim_id, action, note
    from research_question_claim_events
    where project_id = ${projectId} and research_question_id = ${questionId}
    order by sequence, id
  `;
  const synthesisTraceability = await sql`
    select sequence, synthesis_statement_id, action, note
    from research_question_synthesis_statement_events
    where project_id = ${projectId} and research_question_id = ${questionId}
    order by sequence, id
  `;
  return JSON.stringify({ answers, claimContexts, synthesisContexts, traceability, synthesisTraceability });
}

test.describe.serial("Slice 22 Answer-centric manuscript workflow", () => {
  test("drafts exact Answer context into ordinary manuscript blocks and preserves provenance", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 22 E2E ${Date.now()}`);
    await page.getByLabel("Research question").fill("Which supported finding answers the question?");
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    const sql = await getTestDbClient();
    try {
      const [question] = await sql`select id from research_questions where project_id = ${projectId} and identifier = 'RQ1' limit 1`;
      const questionId = String(question.id);
      const paperOneId = uuid();
      const paperTwoId = uuid();
      await sql`insert into papers (id, project_id, title) values (${paperOneId}, ${projectId}, 'Slice 22 citation paper 1')`;
      await sql`insert into papers (id, project_id, title) values (${paperTwoId}, ${projectId}, 'Slice 22 citation paper 2')`;
      const claimOne = await addClaim(sql, projectId, paperOneId, 1);
      const claimTwo = await addClaim(sql, projectId, paperTwoId, 2);
      for (const claim of [claimOne, claimTwo]) {
        await sql`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${projectId}, ${questionId}, ${claim.claimId}, 'linked')`;
      }
      const synthesis = await addSynthesisFixture(sql, projectId, paperOneId, questionId);

      await page.goto(`/projects/${projectId}/research-questions/${questionId}`);
      await expect(page.getByTestId("answer-workspace")).toBeVisible();
      await page.getByLabel("Researcher-authored Answer").fill("The supported intervention improves the measured outcome.");
      await page.getByTestId("answer-workspace").getByLabel(/Researcher note/).fill("Context note must not become prose.");
      await page.locator(`input[name="claimRevisionIds"][value="${claimOne.revisionId}"]`).check();
      await page.locator(`input[name="claimRevisionIds"][value="${claimTwo.revisionId}"]`).check();
      await page.getByRole("button", { name: "Finalize Answer snapshot" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/research-questions/${questionId}/answers/[0-9a-f-]+\\?saved=answer$`));
      await expect(page.getByTestId("answer-snapshot-page")).toBeVisible();
      const answerId = new URL(page.url()).pathname.split("/").pop()!;
      await expect(page.getByText("The supported intervention improves the measured outcome.", { exact: true })).toBeVisible();
      await expect(page.getByText("Researcher note: Context note must not become prose.", { exact: true })).toBeVisible();

      await page.goto(`/projects/${projectId}/manuscript`);
      await page.getByLabel("Section title").fill("Answer Draft");
      await page.getByRole("button", { name: "Create section" }).click();
      await expect(page.getByRole("heading", { name: "Answer Draft" })).toBeVisible();
      await page.getByLabel("New prose for Answer Draft").fill("Existing anchor prose.");
      await page.getByRole("button", { name: "+ Add prose" }).click();
      await expect(page.getByText("Existing anchor prose.", { exact: true })).toBeVisible();
      for (const title of ["Claim Only", "Prose Only", "Archived Target"]) {
        await page.getByLabel("Section title").fill(title);
        await page.getByRole("button", { name: "Create section" }).click();
        await expect(page.getByRole("heading", { name: title })).toBeVisible();
      }
      const [manuscript] = await sql`select id from manuscripts where project_id = ${projectId} order by is_default desc, id limit 1`;
      const sections = await sql`select id, title from manuscript_sections where project_id = ${projectId} order by sort_order, id`;
      const sectionId = (title: string) => String(sections.find((row) => row.title === title)!.id);
      const manuscriptId = String(manuscript.id);
      const answerSectionId = sectionId("Answer Draft");
      const claimOnlySectionId = sectionId("Claim Only");
      const proseOnlySectionId = sectionId("Prose Only");
      const archivedSectionId = sectionId("Archived Target");
      const [anchor] = await sql`select id from manuscript_section_items where project_id = ${projectId} and section_id = ${answerSectionId} and removed_at is null order by sort_order, id limit 1`;
      const anchorId = String(anchor.id);

      const beforeApplication = await answerAndTraceabilityRows(sql, projectId, questionId);
      await page.goto(`/projects/${projectId}/research-questions/${questionId}/answers/${answerId}`);
      await expect(page.getByTestId("answer-snapshot-page")).toBeVisible();
      await page.getByTestId("use-answer-in-manuscript").click();
      await expect(page).toHaveURL(new RegExp(`/answers/${answerId}/manuscript`));
      await expect(page.getByTestId("answer-drafting-context")).toBeVisible();
      await expect(page.getByTestId("answer-text")).toHaveText("The supported intervention improves the measured outcome.");
      await expect(page.getByTestId("answer-researcher-note")).toContainText("Context note must not become prose.");
      await expect(page.getByLabel("Manuscript prose")).toHaveValue("The supported intervention improves the measured outcome.");
      await expect(page.getByTestId("answer-researcher-note").locator("textarea, input")).toHaveCount(0);

      const answerClaims = page.getByTestId("answer-claim-revisions");
      const firstArticle = answerClaims.locator(`article[data-claim-revision-id="${claimOne.revisionId}"]`);
      const secondArticle = answerClaims.locator(`article[data-claim-revision-id="${claimTwo.revisionId}"]`);
      await firstArticle.getByRole("checkbox").check();
      await secondArticle.getByRole("checkbox").check();
      await secondArticle.getByRole("button", { name: "Move ClaimRevision earlier" }).click();
      await expect(secondArticle.getByText("#1", { exact: true })).toBeVisible();
      await expect(firstArticle.getByText("#2", { exact: true })).toBeVisible();
      await page.getByLabel("Manuscript prose").fill("Edited researcher prose.");
      await page.locator('input[name="insertionKind"][value="before"]').check();
      await page.getByLabel("Active SectionItem anchor").selectOption(anchorId);
      await page.getByTestId("apply-answer-to-manuscript").click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/manuscript\\?saved=answer$`));

      const afterApplication = await answerAndTraceabilityRows(sql, projectId, questionId);
      expect(afterApplication).toBe(beforeApplication);
      const orderedItems = await sql`
        select i.item_type, i.sort_order, p.claim_revision_id, r.prose_text as text
        from manuscript_section_items i
        left join manuscript_claim_placements p on p.project_id = i.project_id and p.id = i.id
        left join manuscript_prose_blocks b on b.project_id = i.project_id and b.section_item_id = i.id
        left join lateral (select prose_text from manuscript_prose_revisions r0 where r0.project_id = b.project_id and r0.prose_block_id = b.id order by r0.sequence desc limit 1) r on true
        where i.project_id = ${projectId} and i.section_id = ${answerSectionId} and i.removed_at is null
        order by i.sort_order, i.id
      `;
      expect(orderedItems.map((row) => String(row.item_type))).toEqual(["prose", "claim", "claim", "prose"]);
      expect(String(orderedItems[0].text)).toBe("Edited researcher prose.");
      expect(String(orderedItems[1].claim_revision_id)).toBe(claimTwo.revisionId);
      expect(String(orderedItems[2].claim_revision_id)).toBe(claimOne.revisionId);
      expect(String(orderedItems[3].text)).toBe("Existing anchor prose.");

      await expect(page.getByText("Edited researcher prose.", { exact: true })).toBeVisible();
      await expect(page.getByText("Claim 1 states the supported finding.", { exact: true }).last()).toBeVisible();
      await expect(page.getByText("Claim 2 states the supported finding.", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Bibliography candidates" })).toBeVisible();
      await expect(page.getByText("Slice 22 citation paper 1", { exact: true })).toBeVisible();
      await expect(page.getByText("Slice 22 citation paper 2", { exact: true })).toBeVisible();
      await expect(page.getByText(/citation numbers: \[1\]/)).toBeVisible();
      await expect(page.getByText(/citation numbers: \[2\]/)).toBeVisible();
      await expect(page.getByLabel("Citation style")).toHaveValue("numeric");
      await page.getByLabel("Citation style").selectOption("author_year");
      await page.getByRole("button", { name: "Apply style" }).click();
      await expect(page.getByText("(Slice 22 citation paper 1, n.d.)", { exact: true })).toBeVisible();
      await expect(page.getByText("(Slice 22 citation paper 2, n.d.)", { exact: true })).toBeVisible();

      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("link", { name: "Export Markdown" }).click();
      const download = await downloadPromise;
      const stream = await download.createReadStream();
      let markdown = "";
      if (stream) for await (const chunk of stream) markdown += chunk.toString();
      expect(markdown).toContain("# Manuscript");
      expect(markdown).toContain("Edited researcher prose.");
      expect(markdown).toContain("Claim 1 states the supported finding.");
      expect(markdown).toContain("(Slice 22 citation paper 1, n.d.)");
      expect(markdown).toContain("(Slice 22 citation paper 2, n.d.)");
      expect(markdown).not.toMatch(/Answer marker|answerId|Answer origin/i);

      const synthesisAnswerId = await addSynthesisOnlyAnswer(sql, projectId, questionId, synthesis.statementId, synthesis.revisionId);
      const beforeSynthesisApplication = await answerAndTraceabilityRows(sql, projectId, questionId);
      const placementsBeforeSynthesis = await sql`select count(*)::integer as count from manuscript_claim_placements where project_id = ${projectId}`;
      await page.goto(`/projects/${projectId}/research-questions/${questionId}/answers/${synthesisAnswerId}/manuscript?manuscriptId=${manuscriptId}&sectionId=${proseOnlySectionId}`);
      await expect(page.getByTestId("answer-synthesis-contexts")).toBeVisible();
      await expect(page.getByTestId("answer-claim-revisions")).toContainText("This Answer has no ClaimRevision contexts.");
      await expect(page.getByTestId("answer-claim-revisions").locator("input[type=checkbox]")).toHaveCount(0);
      await page.getByLabel("Manuscript prose").fill("Synthesis-only ordinary prose.");
      await page.getByTestId("apply-answer-to-manuscript").click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/manuscript\\?saved=answer$`));
      const placementsAfterSynthesis = await sql`select count(*)::integer as count from manuscript_claim_placements where project_id = ${projectId}`;
      expect(Number(placementsAfterSynthesis[0].count)).toBe(Number(placementsBeforeSynthesis[0].count));
      const proseOnlyItems = await sql`select item_type from manuscript_section_items where project_id = ${projectId} and section_id = ${proseOnlySectionId} and removed_at is null order by sort_order, id`;
      expect(proseOnlyItems.map((row) => String(row.item_type))).toEqual(["prose"]);
      await expect(page.getByText("Synthesis-only ordinary prose.", { exact: true })).toBeVisible();

      await sql`update research_questions set archived_at = now() where project_id = ${projectId} and id = ${questionId}`;
      await sql`update manuscript_sections set archived_at = now() where project_id = ${projectId} and id = ${archivedSectionId}`;
      await page.goto(`/projects/${projectId}/research-questions/${questionId}/answers/${answerId}/manuscript?manuscriptId=${manuscriptId}&sectionId=${claimOnlySectionId}`);
      await expect(page.getByTestId("archived-rq-notice")).toContainText("Research Question archived");
      await expect(page.getByTestId("archived-rq-notice")).toContainText("drafting remains available");
      await expect(page.getByRole("link", { name: "Archived Target", exact: true })).toHaveCount(0);
      await page.getByLabel("Manuscript prose").fill("");
      await page.getByTestId("answer-claim-revisions").locator(`article[data-claim-revision-id="${claimOne.revisionId}"] input[type="checkbox"]`).check();
      await page.getByTestId("apply-answer-to-manuscript").click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/manuscript\\?saved=answer$`));
      const claimOnlyItems = await sql`select item_type from manuscript_section_items where project_id = ${projectId} and section_id = ${claimOnlySectionId} and removed_at is null order by sort_order, id`;
      expect(claimOnlyItems.map((row) => String(row.item_type))).toEqual(["claim"]);
      await expect(page.getByText("Claim 1 states the supported finding.", { exact: true }).last()).toBeVisible();

      const finalRows = await answerAndTraceabilityRows(sql, projectId, questionId);
      expect(finalRows).toBe(beforeSynthesisApplication);
    } finally {
      await sql.end();
    }
  });
});
