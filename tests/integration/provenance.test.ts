import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview");
const services = createReviewServices(db);
let databaseReady = false;
let projectId = "";

describe("Slice 1 provenance invariants", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
    databaseReady = true;
  });

  beforeEach(async (context) => {
    if (!databaseReady) context.skip();
    const project = await services.createProject({ title: `Test project ${crypto.randomUUID()}` });
    projectId = project.id;
  });

  afterAll(async () => {
    await client.unsafe(`TRUNCATE TABLE claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, screening_decisions, screening_criteria, evidence, claims, papers, projects`);
    await client.end();
  });

  it("derives unsupported/supported status and returns the full provenance chain", async () => {
    const paper = await services.addPaper(projectId, { title: "Source paper", authors: ["First Author"] });
    const item = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "The observed result was significant.", pageNumber: 12, note: "Context" });
    const claim = await services.createClaim(projectId, { claimText: "The observed result was significant." });

    expect((await services.getClaimProvenance(projectId, claim.id)).supportStatus).toBe("unsupported");
    await services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: item.id });
    const provenance = await services.getClaimProvenance(projectId, claim.id);
    expect(provenance.supportStatus).toBe("supported");
    expect(provenance.evidence[0].evidence.sourceText).toContain("significant");
    expect(provenance.evidence[0].evidence.pageNumber).toBe(12);
    expect(provenance.evidence[0].paper.id).toBe(paper.id);

    await services.unlinkEvidenceFromClaim(projectId, { claimId: claim.id, evidenceId: item.id });
    expect((await services.getClaimProvenance(projectId, claim.id)).supportStatus).toBe("unsupported");
  });

  it("rejects duplicate and cross-project links", async () => {
    const other = await services.createProject({ title: "Other project" });
    const paper = await services.addPaper(projectId, { title: "Source paper", authors: [] });
    const item = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Passage", pageNumber: 1 });
    const claim = await services.createClaim(projectId, { claimText: "A claim" });
    const otherPaper = await services.addPaper(other.id, { title: "Other source paper", authors: [] });
    const otherEvidence = await services.recordEvidence(other.id, { paperId: otherPaper.id, sourceText: "Other passage", pageNumber: 2 });
    await services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: item.id });
    await expect(services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: item.id })).rejects.toMatchObject({ code: "DUPLICATE_LINK" });
    await expect(services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: otherEvidence.id })).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
    await expect(services.recordEvidence(projectId, { paperId: otherPaper.id, sourceText: "Invalid cross-project passage", pageNumber: 3 })).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
  });

  it("protects paper/evidence deletion and retires destructive claim deletion", async () => {
    const paper = await services.addPaper(projectId, { title: "Source paper", authors: [] });
    const item = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Passage", pageNumber: 2 });
    const claim = await services.createClaim(projectId, { claimText: "A claim" });
    await services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: item.id });
    await expect(services.deletePaper(projectId, paper.id)).rejects.toMatchObject({ code: "PROTECTED_DELETE" });
    await expect(services.deleteEvidence(projectId, item.id)).rejects.toMatchObject({ code: "PROTECTED_DELETE" });
    await expect(services.deleteClaim(projectId, claim.id)).rejects.toMatchObject({ code: "PROTECTED_DELETE" });
    expect((await services.listPapers(projectId)).some((candidate) => candidate.id === paper.id)).toBe(true);
    expect((await services.listEvidence(projectId)).some((candidate) => candidate.id === item.id)).toBe(true);
    await expect(services.getClaimProvenance(projectId, claim.id)).resolves.toMatchObject({ supportStatus: "supported" });
  });

  it("withdraws without deleting historical support", async () => {
    const paper = await services.addPaper(projectId, { title: "Source paper", authors: ["First Author"] });
    const firstEvidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "First passage", pageNumber: 2 });
    const secondEvidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Second passage", pageNumber: 3 });
    const claim = await services.createClaim(projectId, { claimText: "A claim" });
    await services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: firstEvidence.id });
    await services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: secondEvidence.id });

    const historyBefore = await services.getClaimHistory(projectId, claim.id);
    await services.withdrawClaim(projectId, claim.id, { researcherNote: "No longer used" });
    const historyAfter = await services.getClaimHistory(projectId, claim.id);
    expect(historyAfter.revisions).toHaveLength(historyBefore.revisions.length + 1);
    expect(historyAfter.revisions.at(-1)?.lifecycle).toBe("withdrawn");
    expect(historyAfter.revisions.at(-1)?.supports.evidence).toHaveLength(0);
    expect(historyAfter.revisions.at(-2)?.supports.evidence).toHaveLength(2);
    expect((await services.getClaimRevision(projectId, claim.id, historyAfter.revisions.at(-2)!.id)).revision.supports.evidence).toHaveLength(2);
  });

  it("enforces database-level project ownership on direct inserts", async () => {
    const other = await services.createProject({ title: "Other project" });
    const paper = await services.addPaper(projectId, { title: "Source paper", authors: [] });
    await expect(db.insert((await import("@/db/schema")).evidence).values({ projectId: other.id, paperId: paper.id, sourceText: "invalid", pageNumber: 1 })).rejects.toThrow();
  });
});
