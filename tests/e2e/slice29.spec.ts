import { test, expect } from "@playwright/test";
import { addManualPaper } from "./manual-paper";
import { createPlaywrightTestDatabaseClient } from "./playwright-database";


async function getTestDbClient() {
  return createPlaywrightTestDatabaseClient();
}

test.describe("Slice 29 AI-assisted synthesis", () => {
  test("keeps AI assistive, preserves frozen history, and accepts only through canonical synthesis", async ({ page }) => {
    test.setTimeout(240_000);
    page.setDefaultTimeout(30_000);
    const unique = Date.now();
    const maliciousSource = "<script>alert(1)</script><img src=x onerror=alert(1)>";

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 29 browser review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = page.url().match(/projects\/([0-9a-f-]+)$/)?.[1] as string;

    // Create a question so the accepted canonical SynthesisRevision can be
    // checked through the ordinary RQ traceability workflow later.
    await page.goto(`/projects/${projectId}/protocol`);
    await page.getByLabel("Identifier").fill("RQ1");
    await page.getByLabel("Question").fill("What outcome does the evidence support?");
    await page.getByRole("button", { name: "Add research question" }).click();
    await expect(page.getByText("What outcome does the evidence support?")).toBeVisible();

    await page.goto(`/projects/${projectId}/papers`);
    await page.getByLabel("Title", { exact: true }).fill("Study Alpha");
    await page.getByLabel("Authors").fill("Lead Researcher");
    await page.getByLabel("Publication year").fill("2024");
    await page.getByLabel("Abstract").fill("Study Alpha abstract on outcomes");
    await addManualPaper(page);
    await expect(page.locator(".item-title").filter({ hasText: "Study Alpha" }).first()).toBeVisible();

    await page.goto(`/projects/${projectId}/evidence`);
    await page.getByRole("region", { name: "Record Evidence" }).getByLabel("Paper").selectOption({ label: "Study Alpha" });
    await page.getByLabel("Verbatim source passage").fill(maliciousSource);
    await page.getByLabel("Page number").fill("4");
    await page.getByRole("button", { name: "Record evidence" }).click();
    await expect(page.locator(".quote").filter({ hasText: maliciousSource }).first()).toBeVisible();
    expect(await page.locator(".quote script").count()).toBe(0);
    expect(await page.locator(".quote img[onerror]").count()).toBe(0);

    await page.goto(`/projects/${projectId}/screening`);
    await page.getByLabel("Type").selectOption("exclusion");
    await page.getByLabel("Criterion").fill("Off topic");
    await page.getByRole("button", { name: "Add criterion" }).click();
    const screeningStart = await page.getByRole("link", { name: "Start screening" }).getAttribute("href");
    await page.goto(`${screeningStart}`);
    const paperId = new URL(page.url()).pathname.split("/").pop()!;
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.locator(".status.screening-included")).toBeVisible();
    await page.goto(`/projects/${projectId}/screening/full-text/retrieval/${paperId}`);
    await page.getByLabel("Outcome").selectOption("retrieved");
    await page.getByRole("button", { name: "Record attempt" }).click();
    await expect(page.getByRole("status")).toContainText("Retrieval attempt recorded");
    await page.goto(`/projects/${projectId}/screening/full-text/${paperId}`);
    await page.getByRole("button", { name: "Include", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Full-text decision recorded");

    await page.goto(`/projects/${projectId}/extraction`);
    await page.getByLabel("Field name").fill("Outcome");
    await page.getByRole("button", { name: "Add extraction field" }).click();
    await expect(page).toHaveURL(/\/extraction\?saved=field$/);
    await expect(page.locator(".extraction-field-item").filter({ hasText: "Outcome" }).first()).toBeVisible();
    const extractionLink = await page.locator("a.extraction-progress-item").filter({ hasText: "Study Alpha" }).getAttribute("href");
    expect(extractionLink).toBeTruthy();
    await page.goto(`${extractionLink}`);
    await page.getByLabel("Structured value").fill("Improved");
    const extractionNote = page.getByLabel("Researcher note").last();
    if (await extractionNote.count()) await extractionNote.fill("Frozen extraction note");
    await page.locator('input[name="evidenceIds"]').first().check();
    await page.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByText("Extraction revision saved.")).toBeVisible();

    await page.goto(`/projects/${projectId}/evidence-sets`);
    await page.getByLabel("Name").fill("Outcome Evidence Set");
    await page.getByLabel("Purpose or theme").fill("AI synthesis source set");
    await page.getByRole("button", { name: "Create Evidence Set" }).click();
    await expect(page).toHaveURL(/\/evidence-sets\/[0-9a-f-]+\?saved=created$/);
    await page.goto(`/projects/${projectId}/evidence`);
    await page.getByRole("link", { name: "Open Evidence detail →" }).click();
    await page.locator("#evidence-set").selectOption({ label: "Outcome Evidence Set · 0 members" });
    await page.getByRole("button", { name: "Add to set" }).click();
    await expect(page.getByRole("status")).toHaveText("Evidence Set membership saved.");

    await page.goto(`/projects/${projectId}/evidence-sets`);
    await page.getByRole("link", { name: "Outcome Evidence Set", exact: true }).click();
    await page.getByRole("button", { name: "Prepare synthesis →" }).click();
    await expect(page).toHaveURL(/\/synthesis\/preparations\/[0-9a-f-]+$/);
    const preparationId = new URL(page.url()).pathname.split("/").pop()!;
    await page.getByRole("checkbox", { name: "Select candidate observation from Study Alpha" }).check();
    await page.getByRole("button", { name: "Save candidate selections" }).click();

    // Begin and execute a test-fake request. Provider success alone must not
    // create canonical synthesis state.
    await page.getByRole("checkbox", { name: /selected values.*may be transmitted/i }).check();
    await page.getByRole("button", { name: "Suggest synthesis with AI" }).click();
    await expect(page).toHaveURL(new RegExp(`/synthesis/preparations/${preparationId}\\?saved=ai-requested$`));
    const history = page.locator("section", { hasText: "AI suggestion history" });
    const firstRequest = history.locator(".item").first();
    await firstRequest.getByRole("button", { name: "Generate suggestion" }).click();
    await expect(page.getByText("Deterministic AI synthesis suggestion", { exact: true })).toBeVisible();
    await expect(page.getByText("Frozen grounding locators", { exact: false })).toBeVisible();
    await expect(page.locator(".quote").filter({ hasText: maliciousSource }).first()).toBeVisible();
    expect(await page.locator(".quote script").count()).toBe(0);
    expect(await page.locator(".quote img[onerror]").count()).toBe(0);

    const db = await getTestDbClient();
    let statementId = "";
    let synthesisRevisionId = "";
    try {
      const [beforeDecision] = await db`select count(*)::int as count from synthesis_revisions where project_id=${projectId}`;
      expect(Number(beforeDecision.count)).toBe(0);
      await firstRequest.getByRole("button", { name: "Reject" }).click();
      await expect(page.getByRole("status")).toContainText("AI synthesis suggestion rejected.");
      const [afterReject] = await db`select count(*)::int as count from synthesis_revisions where project_id=${projectId}`;
      expect(Number(afterReject.count)).toBe(0);

      // Regenerate, edit, and accept through the same canonical preparation seam.
      await page.getByRole("checkbox", { name: /selected values.*may be transmitted/i }).check();
      await page.getByRole("button", { name: "Suggest synthesis with AI" }).click();
      const secondRequest = history.locator(".item").first();
      await secondRequest.getByRole("button", { name: "Generate suggestion" }).click();
      await expect(secondRequest.getByText("Deterministic AI synthesis suggestion", { exact: true })).toBeVisible();
      await secondRequest.locator('input[id^="ai-title-"]').fill("Researcher edited title");
      await secondRequest.locator('textarea[id^="ai-statement-"]').fill("Researcher edited statement from the frozen source.");
      await secondRequest.locator('textarea[id^="ai-note-"]').fill("Researcher acceptance note.");
      await secondRequest.getByRole("button", { name: "Edit and accept" }).click();
      await expect(page).toHaveURL(new RegExp(`/synthesis/preparations/${preparationId}\\?saved=ai-accepted$`));
      const [prep] = await db`select target_synthesis_statement_id, finalized_synthesis_revision_id from synthesis_preparations where project_id=${projectId} and id=${preparationId}`;
      statementId = String(prep.target_synthesis_statement_id);
      synthesisRevisionId = String(prep.finalized_synthesis_revision_id);
      expect(statementId).not.toBe("null");
      expect(synthesisRevisionId).not.toBe("null");
      const [canonical] = await db`select count(*)::int as count from synthesis_revisions where project_id=${projectId} and id=${synthesisRevisionId}`;
      expect(Number(canonical.count)).toBe(1);
      const supports = await db`select extraction_revision_id from synthesis_revision_supports where project_id=${projectId} and synthesis_revision_id=${synthesisRevisionId}`;
      expect(supports).toHaveLength(1);
    } finally {
      await db.end();
    }

    // Normal synthesis detail/history remains the canonical surface.
    await page.getByRole("link", { name: "View finalized synthesis statement →" }).click();
    await expect(page).toHaveURL(new RegExp(`/synthesis/${statementId}$`));
    await expect(page.getByRole("heading", { name: "Complete synthesis history" })).toBeVisible();
    await expect(page.locator("p.synthesis-statement").filter({ hasText: "Researcher edited statement from the frozen source." }).first()).toBeVisible();

    // The ordinary Claim workflow can explicitly attach the canonical revision.
    await page.goto(`/projects/${projectId}/claims`);
    await page.getByLabel("Claim text").fill("The intervention improved the outcome.");
    await page.getByRole("button", { name: "Create unsupported claim" }).click();
    await expect(page).toHaveURL(new RegExp(`/claims/[0-9a-f-]+\\?saved=created$`));
    const claimId = page.url().match(/claims\/([0-9a-f-]+)(?:\?|$)/)?.[1] as string;
    expect(claimId).toBeTruthy();
    await page.goto(`/projects/${projectId}/claims/${claimId}?synthesisRevisionId=${synthesisRevisionId}`);
    await expect(page.locator('input[type="hidden"][name="synthesisRevisionIds"][value="' + synthesisRevisionId + '"]')).toHaveValue(synthesisRevisionId);
    await page.locator("#revision-claim-text").fill("The intervention improved the outcome.");
    await page.getByRole("button", { name: "Save new Claim revision" }).click();
    await expect(page.getByText("Supporting synthesis", { exact: true })).toBeVisible();
    await expect(page.locator("p.synthesis-statement").filter({ hasText: "Researcher edited statement from the frozen source." }).first()).toBeVisible();

    // The RQ workflow links the ordinary SynthesisStatement, never an AI row.
    await page.goto(`/projects/${projectId}/research-questions`);
    const rqRow = page.locator("tr", { hasText: "RQ1" });
    await rqRow.getByRole("link", { name: /Open workspace/i }).click();
    const synthesisSection = page.locator("section", { hasText: "Synthesis Statements" });
    await synthesisSection.locator('select[name="statementId"]').selectOption(statementId);
    await synthesisSection.locator('input[name="note"]').fill("Canonical synthesis traceability");
    await synthesisSection.getByRole("button", { name: "Link statement" }).click();
    await expect(page.getByText("Traceability link updated.")).toBeVisible();
    await expect(synthesisSection.locator("article.item").filter({ hasText: "Researcher edited title" }).first()).toBeVisible();

    // Historical source context is frozen even after permitted Paper metadata drift.
    const driftDb = await getTestDbClient();
    try {
      await driftDb`update papers set title='Current mutable title' where project_id=${projectId} and title='Study Alpha'`;
    } finally {
      await driftDb.end();
    }
    await page.goto(`/projects/${projectId}/synthesis/preparations/${preparationId}`);
    await history.locator("details").evaluateAll((nodes) => nodes.forEach((node) => { (node as HTMLDetailsElement).open = true; }));
    await expect(history.getByText("Study Alpha", { exact: true }).first()).toBeVisible();
    await expect(history.locator("li").filter({ hasText: maliciousSource }).first()).toBeVisible();
    await expect(history.getByText("Current mutable title", { exact: true })).not.toBeVisible();
    await expect(history.getByText("rejected", { exact: true }).last()).toBeVisible();
    await expect(history.getByText("accepted", { exact: true }).last()).toBeVisible();
  });
});
