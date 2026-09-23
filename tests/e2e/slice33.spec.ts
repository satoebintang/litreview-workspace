import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { expect, test, type Page } from "@playwright/test";

const DEFAULT_DATABASE_URL = "postgres://litreview:litreview@127.0.0.1:5432/litreview";

async function getTestDbClient() {
  const markerPath = path.resolve(process.cwd(), ".ai", "playwright-db.json");
  if (fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (marker.adminUrl && marker.databaseName) return postgres(`${marker.adminUrl.replace(/\/[^/]+$/, "")}/${marker.databaseName}`, { max: 1, prepare: false });
    } catch {
      // Fall through to the configured test database.
    }
  }
  return postgres(process.env.DATABASE_URL || DEFAULT_DATABASE_URL, { max: 1, prepare: false });
}

async function expectDraftRevision(page: Page, revision: number) {
  await expect(page.getByText(`1 · mutable draft revision ${revision}`, { exact: true })).toBeVisible();
  await expect(page.locator('input[name="expectedDraftRevision"]').first()).toHaveValue(String(revision));
}

test.describe("Slice 33 critical appraisal foundation", () => {
  test("keeps custom framework identity and accessible researcher controls through the appraisal lifecycle", async ({ page }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(30_000);
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto("/");
    const projectTitle = `Slice 33 browser appraisal ${Date.now()}`;
    await page.getByLabel("Project title").fill(projectTitle);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;
    const paperId = randomUUID();
    const evidenceId = randomUUID();
    const sql = await getTestDbClient();

    try {
      await sql.begin(async (tx) => {
        await tx`insert into papers (id, project_id, title, abstract) values (${paperId}::uuid, ${projectId}::uuid, 'Slice 33 included study', 'Included study abstract')`;
        await tx`insert into screening_decisions (project_id, paper_id, decision) values (${projectId}::uuid, ${paperId}::uuid, 'include')`;
        await tx`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at) values (${projectId}::uuid, ${paperId}::uuid, 'retrieved', now())`;
        await tx`insert into full_text_screening_decisions (project_id, paper_id, decision) values (${projectId}::uuid, ${paperId}::uuid, 'include')`;
        await tx`insert into evidence (id, project_id, paper_id, source_text, page_number, note) values (${evidenceId}::uuid, ${projectId}::uuid, ${paperId}::uuid, 'The study design was prospectively specified.', 3, 'Synthetic browser fixture')`;
      });

      await page.goto(`/projects/${projectId}/appraisal/frameworks/new`);
      await page.getByLabel("Name").fill("Custom design appraisal");
      await page.getByRole("button", { name: "Create framework" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/appraisal/frameworks/[0-9a-f-]+$`));
      const frameworkId = new URL(page.url()).pathname.split("/").at(-1)!;
      await page.getByRole("link", { name: "Open draft editor" }).click();
      await expect(page.getByRole("heading", { name: /version 1/i })).toBeVisible();
      await expect(page.getByText("Custom framework", { exact: true }).first()).toBeVisible();
      await expectDraftRevision(page, 0);
      const staleTab = await page.context().newPage();
      await staleTab.goto(page.url());
      await expectDraftRevision(staleTab, 0);

      await page.getByLabel("New section label").fill("Study design");
      await page.getByRole("button", { name: "Add section" }).click();
      await expectDraftRevision(page, 1);
      await staleTab.getByLabel("New section label").fill("Stale tab section");
      await staleTab.getByRole("button", { name: "Add section" }).click();
      const staleDraftError = "This framework draft changed in another session. Reload the current definition before making further edits.";
      await expect(staleTab.getByRole("alert").filter({ hasText: staleDraftError })).toContainText(staleDraftError);
      await expect(staleTab).toHaveURL(/error=/);
      expect(staleTab.url()).not.toContain("constraint");
      await page.reload();
      await expectDraftRevision(page, 1);
      await expect(page.locator('article[id^="draft-section-"]')).toHaveCount(1);
      await staleTab.close();
      await page.getByLabel("New section label").fill("Recruitment");
      await page.getByRole("button", { name: "Add section" }).click();
      await expectDraftRevision(page, 2);
      const studySection = page.locator('article[id^="draft-section-"]').filter({ hasText: "Study design" }).first();
      const studySectionId = await studySection.getAttribute("id");
      await expect(page.getByRole("button", { name: "Move section “Study design” up" })).toBeDisabled();
      const moveSectionDown = page.getByRole("button", { name: "Move section “Study design” down" });
      await moveSectionDown.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/saved=reordered/);
      await expectDraftRevision(page, 3);
      await expect(page.locator(`#${studySectionId}`)).toBeFocused();
      const sectionOrder = await page.locator('article[id^="draft-section-"] > .item-row .item-title').allTextContents();
      expect(sectionOrder).toEqual(["Recruitment", "Study design"]);
      await expect(page.getByRole("button", { name: "Move section “Recruitment” up" })).toBeDisabled();

      const studyDesignCard = page.locator('article[id^="draft-section-"]').filter({ hasText: "Study design" }).first();
      const addItemForm = studyDesignCard.locator('form[id^="add-item-"]');
      await addItemForm.getByRole("checkbox").check();
      await addItemForm.getByRole("textbox", { name: "New item in Study design", exact: true }).fill("Is the study design appropriate?");
      await addItemForm.getByRole("button", { name: "Add item" }).click();
      await expectDraftRevision(page, 4);
      await addItemForm.getByRole("textbox", { name: "New item in Study design", exact: true }).fill("Were methods prespecified?");
      await addItemForm.getByRole("button", { name: "Add item" }).click();
      await expectDraftRevision(page, 5);

      const firstItem = studyDesignCard.locator(".nested-item").filter({ hasText: "Is the study design appropriate?" }).first();
      await firstItem.getByLabel("New response key for Is the study design appropriate?").fill("yes");
      await firstItem.getByLabel("New response label for Is the study design appropriate?").fill("Yes");
      await firstItem.getByRole("button", { name: "Add option" }).click();
      await expectDraftRevision(page, 6);
      await firstItem.getByLabel("New response key for Is the study design appropriate?").fill("unclear");
      await firstItem.getByLabel("New response label for Is the study design appropriate?").fill("Unclear");
      await firstItem.getByRole("button", { name: "Add option" }).click();
      await expectDraftRevision(page, 7);
      const moveOptionDown = page.getByRole("button", { name: "Move response-option “Yes” down" });
      await moveOptionDown.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/saved=reordered/);
      await expectDraftRevision(page, 8);
      const responseOrder = await page.locator('div[id^="draft-response-option-"] > span').allTextContents();
      expect(responseOrder.map((value) => value.trim())).toEqual(["unclear · Unclear", "yes · Yes"]);

      const moveItemDown = page.getByRole("button", { name: "Move item “Is the study design appropriate?” down" });
      await moveItemDown.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/saved=reordered/);
      await expectDraftRevision(page, 9);
      const itemOrder = await page.locator(`${`#${studySectionId}`} .nested-item > .item-row .item-title`).allTextContents();
      expect(itemOrder.map((value) => value.trim())).toEqual(["Were methods prespecified?", "Is the study design appropriate? Required"]);

      const secondItem = studyDesignCard.locator(".nested-item").filter({ hasText: "Were methods prespecified?" }).first();
      await secondItem.getByLabel("New response key for Were methods prespecified?").fill("yes");
      await secondItem.getByLabel("New response label for Were methods prespecified?").fill("Yes");
      await secondItem.getByRole("button", { name: "Add option" }).click();
      await expectDraftRevision(page, 10);

      await page.getByLabel("Add judgement key").fill("useful");
      await page.getByLabel("Add judgement label").fill("Useful");
      await page.getByLabel("require overall judgement").check();
      await page.getByRole("button", { name: "Save overall options" }).click();
      await expectDraftRevision(page, 11);
      await page.getByLabel("Add judgement key").fill("limited");
      await page.getByLabel("Add judgement label").fill("Limited");
      await page.getByRole("button", { name: "Save overall options" }).click();
      await expectDraftRevision(page, 12);
      const moveOverallDown = page.getByRole("button", { name: "Move overall-option “Useful” down" });
      await moveOverallDown.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/saved=reordered/);
      await expectDraftRevision(page, 13);
      const overallOrder = await page.locator('div[id^="draft-overall-option-"] > span').allTextContents();
      expect(overallOrder.map((value) => value.trim())).toEqual(["limited · Limited", "useful · Useful"]);

      await expect(page.getByLabel("Section order")).toHaveCount(0);
      await expect(page.getByLabel("Item order")).toHaveCount(0);
      await expect(page.getByLabel("Option order")).toHaveCount(0);
      await expect(page.getByLabel("Options JSON")).toHaveCount(0);

      await page.getByRole("button", { name: "Finalize immutable version" }).click();
      const finalizeDialog = page.getByRole("dialog");
      await expect(finalizeDialog).toBeVisible();
      await finalizeDialog.getByRole("button", { name: "Finalize version" }).click({ force: true });
      await expect(page).toHaveURL(/saved=finalized/);
      await expect(page.getByText("Custom framework", { exact: true }).first()).toBeVisible();
      const versionOneId = new URL(page.url()).pathname.split("/").at(-1)!;

      await page.goto(`/projects/${projectId}/appraisal`);
      await expect(page.getByText("Slice 33 included study", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Start appraisal" }).click();
      await expect(page.getByRole("heading", { name: "Slice 33 included study" })).toBeVisible();
      await expect(page.getByText("Custom framework", { exact: true }).first()).toBeVisible();
      const responseGroup = page.getByRole("group", { name: /Is the study design appropriate\?/ });
      await expect(responseGroup.locator("legend")).toContainText("Is the study design appropriate?");
      await page.getByRole("link", { name: "Load Evidence picker" }).first().click();
      await page.locator('select[name^="evidenceIds_"]').first().selectOption(evidenceId);
      await page.locator('textarea[name^="rationale_"]').first().fill("The first pass preserves the rationale while the required response is missing.");
      await page.locator('textarea[name="overallRationale"]').fill("Preserve this overall note after validation.");
      await page.getByRole("button", { name: "Save immutable appraisal revision" }).click();

      const errorSummary = page.getByRole("alert").filter({ hasText: "There are problems with this form." });
      await expect(errorSummary).toBeVisible();
      await expect(errorSummary).toContainText("Item “Is the study design appropriate?” requires a response.");
      await expect(errorSummary).toContainText("Overall judgement is required.");
      await expect(errorSummary).toBeFocused();
      const requiredRadios = responseGroup.locator('input[type="radio"]');
      const requiredRadioCount = await requiredRadios.count();
      for (let i = 0; i < requiredRadioCount; i += 1) {
        await expect(requiredRadios.nth(i)).toHaveAttribute("aria-invalid", "true");
        await expect(requiredRadios.nth(i)).toHaveAttribute("aria-describedby", /field-error-response-group-/);
      }
      const rationale = page.locator('textarea[name^="rationale_"]').first();
      await expect(rationale).toHaveValue("The first pass preserves the rationale while the required response is missing.");
      await expect(page.locator('textarea[name="overallRationale"]')).toHaveValue("Preserve this overall note after validation.");
      expect(await page.locator('select[name^="evidenceIds_"]').first().evaluate((select) => Array.from((select as HTMLSelectElement).selectedOptions).map((option) => option.value))).toEqual([evidenceId]);

      const selectedYes = responseGroup.getByRole("radio", { name: "Yes" });
      const selectedUnclear = responseGroup.getByRole("radio", { name: "Unclear" });
      await requiredRadios.first().focus();
      await page.keyboard.press("ArrowRight");
      await expect(selectedUnclear).toBeChecked();
      await page.keyboard.press("ArrowRight");
      await expect(selectedYes).toBeChecked();
      await page.keyboard.press("ArrowLeft");
      await expect(selectedUnclear).toBeChecked();
      await page.getByLabel("Judgement").selectOption({ label: "Useful" });
      await rationale.fill("The design is appropriate for the stated question.");
      await page.locator('textarea[name="overallRationale"]').fill("Researcher-authored overall context.");
      await page.getByRole("button", { name: "Save immutable appraisal revision" }).click();
      await expect(page).toHaveURL(/saved=revision/);
      await expect(page.getByText("Appraisal revision saved.", { exact: true })).toBeVisible();

      await page.locator('textarea[name^="rationale_"]').first().fill("Second immutable researcher revision.");
      await page.getByRole("button", { name: "Save immutable appraisal revision" }).click();
      await expect(page).toHaveURL(/saved=revision/);
      await page.getByRole("link", { name: "Back to appraisal queue" }).click();
      const queueRow = page.locator("article.item").filter({ hasText: "Slice 33 included study" });
      await expect(queueRow.getByText("complete", { exact: true })).toBeVisible();
      await queueRow.getByRole("link", { name: "History" }).click();
      await expect(page.getByText("Custom framework", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Revision 2 · framework version 1", { exact: false })).toBeVisible();
      await expect(page.getByText("Revision 1 · framework version 1", { exact: false })).toBeVisible();

      await page.goto(`/projects/${projectId}/appraisal/frameworks/${frameworkId}`);
      await page.getByRole("button", { name: "Create next draft version" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/[0-9a-f-]+$`));
      const versionTwoId = new URL(page.url()).pathname.split("/").at(-1)!;
      await expect(page.getByText("Custom framework", { exact: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "Finalize immutable version" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Finalize version" }).click({ force: true });
      await expect(page).toHaveURL(/saved=finalized/);

      await page.goto(`/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}`);
      await expect(page.getByText(/A newer finalized version of this researcher-authored framework is available/)).toBeVisible();
      await expect(page.getByRole("link", { name: /begin the explicit reassessment/ })).toHaveAttribute("href", new RegExp(`versionId=${versionTwoId}`));
      await page.getByRole("link", { name: /begin the explicit reassessment/ }).click();
      await expect(page).toHaveURL(new RegExp(`versionId=${versionTwoId}`));
      const reassessmentOptions = page.locator('input[type="radio"][name^="selectedOption_"]:not([value=""])');
      await expect(reassessmentOptions).toHaveCount(3);
      for (const option of await reassessmentOptions.all()) await expect(option).not.toBeChecked();
      await page.getByRole("link", { name: "Back to appraisal queue" }).click();
      await expect(page.locator("article.item").filter({ hasText: "Slice 33 included study" }).getByText("complete", { exact: true })).toBeVisible();

      await page.goto(`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${versionOneId}`);
      for (const width of [375, 320]) {
        await page.setViewportSize({ width, height: 850 });
        const viewport = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        expect(viewport.scroll).toBeLessThanOrEqual(viewport.client);
      }
      await page.goto(`/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}`);
      for (const width of [375, 320]) {
        await page.setViewportSize({ width, height: 850 });
        const viewport = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        expect(viewport.scroll).toBeLessThanOrEqual(viewport.client);
      }
    } finally {
      await sql.end();
    }
  });
});
