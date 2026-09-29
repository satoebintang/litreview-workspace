import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createAiSynthesisSuggestionServices } from "@/application/ai-synthesis-suggestion-services";
import { FakeSynthesisSuggestionProvider } from "@/application/ai/synthesis-suggestion-provider";
import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { papers } from "@/db/schema";
import { resolvePlaywrightTestDatabaseUrl } from "./playwright-database";

async function createServices() {
  const database = createDb(resolvePlaywrightTestDatabaseUrl());
  return { database, services: createReviewServices(database.db) };
}

async function seedOneCandidate(label: string) {
  const { database, services } = await createServices();
  const suffix = randomUUID();
  try {
    const project = await services.createProject({ title: `${label} Project ${suffix}` });
    const field = await services.createExtractionField(project.id, { name: `${label} outcome ${suffix}`, fieldType: "short_text" });
    const paper = await services.addPaper(project.id, { title: `${label} Paper ${suffix}`, authors: ["Preparation fixture"] });
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
    const evidence = await services.recordEvidence(project.id, { paperId: paper.id, sourceText: `Evidence passage ${suffix}`, pageNumber: 1 });
    const revision = await services.reviseExtractionValue(project.id, paper.id, field.id, { value: `Outcome ${suffix}`, evidenceIds: [evidence.id] });
    const set = (await services.createEvidenceSet(project.id, { name: `${label} Set ${suffix}` })).set;
    const currentSet = await services.getEvidenceSet(project.id, set.id);
    const added = await services.addEvidenceToSet(project.id, set.id, { evidenceId: evidence.id, expectedRevisionId: currentSet.currentRevision.id });
    const preparation = await services.createSynthesisPreparation(project.id, { evidenceSetId: set.id, expectedRevisionId: added.revision.id, extractionFieldId: field.id });
    return { database, services, project, field, paper, evidence, revision, set, preparation, suffix };
  } catch (error) {
    await database.client.end();
    throw error;
  }
}

async function seedManyCandidates() {
  const { database, services } = await createServices();
  const suffix = randomUUID();
  try {
    const project = await services.createProject({ title: `Slice 47 candidate workspace ${suffix}` });
    const field = await services.createExtractionField(project.id, { name: `Outcome ${suffix}`, fieldType: "short_text" });
    const exclusionCriterion = await services.createFullTextScreeningCriterion(project.id, { text: `Out of scope for Slice 47 fixture ${suffix}` });
    const paperRows = await database.db.insert(papers).values(Array.from({ length: 51 }, (_, index) => ({
      projectId: project.id,
      title: `Slice 47 candidate ${String(index + 1).padStart(3, "0")} ${suffix}`,
      authors: ["Slice 47 fixture"],
    }))).returning({ id: papers.id, title: papers.title });
    const candidateEvidence = await Promise.all(paperRows.map(async (paper, zeroIndex) => {
      const index = zeroIndex + 1;
      await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
      await services.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
      await services.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
      const evidenceCount = index === 1 ? 26 : 1;
      const evidenceItems = await Promise.all(Array.from({ length: evidenceCount }, (_, evidenceIndex) =>
        services.recordEvidence(project.id, {
          paperId: paper.id,
          sourceText: `Slice 47 pinned source ${String(index).padStart(3, "0")} ${String(evidenceIndex + 1).padStart(2, "0")} ${suffix}`,
          pageNumber: evidenceIndex + 1,
        }),
      ));
      const evidenceIds = evidenceItems.map((evidence) => evidence.id);
      const directOnlyIds: string[] = [];
      if (index === 1) {
        const directOnly = await services.recordEvidence(project.id, {
          paperId: paper.id,
          sourceText: `Slice 47 direct Evidence outside the pin ${suffix}`,
          pageNumber: 99,
        });
        directOnlyIds.push(directOnly.id);
      }
      const revision = await services.reviseExtractionValue(project.id, paper.id, field.id, {
        value: `Value for candidate ${index}`,
        evidenceIds: [...evidenceIds, ...directOnlyIds],
      });
      return { paperId: paper.id, paperTitle: paper.title, evidenceIds, revisionId: revision.id };
    }));
    const pinnedEvidenceIds = candidateEvidence.flatMap((candidate) => candidate.evidenceIds);

    const set = (await services.createEvidenceSet(project.id, { name: `Slice 47 pinned source ${suffix}` })).set;
    let setRevisionId = (await services.getEvidenceSet(project.id, set.id)).currentRevision.id;
    for (const evidenceId of pinnedEvidenceIds) {
      const added = await services.addEvidenceToSet(project.id, set.id, { evidenceId, expectedRevisionId: setRevisionId });
      setRevisionId = added.revision.id;
    }
    const preparation = await services.createSynthesisPreparation(project.id, {
      evidenceSetId: set.id,
      expectedRevisionId: setRevisionId,
      extractionFieldId: field.id,
      workingTitle: `Candidate workspace ${suffix}`,
    });
    const emptySet = (await services.createEvidenceSet(project.id, { name: `Slice 47 empty set ${suffix}` })).set;
    const emptyPreparation = await services.createSynthesisPreparation(project.id, { evidenceSetId: emptySet.id, extractionFieldId: field.id });
    return { database, services, project, field, set, preparation, candidates: candidateEvidence, emptyPreparation, exclusionCriterion, suffix };
  } catch (error) {
    await database.client.end();
    throw error;
  }
}

