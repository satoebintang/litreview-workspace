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
        return postgres(`${base}/${marker.databaseName}`, { max: 1 });
      }
    } catch {
      // fallback
    }
  }
  return postgres(process.env.DATABASE_URL || DEFAULT_DATABASE_URL, { max: 1 });
}

test.describe("Slice 20 Research Questions Traceability", () => {
  test("manages research question traceability across 4 targets, displays protocol context, preserves history, and enforces read-only for archived questions", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const unique = Date.now();

    // 1. Create project
    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 20 Traceability Review ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = page.url().match(/projects\/([0-9a-f-]+)$/)?.[1] as string;

    // 2. Setup protocol: create RQ1, RQ2, search strategy, and search run
    await page.goto(`/projects/${projectId}/protocol`);
    await page.getByLabel("Identifier").fill("RQ1");
    await page.getByLabel("Question").fill("How effective are defensive mechanisms?");
    await page.getByRole("button", { name: "Add research question" }).click();
    await expect(page.locator(".item-title").filter({ hasText: "How effective are defensive mechanisms?" })).toBeVisible({ timeout: 30_000 });

    await page.getByLabel("Identifier").fill("RQ2");
    await page.getByLabel("Question").fill("What are historical attack trajectories?");
    await page.getByRole("button", { name: "Add research question" }).click();
    await expect(page.locator(".item-title").filter({ hasText: "What are historical attack trajectories?" })).toBeVisible({ timeout: 30_000 });

    // Add search strategy
    await page.getByLabel("Strategy name").fill("Core Database Strategy");
    await page.getByLabel("Exact query").fill('("security" AND "defense")');
    await page.getByRole("button", { name: "Save strategy" }).click();
    await expect(page.locator(".item-title").filter({ hasText: "Core Database Strategy" })).toBeVisible({ timeout: 30_000 });

    // Record immutable search run
    await page.getByLabel("Reported result count").fill("42");
    await page.getByRole("button", { name: "Record immutable run" }).click();
    await expect(page.locator(".status.supported").filter({ hasText: "42 results" })).toBeVisible({ timeout: 30_000 });

    // 3. Navigate to Research Questions Matrix View
    await page.goto(`/projects/${projectId}`);
    await page.getByRole("link", { name: /Open Research Questions/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/research-questions$`));

    // Verify Project Protocol Context banner
    const protocolBanner = page.locator("section", { hasText: "Project Protocol Context" });
    await expect(protocolBanner).toBeVisible();
    await expect(protocolBanner.locator(".hint")).toContainText("Project-wide search context:");
    await expect(protocolBanner.locator(".status.supported").filter({ hasText: /active strateg/ })).toBeVisible();
    await expect(protocolBanner.locator(".status.supported").filter({ hasText: /search run/ })).toBeVisible();

    // Verify matrix rows
    await expect(page.locator("tr", { hasText: "RQ1" })).toBeVisible();
    await expect(page.locator("tr", { hasText: "RQ2" })).toBeVisible();
    await expect(page.getByText("How effective are defensive mechanisms?")).toBeVisible();

    // 4. Create source paper, evidence, screening, extraction, evidence set, synthesis, claim
    // Add paper
    await page.goto(`/projects/${projectId}`);
    await page.getByLabel("Title", { exact: true }).fill("Study Alpha");
    await page.getByLabel("Authors").fill("Dr. Alice, Dr. Bob");
    await page.getByLabel("Abstract").fill("Empirical study on cyber defense effectiveness.");
    await page.getByRole("button", { name: "Add paper" }).click();
    await expect(page.locator(".item-title").filter({ hasText: "Study Alpha" })).toBeVisible({ timeout: 30_000 });

    // Record Evidence
    await page.reload();
    await page.getByLabel("Paper").selectOption({ label: "Study Alpha" });
    await page.getByLabel("Verbatim source passage").fill("Automated defense mechanisms reduced intrusion success by 92%.");
    await page.getByLabel("Page number").fill("8");
    await page.getByRole("button", { name: "Record evidence" }).click();
    await expect(page.locator(".quote").filter({ hasText: "Automated defense mechanisms reduced intrusion success by 92%." })).toBeVisible({ timeout: 30_000 });

    // Screen Paper to Included
    await page.goto(`/projects/${projectId}/screening`);
    await page.getByLabel("Type").selectOption("exclusion");
    await page.getByLabel("Criterion").fill("Not empirical");
    await page.getByRole("button", { name: "Add criterion" }).click();
    await expect(page.getByText("Not empirical")).toBeVisible({ timeout: 30_000 });

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

    // Extraction field & observation
    await page.goto(`/projects/${projectId}/extraction`);
    await page.getByLabel("Field name").fill("Intrusion Reduction Rate");
    await page.getByRole("button", { name: "Add extraction field" }).click();

    const extractionLink = await page.locator("a.extraction-progress-item").filter({ hasText: "Study Alpha" }).getAttribute("href");
    expect(extractionLink).toBeTruthy();
    await page.goto(`${extractionLink}`);
    await page.getByLabel("Structured value").fill("92% reduction");
    await page.locator('input[name="evidenceIds"]').first().check();
    await page.getByRole("button", { name: "Save new revision" }).click();
    await expect(page.getByText("Extraction revision saved.")).toBeVisible();

    // Evidence set
    await page.goto(`/projects/${projectId}/evidence-sets`);
    await page.getByLabel("Name").fill("Defense Efficacy Set");
    await page.getByLabel("Purpose or theme").fill("Evidence of intrusion reduction");
    await page.getByRole("button", { name: "Create Evidence Set" }).click();
    await expect(page).toHaveURL(/\/evidence-sets\/[0-9a-f-]+\?saved=created$/);
    const setId = new URL(page.url()).pathname.split("/").pop()!;

    await page.goto(`/projects/${projectId}/evidence`);
    await page.getByRole("link", { name: "Open Evidence detail →" }).click();
    await page.locator("#evidence-set").selectOption(setId);
    await page.getByRole("button", { name: "Add to set" }).click();
    await expect(page.getByRole("status")).toHaveText("Evidence Set membership saved.");

    // Synthesis statement
    await page.goto(`/projects/${projectId}/synthesis`);
    await page.getByRole("checkbox", { name: /Select observation from Study Alpha/i }).check();
    await page.getByLabel("Topic or title").fill("Intrusion Mitigation Synthesis");
    await page.getByLabel("Synthesis statement").fill("Automated defense filters significantly lower intrusion risk across deployments.");
    await page.getByRole("button", { name: "Create synthesis from selected observations" }).click();
    await expect(page.getByText("Synthesis statement created.")).toBeVisible({ timeout: 30_000 });

    // Claim
    await page.goto(`/projects/${projectId}/claims`);
    await page.getByLabel("Claim text").fill("Automated defense is highly effective against modern intrusions.");
    await page.getByRole("button", { name: "Create unsupported claim" }).click();
    await expect(page.getByText("Claim saved.")).toBeVisible({ timeout: 30_000 });

    // 5. Open RQ1 Detail Workspace
    await page.goto(`/projects/${projectId}/research-questions`);
    const rq1Row = page.locator("tr", { hasText: "RQ1" });
    await rq1Row.getByRole("link", { name: /Open workspace/i }).click();
    await expect(page).toHaveURL(/\/research-questions\/[0-9a-f-]+$/);
    const rq1Id = page.url().match(/research-questions\/([0-9a-f-]+)$/)?.[1] as string;
    expect(rq1Id).toBeTruthy();

    // Verify Active status and Protocol context banner
    await expect(page.getByText("● Question Active")).toBeVisible();
    await expect(page.locator("section", { hasText: "Project Protocol Context" })).toBeVisible();

    // Link Extraction Field
    const extractionSection = page.locator("section", { hasText: "Extraction Fields" });
    await extractionSection.locator("select[name='fieldId']").selectOption({ index: 1 });
    await extractionSection.locator("input[name='note']").fill("Primary empirical observation for RQ1");
    await extractionSection.getByRole("button", { name: "Link field" }).click();
    await expect(page.getByText("Traceability link updated.")).toBeVisible();
    await expect(extractionSection.locator(".item-title").filter({ hasText: "Intrusion Reduction Rate" })).toBeVisible();
    await expect(extractionSection.getByText("92% reduction")).toBeVisible();

    // Link Evidence Set
    const evidenceSetSection = page.locator("section", { hasText: "Evidence Sets" });
    await evidenceSetSection.locator("select[name='evidenceSetId']").selectOption({ index: 1 });
    await evidenceSetSection.locator("input[name='note']").fill("Primary evidence collection for RQ1");
    await evidenceSetSection.getByRole("button", { name: "Link set" }).click();
    await expect(page.getByText("Traceability link updated.")).toBeVisible();
    await expect(evidenceSetSection.locator(".item-title").filter({ hasText: "Defense Efficacy Set" })).toBeVisible();

    // Link Synthesis Statement
    const synthesisSection = page.locator("section", { hasText: "Synthesis Statements" });
    await synthesisSection.locator("select[name='statementId']").selectOption({ index: 1 });
    await synthesisSection.locator("input[name='note']").fill("Primary synthesis conclusion for RQ1");
    await synthesisSection.getByRole("button", { name: "Link statement" }).click();
    await expect(page.getByText("Traceability link updated.")).toBeVisible();
    await expect(synthesisSection.locator(".item-title").filter({ hasText: "Intrusion Mitigation Synthesis" })).toBeVisible();

    // Link Claim
    const claimSection = page.locator("section", { hasText: "Manuscript Claims" });
    await claimSection.locator("select[name='claimId']").selectOption({ index: 1 });
    await claimSection.locator("input[name='note']").fill("Primary assertion for RQ1");
    await claimSection.getByRole("button", { name: "Link claim" }).click();
    await expect(page.getByText("Traceability link updated.")).toBeVisible();
    await expect(claimSection.locator(".quote-inline").filter({ hasText: "Automated defense is highly effective" })).toBeVisible();

    // Check Event History on Extraction Field
    await extractionSection.locator("summary", { hasText: "Event History" }).click();
    await expect(extractionSection.locator("details.revision-history").getByText(/seq #\d+/)).toBeVisible();
    await expect(extractionSection.locator("details.revision-history").getByText("Primary empirical observation for RQ1")).toBeVisible();

    // 6. Test Unlink and Re-link cycle
    await extractionSection.locator("input[name='note']").first().fill("Unlinking to test alternating transition");
    await extractionSection.getByRole("button", { name: "Unlink" }).click();
    await expect(page.getByText("Traceability link updated.")).toBeVisible();
    await expect(extractionSection.getByText("No extraction fields linked to this research question yet.")).toBeVisible();

    // Re-link
    await extractionSection.locator("select[name='fieldId']").selectOption({ index: 1 });
    await extractionSection.locator("input[name='note']").fill("Restoring link after verification");
    await extractionSection.getByRole("button", { name: "Link field" }).click();
    await expect(page.getByText("Traceability link updated.")).toBeVisible();
    await expect(extractionSection.locator(".item-title").filter({ hasText: "Intrusion Reduction Rate" })).toBeVisible();

    // Verify all 3 events are present in history
    await extractionSection.locator("summary", { hasText: "Event History" }).click();
    await expect(extractionSection.locator("summary", { hasText: "3 events" })).toBeVisible();

    // 7. Verify Matrix view reflects updated counts
    await page.goto(`/projects/${projectId}/research-questions`);
    const rq1MatrixRow = page.locator("tr", { hasText: "RQ1" });
    await expect(rq1MatrixRow.getByText("1 linked").first()).toBeVisible();

    // 8. Test Archived Question Read-Only Enforcement
    const sql = await getTestDbClient();
    try {
      // Find RQ2 id
      const [rq2] = await sql`
        select id from research_questions
        where project_id = ${projectId} and identifier = 'RQ2'
        limit 1
      `;
      expect(rq2).toBeTruthy();
      const rq2Id = rq2.id;

      // Archive RQ2
      await sql`
        update research_questions
        set archived_at = now()
        where id = ${rq2Id}
      `;

      // Visit RQ2 detail workspace
      await page.goto(`/projects/${projectId}/research-questions/${rq2Id}`);
      await expect(page.getByText("● Question Archived")).toBeVisible();
      await expect(page.getByText("Read-only question: This research question has been archived.")).toBeVisible();

      // Ensure linking forms are not shown
      await expect(page.getByRole("button", { name: "Link field" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Link set" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Link statement" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Link claim" })).toHaveCount(0);

      // Verify Matrix shows Archived badge for RQ2
      await page.goto(`/projects/${projectId}/research-questions`);
      const rq2MatrixRow = page.locator("tr", { hasText: "RQ2" });
      await expect(rq2MatrixRow.getByText("Archived")).toBeVisible();
    } finally {
      await sql.end();
    }
  });
});
