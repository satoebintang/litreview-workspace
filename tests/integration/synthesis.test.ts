import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { synthesisRevisionSupports, synthesisRevisions } from "@/db/schema";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview");
const services = createReviewServices(db);
let projectId = "";

describe("Slice 4 evidence synthesis", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Synthesis project ${crypto.randomUUID()}` })).id; });
  afterAll(async () => {
    await client.unsafe("TRUNCATE TABLE manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, screening_decisions, screening_criteria, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, evidence, claims, papers, projects");
    await client.end();
  });

  async function includedPaper(title: string) {
    const paper = await services.addPaper(projectId, { title });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  it("derives unsupported/supported state and descriptive coverage", async () => {
    const paperA = await includedPaper("Study A");
    const paperB = await includedPaper("Study B");
    const field = await services.createExtractionField(projectId, { name: "Technique", fieldType: "short_text" });
    const revisionA = await services.reviseExtractionValue(projectId, paperA.id, field.id, { value: "Poisoning", evidenceIds: [] });
    const revisionB = await services.reviseExtractionValue(projectId, paperB.id, field.id, { value: "Poisoning", evidenceIds: [] });
    const created = await services.createSynthesisStatement(projectId, { statementText: "Both studies report poisoning.", extractionRevisionIds: [] });
    expect((await services.getCurrentSynthesis(projectId, created.statement.id))?.supportStatus).toBe("unsupported");
    const revised = await services.reviseSynthesisStatement(projectId, created.statement.id, { statementText: "Both studies report poisoning.", extractionRevisionIds: [revisionA.id, revisionB.id] });
    expect(revised.revision.sequence).toBeGreaterThan(created.revision.sequence);
    const current = await services.getCurrentSynthesis(projectId, created.statement.id);
    expect(current?.supportStatus).toBe("supported");
    expect(current?.supportingRevisionCount).toBe(2);
    expect(current?.supportingPaperCount).toBe(2);
  });

  it("rejects duplicate, cross-project, and non-finalized support", async () => {
    const paper = await includedPaper("Study");
    const field = await services.createExtractionField(projectId, { name: "Technique", fieldType: "short_text" });
    const revision = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Poisoning", evidenceIds: [] });
    const other = await services.createProject({ title: "Other" });
    const otherPaper = await services.addPaper(other.id, { title: "Other study" });
    await services.recordScreeningDecision(other.id, otherPaper.id, { decision: "include" });
    const otherField = await services.createExtractionField(other.id, { name: "Technique", fieldType: "short_text" });
    const foreignRevision = await services.reviseExtractionValue(other.id, otherPaper.id, otherField.id, { value: "Other", evidenceIds: [] });
    await expect(services.createSynthesisStatement(projectId, { statementText: "Duplicate", extractionRevisionIds: [revision.id, revision.id] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(services.createSynthesisStatement(projectId, { statementText: "Foreign", extractionRevisionIds: [foreignRevision.id] })).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
  });

  it("keeps exact historical extraction support and requires explicit replacement", async () => {
    const paper = await includedPaper("Study");
    const field = await services.createExtractionField(projectId, { name: "Technique", fieldType: "short_text" });
    const oldRevision = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Data poisoning", evidenceIds: [] });
    const statement = await services.createSynthesisStatement(projectId, { statementText: "The study reports poisoning.", extractionRevisionIds: [oldRevision.id] });
    const newRevision = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Backdoor attack", evidenceIds: [] });
    const oldCurrent = await services.getCurrentSynthesis(projectId, statement.statement.id);
    expect(oldCurrent?.supports[0].extractionRevisionId).toBe(oldRevision.id);
    expect(oldCurrent?.supports[0].isCurrentExtractionRevision).toBe(false);
    const updated = await services.reviseSynthesisStatement(projectId, statement.statement.id, { statementText: "The study reports a backdoor attack.", extractionRevisionIds: [newRevision.id] });
    expect(updated.revision.sequence).toBeGreaterThan(statement.revision.sequence);
    expect((await services.getSynthesisHistory(projectId, statement.statement.id)).map((revision) => revision.supports[0]?.extractionRevisionId)).toEqual([oldRevision.id, newRevision.id]);
  });

  it("makes withdrawal genuinely idempotent and preserves history", async () => {
    const statement = await services.createSynthesisStatement(projectId, { statementText: "A conclusion", extractionRevisionIds: [] });
    const withdrawn = await services.withdrawSynthesisStatement(projectId, statement.statement.id);
    const repeated = await services.withdrawSynthesisStatement(projectId, statement.statement.id, { researcherNote: "ignored" });
    expect(withdrawn.idempotent).toBe(false);
    expect(repeated.idempotent).toBe(true);
    expect(repeated.revision.id).toBe(withdrawn.revision.id);
    expect((await services.getSynthesisHistory(projectId, statement.statement.id)).map((revision) => revision.state)).toEqual(["active", "withdrawn"]);
  });

  it("preserves historical support after Paper exclusion while rejecting new writes", async () => {
    const paper = await includedPaper("Study");
    const field = await services.createExtractionField(projectId, { name: "Technique", fieldType: "short_text" });
    const revision = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Poisoning", evidenceIds: [] });
    const statement = await services.createSynthesisStatement(projectId, { statementText: "Supported", extractionRevisionIds: [revision.id] });
    const criterion = await services.createScreeningCriterion(projectId, { type: "exclusion", text: "Out of scope" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "exclude", exclusionCriterionId: criterion.id });
    const historical = await services.getSynthesisProvenance(projectId, statement.statement.id);
    expect(historical.supports[0].extractionRevisionId).toBe(revision.id);
    await expect(services.reviseSynthesisStatement(projectId, statement.statement.id, { statementText: "Still supported", extractionRevisionIds: [revision.id] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects direct finalized revision and support-set mutations", async () => {
    const paper = await includedPaper("Study");
    const field = await services.createExtractionField(projectId, { name: "Technique", fieldType: "short_text" });
    const extractionRevision = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Poisoning", evidenceIds: [] });
    const statement = await services.createSynthesisStatement(projectId, { statementText: "Immutable", extractionRevisionIds: [extractionRevision.id] });
    const laterExtractionRevision = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Backdoor", evidenceIds: [] });
    await expect(db.update(synthesisRevisions).set({ statementText: "mutated" }).where(and(eq(synthesisRevisions.projectId, projectId), eq(synthesisRevisions.id, statement.revision.id)))).rejects.toThrow();
    await expect(db.delete(synthesisRevisions).where(eq(synthesisRevisions.id, statement.revision.id))).rejects.toThrow();
    await expect(db.delete(synthesisRevisionSupports).where(eq(synthesisRevisionSupports.synthesisRevisionId, statement.revision.id))).rejects.toThrow();
    await expect(db.insert(synthesisRevisionSupports).values({ projectId, synthesisRevisionId: statement.revision.id, extractionRevisionId: laterExtractionRevision.id })).rejects.toThrow();
  });

  it("returns current comparison rows including missing and ungrounded states", async () => {
    const included = await includedPaper("Included");
    const notExtracted = await includedPaper("Not extracted");
    const field = await services.createExtractionField(projectId, { name: "Technique", fieldType: "short_text" });
    await services.reviseExtractionValue(projectId, included.id, field.id, { value: "Poisoning", evidenceIds: [] });
    const rows = await services.listExtractionComparison(projectId, field.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.paper.id === notExtracted.id)?.valueState).toBe("not_extracted");
    expect(rows.find((row) => row.paper.id === included.id)?.supportStatus).toBe("ungrounded");
  });
});
