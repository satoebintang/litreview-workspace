import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { resolvePlaywrightTestDatabaseUrl } from "./playwright-database";

test.describe("Slice 45 Evidence Set workspace", () => {
  test("pages the workspace, searches explicitly, moves across pages, preserves history, and reports stale mutations", async ({ page }) => {
    test.setTimeout(300_000);
    const suffix = randomUUID();
    const database = createDb(resolvePlaywrightTestDatabaseUrl());
    const services = createReviewServices(database.db);
    let projectId = "";
    let setId = "";
    const evidenceIds: string[] = [];
    const setName = `Slice45 Set ${suffix}`;
    try {
      const project = await services.createProject({ title: `Slice 45 workspace ${suffix}` });
      projectId = project.id;
      const paper = await services.addPaper(projectId, { title: `Slice 45 Study ${suffix}`, authors: ["Workspace Author"] });
      for (let index = 1; index <= 52; index += 1) {
        const recorded = await services.recordEvidence(projectId, {
          paperId: paper.id,
          sourceText: index === 52 ? "Unique browse candidate passage" : `Ordered passage ${String(index).padStart(2, "0")}`,
          pageNumber: index,
        });
        evidenceIds.push(recorded.id);
      }
      const createdSet = await services.createEvidenceSet(projectId, { name: setName, description: "Bounded workspace browser fixture" });
      setId = createdSet.set.id;
      let revisionId = createdSet.revision.id;
      for (const evidenceId of evidenceIds.slice(0, 51)) {
        const result = await services.addEvidenceToSet(projectId, setId, { evidenceId, expectedRevisionId: revisionId });
        revisionId = result.revision.id;
      }

      const collectionUrl = `/projects/${projectId}/evidence-sets`;
      await page.goto(`${collectionUrl}?query=${encodeURIComponent(setName)}&visibility=active`);
      await expect(page.getByRole("link", { name: setName })).toBeVisible();
      await expect(page.getByText("1 active · 0 archived", { exact: true }).first()).toBeVisible();

      const setUrl = `/projects/${projectId}/evidence-sets/${setId}`;
      await page.goto(setUrl);
      await expect(page.locator('[data-testid="evidence-set-member"]')).toHaveCount(50);
      await expect(page.getByText("Unique browse candidate passage", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Browse candidates" })).toBeVisible();
      await page.getByRole("button", { name: "Browse candidates" }).click();
      await expect(page).toHaveURL(/candidateBrowse=1/);
      const candidate = page.locator("article.item").filter({ hasText: "Unique browse candidate passage" });
      await expect(candidate).toBeVisible();
      await candidate.getByRole("button", { name: "Add to this set" }).click();
      await expect(page.getByRole("status")).toHaveText("Evidence Set membership saved.");
      await expect(page.locator('[data-testid="evidence-set-member"]')).toHaveCount(50);

      const passage50 = page.locator('[data-testid="evidence-set-member"]').filter({ hasText: "Ordered passage 50" });
      await passage50.getByRole("button", { name: /Move .* down/ }).click();
      await page.getByRole("link", { name: "Next member page" }).click();
      const pageTwoPassage50 = page.locator('[data-testid="evidence-set-member"]').filter({ hasText: "Ordered passage 50" });
      await expect(pageTwoPassage50).toBeVisible();
      await pageTwoPassage50.getByRole("button", { name: /Move .* up/ }).click();
      await expect(page.locator('[data-testid="evidence-set-member"]').filter({ hasText: "Ordered passage 50" })).toBeVisible();

      const history = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Composition history" }) });
      await expect(history.getByRole("link", { name: "Older revisions" })).toBeVisible();
      await history.getByRole("link", { name: "Older revisions" }).click();
      await expect(page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Composition history" }) }).getByText("revisions shown")).toBeVisible();
      await page.goto(setUrl);
      const latestHistory = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Composition history" }) });
      await latestHistory.getByRole("link", { name: "Open exact members" }).first().click();
      await expect(page.getByRole("heading", { name: "Exact ordered members" })).toBeVisible();
      await expect(page.locator("article.item")).toHaveCount(50);
      await page.getByRole("link", { name: "Next page" }).click();
      await expect(page.locator("article.item")).toHaveCount(2);

      await page.goto(setUrl);
      const firstMember = page.locator('[data-testid="evidence-set-member"]').filter({ hasText: "Ordered passage 01" });
      await firstMember.getByRole("button", { name: "Remove" }).click();
      await expect(page.getByRole("status")).toHaveText("Evidence Set membership saved.");
      await expect(page.locator('[data-testid="evidence-set-member"]').filter({ hasText: "Ordered passage 01" })).toHaveCount(0);

      const stalePageRevision = (await page.getByTestId("composition-revision").textContent())?.match(/[0-9a-f-]{36}/i)?.[0];
      expect(stalePageRevision).toBeTruthy();
      const latest = await services.getEvidenceSet(projectId, setId);
      const concurrentEvidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Concurrent revision evidence", pageNumber: 90 });
      await services.addEvidenceToSet(projectId, setId, { evidenceId: concurrentEvidence.id, expectedRevisionId: latest.currentRevision.id });
      await page.locator('[data-testid="evidence-set-member"]').first().getByRole("button", { name: /Move .* up/ }).click();
      await expect(page.locator(".error-banner[role='alert']")).toContainText("changed in another session");

      await page.getByRole("button", { name: "Archive and freeze set" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Archive and freeze set" }).click();
      await expect(page.getByRole("status")).toHaveText("Evidence Set archived and frozen.");
      await expect(page.getByRole("button", { name: /Move .* (up|down)/ })).toHaveCount(0);
      await page.goto(`${collectionUrl}?query=${encodeURIComponent(setName)}&visibility=archived`);
      await expect(page.getByRole("link", { name: setName })).toBeVisible();

      const selectorSet = await services.createEvidenceSet(projectId, { name: `Selector Set ${suffix}` });
      await page.goto(`/projects/${projectId}/evidence/${evidenceIds[0]}`);
      await page.getByLabel("Search active Sets").fill(`Selector Set ${suffix}`);
      await page.getByRole("button", { name: "Search Sets" }).click();
      await page.locator("#evidence-set").selectOption({ label: `Selector Set ${suffix} · 0 members` });
      await page.getByRole("button", { name: "Add to set" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/evidence-sets/${selectorSet.set.id}\\?saved=member&revisionId=`));
    } finally {
      await database.client.end();
    }
  });
});
