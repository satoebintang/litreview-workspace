import { test, expect } from "@playwright/test";

test.describe("Slice 19 Synthesis Interpretation Context", () => {
  test("authors interpretation snapshots over exact finalized SynthesisRevision, records limitations, questions, and contradiction pairs, and drafts manuscript Claim with exact synthesis support", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const unique = Date.now();

    // 1. Create project
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 19 review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = page.url().match(/projects\/([0-9a-f-]+)$/)?.[1] as string;

    // 2. Add two Papers
    await page.getByLabel("Title", { exact: true }).fill("Study Alpha");
    await page.getByLabel("Authors").fill("Lead Researcher Alpha");
    await page.getByLabel("Abstract").fill("Study Alpha abstract on outcomes");
    await page.getByRole("button", { name: "Add paper" }).click();
    await expect(page.locator(".paper-chip, .item-title").filter({ hasText: "Study Alpha" }).first()).toBeVisible({ timeout: 30_000 });

    await page.getByLabel("Title", { exact: true }).fill("Study Beta");
    await page.getByLabel("Authors").fill("Lead Researcher Beta");
    await page.getByLabel("Abstract").fill("Study Beta abstract on outcomes");
    await page.getByRole("button", { name: "Add paper" }).click();
    await expect(page.locator(".paper-chip, .item-title").filter({ hasText: "Study Beta" }).first()).toBeVisible({ timeout: 30_000 });

    // 3. Record Evidence for both papers
    await page.reload();
    await page.getByLabel("Paper").selectOption({ label: "Study Alpha" });
    await page.getByLabel("Verbatim source passage").fill("Primary outcome was significantly enhanced by 85%.");
    await page.getByLabel("Page number").fill("12");
    await page.getByRole("button", { name: "Record evidence" }).click();
    await expect(page.locator(".quote").filter({ hasText: "Primary outcome was significantly enhanced by 85%." })).toBeVisible({ timeout: 30_000 });

    await page.getByLabel("Paper").selectOption({ label: "Study Beta" });
    await page.getByLabel("Verbatim source passage").fill("Primary outcome showed minimal change of only 15%.");
    await page.getByLabel("Page number").fill("34");
    await page.getByRole("button", { name: "Record evidence" }).click();
    await expect(page.locator(".quote").filter({ hasText: "Primary outcome showed minimal change of only 15%." })).toBeVisible({ timeout: 30_000 });

    // 4. Screen both papers to included
    await page.goto(`/projects/${projectId}/screening`);
    await page.getByLabel("Type").selectOption("exclusion");
    await page.getByLabel("Criterion").fill("Off topic");
    await page.getByRole("button", { name: "Add criterion" }).click();
    await expect(page.getByText("Off topic")).toBeVisible({ timeout: 30_000 });

    // Screen first paper
    const screeningStart = await page.getByRole("link", { name: "Start screening" }).getAttribute("href");
    await page.goto(`${screeningStart}`);
    const paper1Id = new URL(page.url()).pathname.split("/").pop()!;
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.locator(".status.screening-included")).toBeVisible();

    await page.goto(`/projects/${projectId}/screening/full-text/retrieval/${paper1Id}`);
    await page.getByLabel("Outcome").selectOption("retrieved");
    await page.getByRole("button", { name: "Record attempt" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Retrieval attempt recorded" })).toBeVisible();

    await page.goto(`/projects/${projectId}/screening/full-text/${paper1Id}`);
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.getByText("Full-text decision recorded in screening history.")).toBeVisible();

    // Screen second paper
    await page.goto(`/projects/${projectId}/screening`);
    await page.getByRole("link", { name: "Start screening" }).click();
    const paper2Id = new URL(page.url()).pathname.split("/").pop()!;
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.locator(".status.screening-included")).toBeVisible();

    await page.goto(`/projects/${projectId}/screening/full-text/retrieval/${paper2Id}`);
    await page.getByLabel("Outcome").selectOption("retrieved");
    await page.getByRole("button", { name: "Record attempt" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Retrieval attempt recorded" })).toBeVisible();

    await page.goto(`/projects/${projectId}/screening/full-text/${paper2Id}`);
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.getByText("Full-text decision recorded in screening history.")).toBeVisible();

    // 5. Create extraction field and observations for both papers
    await page.goto(`/projects/${projectId}/extraction`);
    await page.getByLabel("Field name").fill("Efficacy Rate");
    await page.getByRole("button", { name: "Add extraction field" }).click();
    await expect(page.getByText("Extraction field saved.")).toBeVisible({ timeout: 30_000 });

    // Extract for Study Alpha
    const alphaExtractionLink = await page.locator("a.extraction-progress-item").filter({ hasText: "Study Alpha" }).getAttribute("href");
    expect(alphaExtractionLink).toBeTruthy();
    await page.goto(`${alphaExtractionLink}`);
    await page.getByLabel("Structured value").fill("85% efficacy rate");
    await page.locator('input[name="evidenceIds"]').first().check();
    await page.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByText("Extraction revision saved.")).toBeVisible();

    // Extract for Study Beta
    await page.goto(`/projects/${projectId}/extraction`);
    const betaExtractionLink = await page.locator("a.extraction-progress-item").filter({ hasText: "Study Beta" }).getAttribute("href");
    expect(betaExtractionLink).toBeTruthy();
    await page.goto(`${betaExtractionLink}`);
    await page.getByLabel("Structured value").fill("15% efficacy rate");
    await page.locator('input[name="evidenceIds"]').first().check();
    await page.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByText("Extraction revision saved.")).toBeVisible();

    // 6. Create Synthesis Statement with both observations
    await page.goto(`/projects/${projectId}/synthesis`);
    await page.getByRole("checkbox", { name: "Select observation from Study Alpha" }).check();
    await page.getByRole("checkbox", { name: "Select observation from Study Beta" }).check();
    await page.locator("#synthesis-title").fill("Cross-study efficacy comparison");
    await page.locator("#synthesis-text").fill("Study Alpha reports 85% efficacy whereas Study Beta reports 15% efficacy.");
    await page.locator("#synthesis-note").fill("Synthesized across both included trials.");
    await page.getByRole("button", { name: "Create synthesis from selected observations" }).click();

    await expect(page).toHaveURL(/\/synthesis\/[0-9a-f-]+\?saved=created$/);
    const statementId = page.url().match(/synthesis\/([0-9a-f-]+)\?saved=created$/)?.[1] as string;

    // 7. Navigate to exact revision page
    await page.getByRole("link", { name: /Inspect exact revision & interpretation/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/synthesis/${statementId}/revisions/[0-9a-f-]+$`));
    const revisionId = page.url().match(/revisions\/([0-9a-f-]+)$/)?.[1] as string;
    expect(revisionId).toBeTruthy();

    await expect(page.getByText("Exact supporting observations (2)")).toBeVisible();
    await expect(page.getByText("85% efficacy rate").first()).toBeVisible();
    await expect(page.getByText("15% efficacy rate").first()).toBeVisible();

    // 8. Record First Interpretation Snapshot: 'mixed'
    await page.locator("#convergence-state").selectOption("mixed");
    await page.locator("#summary").fill("Preliminary results suggest mixed outcomes with notable disparity between trial protocols.");
    await page.locator("#researcher-note").fill("Trial Alpha used higher dosing than Trial Beta.");
    await page.locator('input[name="limitationBody"]').first().fill("Disparate dosage schedules between cohorts");
    await page.locator('input[name="questionBody"]').first().fill("What dosage threshold produces the inflection point?");
    await page.getByRole("button", { name: "Record interpretation snapshot" }).click();

    await expect(page).toHaveURL(new RegExp(`/synthesis/${statementId}/revisions/${revisionId}\\?saved=interpretation$`));
    await expect(page.locator(".success-note")).toHaveText("Interpretation snapshot saved successfully.");
    await expect(page.locator(".badge-convergence.mixed").first()).toBeVisible();
    await expect(page.getByText("Preliminary results suggest mixed outcomes with notable disparity between trial protocols.").first()).toBeVisible();
    await expect(page.getByText("Disparate dosage schedules between cohorts")).toBeVisible();
    await expect(page.getByText("What dosage threshold produces the inflection point?")).toBeVisible();

    // 9. Record Second Interpretation Snapshot: 'contradictory' with contradiction pair
    await page.locator("#convergence-state").selectOption("contradictory");
    await page.locator("#summary").fill("Direct empirical contradiction between Alpha and Beta under comparable test conditions.");
    await page.locator("#researcher-note").fill("Contradiction identified on primary efficacy metric.");
    await page.locator('input[name="limitationBody"]').first().fill("Small sample size in Study Beta");
    await page.locator('input[name="questionBody"]').first().fill("Are patient genetic covariates driving the divergence?");
    // Check contradiction pair
    await page.locator('input[name="contradictionPairs"]').first().check();
    await page.getByRole("button", { name: "Record interpretation snapshot" }).click();

    await expect(page).toHaveURL(new RegExp(`/synthesis/${statementId}/revisions/${revisionId}\\?saved=interpretation$`));
    await expect(page.locator(".success-note")).toHaveText("Interpretation snapshot saved successfully.");
    await expect(page.locator(".badge-convergence.contradictory").first()).toBeVisible();
    await expect(page.getByText("Direct empirical contradiction between Alpha and Beta under comparable test conditions.").first()).toBeVisible();
    await expect(page.locator(".pair-vs")).toBeVisible();
    await expect(page.locator(".pair-vs-badge")).toBeVisible();

    // Verify Interpretation history contains both snapshots
    await expect(page.getByRole("heading", { name: "Interpretation history" })).toBeVisible();
    await expect(page.getByText("2 snapshots")).toBeVisible();

    // 10. Advance this interpretation to a manuscript Claim
    await page.getByRole("link", { name: /Draft Claim from this interpretation/ }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/claims\\?interpretationId=[0-9a-f-]+&synthesisRevisionId=${revisionId}$`));

    // Verify draft banner and prefilled claim text
    await expect(page.getByText(/Drafting from Synthesis Interpretation snapshot/)).toBeVisible();
    await expect(page.locator("#claim-text")).toHaveValue("Direct empirical contradiction between Alpha and Beta under comparable test conditions.");

    // Submit claim creation
    await page.getByRole("button", { name: "Create claim with synthesis support" }).click();

    // 11. Verify created claim detail page
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+\/claims\/[0-9a-f-]+\?saved=created_from_interpretation$/);
    await expect(page.locator(".success-note")).toHaveText("Claim created with exact synthesis support from interpretation context.");
    await expect(page.locator(".claim-assertion")).toHaveText("Direct empirical contradiction between Alpha and Beta under comparable test conditions.");
    await expect(page.locator(".workspace-header .status.supported")).toBeVisible();

    // Check support snapshot contains Supporting synthesis
    await expect(page.getByText("Supporting synthesis", { exact: true })).toBeVisible();
    await expect(page.locator("p.synthesis-statement")).toHaveText("Study Alpha reports 85% efficacy whereas Study Beta reports 15% efficacy.");

    // Check citation candidates reach both papers
    await expect(page.getByRole("heading", { name: "Citation candidates" })).toBeVisible();
    await expect(page.getByText("Study Alpha", { exact: true })).toBeVisible();
    await expect(page.getByText("Study Beta", { exact: true })).toBeVisible();
  });
});