test.describe("Slice 47 scalable synthesis preparation workspace", () => {
  test("pages candidate epochs and filters, preserves drifted selections, and separates exact Evidence provenance", async ({ page }) => {
    test.setTimeout(300_000);
    const fixture = await seedManyCandidates();
    const base = `/projects/${fixture.project.id}/synthesis/preparations/${fixture.preparation.id}`;
    try {
      await page.goto(`/projects/${fixture.project.id}/synthesis/preparations`);
      await expect(page.getByText("Showing at most 50 preparations on this page.")).toBeVisible();
      await expect(page.locator("article.item.item-row")).toHaveCount(2);
      await expect(page.getByText("● Active", { exact: true })).toHaveCount(2);
      await expect(page.getByText("Source Set changed since pinned revision", { exact: true })).toHaveCount(0);
      const laterEvidence = await fixture.services.recordEvidence(fixture.project.id, {
        paperId: fixture.candidates[0]!.paperId,
        sourceText: `Added after the preparation was pinned ${fixture.suffix}`,
        pageNumber: 99,
      });
      const currentSet = await fixture.services.getEvidenceSet(fixture.project.id, fixture.set.id);
      await fixture.services.addEvidenceToSet(fixture.project.id, fixture.set.id, {
        evidenceId: laterEvidence.id,
        expectedRevisionId: currentSet.currentRevision.id,
      });
      await page.reload();
      await expect(page.getByText("Source Set changed since pinned revision", { exact: true })).toHaveCount(1);

      await page.goto(base);
      const candidates = page.locator('[data-testid="synthesis-preparation-candidate"]');
      const chooseCandidateFilter = async (label: string, filter: "all" | "selected" | "selectable" | "ineligible") => {
        await page.getByRole("link", { name: label, exact: true }).click();
        await expect.poll(() => {
          const url = new URL(page.url());
          return { filter: url.searchParams.get("candidateFilter"), hasCursor: url.searchParams.has("candidateCursor") };
        }).toEqual({ filter, hasCursor: false });
      };
      await expect(candidates).toHaveCount(50);
      await expect(page.getByText("51 candidate revisions in this snapshot", { exact: false })).toBeVisible();

      // The existing cursor carries the first-page candidate identity epoch.
      const cursorBeforeRevision = new URL(page.url());
      expect(cursorBeforeRevision.searchParams.has("candidateCursor")).toBe(false);
      const lastCandidate = fixture.candidates[50]!;
      const laterRevision = await fixture.services.reviseExtractionValue(fixture.project.id, lastCandidate.paperId, fixture.field.id, {
        value: "Finalized after the candidate epoch was captured",
        evidenceIds: lastCandidate.evidenceIds,
      });
      await page.getByRole("link", { name: "Next candidate page" }).click();
      await expect(page).toHaveURL(/candidateCursor=/);
      await expect(candidates).toHaveCount(1);
      await expect(page.getByText("51 candidate revisions in this snapshot", { exact: false })).toBeVisible();
      await expect(candidates.first()).toContainText(lastCandidate.paperTitle);
      const epochCandidateHref = await candidates.first().getByRole("link", { name: "View exact provenance" }).getAttribute("href");
      expect(epochCandidateHref).toContain(lastCandidate.revisionId);
      expect(epochCandidateHref).not.toContain(laterRevision.id);

      const candidateCursor = new URL(page.url()).searchParams.get("candidateCursor");
      expect(candidateCursor).toBeTruthy();
      await candidates.first().getByRole("button", { name: "Select", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Candidate revision selected." })).toBeVisible();
      await expect.poll(() => {
        const url = new URL(page.url());
        return { filter: url.searchParams.get("candidateFilter"), cursor: url.searchParams.get("candidateCursor") };
      }).toEqual({ filter: "all", cursor: candidateCursor });
      await expect(candidates).toHaveCount(1);
      await candidates.first().getByRole("button", { name: "Deselect", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Candidate revision deselected." })).toBeVisible();
      await expect.poll(() => {
        const url = new URL(page.url());
        return { filter: url.searchParams.get("candidateFilter"), cursor: url.searchParams.get("candidateCursor") };
      }).toEqual({ filter: "all", cursor: candidateCursor });

      await page.getByRole("link", { name: "Refresh candidate snapshot" }).click();
      await expect(page.getByText("52 candidate revisions in this snapshot", { exact: false })).toBeVisible();
      await chooseCandidateFilter("Ineligible", "ineligible");
      await expect(candidates).toHaveCount(0);
      await expect(page.getByText("No candidate revisions match this filter in the pinned composition.")).toBeVisible();

      // Make Paper 051 ineligible after the initial epoch and verify membership remains separate.
      await fixture.services.recordFullTextScreeningDecision(fixture.project.id, lastCandidate.paperId, { decision: "exclude", exclusionCriterionId: fixture.exclusionCriterion.id });
      await page.getByRole("link", { name: "Refresh candidate snapshot" }).click();
      await expect(page).toHaveURL(/candidateFilter=ineligible/);
      await expect(candidates).toHaveCount(2);
      await expect(candidates.first()).toContainText(lastCandidate.paperTitle);
      const refreshedRevisionHrefs = await candidates.getByRole("link", { name: "View exact provenance" }).evaluateAll((links) => links.map((link) => link.getAttribute("href")));
      expect(refreshedRevisionHrefs).toEqual(expect.arrayContaining([expect.stringContaining(lastCandidate.revisionId), expect.stringContaining(laterRevision.id)]));
      await chooseCandidateFilter("Eligible", "selectable");
      await expect(candidates).toHaveCount(50);

      await chooseCandidateFilter("All candidates", "all");
      await expect(page.getByText("52 candidate revisions in this snapshot", { exact: false })).toBeVisible();
      await expect(candidates).toHaveCount(50);
      await expect(page.getByRole("link", { name: "Refresh candidate snapshot" })).toHaveAttribute("href", /candidateFilter=all/);
      const first = candidates.first();
      const firstTitle = fixture.candidates[0]!.paperTitle;
      await expect(first).toContainText(firstTitle);
      await first.getByRole("button", { name: "Select", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Candidate revision selected." })).toBeVisible();
      await expect(page).toHaveURL(/candidateFilter=all/);
      await page.getByRole("link", { name: "Next candidate page" }).click();
      await expect(page).toHaveURL(/candidateCursor=/);
      await expect(candidates).toHaveCount(2);
      await expect(page.getByText("1 selected", { exact: true }).first()).toBeVisible();
      await page.getByRole("link", { name: "First candidate page" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.has("candidateCursor")).toBe(false);
      const selectedFirst = candidates.first();
      await expect(selectedFirst.getByRole("button", { name: "Deselect", exact: true })).toBeVisible();
      await selectedFirst.getByRole("button", { name: "Deselect", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Candidate revision deselected." })).toBeVisible();
      await expect(page).toHaveURL(/candidateFilter=all/);

      // A selected row remains visible and removable when current eligibility drifts.
      const eligibleFirst = candidates.first();
      await eligibleFirst.getByRole("button", { name: "Select", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Candidate revision selected." })).toBeVisible();
      await expect(page).toHaveURL(/candidateFilter=all/);
      await fixture.services.recordFullTextScreeningDecision(fixture.project.id, fixture.candidates[0]!.paperId, { decision: "exclude", exclusionCriterionId: fixture.exclusionCriterion.id });
      await chooseCandidateFilter("Selected", "selected");
      const drifted = candidates.first();
      await expect(candidates).toHaveCount(1);
      await expect(drifted).toContainText(firstTitle);
      await expect(drifted).toContainText("Selected");
      await expect(drifted).toContainText("Paper not finally included");
      await drifted.getByRole("button", { name: "Deselect", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Candidate revision deselected." })).toBeVisible();
      await expect(page).toHaveURL(/candidateFilter=selected/);
      await expect(page.getByText("No candidate revisions match this filter in the pinned composition.")).toBeVisible();

      // Exact candidate membership is checked against this preparation; an empty pinned Set has no such candidate.
      await page.goto(`${base}?candidateFilter=all`);
      const candidateRouteLink = candidates.first().getByRole("link", { name: "View exact provenance" });
      const candidateRoute = await candidateRouteLink.getAttribute("href");
      expect(candidateRoute).toContain("returnCandidateFilter=all");
      await candidateRouteLink.click();
      await expect(page.getByText("Connecting Evidence: 26 · direct Evidence: 27", { exact: true })).toBeVisible();
      const connecting = page.locator("section.card.section-card").filter({ has: page.getByRole("heading", { name: "Connecting Evidence in the pinned composition" }) });
      const direct = page.locator("section.card.section-card").filter({ has: page.getByRole("heading", { name: "All Evidence directly linked to this revision" }) });
      await expect(connecting.locator("article.item")).toHaveCount(25);
      await expect(direct.locator("article.item")).toHaveCount(25);
      await connecting.getByRole("link", { name: "Next connecting Evidence page" }).click();
      await expect(connecting.locator("article.item")).toHaveCount(1);
      await direct.getByRole("link", { name: "Next direct Evidence page" }).click();
      await expect(direct.locator("article.item")).toHaveCount(2);
      await expect(direct.getByText(/direct Evidence outside the pin/)).toBeVisible();
      await page.getByRole("link", { name: "Return to preparation" }).click();
      await expect(page).toHaveURL(/candidateFilter=all/);

      await page.goto(`/projects/${fixture.project.id}/synthesis/preparations/${fixture.emptyPreparation.id}`);
      await expect(page.getByText("No candidate revisions match this filter in the pinned composition.")).toBeVisible();
      const notCandidate = await page.goto(`/projects/${fixture.project.id}/synthesis/preparations/${fixture.emptyPreparation.id}/candidates/${fixture.candidates[0]!.revisionId}`);
      expect(notCandidate?.status()).toBe(404);
    } finally {
      await fixture.database.client.end();
    }
  });

  test("browses targets only on submit, saves metadata, clears the target, finalizes, and abandons", async ({ page }) => {
    const fixture = await seedOneCandidate("Slice 47 settings");
    const base = `/projects/${fixture.project.id}/synthesis/preparations/${fixture.preparation.id}`;
    try {
      await fixture.services.createSynthesisStatement(fixture.project.id, {
        statementText: `Target statement ${fixture.suffix}`,
        extractionRevisionIds: [fixture.revision.id],
      });
      await page.goto(base);
      const targetSearch = page.getByRole("searchbox", { name: "Browse or search existing statements" });
      await expect(page.getByText(`Target statement ${fixture.suffix}`, { exact: true })).toHaveCount(0);
      await targetSearch.focus();
      await expect(page).not.toHaveURL(/targetBrowse=1/);
      await expect(page.getByText(`Target statement ${fixture.suffix}`, { exact: true })).toHaveCount(0);
      await targetSearch.fill(`Target statement ${fixture.suffix}`);
      await page.getByRole("button", { name: "Browse statements" }).click();
      await expect(page).toHaveURL(/targetBrowse=1/);
      const targetOption = page.locator("article.item").filter({ hasText: `Target statement ${fixture.suffix}` });
      await expect(targetOption).toBeVisible();
      await targetOption.getByRole("button", { name: "Use this target" }).click();
      await expect(page.getByText(`Target statement ${fixture.suffix}`, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Clear target" }).click();
      await expect(page.getByText("Create on finalize", { exact: true })).toBeVisible();

      await page.getByLabel("Working title").fill(`Updated preparation ${fixture.suffix}`);
      await page.getByLabel("Working note").fill("Metadata remains independent of candidate materialization.");
      await page.getByRole("button", { name: "Save metadata" }).click();
      await expect(page.getByRole("heading", { name: `Updated preparation ${fixture.suffix}` })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Preparation settings saved." })).toBeVisible();

      await page.getByLabel(/Synthesis statement/).fill(`Final statement ${fixture.suffix}`);
      await page.getByRole("button", { name: "Finalize preparation" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${fixture.project.id}/synthesis/[0-9a-f-]+\\?saved=finalized_from_preparation$`));
      await expect(page.getByRole("heading", { name: `Updated preparation ${fixture.suffix}` })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Synthesis statement finalized from preparation workspace." })).toBeVisible();
      await expect(page.getByText("Finalized from preparation workspace for Evidence Set", { exact: false })).toBeVisible();

      await page.goto(base);
      await expect(page.getByRole("heading", { name: `Updated preparation ${fixture.suffix}` })).toBeVisible();
      await expect(page.getByText("✓ Finalized", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save metadata" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Finalize preparation →" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Abandon preparation" })).toHaveCount(0);

      const emptySet = (await fixture.services.createEvidenceSet(fixture.project.id, { name: `Abandon target ${fixture.suffix}` })).set;
      const abandoned = await fixture.services.createSynthesisPreparation(fixture.project.id, { evidenceSetId: emptySet.id, extractionFieldId: fixture.field.id });
      await page.goto(`/projects/${fixture.project.id}/synthesis/preparations/${abandoned.id}`);
      await page.getByRole("button", { name: "Abandon preparation" }).click();
      const dialog = page.getByRole("dialog", { name: "Abandon this preparation?" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Abandon preparation" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Preparation abandoned and frozen." })).toBeVisible();
      await expect(page.getByText("Abandoned workspace:", { exact: false })).toBeVisible();
    } finally {
      await fixture.database.client.end();
    }
  });

  test("shows bounded AI request history and binds exact nested detail to its preparation", async ({ page }) => {
    test.setTimeout(300_000);
    const fixture = await seedOneCandidate("Slice 47 AI");
    const otherPreparation = await fixture.services.createSynthesisPreparation(fixture.project.id, {
      evidenceSetId: fixture.set.id,
      extractionFieldId: fixture.field.id,
    });
    try {
      await fixture.services.selectSynthesisPreparationRevision(fixture.project.id, fixture.preparation.id, { extractionRevisionId: fixture.revision.id });
      let responseOrdinal = 0;
      const provider = new FakeSynthesisSuggestionProvider({
        result: (input) => ({
          kind: "success",
          suggestion: {
            outcome: "candidate",
            title: "Bounded history suggestion",
            statementText: "The frozen evidence supports this test suggestion.",
            explanation: "Generated for the bounded history browser fixture.",
            groundings: input.supports.map((support) => {
              const evidence = support.connectingEvidence[0]!;
              return { supportId: support.id, evidenceId: String(evidence.id ?? evidence.evidenceId), quote: String(evidence.text ?? evidence.sourceText) };
            }),
          },
          metadata: { provider: "fake", configuredModel: input.model, returnedModel: "fake-model", responseId: `slice47-${fixture.suffix}-${responseOrdinal++}`, inputTokens: 1, outputTokens: 1, totalTokens: 2, durationMs: 1 },
        }),
      });
      const aiServices = createAiSynthesisSuggestionServices(fixture.database.db, provider, {
        finalizePreparationInTransaction: fixture.services.finalizeSynthesisPreparationInTransaction,
      });
      for (let index = 0; index < 26; index += 1) {
        const request = await aiServices.beginAiSynthesisSuggestion({
          projectId: fixture.project.id,
          preparationId: fixture.preparation.id,
          idempotencyKey: randomUUID(),
          externalTransmissionAcknowledged: true,
          disclosureVersion: "slice47-history-fixture-v1",
        });
        await aiServices.executeAiSynthesisSuggestion(String(request.requestId), fixture.project.id, fixture.preparation.id);
      }

      const base = `/projects/${fixture.project.id}/synthesis/preparations/${fixture.preparation.id}`;
      await page.goto(base);
      const history = page.locator("section.card.section-card").filter({ has: page.getByRole("heading", { name: "AI suggestion history" }) });
      await expect(history.locator("a", { hasText: "Open exact AI request" })).toHaveCount(25);
      await expect(history).not.toContainText("Frozen support manifest");
      const firstRequestHref = await history.getByRole("link", { name: "Open exact AI request" }).first().getAttribute("href");
      expect(firstRequestHref).toBeTruthy();
      const requestId = firstRequestHref!.split("/").at(-1)!;
      await history.getByRole("link", { name: "Older AI requests" }).click();
      await expect(history.getByRole("link", { name: "Open exact AI request" })).toHaveCount(1);

      await page.goto(firstRequestHref!);
      await expect(page.getByRole("heading", { name: "AI synthesis request audit" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Frozen supports" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Connecting Evidence manifest" })).toBeVisible();
      await page.goto(`/projects/${fixture.project.id}/synthesis/preparations/${otherPreparation.id}/ai-requests/${requestId}`);
      await expect(page.getByRole("heading", { name: "AI synthesis request audit" })).toHaveCount(0);
      await expect(page.getByText("404", { exact: true })).toBeVisible();
    } finally {
      await fixture.database.client.end();
    }
  });
});
