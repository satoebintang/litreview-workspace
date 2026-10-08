import { expect, test, type Page } from "@playwright/test";
import { addManualPaper } from "./manual-paper";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";

type Fixture = {
  projectId: string;
  paperId: string;
  fieldAId: string;
  fieldBId: string;
  candidateIds: Record<number, string>;
  worksheetPath: string;
};

async function createFixture(page: Page): Promise<Fixture> {
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectTitle = `Slice 55 Evidence selection ${unique}`;
  const paperTitle = `Slice 55 Paper ${unique}`;
  await page.goto("/");
  await page.getByLabel("Project title").fill(projectTitle);
  await page.getByRole("button", { name: /Create project/ }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
  const projectId = new URL(page.url()).pathname.split("/").at(-1)!;

  await page.goto(`/projects/${projectId}/papers`);
  await page.getByLabel("Title", { exact: true }).fill(paperTitle);
  await page.getByLabel("Authors").fill("Slice 55 Researcher");
  await page.getByLabel("Abstract").fill("A Paper for scalable Evidence selection coverage.");
  const paperId = await addManualPaper(page);

  const db = createPlaywrightTestDatabaseClient();
  try {
    await db`insert into screening_decisions (project_id, paper_id, decision) values (${projectId}::uuid, ${paperId}::uuid, 'include')`;
    await db`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at) values (${projectId}::uuid, ${paperId}::uuid, 'retrieved', now())`;
    await db`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${projectId}::uuid, ${paperId}::uuid, 'include')`;
    const fields = await db<{ id: string; name: string }[]>`insert into extraction_fields (project_id, name, field_type, required, sort_order)
      values (${projectId}::uuid, 'Primary outcome', 'short_text', true, 0), (${projectId}::uuid, 'Secondary outcome', 'short_text', false, 1)
      returning id::text as id, name`;
    const fieldAId = fields.find((field) => field.name === "Primary outcome")!.id;
    const fieldBId = fields.find((field) => field.name === "Secondary outcome")!.id;
    await db`insert into evidence (project_id, paper_id, source_text, note, page_number, created_at, updated_at)
      select ${projectId}::uuid, ${paperId}::uuid,
        'Candidate ' || lpad(series::text, 2, '0') || ' — outcome evidence 🙂 ' || repeat('x', 1205),
        'Evidence note ' || series::text || ' ' || repeat('n', 605),
        series,
        '2026-10-01T00:00:00Z'::timestamptz + series * interval '1 second',
        '2026-10-01T00:00:00Z'::timestamptz + series * interval '1 second'
      from generate_series(1, 25) as series`;
    await db`insert into evidence_review_decisions (project_id, evidence_id, decision)
      select ${projectId}::uuid, id,
        case page_number when 12 then 'rejected' when 11 then 'needs_review' else 'accepted' end
      from evidence where project_id=${projectId}::uuid and paper_id=${paperId}::uuid`;
    const candidates = await db<{ id: string; page_number: number }[]>`select id::text as id, page_number from evidence where project_id=${projectId}::uuid and paper_id=${paperId}::uuid`;
    return {
      projectId,
      paperId,
      fieldAId,
      fieldBId,
      candidateIds: Object.fromEntries(candidates.map((item) => [item.page_number, item.id])),
      worksheetPath: `/projects/${projectId}/extraction/${paperId}`,
    };
  } finally {
    await db.end();
  }
}

test.describe("Slice 55 scalable Paper Evidence selection", () => {
  test("shares one lazy browser, restores browse history, retains failed drafts, and supports no-JavaScript saves", async ({ page, browser }) => {
    test.setTimeout(240_000);
    const fixture = await createFixture(page);
    await page.goto(fixture.worksheetPath);

    const browserRegion = page.getByRole("region", { name: "Shared Evidence browser" });
    await expect(browserRegion).toHaveCount(1);
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(0);
    const fieldA = page.locator(`.extraction-value[data-extraction-field="${fixture.fieldAId}"]`);
    const fieldB = page.locator(`.extraction-value[data-extraction-field="${fixture.fieldBId}"]`);
    await fieldA.getByLabel("Structured value").fill("Draft outcome A");
    await fieldA.locator("textarea[name='researcherNote']").fill("Unsubmitted note A");
    await fieldB.getByLabel("Structured value").fill("Draft outcome B");
    await fieldB.locator("textarea[name='researcherNote']").fill("Unsubmitted note B");

    await fieldA.getByRole("button", { name: "Browse Evidence to add to Primary outcome" }).click();
    await expect(page).toHaveURL(new RegExp(`evidenceField=${fixture.fieldAId}`));
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await expect(browserRegion.locator(".candidate-evidence").filter({ hasText: "Candidate 25" })).toBeVisible();
    const candidate25 = browserRegion.locator(".candidate-evidence").filter({ hasText: "Candidate 25" });
    const candidateDetailPopupPromise = page.waitForEvent("popup");
    await candidate25.getByRole("link", { name: /Open exact Evidence detail/ }).click();
    const candidateDetailPopup = await candidateDetailPopupPromise;
    await expect(candidateDetailPopup).toHaveURL(new RegExp(`/evidence/${fixture.candidateIds[25]}$`));
    await expect(page).toHaveURL(new RegExp(`evidenceField=${fixture.fieldAId}`));
    await expect(fieldA.getByLabel("Structured value")).toHaveValue("Draft outcome A");
    await expect(fieldA.locator("textarea[name='researcherNote']")).toHaveValue("Unsubmitted note A");
    await candidateDetailPopup.close();
    const rejectedCandidate = browserRegion.locator(".candidate-evidence").filter({ hasText: "Candidate 12" });
    await expect(rejectedCandidate.getByText(/Rejected Evidence cannot be added/)).toBeVisible();
    await expect(rejectedCandidate.getByRole("button", { name: /Add to this Field/ })).toHaveCount(0);
    await expect(browserRegion.locator(".candidate-evidence").filter({ hasText: "Candidate 11" }).getByRole("button", { name: "Add to this Field" })).toBeEnabled();
    await browserRegion.locator(".candidate-evidence").filter({ hasText: "Candidate 25" }).getByRole("button", { name: "Add to this Field" }).click();

    await browserRegion.getByRole("button", { name: "Next Evidence page" }).click();
    await expect(page).toHaveURL(/evidenceAfter=/);
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(5);
    await page.goBack();
    await expect(page).not.toHaveURL(/evidenceAfter=/);
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await expect(fieldA.getByLabel("Structured value")).toHaveValue("Draft outcome A");
    await expect(fieldA.locator("textarea[name='researcherNote']")).toHaveValue("Unsubmitted note A");
    await page.goForward();
    await expect(page).toHaveURL(/evidenceAfter=/);
    const candidate05 = browserRegion.locator(".candidate-evidence").filter({ hasText: "Candidate 05" });
    await candidate05.getByRole("button", { name: "Add to this Field" }).click();
    const selectedCandidate05 = fieldA.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[5]}"]`);
    await expect(selectedCandidate05).toBeChecked();
    const selectedDetailPopupPromise = page.waitForEvent("popup");
    await fieldA.locator(".selected-evidence-support").filter({ hasText: "Candidate 05" }).getByRole("link", { name: /Open exact Evidence detail/ }).click();
    const selectedDetailPopup = await selectedDetailPopupPromise;
    await expect(selectedDetailPopup).toHaveURL(new RegExp(`/evidence/${fixture.candidateIds[5]}$`));
    await expect(page).toHaveURL(/evidenceAfter=/);
    await expect(fieldA.getByLabel("Structured value")).toHaveValue("Draft outcome A");
    await expect(fieldA.locator("textarea[name='researcherNote']")).toHaveValue("Unsubmitted note A");
    await expect(fieldA.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[25]}"]`)).toBeChecked();
    await expect(selectedCandidate05).toBeChecked();
    await selectedDetailPopup.close();
    await browserRegion.getByRole("button", { name: "First page" }).click();
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(20);
    await expect(selectedCandidate05).toBeVisible();

    await browserRegion.getByLabel("Field receiving added Evidence").selectOption(fixture.fieldBId);
    await expect(page).toHaveURL(new RegExp(`evidenceField=${fixture.fieldBId}`));
    await browserRegion.locator(".candidate-evidence").filter({ hasText: "Candidate 24" }).getByRole("button", { name: "Add to this Field" }).click();
    await expect(fieldB.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[24]}"]`)).toBeChecked();
    await expect(fieldB.getByLabel("Structured value")).toHaveValue("Draft outcome B");
    await expect(fieldB.locator("textarea[name='researcherNote']")).toHaveValue("Unsubmitted note B");
    await browserRegion.getByLabel("Field receiving added Evidence").selectOption(fixture.fieldAId);
    await expect(fieldA.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[25]}"]`)).toBeChecked();
    await expect(fieldA.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[5]}"]`)).toBeChecked();

    const db = createPlaywrightTestDatabaseClient();
    try {
      await db`insert into evidence_review_decisions (project_id, evidence_id, decision) values (${fixture.projectId}::uuid, ${fixture.candidateIds[5]}::uuid, 'rejected')`;
    } finally {
      await db.end();
    }
    await page.evaluate((fieldId) => {
      const target = window as unknown as { __slice55SubmittedEvidenceIds?: string[] | null };
      target.__slice55SubmittedEvidenceIds = null;
      const form = document.querySelector<HTMLFormElement>(`.extraction-value[data-extraction-field="${fieldId}"] .extraction-form`)!;
      form.addEventListener("formdata", (event) => {
        target.__slice55SubmittedEvidenceIds = event.formData.getAll("evidenceIds").filter((value): value is string => typeof value === "string");
      }, { once: true });
    }, fixture.fieldAId);
    await fieldA.getByRole("button", { name: "Save new revision" }).click();
    await expect(fieldA.getByRole("alert")).toContainText("Rejected Evidence cannot be used as new direct support");
    const submittedEvidenceIds = await page.evaluate(() => (window as unknown as { __slice55SubmittedEvidenceIds: string[] | null }).__slice55SubmittedEvidenceIds);
    expect(submittedEvidenceIds).toEqual([fixture.candidateIds[25], fixture.candidateIds[5]]);
    await expect(fieldA.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[5]}"]`)).toBeChecked();
    await expect(fieldA.getByText(/This current support stays selected until you remove it explicitly/)).toBeVisible();
    await expect(fieldA.getByLabel("Structured value")).toHaveValue("Draft outcome A");
    await expect(fieldA.locator("textarea[name='researcherNote']")).toHaveValue("Unsubmitted note A");

    await fieldA.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[5]}"]`).click({ noWaitAfter: true });
    await expect(fieldA.locator("input[name='evidenceIds']")).toHaveCount(1);
    await fieldA.getByRole("button", { name: "Save new revision" }).click();
    await expect(page).toHaveURL(new RegExp(`${fixture.worksheetPath.replaceAll("/", "\\/")}\\?saved=value(?:#.*)?$`));
    await expect(page.getByRole("status").filter({ hasText: "Extraction revision saved." })).toBeVisible();
    const savedFieldA = page.locator(`.extraction-value[data-extraction-field="${fixture.fieldAId}"]`);
    await expect(savedFieldA.locator(".current-observation")).toContainText("Draft outcome A");
    await expect(savedFieldA.locator("input[name='evidenceIds']")).toHaveCount(1);

    await savedFieldA.getByRole("link", { name: /Open Field revision history/ }).click();
    await expect(page).toHaveURL(new RegExp(`/fields/${fixture.fieldAId}/history$`));
    await page.getByRole("link", { name: /Open exact revision/ }).first().click();
    await expect(page.getByText("Exact immutable value", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: /Return to Field revision history/ }).click();
    await page.getByRole("link", { name: /Return to current worksheet/ }).click();
    await expect(page).toHaveURL(fixture.worksheetPath);

    const noJsContext = await browser.newContext({ baseURL: "http://127.0.0.1:3000", javaScriptEnabled: false });
    try {
      const noJsPage = await noJsContext.newPage();
      await noJsPage.goto(fixture.worksheetPath);
      const noJsField = noJsPage.locator(`.extraction-value[data-extraction-field="${fixture.fieldAId}"]`);
      await expect(noJsField.locator("input[name='evidenceIds']")).toHaveCount(1);
      const currentSupport = noJsField.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[25]}"]`);
      await expect(currentSupport).toBeChecked();
      await expect(noJsPage.getByText(/Browsing and adding additional Evidence requires JavaScript/).first()).toBeVisible();
      await noJsField.getByLabel("Structured value").fill("No-JavaScript attempted value");
      await noJsField.locator("textarea[name='researcherNote']").fill("No-JavaScript attempted note");

      const raceDb = createPlaywrightTestDatabaseClient();
      try {
        await raceDb`insert into evidence_review_decisions (project_id, evidence_id, decision) values (${fixture.projectId}::uuid, ${fixture.candidateIds[25]}::uuid, 'rejected')`;
      } finally {
        await raceDb.end();
      }
      await noJsField.getByRole("button", { name: "Save new revision" }).click();
      await expect(noJsPage).toHaveURL(new RegExp(`draftField=${fixture.fieldAId}`));
      await expect(noJsField.getByRole("alert")).toContainText("Rejected Evidence cannot be used as new direct support");
      await expect(noJsField.getByLabel("Structured value")).toHaveValue("No-JavaScript attempted value");
      await expect(noJsField.locator("textarea[name='researcherNote']")).toHaveValue("No-JavaScript attempted note");
      await expect(currentSupport).toBeChecked();
      await expect(noJsField.getByText(/This current support stays selected until you remove it explicitly/)).toBeVisible();
      await currentSupport.uncheck();
      await expect(currentSupport).not.toBeChecked();
      await noJsField.getByRole("button", { name: "Save new revision" }).click();
      await expect(noJsPage).toHaveURL(new RegExp(`${fixture.worksheetPath.replaceAll("/", "\\/")}\\?saved=value(?:#.*)?$`));
      await expect(noJsPage.locator(`.extraction-value[data-extraction-field="${fixture.fieldAId}"] .current-observation`)).toContainText("No-JavaScript attempted value");
      await expect(noJsPage.locator(`.extraction-value[data-extraction-field="${fixture.fieldAId}"] input[name="evidenceIds"]`)).toHaveCount(0);
      const verifyDb = createPlaywrightTestDatabaseClient();
      try {
        const revisions = await verifyDb<{ sequence: number; support_count: number }[]>`select revision.sequence, count(support.evidence_id)::int as support_count
          from extraction_value_revisions revision
          left join extraction_revision_evidence support on support.project_id=revision.project_id and support.revision_id=revision.id
          where revision.project_id=${fixture.projectId}::uuid and revision.paper_id=${fixture.paperId}::uuid and revision.field_id=${fixture.fieldAId}::uuid
          group by revision.id order by revision.sequence`;
        expect(revisions).toHaveLength(2);
        expect(revisions[0]?.support_count).toBe(1);
        expect(revisions[1]?.support_count).toBe(0);
      } finally {
        await verifyDb.end();
      }
    } finally {
      await noJsContext.close();
    }
  });

  test("ignores stale candidate responses and reports load failures without losing selected supports", async ({ page }) => {
    test.setTimeout(180_000);
    const fixture = await createFixture(page);
    let releaseFirstResponse!: () => void;
    let firstResponseReady!: () => void;
    let firstResponseFinished!: () => void;
    let secondResponseFinished!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
    const firstReady = new Promise<void>((resolve) => { firstResponseReady = resolve; });
    const firstFinished = new Promise<void>((resolve) => { firstResponseFinished = resolve; });
    const secondFinished = new Promise<void>((resolve) => { secondResponseFinished = resolve; });
    let actionRequestCount = 0;
    await page.route("**/api/projects/**/extraction-evidence**", async (route) => {
      const request = route.request();
      if (request.method() !== "GET") return route.continue();
      actionRequestCount += 1;
      if (actionRequestCount === 3) return route.abort("failed");
      const response = await route.fetch();
      if (actionRequestCount === 1) {
        firstResponseReady();
        await firstGate;
        await route.fulfill({ response });
        firstResponseFinished();
        return;
      }
      await route.fulfill({ response });
      if (actionRequestCount === 2) secondResponseFinished();
    });

    await page.goto(fixture.worksheetPath);
    const fieldA = page.locator(`.extraction-value[data-extraction-field="${fixture.fieldAId}"]`);
    await fieldA.getByRole("button", { name: "Browse Evidence to add to Primary outcome" }).click();
    await firstReady;
    const browserRegion = page.getByRole("region", { name: "Shared Evidence browser" });
    await browserRegion.getByLabel("Candidates per page").selectOption("50");
    await expect(browserRegion.getByRole("status").filter({ hasText: "Showing 25 candidates" })).toBeVisible();
    await secondFinished;
    releaseFirstResponse();
    await firstFinished;
    await expect(browserRegion.locator(".candidate-evidence")).toHaveCount(25);
    await expect(browserRegion.getByLabel("Candidates per page")).toHaveValue("50");

    await browserRegion.locator(".candidate-evidence").filter({ hasText: "Candidate 25" }).getByRole("button", { name: "Add to this Field" }).click();
    const selected = fieldA.locator(`input[name="evidenceIds"][value="${fixture.candidateIds[25]}"]`);
    await expect(selected).toBeChecked();
    await browserRegion.getByLabel("Candidates per page").selectOption("20");
    await expect(browserRegion.getByRole("alert")).toContainText("Selected supports were kept unchanged");
    await expect(selected).toBeChecked();
  });
});
