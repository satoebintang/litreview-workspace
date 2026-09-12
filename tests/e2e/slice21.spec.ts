import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgres://litreview:litreview@127.0.0.1:5432/litreview";

async function getTestDbClient() {
  const databaseMarkerPath = path.resolve(process.cwd(), ".ai", "playwright-db.json");
  if (fs.existsSync(databaseMarkerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(databaseMarkerPath, "utf8"));
      if (marker.adminUrl && marker.databaseName) {
        const base = marker.adminUrl.replace(/\/[^/]+$/, "");
        return postgres(`${base}/${marker.databaseName}`, { max: 1, prepare: false });
      }
    } catch {
      // fall back to the configured test database
    }
  }
  return postgres(process.env.DATABASE_URL || DEFAULT_DATABASE_URL, { max: 1, prepare: false });
}

const uuid = () => crypto.randomUUID();

test.describe("Slice 21 Research Question Answers", () => {
  test("creates an exact-context Answer, refreshes after a revision conflict, and derives historical drift", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 21 Answer Review ${Date.now()}`);
    await page.getByLabel("Research question").fill("Which supported finding answers the question?");
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    const sql = await getTestDbClient();
    try {
      const questionRows = await sql`
        select id from research_questions
        where project_id = ${projectId} and identifier = 'RQ1'
        limit 1
      `;
      const questionId = String(questionRows[0].id);
      const paperId = uuid();
      const evidenceId = uuid();
      const claimId = uuid();
      const firstRevisionId = uuid();
      const secondRevisionId = uuid();
      const withdrawnRevisionId = uuid();

      await sql`insert into papers (id, project_id, title) values (${paperId}, ${projectId}, 'Answer fixture paper')`;
      await sql`insert into evidence (id, project_id, paper_id, source_text, page_number) values (${evidenceId}, ${projectId}, ${paperId}, 'The supported finding.', 1)`;
      await sql`insert into claims (id, project_id) values (${claimId}, ${projectId})`;
      await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${firstRevisionId}, ${projectId}, ${claimId}, 'active', 'The first supported finding.')`;
      await sql`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${projectId}, ${firstRevisionId}, ${evidenceId})`;
      await sql`update claim_revisions set finalized_at = now() where project_id = ${projectId} and id = ${firstRevisionId}`;
      await sql`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${projectId}, ${questionId}, ${claimId}, 'linked')`;

      await page.goto(`/projects/${projectId}/research-questions/${questionId}`);
      await expect(page.getByTestId("answer-workspace")).toBeVisible();
      const firstCandidate = page.locator('input[name="claimRevisionIds"]');
      await expect(firstCandidate).toHaveValue(firstRevisionId);

      // A newer finalized revision wins while the page still contains the
      // first exact ID. The action must reject and the Server Component must
      // refresh the candidate list rather than silently floating the ID.
      await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${secondRevisionId}, ${projectId}, ${claimId}, 'active', 'The newer supported finding.')`;
      await sql`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${projectId}, ${secondRevisionId}, ${evidenceId})`;
      await sql`update claim_revisions set finalized_at = now() where project_id = ${projectId} and id = ${secondRevisionId}`;

      await page.getByLabel("Researcher-authored Answer").fill("The answer records the supported finding.");
      await firstCandidate.check();
      await page.getByRole("button", { name: "Finalize Answer snapshot" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/research-questions/${questionId}\\?error=`));
      await expect(page.locator(".error-banner")).toContainText(/no longer the current finalized revision/i);
      await expect(page.locator('input[name="claimRevisionIds"]')).toHaveValue(secondRevisionId);

      await page.getByLabel("Researcher-authored Answer").fill("The answer records the newer supported finding.");
      await page.locator(`input[name="claimRevisionIds"][value="${secondRevisionId}"]`).check();
      await page.getByRole("button", { name: "Finalize Answer snapshot" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/research-questions/${questionId}/answers/[0-9a-f-]+\\?saved=answer$`));
      await expect(page.getByTestId("answer-snapshot-page")).toBeVisible();
      await expect(page.getByText("The answer records the newer supported finding.", { exact: true })).toBeVisible();

      const answerId = new URL(page.url()).pathname.split("/").pop()!;
      const [storedContext] = await sql`
        select claim_revision_id from research_question_answer_claim_contexts
        where project_id = ${projectId} and answer_id = ${answerId}
      `;
      expect(String(storedContext.claim_revision_id)).toBe(secondRevisionId);

      // Withdrawal is represented by the next exact revision, while unlink
      // is represented by the later traceability event. Both are read-time
      // drift on this immutable Answer, never a historical rewrite.
      await sql`insert into claim_revisions (id, project_id, claim_id, state, claim_text) values (${withdrawnRevisionId}, ${projectId}, ${claimId}, 'withdrawn', null)`;
      await sql`update claim_revisions set finalized_at = now() where project_id = ${projectId} and id = ${withdrawnRevisionId}`;
      await sql`insert into research_question_claim_events (project_id, research_question_id, claim_id, action) values (${projectId}, ${questionId}, ${claimId}, 'unlinked')`;

      await page.reload();
      await expect(page.getByText("Claim revision superseded")).toBeVisible();
      await expect(page.getByText("Claim now withdrawn")).toBeVisible();
      await expect(page.getByText("Claim no longer linked to this RQ")).toBeVisible();
      await expect(page.getByText("The answer records the newer supported finding.", { exact: true })).toBeVisible();
    } finally {
      await sql.end();
    }
  });
});
