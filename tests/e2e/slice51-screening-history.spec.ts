import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { createPlaywrightTestDatabaseClient, resolvePlaywrightTestDatabaseUrl } from "./playwright-database";

test.describe("Slice 51 bounded screening histories", () => {
  test("pages each stream, restores exact events, rejects forged scope, and resets writers to page one", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(30_000);
    const unique = randomUUID();
    const database = createDb(resolvePlaywrightTestDatabaseUrl());
    const services = createReviewServices(database.db);
    const seedClient = createPlaywrightTestDatabaseClient({ prepare: false });
    const titleAbstractNote = `Title/abstract audit note ${"T".repeat(700)}`;
    const retrievalNote = `Retrieval audit note ${"R".repeat(500)}`;
    const sourceReference = `Retrieval source reference ${"S".repeat(500)}`;
    const fullTextNote = `Full-text audit note ${"F".repeat(700)}`;
    const paperAbstract = `Exact abstract, fully retained. ${"Abstract detail ".repeat(100)}`;
    const historicalAttemptedAt = new Date("1900-01-01T12:00:00.000Z");

    try {
      const project = await services.createProject({ title: `Slice 51 history ${unique}` });
      const paper = await services.addPaper(project.id, {
        title: "Slice 51 exact-history Paper",
        authors: ["Exact author one", "Exact author two"],
        abstract: paperAbstract,
        doi: "10.5555/slice51-history-e2e",
      });
      const otherPaper = await services.addPaper(project.id, { title: "Slice 51 other Paper" });
      const titleCriterion = await services.createScreeningCriterion(project.id, {
        type: "exclusion",
        text: "Historical title/abstract exclusion criterion",
      });
      const fullTextCriterion = await services.createFullTextScreeningCriterion(project.id, {
        text: "Historical full-text exclusion criterion",
      });

      const titleFirst = await services.recordScreeningDecision(project.id, paper.id, {
        decision: "exclude",
        exclusionCriterionId: titleCriterion.id,
        note: titleAbstractNote,
      });
      for (let index = 2; index <= 20; index += 1) {
        await services.recordScreeningDecision(project.id, paper.id, {
          decision: "maybe",
          note: `Title/abstract event ${index}`,
        });
      }
      const titleCurrent = await services.recordScreeningDecision(project.id, paper.id, {
        decision: "include",
        note: "Current title/abstract decision starts at sequence 21.",
      });

      const retrievalFirst = await services.recordFullTextRetrievalAttempt(project.id, paper.id, {
        outcome: "unavailable",
        method: "publisher",
        sourceReference,
        note: retrievalNote,
        attemptedAt: new Date("2200-01-01T00:00:00.000Z"),
      });
      for (let index = 2; index <= 20; index += 1) {
        await services.recordFullTextRetrievalAttempt(project.id, paper.id, {
          outcome: "unavailable",
          method: "publisher",
          attemptedAt: new Date(`2200-01-${String(index).padStart(2, "0")}T00:00:00.000Z`),
        });
      }
      const retrievalCurrent = await services.recordFullTextRetrievalAttempt(project.id, paper.id, {
        outcome: "retrieved",
        method: "publisher",
        attemptedAt: historicalAttemptedAt,
      });

      const fullTextFirst = await services.recordFullTextScreeningDecision(project.id, paper.id, {
        decision: "exclude",
        exclusionCriterionId: fullTextCriterion.id,
        note: fullTextNote,
      });
      for (let index = 2; index <= 20; index += 1) {
        await services.recordFullTextScreeningDecision(project.id, paper.id, {
          decision: "maybe",
          note: `Full-text event ${index}`,
        });
      }
      const fullTextCurrent = await services.recordFullTextScreeningDecision(project.id, paper.id, {
        decision: "include",
        note: "Current full-text decision starts at sequence 21.",
      });

      await services.archiveScreeningCriterion(project.id, titleCriterion.id);
      await services.archiveFullTextScreeningCriterion(project.id, fullTextCriterion.id);

      const titleDetailPath = `/projects/${project.id}/screening/${paper.id}`;
      const titleHistoryPath = `${titleDetailPath}/history`;
      const retrievalDetailPath = `/projects/${project.id}/screening/full-text/retrieval/${paper.id}`;
      const retrievalHistoryPath = `${retrievalDetailPath}/history`;
      const fullTextDetailPath = `/projects/${project.id}/screening/full-text/${paper.id}`;
      const sectionForHeading = (name: string) => page.getByRole("heading", { name, exact: true }).locator("..").locator("..");

      await page.goto(titleDetailPath);
      await expect(page.getByRole("heading", { name: paper.title, exact: true })).toBeVisible();
      await expect(page.getByText(paperAbstract, { exact: true })).toBeVisible();
      await expect(page.getByText("Exact author one, Exact author two", { exact: true })).toBeVisible();
      await expect(page.getByText("DOI: 10.5555/slice51-history-e2e", { exact: true })).toBeVisible();
      const titleDetailHistory = sectionForHeading("Screening history");
      await expect(titleDetailHistory.getByText("20 shown", { exact: true })).toBeVisible();
      await expect(titleDetailHistory.getByText("preview shortened", { exact: false })).toBeVisible();
      await expect(titleDetailHistory.getByText(titleCriterion.text, { exact: false })).toBeVisible();
      await expect(titleDetailHistory.getByRole("link", { name: "View exact current event →" })).toBeVisible();
      await titleDetailHistory.getByRole("link", { name: "View full event →" }).first().click();
      await expect(page.getByRole("heading", { name: "Historical event" })).toBeVisible();
      await expect(page.getByText(titleAbstractNote, { exact: true })).toBeVisible();
      await expect(page.getByText(titleCriterion.text, { exact: true })).toBeVisible();
      await page.goto(titleDetailPath);
      await titleDetailHistory.getByRole("link", { name: "More history →" }).click();
      await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
      await expect(page.getByText("1 shown", { exact: true })).toBeVisible();
      await expect(page.getByText("Current state: include", { exact: true })).toBeVisible();
      await expect(page.getByText("INCLUDE", { exact: true })).toBeVisible();

      const titleCursor = new URL(page.url()).searchParams.get("cursor");
      expect(titleCursor).toBeTruthy();
      const wrongPaperCursorResponse = await page.goto(`${`/projects/${project.id}/screening/${otherPaper.id}/history`}?cursor=${encodeURIComponent(titleCursor!)}`);
      expect(wrongPaperCursorResponse?.status()).toBe(404);
      const wrongPaperEventResponse = await page.goto(`${`/projects/${project.id}/screening/${otherPaper.id}/history`}/${titleFirst.id}`);
      expect(wrongPaperEventResponse?.status()).toBe(404);
      const malformedCursorResponse = await page.goto(`${titleHistoryPath}?cursor=not-a-cursor`);
      expect(malformedCursorResponse?.status()).toBe(404);

      await page.goto(titleDetailPath);
      await page.getByLabel("Include note").fill("Title/abstract writer after continuation");
      await page.getByRole("button", { name: "Include", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${titleDetailPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?saved=decision$`));
      await expect(page.getByRole("status").filter({ hasText: "Decision recorded in screening history." })).toBeVisible();
      await expect(sectionForHeading("Screening history").getByText("20 shown", { exact: true })).toBeVisible();
      await expect(sectionForHeading("Screening history").getByRole("link", { name: "View exact current event →" })).toBeVisible();

      await page.goto(retrievalDetailPath);
      await expect(page.getByText("Current state", { exact: true }).locator("..").getByText("retrieved", { exact: true })).toBeVisible();
      await expect(page.getByText("Ever retrieved", { exact: true }).locator("..").getByText("yes", { exact: true })).toBeVisible();
      const retrievalDetailHistory = sectionForHeading("Retrieval history");
      await expect(retrievalDetailHistory.getByText("20 shown", { exact: true })).toBeVisible();
      await expect(retrievalDetailHistory.getByText("preview shortened", { exact: false })).toHaveCount(2);
      await expect(retrievalDetailHistory.getByRole("link", { name: "View exact current attempt →" })).toBeVisible();
      await retrievalDetailHistory.getByRole("link", { name: "View full event →" }).first().click();
      await expect(page.getByRole("heading", { name: "Historical attempt" })).toBeVisible();
      await expect(page.getByText(sourceReference, { exact: true })).toBeVisible();
      await expect(page.getByText(retrievalNote, { exact: true })).toBeVisible();
      await page.goto(retrievalDetailPath);
      await retrievalDetailHistory.getByRole("link", { name: "View exact current attempt →" }).click();
      await expect(page.getByRole("heading", { name: "Historical attempt", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: paper.title, exact: true })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe(`${retrievalDetailPath}/history/${retrievalCurrent.id}`);
      await expect(page.locator(".workspace-header .status")).toHaveText("retrieved");
      await expect(page.locator(".workspace-header")).toContainText(
        `Sequence ${retrievalCurrent.sequence} · attempted ${historicalAttemptedAt.toLocaleString()}`,
      );
      const exactEventRow = (label: string) => page.locator("dl .item-row").filter({
        has: page.locator("dt").getByText(label, { exact: true }),
      });
      await expect(exactEventRow("Event ID").locator("dd")).toHaveText(retrievalCurrent.id);
      await expect(exactEventRow("Outcome").locator("dd")).toHaveText("retrieved");
      await expect(exactEventRow("Sequence").locator("dd")).toHaveText(String(retrievalCurrent.sequence));
      await expect(exactEventRow("Attempted at").locator("dd")).toHaveText(historicalAttemptedAt.toLocaleString());
      await expect(exactEventRow("Recorded").locator("dd")).toHaveText(retrievalCurrent.createdAt.toLocaleString());
      expect(retrievalCurrent.createdAt.getTime()).not.toBe(historicalAttemptedAt.getTime());
      await page.goto(retrievalDetailPath);
      await retrievalDetailHistory.getByRole("link", { name: "More retrieval history →" }).click();
      await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
      await expect(page.getByText("1 shown", { exact: true })).toBeVisible();
      await expect(page.getByText("Current state: retrieved · ever retrieved: yes", { exact: true })).toBeVisible();
      await expect(page.getByText("RETRIEVED", { exact: true })).toBeVisible();

      await page.goto(fullTextDetailPath);
      const fullTextDetailHistory = sectionForHeading("Full-text screening history");
      const embeddedRetrievalHistory = sectionForHeading("Retrieval history");
      await expect(fullTextDetailHistory.getByText("20 shown", { exact: true })).toBeVisible();
      await expect(embeddedRetrievalHistory.getByText("20 shown", { exact: true })).toBeVisible();
      await expect(fullTextDetailHistory.getByText("criterion archived", { exact: false })).toBeVisible();
      await expect(fullTextDetailHistory.getByText("preview shortened", { exact: false })).toBeVisible();
      await expect(fullTextDetailHistory.getByRole("link", { name: "View exact current event →" })).toBeVisible();
      await fullTextDetailHistory.getByRole("link", { name: "View full event →" }).first().click();
      await expect(page.getByRole("heading", { name: "Historical event" })).toBeVisible();
      await expect(page.getByText(fullTextNote, { exact: true })).toBeVisible();
      await expect(page.getByText(fullTextCriterion.text, { exact: true })).toBeVisible();
      await page.goto(fullTextDetailPath);
      await fullTextDetailHistory.getByRole("link", { name: "View exact current event →" }).click();
      await expect(page.getByText("Current full-text decision starts at sequence 21.", { exact: true })).toBeVisible();
      await page.goto(fullTextDetailPath);
      await fullTextDetailHistory.getByRole("link", { name: "More history →" }).click();
      await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
      await expect(page.getByText("1 shown", { exact: true })).toBeVisible();
      await expect(page.getByText("Current state: include", { exact: true })).toBeVisible();
      await expect(page.getByText("INCLUDE", { exact: true })).toBeVisible();
      const fullTextCursor = new URL(page.url()).searchParams.get("cursor");
      expect(fullTextCursor).toBeTruthy();
      const wrongHistoryTypeResponse = await page.goto(`${retrievalHistoryPath}?cursor=${encodeURIComponent(fullTextCursor!)}`);
      expect(wrongHistoryTypeResponse?.status()).toBe(404);

      await page.goto(fullTextDetailPath);
      await page.getByLabel("Include note").fill("Full-text writer after continuation");
      await page.getByRole("button", { name: "Include", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${fullTextDetailPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?saved=decision$`));
      await expect(page.getByRole("status").filter({ hasText: "Full-text decision recorded in screening history." })).toBeVisible();
      await expect(page.getByText("20 shown", { exact: true })).toHaveCount(2);

      await page.goto(retrievalDetailPath);
      await page.getByLabel("Outcome").selectOption("pending");
      await page.getByLabel("Attempted at").fill("1800-01-01T12:00");
      await page.locator("#retrieval-note").fill("Backdated pending attempt becomes current by sequence.");
      await page.getByRole("button", { name: "Record attempt" }).click();
      await expect(page).toHaveURL(new RegExp(`${retrievalDetailPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?saved=attempt$`));
      await expect(page.getByRole("status").filter({ hasText: "Retrieval attempt recorded." })).toBeVisible();
      await expect(page.locator(".workspace-header .status")).toHaveText("pending");
      await expect(page.getByText("Ever retrieved", { exact: true }).locator("..").getByText("yes", { exact: true })).toBeVisible();
      await expect(page.getByText("20 shown", { exact: true })).toBeVisible();
      expect(titleCurrent.id).toBeTruthy();
      expect(retrievalFirst.id).toBeTruthy();
      expect(retrievalCurrent.id).toBeTruthy();
      expect(fullTextFirst.id).toBeTruthy();
      expect(fullTextCurrent.id).toBeTruthy();
    } finally {
      await seedClient.end();
      await database.client.end();
    }
  });
});
