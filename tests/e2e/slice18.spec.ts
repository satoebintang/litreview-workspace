import { test, expect } from "@playwright/test";

test.describe("Slice 18 Synthesis Preparation from Evidence Sets", () => {
  test("creates preparation workspace from Evidence Set, manages selections with connecting evidence, and finalizes to synthesis statement with preparation context", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const unique = Date.now();
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 18 review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = page.url().match(/projects\/([0-9a-f-]+)$/)?.[1] as string;

    // 1. Add Paper
    await page.getByLabel("Title", { exact: true }).fill("Study Alpha");
    await page.getByLabel("Authors").fill("Lead Researcher");
    await page.getByLabel("Abstract").fill("Study Alpha abstract on outcomes");
    await page.getByRole("button", { name: "Add paper" }).click();
    await expect(page.locator(".paper-chip, .item-title").filter({ hasText: "Study Alpha" }).first()).toBeVisible({ timeout: 30_000 });

    // 2. Record Evidence
    await page.reload();
    await page.getByLabel("Paper").selectOption({ label: "Study Alpha" });
    await page.getByLabel("Verbatim source passage").fill("Primary outcome was significantly enhanced by 42%.");
    await page.getByLabel("Page number").fill("4");
    await page.getByRole("button", { name: "Record evidence" }).click();
    await expect(page.locator(".quote").filter({ hasText: "Primary outcome was significantly enhanced by 42%." })).toBeVisible({ timeout: 30_000 });

    // 3. Screen paper to included (title/abstract + full-text retrieval + full-text screening)
    await page.goto(`/projects/${projectId}/screening`);
    await page.getByLabel("Type").selectOption("exclusion");
    await page.getByLabel("Criterion").fill("Off topic");
    await page.getByRole("button", { name: "Add criterion" }).click();
    await expect(page.getByText("Off topic")).toBeVisible({ timeout: 30_000 });

    const screeningStart = await page.getByRole("link", { name: "Start screening" }).getAttribute("href");
    await page.goto(`${screeningStart}`);
    const paperId = new URL(page.url()).pathname.split("/").pop()!;
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.locator(".status.screening-included")).toBeVisible();

    await page.goto(`/projects/${projectId}/screening/full-text/retrieval/${paperId}`);
    await page.getByLabel("Outcome").selectOption("retrieved");
    await page.getByRole("button", { name: "Record attempt" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Retrieval attempt recorded" })).toBeVisible();

    await page.goto(`/projects/${projectId}/screening/full-text/${paperId}`);
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.getByText("Full-text decision recorded in screening history.")).toBeVisible();

    // 4. Create extraction field and revise value linking the evidence
    await page.goto(`/projects/${projectId}/extraction`);
    await page.getByLabel("Field name").fill("Effect Size");
    await page.getByRole("button", { name: "Add extraction field" }).click();

    const extractionLink = await page.locator("a.extraction-progress-item").filter({ hasText: "Study Alpha" }).getAttribute("href");
    expect(extractionLink).toBeTruthy();
    await page.goto(`${extractionLink}`);
    await page.getByLabel("Structured value").fill("42% enhancement");
    await page.locator('input[name="evidenceIds"]').first().check();
    await page.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByText("Extraction revision saved.")).toBeVisible();

    // 5. Create Evidence Set and add evidence
    await page.goto(`/projects/${projectId}/evidence-sets`);
    await page.getByLabel("Name").fill("Outcome Evidence Set");
    await page.getByLabel("Purpose or theme").fill("Comparing study outcome measures");
    await page.getByRole("button", { name: "Create Evidence Set" }).click();
    await expect(page).toHaveURL(/\/evidence-sets\/[0-9a-f-]+\?saved=created$/);
    const setId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto(`/projects/${projectId}/evidence`);
    await page.getByRole("link", { name: "Open Evidence detail →" }).click();
    await page.locator("#evidence-set").selectOption(setId);
    await page.getByRole("button", { name: "Add to set" }).click();
    await expect(page.getByRole("status")).toHaveText("Evidence Set membership saved.");

    // 6. Navigate to Evidence Set detail and prepare synthesis
    await page.goto(`/projects/${projectId}/evidence-sets/${setId}`);
    await expect(page.getByRole("heading", { name: "Prepare synthesis workspace" })).toBeVisible();
    await expect(page.getByText("Effect Size", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Prepare synthesis →" }).click();

    // 7. Workspace page
    await expect(page).toHaveURL(/\/synthesis\/preparations\/[0-9a-f-]+$/);
    const prepId = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByText("Pinned Evidence Set: Outcome Evidence Set")).toBeVisible();
    await expect(page.getByText("Field: Effect Size")).toBeVisible();
    await expect(page.getByText("Primary outcome was significantly enhanced by 42%.")).toBeVisible();
    await expect(page.getByText("42% enhancement")).toBeVisible();

    // 8. Select candidate observation
    await page.getByRole("checkbox", { name: "Select candidate observation from Study Alpha" }).check();
    await page.getByRole("button", { name: "Save candidate selections" }).click();
    await expect(page).toHaveURL(new RegExp(`/synthesis/preparations/${prepId}\\?saved=selections$`));
    await expect(page.getByRole("status")).toHaveText("Candidate selections updated.");
    await expect(page.getByText("1 of 1 selected")).toBeVisible();

    // 9. Finalize synthesis preparation
    await page.locator("#final-title").fill("Cross-study effect size synthesis");
    await page.locator("#final-statement").fill("Primary outcomes demonstrate substantial positive effects across synthesized evidence.");
    await page.locator("#final-note").fill("Finalized from Outcome Evidence Set.");
    await page.getByRole("button", { name: "Finalize preparation →" }).click();

    // 10. Check finalized synthesis statement page
    await expect(page).toHaveURL(/\/synthesis\/[0-9a-f-]+\?saved=finalized_from_preparation$/);
    await expect(page.locator(".workspace-header h1")).toHaveText("Cross-study effect size synthesis");
    await expect(page.locator("p.synthesis-statement")).toHaveText("Primary outcomes demonstrate substantial positive effects across synthesized evidence.");
    await expect(page.getByText("Preparation context", { exact: true })).toBeVisible();
    await expect(page.getByText(/Finalized from preparation workspace for Evidence Set Outcome Evidence Set/)).toBeVisible();

    // 11. Open preparation workspace and check frozen finalized state
    await page.getByRole("link", { name: "Open preparation workspace →" }).click();
    await expect(page).toHaveURL(new RegExp(`/synthesis/preparations/${prepId}$`));
    await expect(page.getByText("Finalized workspace:")).toBeVisible();
    await expect(page.getByText("✓ Finalized")).toBeVisible();
  });
});
