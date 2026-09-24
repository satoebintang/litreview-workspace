import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createClaimSupportReadServices, type ClaimSupportSearchKind } from "@/application/claim-support-read-services";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview");
const services = createReviewServices(db);
const readServices = createClaimSupportReadServices(db);
let projectId = "";

describe("bounded Claim support search", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Claim support search ${crypto.randomUUID()}` })).id; });
  afterAll(async () => { await client.end(); });

  async function includedPaper(title: string) {
    const paper = await services.addPaper(projectId, { title, authors: ["Author"] });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  it("matches the legacy eligible ID sets across every page", async () => {
    const paperA = await includedPaper("Alpha study");
    const paperB = await includedPaper("Beta study");
    const paperC = await includedPaper("Gamma study");
    const evidenceA = await services.recordEvidence(projectId, { paperId: paperA.id, sourceText: "Gamma primary passage", pageNumber: 1 });
    const evidenceB = await services.recordEvidence(projectId, { paperId: paperA.id, sourceText: "Second path %", pageNumber: 2 });
    const evidenceC = await services.recordEvidence(projectId, { paperId: paperB.id, sourceText: "Gamma other passage", pageNumber: 3 });
    const unscreenedPaper = await services.addPaper(projectId, { title: "Unscreened paper", authors: ["Author"] });
    const evidenceNeedsReview = await services.recordEvidence(projectId, { paperId: unscreenedPaper.id, sourceText: "Needs review passage", pageNumber: 5 });
    const rejected = await services.recordEvidence(projectId, { paperId: paperC.id, sourceText: "Gamma rejected passage", pageNumber: 4 });
    await services.appendEvidenceReviewDecision(projectId, evidenceB.id, { decision: "needs_review" });
    await services.appendEvidenceReviewDecision(projectId, evidenceB.id, { decision: "accepted" });
    await services.appendEvidenceReviewDecision(projectId, evidenceNeedsReview.id, { decision: "needs_review" });
    await services.appendEvidenceReviewDecision(projectId, rejected.id, { decision: "accepted" });
    await services.appendEvidenceReviewDecision(projectId, rejected.id, { decision: "rejected" });

    const fieldA = await services.createExtractionField(projectId, { name: "Attack mechanism", fieldType: "short_text" });
    const fieldB = await services.createExtractionField(projectId, { name: "Outcome", fieldType: "short_text" });
    const superseded = await services.reviseExtractionValue(projectId, paperA.id, fieldA.id, { value: "Older extraction", evidenceIds: [] });
    const extractionA = await services.reviseExtractionValue(projectId, paperA.id, fieldA.id, { value: "Special Value", evidenceIds: [evidenceA.id, evidenceB.id] });
    const extractionB = await services.reviseExtractionValue(projectId, paperA.id, fieldB.id, { value: "Repeated path", evidenceIds: [evidenceA.id] });
    const extractionC = await services.reviseExtractionValue(projectId, paperB.id, fieldA.id, { value: "Other included", evidenceIds: [evidenceC.id] });
    await services.clearExtractionValue(projectId, paperA.id, fieldA.id);

    const laterUnresolvedPaper = await includedPaper("Later unresolved study");
    const excludedExtraction = await services.reviseExtractionValue(projectId, laterUnresolvedPaper.id, fieldA.id, { value: "No longer eligible", evidenceIds: [] });
    await services.recordFullTextScreeningDecision(projectId, laterUnresolvedPaper.id, { decision: "maybe" });

    const synthesis = await services.createSynthesisStatement(projectId, {
      title: "Claim synthesis title",
      statementText: "A synthesis statement for exact support counts.",
      extractionRevisionIds: [extractionA.id, extractionB.id],
    });
    await services.reviseSynthesisStatement(projectId, synthesis.statement.id, {
      title: "Updated synthesis title",
      statementText: "A later synthesis statement remains active.",
      extractionRevisionIds: [extractionB.id],
    });
    const withdrawn = await services.createSynthesisStatement(projectId, {
      statementText: "This statement is withdrawn.", extractionRevisionIds: [extractionC.id],
    });
    await services.withdrawSynthesisStatement(projectId, withdrawn.statement.id);

    const legacy = await services.listClaimSupportOptions(projectId);
    const cases: Array<{ kind: ClaimSupportSearchKind; expected: string[] }> = [
      { kind: "evidence", expected: legacy.evidence.map((item) => item.id) },
      { kind: "extractionRevision", expected: legacy.extraction.map((item) => item.id) },
      { kind: "synthesisRevision", expected: legacy.synthesis.map((item) => item.id) },
    ];

    for (const testCase of cases) {
      const initial = await readServices.searchClaimSupportOptions({ projectId, kind: testCase.kind, pageSize: 2 });
      expect(initial.totalCount).toBe(testCase.expected.length);
      expect(initial.page).toBe(1);
      expect(initial.pageSize).toBe(2);
      expect(initial.hasPrevious).toBe(false);
      const pageIds: string[] = [];
      for (let page = 1; page <= initial.totalPages; page += 1) {
        const result = await readServices.searchClaimSupportOptions({ projectId, kind: testCase.kind, page, pageSize: 2 });
        pageIds.push(...result.items.map((item) => String((item as { id: string }).id)));
        expect(result.hasPrevious).toBe(page > 1);
        expect(result.hasNext).toBe(page < initial.totalPages);
      }
      expect(new Set(pageIds).size).toBe(pageIds.length);
      expect([...pageIds].sort()).toEqual([...testCase.expected].sort());
      expect((await readServices.searchClaimSupportOptions({ projectId, kind: testCase.kind, pageSize: 2 })).items.map((item) => (item as { id: string }).id))
        .toEqual(initial.items.map((item) => (item as { id: string }).id));
    }

    expect(cases[0].expected).not.toContain(rejected.id);
    expect(cases[0].expected).toContain(evidenceNeedsReview.id);
    expect(cases[1].expected).toContain(superseded.id);
    expect(cases[1].expected).not.toContain(excludedExtraction.id);
    expect(cases[2].expected).toContain(synthesis.revision.id);
    expect(cases[2].expected).not.toContain(withdrawn.revision.id);

    const allEvidence = await readServices.searchClaimSupportOptions({ projectId, kind: "evidence", pageSize: 50 });
    const stateById = new Map(allEvidence.items.map((item) => {
      const row = item as { id: string; reviewState: string };
      return [row.id, row.reviewState] as const;
    }));
    expect(stateById.get(evidenceA.id)).toBe("unreviewed");
    expect(stateById.get(evidenceB.id)).toBe("accepted");
    expect(stateById.get(evidenceNeedsReview.id)).toBe("needs_review");
    const evidenceById = new Map(allEvidence.items.map((item) => {
      const row = item as { id: string; createdAt: string };
      return [row.id, row] as const;
    }));
    expect(evidenceById.get(evidenceA.id)?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const allExtractions = await readServices.searchClaimSupportOptions({ projectId, kind: "extractionRevision", pageSize: 50 });
    const extractionCurrentById = new Map(allExtractions.items.map((item) => {
      const row = item as { id: string; isCurrentExtractionRevision: boolean };
      return [row.id, row.isCurrentExtractionRevision] as const;
    }));
    expect(extractionCurrentById.get(superseded.id)).toBe(false);
    expect(extractionCurrentById.get(extractionC.id)).toBe(true);

    const exactEligibility = await readServices.resolveEligibleClaimSupportIds({
      projectId,
      evidenceIds: [evidenceA.id, rejected.id],
      extractionRevisionIds: [superseded.id, excludedExtraction.id],
      synthesisRevisionIds: [synthesis.revision.id, withdrawn.revision.id],
    });
    expect(exactEligibility.evidence).toEqual([evidenceA.id]);
    expect(exactEligibility.extractionRevision).toContain(superseded.id);
    expect(exactEligibility.extractionRevision).not.toContain(excludedExtraction.id);
    expect(exactEligibility.synthesisRevision).toEqual([synthesis.revision.id]);

    const largeEvidenceSelection = [evidenceA.id, ...Array.from({ length: 999 }, () => crypto.randomUUID())];
    const largeEligibility = await readServices.resolveEligibleClaimSupportIds({
      projectId,
      evidenceIds: largeEvidenceSelection,
      extractionRevisionIds: [],
      synthesisRevisionIds: [],
    });
    expect(largeEligibility.evidence).toEqual([evidenceA.id]);
    expect(largeEligibility.extractionRevision).toEqual([]);
    expect(largeEligibility.synthesisRevision).toEqual([]);
  });

  it("uses literal case-insensitive search and exact synthesis path counts", async () => {
    const paper = await includedPaper("Searchable alpha paper");
    const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "GAMMA passage with % marker", pageNumber: 1 });
    const fieldA = await services.createExtractionField(projectId, { name: "Search field", fieldType: "short_text" });
    const fieldB = await services.createExtractionField(projectId, { name: "Second field", fieldType: "short_text" });
    const extractionA = await services.reviseExtractionValue(projectId, paper.id, fieldA.id, { value: "Special Value", evidenceIds: [evidence.id] });
    const extractionB = await services.reviseExtractionValue(projectId, paper.id, fieldB.id, { value: "Another value", evidenceIds: [evidence.id] });
    const synthesis = await services.createSynthesisStatement(projectId, {
      title: "Case Search Title", statementText: "A searchable exact-revision statement.",
      extractionRevisionIds: [extractionA.id, extractionB.id],
    });

    const evidenceSearch = await readServices.searchClaimSupportOptions({ projectId, kind: "evidence", query: "gamma" });
    expect(evidenceSearch.items.map((item) => (item as { id: string }).id)).toContain(evidence.id);
    expect(evidenceSearch.pageSize).toBe(20);
    const literalPercent = await readServices.searchClaimSupportOptions({ projectId, kind: "evidence", query: "%" });
    expect(literalPercent.items.map((item) => (item as { id: string }).id)).toEqual([evidence.id]);
    const extractionSearch = await readServices.searchClaimSupportOptions({ projectId, kind: "extractionRevision", query: "special value" });
    expect(extractionSearch.items.map((item) => (item as { id: string }).id)).toContain(extractionA.id);
    const synthesisSearch = await readServices.searchClaimSupportOptions({ projectId, kind: "synthesisRevision", query: "case search" });
    expect(synthesisSearch.items.map((item) => (item as { id: string }).id)).toContain(synthesis.revision.id);

    const synthesisItem = synthesisSearch.items.find((item) => (item as { id: string }).id === synthesis.revision.id) as { observationCount: number; evidencePathCount: number };
    expect(synthesisItem.observationCount).toBe(2);
    expect(synthesisItem.evidencePathCount).toBe(2);
  });

  it("bounds inputs and uses a read-only repeatable-read transaction with two statements", async () => {
    const paper = await includedPaper(`${"A".repeat(200)} truncated suffix`);
    const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Bounded query target", pageNumber: 1 });
    const tooLongQuery = `${"A".repeat(200)} missing suffix`;
    const capped = await readServices.searchClaimSupportOptions({ projectId, kind: "evidence", query: tooLongQuery, pageSize: 100 });
    expect(capped.items.map((item) => (item as { id: string }).id)).toEqual([evidence.id]);
    expect(capped.pageSize).toBe(50);
    const blank = await readServices.searchClaimSupportOptions({ projectId, kind: "evidence", query: "  ", page: 1 });
    expect(blank.totalCount).toBe(1);
    const clampedPage = await readServices.searchClaimSupportOptions({ projectId, kind: "evidence", page: 500, pageSize: 1 });
    expect(clampedPage.page).toBe(clampedPage.totalPages);
    expect(clampedPage.hasNext).toBe(false);

    await expect(readServices.searchClaimSupportOptions({ projectId: "not-a-uuid", kind: "evidence" }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(readServices.searchClaimSupportOptions({ projectId, kind: "invalid" as ClaimSupportSearchKind }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(readServices.searchClaimSupportOptions({ projectId, kind: "evidence", page: 0 }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(readServices.searchClaimSupportOptions({ projectId, kind: "evidence", pageSize: 0 }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
