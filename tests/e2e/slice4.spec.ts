import { test, expect } from "@playwright/test";

test.describe("Slice 4 evidence synthesis", () => {
  test("compares observations and retains exact historical support through revision, exclusion, and withdrawal", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(30_000);
    const unique = Date.now();
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Synthesis review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = page.url().match(/projects\/([0-9a-f-]+)$/)?.[1] as string;

    async function addPaper(title: string) {
      await page.getByLabel("Title", { exact: true }).fill(title);
      await page.getByLabel("Authors").fill("Researcher");
      await page.getByLabel("Abstract").fill(`${title} abstract`);
      await page.getByRole("button", { name: "Add paper" }).click();
      await expect(page.locator(".paper-chip, .item-title").filter({ hasText: title }).first()).toBeVisible({ timeout: 30_000 });
    }
    await addPaper("Study A");
    await addPaper("Study B");

    async function recordEvidence(title: string, passage: string) {
      await page.reload();
      await page.getByLabel("Paper").selectOption({ label: title });
      await page.getByLabel("Verbatim source passage").fill(passage);
      await page.getByLabel("Page number").fill("7");
      await page.getByRole("button", { name: "Record evidence" }).click();
      await expect(page.locator(".quote").filter({ hasText: passage })).toBeVisible({ timeout: 30_000 });
    }
    await recordEvidence("Study A", "Study A reports data poisoning.");
    await recordEvidence("Study B", "Study B reports data poisoning.");

    await page.goto(`/projects/${projectId}/screening`);
    await page.getByLabel("Type").selectOption("exclusion");
    await page.getByLabel("Criterion").fill("Out of scope for this review");
    await page.getByRole("button", { name: "Add criterion" }).click();
    await expect(page.getByText("Out of scope for this review")).toBeVisible({ timeout: 30_000 });
    const screeningStart = await page.getByRole("link", { name: "Start screening" }).getAttribute("href");
    await page.goto(`${screeningStart}`);
    await page.getByRole("button", { name: "Include", exact: true }).click();
    const nextScreening = await page.getByRole("link", { name: "Next →" }).getAttribute("href");
    await page.goto(`${nextScreening}`);
    await page.getByRole("button", { name: "Include", exact: true }).click();

    await page.goto(`/projects/${projectId}/extraction`);
    await page.getByLabel("Field name").fill("Attack technique");
    await page.getByRole("button", { name: "Add extraction field" }).click();
    const studyALink = await page.locator("a.extraction-progress-item").filter({ hasText: "Study A" }).getAttribute("href");
    const studyBLink = await page.locator("a.extraction-progress-item").filter({ hasText: "Study B" }).getAttribute("href");
    expect(studyALink).toBeTruthy();
    expect(studyBLink).toBeTruthy();
    await page.goto(`${studyALink}`);
    await page.getByLabel("Structured value").fill("Data poisoning");
    await page.locator('input[name="evidenceIds"]').first().check();
    await page.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByText("Extraction revision saved.")).toBeVisible();
    await page.goto(`${studyBLink}`);
    await page.getByLabel("Structured value").fill("Data poisoning");
    await page.locator('input[name="evidenceIds"]').first().check();
    await page.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByText("Extraction revision saved.")).toBeVisible();

    await page.goto(`/projects/${projectId}/synthesis`);
    await expect(page.getByRole("heading", { name: "Evidence matrix" })).toBeVisible();
    await expect(page.locator(".matrix-row").filter({ hasText: "Study A" })).toContainText("Data poisoning");
    await page.getByRole("checkbox", { name: "Select observation from Study A" }).check();
    await page.getByRole("checkbox", { name: "Select observation from Study B" }).check();
    await page.getByLabel("Synthesis statement").fill("Data poisoning appears in both included studies.");
    await page.getByRole("button", { name: "Create synthesis from selected observations" }).click();
    await expect(page).toHaveURL(/\/synthesis\/[0-9a-f-]+(?:\?saved=created)?$/);
    const statementUrl = page.url();
    await expect(page.getByText("2 supporting observations across 2 Papers")).toBeVisible();
    await expect(page.getByText("Study A reports data poisoning.")).toBeVisible();
    await expect(page.getByText("Study B reports data poisoning.")).toBeVisible();

    await page.goto(`${studyBLink}`);
    await page.getByLabel("Structured value").fill("Backdoor attack");
    await page.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByText("Extraction revision saved.")).toBeVisible({ timeout: 30_000 });
    await page.goto(statementUrl);
    await expect(page.getByText("Superseded support", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Extraction revision \d+/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Study B reports data poisoning.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("checkbox", { name: "Use current extraction from Study B" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("checkbox", { name: "Use current extraction from Study B" }).check();
    await page.locator("label.checkbox-row").filter({ hasText: "Study B" }).first().locator("input").uncheck();
    await page.getByRole("button", { name: "Save new synthesis revision" }).click();
    await expect(page.getByText("New synthesis revision saved.")).toBeVisible();
    await expect(page.getByText(/Backdoor attack/).first()).toBeVisible();
    await expect(page.getByText("Complete synthesis history")).toBeVisible();
    await expect(page.getByText(/Revision \d+ · Supported observations/)).toHaveCount(2);

    await page.goto(`/projects/${projectId}/screening`);
    await page.getByRole("link", { name: /Study B/ }).click();
    await page.getByLabel("Exclusion reason").selectOption({ label: "Out of scope for this review" });
    await page.getByRole("button", { name: "Confirm exclusion" }).click();
    await expect(page.getByText("Decision recorded in screening history.")).toBeVisible({ timeout: 30_000 });
    await page.goto(statementUrl);
    await expect(page.getByText("Paper excluded", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Study B reports data poisoning.")).toBeVisible();

    await page.getByRole("button", { name: "Withdraw synthesis" }).click();
    await expect(page.getByText("Synthesis withdrawn. Its history remains available.")).toBeVisible();
    await expect(page.getByText("This conclusion is already withdrawn.")).toBeVisible();
    await expect(page.getByText(/3 revisions/)).toBeVisible();
  });
});
