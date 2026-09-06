import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { claimRevisionEvidenceSupports, claimRevisions } from "@/db/schema";
import { eq } from "drizzle-orm";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview");
const services = createReviewServices(db);
let projectId = "";

describe("Slice 5 manuscript Claims and citation grounding", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Claims project ${crypto.randomUUID()}` })).id; });
  afterAll(async () => {
    await client.unsafe("TRUNCATE TABLE manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, screening_decisions, screening_criteria, evidence, claims, papers, projects");
    await client.end();
  });

  async function includedPaper(title: string) {
    const paper = await services.addPaper(projectId, { title, authors: ["Author"] });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  it("creates unsupported Claims, then snapshots direct support and citation candidates", async () => {
    const paper = await includedPaper("Direct source");
    const item = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Exact passage", pageNumber: 4 });
    const claim = await services.createClaim(projectId, { claimText: "An unsupported assertion" });
    expect((await services.getCurrentClaim(projectId, claim.id)).currentRevision.supportStatus).toBe("unsupported");

    const revised = await services.createClaimRevision(projectId, claim.id, {
      claimText: "An assertion grounded in the source", supports: [{ kind: "evidence", evidenceId: item.id }],
      expectedCurrentRevisionId: claim.revision.id,
    });
    expect(revised.revision.supportStatus).toBe("supported");
    expect(revised.revision.citationCandidateCount).toBe(1);
    expect(revised.revision.citationCandidates[0].paper.id).toBe(paper.id);
  });

  it("supports mixed exact targets, deduplicates Papers, and rejects duplicate/cross-project support", async () => {
    const paper = await includedPaper("Mixed source");
    const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Observation", pageNumber: 2 });
    const field = await services.createExtractionField(projectId, { name: "Attack", fieldType: "short_text" });
    const extraction = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Poisoning", evidenceIds: [evidence.id] });
    const synthesis = await services.createSynthesisStatement(projectId, { statementText: "Poisoning is observed.", extractionRevisionIds: [extraction.id] });
    const claim = await services.createClaim(projectId, { claimText: "Mixed claim" });
    const revised = await services.createClaimRevision(projectId, claim.id, {
      claimText: "Mixed claim", supports: [
        { kind: "evidence", evidenceId: evidence.id },
        { kind: "extractionRevision", extractionRevisionId: extraction.id },
        { kind: "synthesisRevision", synthesisRevisionId: synthesis.revision.id },
      ], expectedCurrentRevisionId: claim.revision.id,
    });
    expect(revised.revision.totalSupportCount).toBe(3);
    expect(revised.revision.distinctPaperCount).toBe(1);
    expect(revised.revision.citationCandidateCount).toBe(1);
    expect(revised.revision.citationCandidates[0].pathCount).toBe(3);
    await expect(services.createClaimRevision(projectId, claim.id, {
      claimText: "Duplicate", supports: [{ kind: "evidence", evidenceId: evidence.id }, { kind: "evidence", evidenceId: evidence.id }],
      expectedCurrentRevisionId: revised.revision.id,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const other = await services.createProject({ title: "Other project" });
    const otherPaper = await services.addPaper(other.id, { title: "Foreign" });
    const foreignEvidence = await services.recordEvidence(other.id, { paperId: otherPaper.id, sourceText: "Foreign", pageNumber: 1 });
    await expect(services.createClaimRevision(projectId, claim.id, {
      claimText: "Foreign", supports: [{ kind: "evidence", evidenceId: foreignEvidence.id }], expectedCurrentRevisionId: revised.revision.id,
    })).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
  });

  it("retains superseded extraction support exactly and exposes freshness without retargeting", async () => {
    const paper = await includedPaper("Extraction source");
    const field = await services.createExtractionField(projectId, { name: "Rate", fieldType: "short_text" });
    const oldRevision = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "84.2%", evidenceIds: [] });
    const claim = await services.createClaim(projectId, { claimText: "The reported rate is 84.2%" });
    const supported = await services.createClaimRevision(projectId, claim.id, { claimText: claim.claimText, supports: [{ kind: "extractionRevision", extractionRevisionId: oldRevision.id }], expectedCurrentRevisionId: claim.revision.id });
    const newer = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "82.1%", evidenceIds: [] });
    const historical = await services.getClaimRevision(projectId, claim.id, supported.revision.id);
    expect(historical.revision.supports.extractionRevisions[0].extractionRevisionId).toBe(oldRevision.id);
    expect(historical.revision.supports.extractionRevisions[0].isCurrentExtractionRevision).toBe(false);
    expect(historical.revision.citationCandidateCount).toBe(0);
    const refreshed = await services.createClaimRevision(projectId, claim.id, { claimText: "The reported rate is 82.1%", supports: [{ kind: "extractionRevision", extractionRevisionId: newer.id }], expectedCurrentRevisionId: supported.revision.id });
    expect(refreshed.revision.supports.extractionRevisions[0].extractionRevisionId).toBe(newer.id);
  });

  it("keeps ungrounded synthesis structural support separate from citations", async () => {
    const paper = await includedPaper("Synthesis source");
    const field = await services.createExtractionField(projectId, { name: "Category", fieldType: "short_text" });
    const extraction = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Poisoning", evidenceIds: [] });
    const synthesis = await services.createSynthesisStatement(projectId, { statementText: "Poisoning appears.", extractionRevisionIds: [extraction.id] });
    const claim = await services.createClaim(projectId, { claimText: "Poisoning is common" });
    const revised = await services.createClaimRevision(projectId, claim.id, { claimText: claim.claimText, supports: [{ kind: "synthesisRevision", synthesisRevisionId: synthesis.revision.id }], expectedCurrentRevisionId: claim.revision.id });
    expect(revised.revision.supportStatus).toBe("supported");
    expect(revised.revision.citationCandidateCount).toBe(0);
  });

  it("withdraws idempotently, reactivates explicitly, and rejects stale revision submissions", async () => {
    const claim = await services.createClaim(projectId, { claimText: "Lifecycle claim" });
    const first = await services.withdrawClaim(projectId, claim.id, { researcherNote: "Withdrawn" , expectedCurrentRevisionId: claim.revision.id });
    const repeated = await services.withdrawClaim(projectId, claim.id, { researcherNote: "Withdrawn" , expectedCurrentRevisionId: first.revision.id });
    expect(repeated.revision.id).toBe(first.revision.id);
    const active = await services.reactivateClaim(projectId, claim.id, { claimText: "Lifecycle claim restored", supports: [], expectedCurrentRevisionId: first.revision.id });
    await expect(services.createClaimRevision(projectId, claim.id, { claimText: "Stale", supports: [], expectedCurrentRevisionId: first.revision.id })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(active.revision.lifecycle).toBe("active");
    expect((await services.getClaimHistory(projectId, claim.id)).revisions.map((r) => r.lifecycle)).toEqual(["active", "withdrawn", "active"]);
  });

  it("enforces finalized ClaimRevision and support immutability at PostgreSQL", async () => {
    const paper = await includedPaper("Immutable source");
    const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Immutable passage", pageNumber: 1 });
    const claim = await services.createClaim(projectId, { claimText: "Immutable claim" });
    const revised = await services.createClaimRevision(projectId, claim.id, { claimText: claim.claimText, supports: [{ kind: "evidence", evidenceId: evidence.id }], expectedCurrentRevisionId: claim.revision.id });
    await expect(db.update(claimRevisions).set({ claimText: "mutated" }).where(eq(claimRevisions.id, revised.revision.id))).rejects.toThrow();
    await expect(db.delete(claimRevisions).where(eq(claimRevisions.id, revised.revision.id))).rejects.toThrow();
    await expect(db.delete(claimRevisionEvidenceSupports).where(eq(claimRevisionEvidenceSupports.claimRevisionId, revised.revision.id))).rejects.toThrow();
  });
});
