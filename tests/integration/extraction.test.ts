import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { extractionRevisionEvidence, extractionValueRevisions } from "@/db/schema";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview");
const services = createReviewServices(db);
let projectId = "";

describe("Slice 3 extraction provenance", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Extraction project ${crypto.randomUUID()}` })).id; });
  afterAll(async () => {
    await client.unsafe(`TRUNCATE TABLE extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, screening_decisions, screening_criteria, claim_evidence, evidence, claims, papers, projects`);
    await client.end();
  });

  async function includedPaper() {
    const paper = await services.addPaper(projectId, { title: "Study" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  it("creates typed fields and immutable revision-specific provenance", async () => {
    const paper = await includedPaper();
    const field = await services.createExtractionField(projectId, { name: "Attack technique", fieldType: "short_text", required: true });
    const evidenceA = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "A", pageNumber: 7 });
    const evidenceB = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "B", pageNumber: 8 });
    await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Data poisoning", evidenceIds: [evidenceA.id] });
    await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Evasion", evidenceIds: [evidenceB.id] });
    const history = await services.getExtractionValueHistory(projectId, paper.id, field.id);
    expect(history).toHaveLength(2);
    expect(history[0].evidence.map((item) => item.id)).toEqual([evidenceA.id]);
    expect(history[1].evidence.map((item) => item.id)).toEqual([evidenceB.id]);
    expect((await services.getPaperExtraction(projectId, paper.id)).values[0].supportStatus).toBe("grounded");
    await expect(db.update(extractionValueRevisions).set({ researcherNote: "mutated" }).where(eq(extractionValueRevisions.id, history[0].id))).rejects.toThrow();
    await expect(db.delete(extractionRevisionEvidence).where(and(eq(extractionRevisionEvidence.projectId, projectId), eq(extractionRevisionEvidence.revisionId, history[1].id)))).rejects.toThrow();
  });

  it("requires same-paper Evidence and derives progress", async () => {
    const paper = await includedPaper();
    const other = await services.addPaper(projectId, { title: "Other" });
    const field = await services.createExtractionField(projectId, { name: "Dataset", fieldType: "short_text", required: true });
    const foreignEvidence = await services.recordEvidence(projectId, { paperId: other.id, sourceText: "foreign", pageNumber: 1 });
    await expect(services.reviseExtractionValue(projectId, paper.id, field.id, { value: "CIFAR", evidenceIds: [foreignEvidence.id] })).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
    await services.reviseExtractionValue(projectId, paper.id, field.id, { state: "not_reported", evidenceIds: [] });
    expect((await services.getProjectExtractionProgress(projectId)).papers[0].status).toBe("complete");
  });
});
