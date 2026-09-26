import { expect, test } from "@playwright/test";
import { addManualPaper } from "./manual-paper";
import { selectEvidencePaper } from "./evidence-paper-picker";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";

test.describe("Slice 37 Extraction workspace", () => {
  test("keeps protocol edits, bounded progress pages, and included or historical worksheets usable", async ({ page }) => {
    test.setTimeout(180_000);
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
    await page.getByRole("dialog", { name: "Archive this extraction field?" }).getByRole("button", { name: "Archive field" }).click();
    await expect(retiredField.getByText("archived", { exact: true })).toBeVisible();

    const sampleSizeLink = page.locator("a.extraction-progress-item").filter({ hasText: paperTitle });
    await expect(sampleSizeLink).toBeVisible();
    await sampleSizeLink.click();
    await expect(page.getByText("Structured extraction · Included paper", { exact: true })).toBeVisible();
    const sampleSize = page.locator(".extraction-value").filter({ hasText: "Sample size" });
    await sampleSize.getByLabel("Structured value").fill("1500");
    await sampleSize.getByLabel(/Page 9/).check();
    await sampleSize.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Extraction revision saved" })).toBeVisible();
    await expect(sampleSize.getByText("● Grounded")).toBeVisible();

    await sampleSize.getByLabel("Structured value").fill("1600");
    await sampleSize.getByLabel(/Page 9/).uncheck();
    await sampleSize.getByRole("button", { name: "Save new revision" }).click();
    await expect(sampleSize.locator(".current-observation")).toContainText("1600");
    await sampleSize.locator("summary", { hasText: "Revision history (2)" }).click();
    await expect(sampleSize.getByText("Revision 1", { exact: true })).toBeVisible();
    await expect(sampleSize.getByText("Revision 2", { exact: true })).toBeVisible();
    await expect(sampleSize.locator(".history-evidence")).toContainText("Page 9");

    const effectEstimate = page.locator(".extraction-value").filter({ hasText: "Effect estimate" });
    await effectEstimate.getByLabel("Structured value").fill("0.35");
    await effectEstimate.getByRole("button", { name: "Save new revision" }).click();
    await expect(effectEstimate.locator(".current-observation")).toContainText("0.35");

    const studyDesign = page.locator(".extraction-value").filter({ hasText: "Study design" });
    await studyDesign.getByLabel("Structured value").selectOption({ label: "Cohort" });
    await studyDesign.getByRole("button", { name: "Save new revision" }).click();
    await expect(studyDesign.locator(".current-observation")).toContainText("Cohort");

    await page.goto(`/projects/${projectId}/extraction`);
    const designProtocol = page.locator(".extraction-field-item").filter({ hasText: "Study design" });
    await designProtocol.locator(".option-row").filter({ hasText: "Cohort" }).getByRole("button", { name: "Archive" }).click();
    await page.getByRole("dialog", { name: "Archive this extraction option?" }).getByRole("button", { name: "Archive option" }).click();
    await expect(designProtocol.locator(".option-row").filter({ hasText: "Cohort" })).toHaveCount(0);

    await page.goto(`/projects/${projectId}/extraction/${paperId}`);
    const studyDesignValue = page.locator(".extraction-value").filter({ hasText: "Study design" }).getByLabel("Structured value");
    const archivedCohort = studyDesignValue.getByRole("option", { name: "Cohort (archived)" });
    await expect(archivedCohort).toBeAttached();
    await expect(archivedCohort).not.toBeDisabled();
    await expect(studyDesignValue).toHaveValue(await archivedCohort.getAttribute("value") ?? "");
    await expect(page.locator(".extraction-value").filter({ hasText: "Retired field" })).toHaveCount(0);

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
