import { expect, test } from "@playwright/test";
import { addManualPaper } from "./manual-paper";
import { selectEvidencePaper } from "./evidence-paper-picker";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";

test.describe("Slice 37 Extraction workspace", () => {
  test("keeps protocol edits, bounded progress pages, and included or historical worksheets usable", async ({ page }) => {
    test.setTimeout(180_000);
    const expectGenericNotFound = async (path: string) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(page.getByText("This page could not be found.", { exact: true })).toBeVisible();
      await expect(page.getByText(/DomainError|VALIDATION_ERROR|PostgreSQL|extraction_value_revisions/i)).toHaveCount(0);
    };
    const unique = Date.now();
    const paperTitle = `Slice 37 Extraction study ${unique}`;

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 37 Extraction ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto(`/projects/${projectId}/papers`);
    await page.getByLabel("Title", { exact: true }).fill(paperTitle);
    await page.getByLabel("Authors").fill("A. Researcher");
    await page.getByLabel("Abstract").fill("A source fixture for the Extraction workspace.");
    await addManualPaper(page);
    await expect(page.getByText(paperTitle, { exact: true }).first()).toBeVisible();

    await page.goto(`/projects/${projectId}/evidence`);
    await selectEvidencePaper(page, paperTitle, page.getByRole("region", { name: "Record Evidence" }));
    await page.getByLabel("Verbatim source passage").fill("The study included 1,500 participants.");
    await page.getByLabel("Page number", { exact: true }).fill("9");
    await page.getByRole("button", { name: "Record evidence" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Evidence recorded" })).toBeVisible();

    await page.goto(`/projects/${projectId}/screening`);
    await page.getByRole("link", { name: "Start screening" }).click();
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.locator(".status.screening-included")).toBeVisible();
    const paperId = new URL(page.url()).pathname.split("/").pop()!;
    await page.goto(`/projects/${projectId}/screening/full-text/retrieval/${paperId}`);
    await page.getByLabel("Outcome").selectOption("retrieved");
    await page.getByRole("button", { name: "Record attempt" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Retrieval attempt recorded" })).toBeVisible();
    await page.goto(`/projects/${projectId}/screening/full-text/${paperId}`);
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.getByText("Full-text decision recorded in screening history.")).toBeVisible();

    await page.goto(`/projects/${projectId}/extraction`);
    await page.getByLabel("Field name").fill("Sample size");
    await page.getByLabel("Field type").selectOption("short_text");
    await page.getByRole("checkbox", { name: /Required field/ }).check();
    await page.getByRole("button", { name: "Add extraction field" }).click();
    await expect(page.getByText("Extraction field saved.")).toBeVisible();

    await page.getByLabel("Field name").fill("Effect estimate");
    await page.getByLabel("Field type").selectOption("number");
    await page.getByRole("button", { name: "Add extraction field" }).click();
    await expect(page.getByText("Effect estimate", { exact: true })).toBeVisible();

    await page.getByLabel("Field name").fill("Study design");
    await page.getByLabel("Field type").selectOption("single_select");
    await page.getByRole("button", { name: "Add extraction field" }).click();
    await page.getByLabel("New option for Study design").fill("Cohort");
    await page.getByRole("button", { name: "Add option" }).click();
    await expect(page.getByText("Extraction option saved.")).toBeVisible();
    await page.getByLabel("New option for Study design").fill("Case-control");
    await page.getByRole("button", { name: "Add option" }).click();
    await expect(page.getByText("Case-control", { exact: true })).toBeVisible();

    await page.getByLabel("Field name").fill("Retired field");
    await page.getByLabel("Field type").selectOption("short_text");
    await page.getByRole("button", { name: "Add extraction field" }).click();
    const retiredField = page.locator(".extraction-field-item").filter({ hasText: "Retired field" });
    await retiredField.getByRole("button", { name: "Archive" }).click();
    const retiredFieldArchiveDialog = page.getByRole("dialog", { name: "Archive this extraction field?" });
    const retiredFieldId = await retiredFieldArchiveDialog.locator('input[name="fieldId"]').inputValue();
    await retiredFieldArchiveDialog.getByRole("button", { name: "Cancel" }).click();

    const sampleSizeLink = page.locator("a.extraction-progress-item").filter({ hasText: paperTitle });
    await expect(sampleSizeLink).toBeVisible();
    await sampleSizeLink.click();
    await expect(page.getByText("Structured extraction · Included paper", { exact: true })).toBeVisible();
    const sampleSize = page.locator(".extraction-value").filter({ hasText: "Sample size" });
    await sampleSize.getByLabel("Structured value").fill("1500");
    const evidenceBrowser = page.getByRole("region", { name: "Shared Evidence browser" });
    await expect(evidenceBrowser).toHaveCount(1);
    await expect(evidenceBrowser.locator(".candidate-evidence")).toHaveCount(0);
    await sampleSize.getByRole("button", { name: "Browse Evidence to add to Sample size" }).click();
    const pageNineCandidate = evidenceBrowser.locator(".candidate-evidence").filter({ hasText: /Page 9/ });
    await expect(pageNineCandidate).toHaveCount(1);
    await pageNineCandidate.getByRole("button", { name: "Add to this Field" }).click();
    await expect(sampleSize.locator('input[name="evidenceIds"]')).toHaveCount(1);
    await expect(sampleSize.locator('input[name="evidenceIds"]')).toBeChecked();
    await sampleSize.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Extraction revision saved" })).toBeVisible();
    await expect(sampleSize.getByText("● Grounded")).toBeVisible();

    await sampleSize.getByLabel("Structured value").fill("1600");
    const selectedEvidence = sampleSize.locator('input[name="evidenceIds"]');
    await expect(selectedEvidence).toHaveCount(1);
    await selectedEvidence.click({ noWaitAfter: true });
    await expect(selectedEvidence).toHaveCount(0);
    await sampleSize.getByRole("button", { name: "Save new revision" }).click();
    await expect(sampleSize.locator(".current-observation")).toContainText("1600");
    await expect(sampleSize.getByText(/Revision history \(/)).toHaveCount(0);
    await sampleSize.getByRole("link", { name: /Open Field revision history/ }).click();
    await expect(page).toHaveURL(new RegExp(`/fields/[^/]+/history$`));
    await expect(page.getByText("1 Evidence · grounded", { exact: true })).toBeVisible();
    const sampleSizeHistory = page.locator(".item");
    await expect(sampleSizeHistory).toHaveCount(2);
    await expect(sampleSizeHistory.first()).toContainText("Current");
    await expect(sampleSizeHistory.first()).toContainText("1600");
    await expect(sampleSizeHistory.last()).toContainText("1500");
    const sampleSizeHistoryHref = new URL(page.url()).pathname;
    const sampleExactHref = await sampleSizeHistory.first().getByRole("link", { name: /Open exact revision/ }).getAttribute("href");
    const sampleScope = sampleExactHref?.match(/\/fields\/([^/]+)\/revisions\/([^/?]+)$/);
    expect(sampleScope).not.toBeNull();
    const sampleSizeFieldId = sampleScope![1];
    const sampleSizeCurrentRevisionId = sampleScope![2];
    await sampleSizeHistory.last().getByRole("link", { name: /Open exact revision/ }).click();
    await expect(page.getByText("Exact immutable value")).toBeVisible();
    await expect(page.locator(".quote")).toContainText("The study included 1,500 participants.");
    await expect(page.getByText("Superseded revision", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: /Return to Field revision history/ }).click();
    await expect(page).toHaveURL(new RegExp(`/fields/[^/]+/history$`));
    await page.getByRole("link", { name: /Return to current worksheet/ }).click();
    await expect(page).toHaveURL(`/projects/${projectId}/extraction/${paperId}`);

    await page.goto(`${sampleSizeHistoryHref}?pageSize=1`);
    const continuationItems = page.locator(".item");
    await expect(continuationItems).toHaveCount(1);
    await expect(continuationItems.first()).toContainText("1600");
    await page.getByRole("link", { name: /Next Field history page/ }).click();
    await expect(page).toHaveURL(/pageSize=1&cursor=/);
    await expect(continuationItems).toHaveCount(1);
    await expect(continuationItems.first()).toContainText("1500");
    await expect(page.getByRole("link", { name: /Next Field history page/ })).toHaveCount(0);
    await expectGenericNotFound(`${sampleSizeHistoryHref}?cursor=not-a-cursor`);
    await page.goto(`/projects/${projectId}/extraction/${paperId}`);
    await expect(page).toHaveURL(`/projects/${projectId}/extraction/${paperId}`);

    const effectEstimate = page.locator(".extraction-value").filter({ hasText: "Effect estimate" });
    await effectEstimate.getByLabel("Structured value").fill("0.35");
    await effectEstimate.getByRole("button", { name: "Save new revision" }).click();
    await expect(effectEstimate.locator(".current-observation")).toContainText("0.35");

    const studyDesign = page.locator(".extraction-value").filter({ hasText: "Study design" });
    await studyDesign.getByLabel("Structured value").selectOption({ label: "Cohort" });
    await studyDesign.getByRole("button", { name: "Save new revision" }).click();
    await expect(studyDesign.locator(".current-observation")).toContainText("Cohort");

    const retiredValue = page.locator(".extraction-value").filter({ hasText: "Retired field" });
    await retiredValue.getByLabel("Structured value").fill("Archived-field audit value");
    await retiredValue.getByRole("button", { name: "Save new revision" }).click();
    await expect(retiredValue.locator(".current-observation")).toContainText("Archived-field audit value");

    await page.goto(`/projects/${projectId}/extraction`);
    const designProtocol = page.locator(".extraction-field-item").filter({ hasText: "Study design" });
    await designProtocol.locator(".option-row").filter({ hasText: "Cohort" }).getByRole("button", { name: "Archive" }).click();
    await page.getByRole("dialog", { name: "Archive this extraction option?" }).getByRole("button", { name: "Archive option" }).click();
    await expect(designProtocol.locator(".option-row").filter({ hasText: "Cohort" })).toHaveCount(0);
    const retiredProtocol = page.locator(".extraction-field-item").filter({ hasText: "Retired field" });
    await retiredProtocol.getByRole("button", { name: "Archive" }).click();
    await page.getByRole("dialog", { name: "Archive this extraction field?" }).getByRole("button", { name: "Archive field" }).click();
    await expect(retiredProtocol.getByText("archived", { exact: true })).toBeVisible();

    await page.goto(`/projects/${projectId}/extraction/${paperId}`);
    const studyDesignValue = page.locator(".extraction-value").filter({ hasText: "Study design" }).getByLabel("Structured value");
    const archivedCohort = studyDesignValue.getByRole("option", { name: "Cohort (archived)" });
    await expect(archivedCohort).toBeAttached();
    await expect(archivedCohort).not.toBeDisabled();
    await expect(studyDesignValue).toHaveValue(await archivedCohort.getAttribute("value") ?? "");
    await expect(page.locator(".extraction-value").filter({ hasText: "Retired field" })).toHaveCount(0);
    await page.goto(`/projects/${projectId}/extraction/${paperId}/fields/${retiredFieldId}/history`);
    await expect(page.getByText("Extraction audit · Archived Field", { exact: true })).toBeVisible();
    await expect(page.getByText(/Sequence \d+ · present · Current/)).toBeVisible();
    await page.getByRole("link", { name: /Open exact revision/ }).click();
    await expect(page.locator(".workspace-header")).toContainText("Archived Field");
    await expect(page.locator(".section-card").first()).toContainText("Archived-field audit value");

    await expectGenericNotFound(`/projects/${projectId}/extraction/${paperId}/fields/${retiredFieldId}/revisions/not-a-uuid`);
    await expectGenericNotFound(`/projects/${projectId}/extraction/${paperId}/fields/${retiredFieldId}/revisions/${sampleSizeCurrentRevisionId}`);

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 37 Cross-scope ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const otherProjectId = new URL(page.url()).pathname.split("/").pop()!;
    await expectGenericNotFound(`/projects/${otherProjectId}/extraction/${paperId}/fields/${sampleSizeFieldId}/history`);

    const databaseClient = createPlaywrightTestDatabaseClient({ prepare: false });
    try {
      await databaseClient.begin(async (tx) => {
        await tx`set local session_replication_role = 'replica'`;
        await tx`delete from full_text_screening_decisions where project_id=${projectId}::uuid and paper_id=${paperId}::uuid`;
      });
    } finally {
      await databaseClient.end();
    }

    await page.goto(`/projects/${projectId}/extraction`);
    await expect(page.locator("a.extraction-progress-item").filter({ hasText: paperTitle })).toContainText("read-only historical state");
    await page.goto(`/projects/${projectId}/extraction/${paperId}`);
    await expect(page.getByText(/historical extraction work from before full-text screening/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save new revision" }).first()).toBeDisabled();
    await expect(page.locator(".current-observation").filter({ hasText: "1600" })).toBeVisible();

    const paginationClient = createPlaywrightTestDatabaseClient({ prepare: false });
    try {
      await paginationClient.begin(async (tx) => {
        await tx`insert into papers (project_id, title, created_at, updated_at)
          select ${projectId}::uuid, 'Slice 37 progress fixture ' || n::text, '2026-09-24T00:00:00Z'::timestamptz, '2026-09-24T00:00:00Z'::timestamptz
          from generate_series(1, 50) as n`;
        await tx`insert into screening_decisions (project_id, paper_id, decision)
          select ${projectId}::uuid, p.id, 'include'
          from papers p where p.project_id=${projectId}::uuid and p.title like 'Slice 37 progress fixture %'`;
        await tx`insert into full_text_retrieval_attempts (project_id, paper_id, outcome, attempted_at)
          select ${projectId}::uuid, p.id, 'retrieved', '2026-09-24T00:00:00Z'::timestamptz
          from papers p where p.project_id=${projectId}::uuid and p.title like 'Slice 37 progress fixture %'`;
        await tx`insert into full_text_screening_decisions (project_id, paper_id, decision)
          select ${projectId}::uuid, p.id, 'include'
          from papers p where p.project_id=${projectId}::uuid and p.title like 'Slice 37 progress fixture %'`;
      });
    } finally {
      await paginationClient.end();
    }

    await page.goto(`/projects/${projectId}/extraction`);
    const pagination = page.getByRole("navigation", { name: "Extraction progress pagination" });
    await expect(page.getByText("1–50 of 51", { exact: true })).toBeVisible();
    await expect(page.locator("a.extraction-progress-item")).toHaveCount(50);
    await expect(pagination.getByText("Page 1 of 2", { exact: true })).toHaveAttribute("aria-current", "page");
    await pagination.getByRole("link", { name: "Next page" }).click();
    await expect(page).toHaveURL(new RegExp(`/extraction\\?page=2$`));
    await expect(page.getByText("51–51 of 51", { exact: true })).toBeVisible();
    await expect(page.locator("a.extraction-progress-item")).toHaveCount(1);
    await expect(pagination.getByRole("link", { name: "Previous page" })).toBeVisible();
    await expect(pagination.getByText("Page 2 of 2", { exact: true })).toHaveAttribute("aria-current", "page");
  });
});
