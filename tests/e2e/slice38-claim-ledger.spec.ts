import { expect, test } from "@playwright/test";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { createPlaywrightTestDatabaseClient, resolvePlaywrightTestDatabaseUrl } from "./playwright-database";

test.describe("Slice 38 Claim ledger", () => {
  test("pages and filters database rows while preserving an active interpretation form", async ({ page }) => {
    test.setTimeout(180_000);
    const unique = Date.now();

    await page.goto("/");
    await page.getByLabel("Project title").fill(`Slice 38 Claims ${unique}`);
    await page.getByRole("button", { name: /Create project/ }).click();
    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+$/);
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    const testDatabase = createDb(resolvePlaywrightTestDatabaseUrl());
    const services = createReviewServices(testDatabase.db);
    const seedClient = createPlaywrightTestDatabaseClient({ prepare: false });
    let interpretationId = "";
    let synthesisRevisionId = "";
    try {
      await seedClient.begin(async (tx) => {
        await tx`insert into claims (project_id)
          select ${projectId}::uuid from generate_series(1, 51)`;
        await tx`insert into claim_revisions (project_id, claim_id, state, claim_text)
          select ${projectId}::uuid, c.id, 'active', 'Unsupported fixture ' || row_number() over (order by c.id)::text
          from claims c where c.project_id=${projectId}::uuid`;
        await tx`update claim_revisions set finalized_at=now()
          where project_id=${projectId}::uuid and finalized_at is null`;
      });

      const paper = await services.addPaper(projectId, { title: `Slice 38 interpretation source ${unique}`, authors: ["A. Researcher"] });
      await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
      await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
      await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
      const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "The source supports the exact Claim revision.", pageNumber: 4 });
      const field = await services.createExtractionField(projectId, { name: `Slice 38 finding ${unique}`, fieldType: "short_text" });
      const extraction = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Observed result", evidenceIds: [] });
      const synthesis = await services.createSynthesisStatement(projectId, { statementText: "The observed result is consistent.", extractionRevisionIds: [extraction.id] });
      synthesisRevisionId = synthesis.revision.id;
      const interpretation = await services.appendSynthesisInterpretation(projectId, synthesis.statement.id, synthesis.revision.id, {
        convergenceState: "convergent",
        summary: "The included study reports a consistent result.",
      });
      interpretationId = interpretation.id;

      const claim = await services.createClaim(projectId, { claimText: "The source provides a direct supporting passage." });
      await services.createClaimRevision(projectId, claim.id, {
        claimText: "The source provides a direct supporting passage.",
        expectedCurrentRevisionId: claim.revision.id,
        supports: [{ kind: "evidence", evidenceId: evidence.id }],
      });
    } finally {
      await seedClient.end();
      await testDatabase.client.end();
    }

    const query = `interpretationId=${interpretationId}&synthesisRevisionId=${synthesisRevisionId}`;
    await page.goto(`/projects/${projectId}/claims?${query}`);
    await expect(page.getByRole("heading", { name: "New claim from interpretation" })).toBeVisible();
    await expect(page.getByLabel("Claim text")).toHaveValue("The included study reports a consistent result.");

    const pagination = page.getByRole("navigation", { name: "Claim ledger pagination" });
    await expect(page.getByText("1–50 of 52", { exact: true })).toBeVisible();
    await expect(page.locator(".item-list .item")).toHaveCount(50);
    await expect(pagination.getByText("Page 1 of 2", { exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".claim-stats")).toContainText("All claims52");
    await expect(page.locator(".claim-stats")).toContainText("Supported1");
    await expect(page.locator(".claim-stats")).toContainText("Unsupported51");

    await pagination.getByRole("link", { name: "Next page" }).click();
    await expect(page).toHaveURL(new RegExp(`/claims\\?page=2&interpretationId=${interpretationId}&synthesisRevisionId=${synthesisRevisionId}$`));
    await expect(page.getByText("51–52 of 52", { exact: true })).toBeVisible();
    await expect(page.locator(".item-list .item")).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "New claim from interpretation" })).toBeVisible();

    await page.locator(".claim-stats .screening-stat").nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/claims\\?filter=supported&interpretationId=${interpretationId}&synthesisRevisionId=${synthesisRevisionId}$`));
    await expect(page.getByText("1–1 of 1", { exact: true })).toBeVisible();
    await expect(page.locator(".item-list .item")).toHaveCount(1);
    await expect(page.locator(".claim-stats .screening-stat.active")).toContainText("Supported1");
    await expect(page.getByRole("heading", { name: "New claim from interpretation" })).toBeVisible();
  });
});
