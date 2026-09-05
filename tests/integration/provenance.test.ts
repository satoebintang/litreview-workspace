import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { DomainError } from "@/domain/errors";
import { claimEvidence, claims, evidence, papers } from "@/db/schema";

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
    await client.unsafe(`TRUNCATE TABLE synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, screening_decisions, screening_criteria, claim_evidence, evidence, claims, papers, projects`);
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

  it("protects paper/evidence deletion and explicitly removes links on claim deletion", async () => {
    const paper = await services.addPaper(projectId, { title: "Source paper", authors: [] });
    const item = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Passage", pageNumber: 2 });
    const claim = await services.createClaim(projectId, { claimText: "A claim" });
    await services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: item.id });
    await expect(services.deletePaper(projectId, paper.id)).rejects.toMatchObject({ code: "PROTECTED_DELETE" });
    await expect(services.deleteEvidence(projectId, item.id)).rejects.toMatchObject({ code: "PROTECTED_DELETE" });
    await services.deleteClaim(projectId, claim.id);
    expect((await services.listPapers(projectId)).some((candidate) => candidate.id === paper.id)).toBe(true);
    expect((await services.listEvidence(projectId)).some((candidate) => candidate.id === item.id)).toBe(true);
    await services.deleteEvidence(projectId, item.id);
    await services.deletePaper(projectId, paper.id);
    await expect(services.getClaimProvenance(projectId, claim.id)).rejects.toBeInstanceOf(DomainError);
  });

  it("rolls back ClaimEvidence deletion when Claim deletion fails", async () => {
    const paper = await services.addPaper(projectId, { title: "Source paper", authors: ["First Author"] });
    const firstEvidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "First passage", pageNumber: 2 });
    const secondEvidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Second passage", pageNumber: 3 });
    const claim = await services.createClaim(projectId, { claimText: "A claim" });
    await services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: firstEvidence.id });
    await services.linkEvidenceToClaim(projectId, { claimId: claim.id, evidenceId: secondEvidence.id });

    const originalPapers = await db.select().from(papers).where(and(eq(papers.projectId, projectId), eq(papers.id, paper.id)));
    const originalEvidence = await db.select().from(evidence).where(eq(evidence.projectId, projectId));
    const originalClaims = await db.select().from(claims).where(and(eq(claims.projectId, projectId), eq(claims.id, claim.id)));
    const originalLinks = await db.select().from(claimEvidence).where(and(eq(claimEvidence.projectId, projectId), eq(claimEvidence.claimId, claim.id)));
    const triggerId = crypto.randomUUID().replaceAll("-", "");
    const functionName = `fail_claim_delete_${triggerId}`;
    const triggerName = `fail_claim_delete_trigger_${triggerId}`;

    try {
      await client.unsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          RAISE EXCEPTION 'forced claim deletion failure';
        END;
        $function$;
        CREATE TRIGGER "${triggerName}"
        BEFORE DELETE ON claims
        FOR EACH ROW
        EXECUTE FUNCTION "${functionName}"();
      `);

      await expect(services.deleteClaim(projectId, claim.id)).rejects.toThrow('delete from "claims"');

      expect(await db.select().from(papers).where(and(eq(papers.projectId, projectId), eq(papers.id, paper.id)))).toEqual(originalPapers);
      expect(await db.select().from(evidence).where(eq(evidence.projectId, projectId))).toEqual(originalEvidence);
      expect(await db.select().from(claims).where(and(eq(claims.projectId, projectId), eq(claims.id, claim.id)))).toEqual(originalClaims);
      expect(await db.select().from(claimEvidence).where(and(eq(claimEvidence.projectId, projectId), eq(claimEvidence.claimId, claim.id)))).toEqual(originalLinks);
    } finally {
      await client.unsafe(`
        DROP TRIGGER IF EXISTS "${triggerName}" ON claims;
        DROP FUNCTION IF EXISTS "${functionName}"();
      `);
    }
  });

  it("enforces database-level project ownership on direct inserts", async () => {
    const other = await services.createProject({ title: "Other project" });
    const paper = await services.addPaper(projectId, { title: "Source paper", authors: [] });
    await expect(db.insert((await import("@/db/schema")).evidence).values({ projectId: other.id, paperId: paper.id, sourceText: "invalid", pageNumber: 1 })).rejects.toThrow();
  });
});
