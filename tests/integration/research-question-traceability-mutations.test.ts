/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createResearchQuestionTraceabilityServices } from "@/application/research-question-traceability-services";
import { DomainError } from "@/domain/errors";

const { db, client } = createDb(
  process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview",
);
const reviewServices = createReviewServices(db);
const traceabilityServices = createResearchQuestionTraceabilityServices(db);

let projectId = "";
let otherProjectId = "";

describe("Slice 20 Research Question Traceability Mutations & Reducer", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  beforeEach(async () => {
    projectId = (
      await reviewServices.createProject({
        title: `Traceability Test Project ${crypto.randomUUID()}`,
      })
    ).id;
    otherProjectId = (
      await reviewServices.createProject({
        title: `Other Project ${crypto.randomUUID()}`,
      })
    ).id;
  });

  afterAll(async () => {
    await client.unsafe(
      "TRUNCATE TABLE research_question_extraction_field_events, research_question_evidence_set_events, research_question_synthesis_statement_events, research_question_claim_events, synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_set_composition_members, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, evidence_label_events, evidence_annotations, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects",
    );
    await client.end();
  });

  it("enforces first-event must be 'linked' and rejects initial 'unlinked'", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ1",
      label: "What are the outcomes?",
    });
    const field = await reviewServices.createExtractionField(projectId, {
      name: "Outcome Metric",
      fieldType: "short_text",
    });

    // Unlinking before ever being linked must fail
    await expect(
      traceabilityServices.unlinkExtractionField({
        projectId,
        questionId: question.id,
        fieldId: field.id,
      }),
    ).rejects.toThrow(DomainError);

    try {
      await traceabilityServices.unlinkExtractionField({
        projectId,
        questionId: question.id,
        fieldId: field.id,
      });
    } catch (e: any) {
      expect(e.code).toBe("VALIDATION_ERROR");
      expect(e.message).toContain("First event");
    }
  });

  it("handles complete link -> unlink -> relink cycle with authoritative reducer state", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ1",
      label: "Cycle test question",
    });
    const fieldA = await reviewServices.createExtractionField(projectId, {
      name: "Sample Size",
      fieldType: "number",
    });
    const fieldB = await reviewServices.createExtractionField(projectId, {
      name: "Study Design",
      fieldType: "short_text",
    });

    // 1. Link field A
    const event1 = await traceabilityServices.linkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: fieldA.id,
      note: "Primary numeric variable",
    });
    expect(event1.action).toBe("linked");
    expect(event1.sequence).toBeGreaterThan(0);
    expect(event1.note).toBe("Primary numeric variable");

    // Reducer check: fieldA is linked, fieldB is not
    let links = await traceabilityServices.getCurrentLinksForQuestion(projectId, question.id);
    expect(links.extractionFieldIds).toEqual([fieldA.id]);

    // 2. Duplicate link field A must fail
    await expect(
      traceabilityServices.linkExtractionField({
        projectId,
        questionId: question.id,
        fieldId: fieldA.id,
      }),
    ).rejects.toThrow(DomainError);

    // 3. Link field B
    await traceabilityServices.linkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: fieldB.id,
    });
    links = await traceabilityServices.getCurrentLinksForQuestion(projectId, question.id);
    expect(links.extractionFieldIds).toContain(fieldA.id);
    expect(links.extractionFieldIds).toContain(fieldB.id);

    // 4. Unlink field A
    const event2 = await traceabilityServices.unlinkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: fieldA.id,
      note: "Removed from primary analysis",
    });
    expect(event2.action).toBe("unlinked");
    expect(event2.sequence).toBeGreaterThan(event1.sequence);
    expect(event2.note).toBe("Removed from primary analysis");

    // Reducer check: fieldA is no longer in current links; fieldB remains
    links = await traceabilityServices.getCurrentLinksForQuestion(projectId, question.id);
    expect(links.extractionFieldIds).not.toContain(fieldA.id);
    expect(links.extractionFieldIds).toContain(fieldB.id);

    // 5. Duplicate unlink field A must fail
    await expect(
      traceabilityServices.unlinkExtractionField({
        projectId,
        questionId: question.id,
        fieldId: fieldA.id,
      }),
    ).rejects.toThrow(DomainError);

    // 6. Relink field A
    const event3 = await traceabilityServices.linkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: fieldA.id,
      note: "Restored after protocol amendment",
    });
    expect(event3.action).toBe("linked");
    expect(event3.sequence).toBeGreaterThan(event2.sequence);

    // Reducer check: both are currently linked
    links = await traceabilityServices.getCurrentLinksForQuestion(projectId, question.id);
    expect(links.extractionFieldIds).toContain(fieldA.id);
    expect(links.extractionFieldIds).toContain(fieldB.id);

    // History verification
    const histories = await traceabilityServices.getQuestionTraceabilityHistories(projectId, question.id);
    const fieldAEvents = histories.fieldEvents.filter((e) => e.extractionFieldId === fieldA.id);
    expect(fieldAEvents).toHaveLength(3);
    expect(fieldAEvents[0].action).toBe("linked");
    expect(fieldAEvents[1].action).toBe("unlinked");
    expect(fieldAEvents[2].action).toBe("linked");
  });

  it("supports evidence sets, synthesis statements, and claims linking & unlinking", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ1",
      label: "Multi-target question",
    });

    // Target 1: Evidence Set
    const createdSet = await reviewServices.createEvidenceSet(projectId, {
      name: "RCT Core Evidence",
      description: "Randomized controlled trials",
    });
    const evidenceSet = createdSet.set;

    const setLink = await traceabilityServices.linkEvidenceSet({
      projectId,
      questionId: question.id,
      evidenceSetId: evidenceSet.id,
      note: "Population evidence set",
    });
    expect(setLink.action).toBe("linked");
    expect(setLink.evidenceSetId).toBe(evidenceSet.id);

    // Target 2: Synthesis Statement
    const stmt = await reviewServices.createSynthesisStatement(projectId, {
      statementText: "High certainty evidence of effect.",
      extractionRevisionIds: [],
    });

    const stmtLink = await traceabilityServices.linkSynthesisStatement({
      projectId,
      questionId: question.id,
      statementId: stmt.statement.id,
    });
    expect(stmtLink.action).toBe("linked");
    expect(stmtLink.synthesisStatementId).toBe(stmt.statement.id);

    // Target 3: Claim
    const claimResult = await reviewServices.createClaimWithSynthesisSupport(projectId, {
      claimText: "Intervention consistently reduces risk",
      synthesisRevisionId: stmt.revision.id,
    });

    const claimLink = await traceabilityServices.linkClaim({
      projectId,
      questionId: question.id,
      claimId: claimResult.claim.id,
    });
    expect(claimLink.action).toBe("linked");
    expect(claimLink.claimId).toBe(claimResult.claim.id);

    // Current links verification
    const current = await traceabilityServices.getCurrentLinksForQuestion(projectId, question.id);
    expect(current.evidenceSetIds).toEqual([evidenceSet.id]);
    expect(current.synthesisStatementIds).toEqual([stmt.statement.id]);
    expect(current.claimIds).toEqual([claimResult.claim.id]);

    // Unlink each
    await traceabilityServices.unlinkEvidenceSet({
      projectId,
      questionId: question.id,
      evidenceSetId: evidenceSet.id,
    });
    await traceabilityServices.unlinkSynthesisStatement({
      projectId,
      questionId: question.id,
      statementId: stmt.statement.id,
    });
    await traceabilityServices.unlinkClaim({
      projectId,
      questionId: question.id,
      claimId: claimResult.claim.id,
    });

    const unlinkedState = await traceabilityServices.getCurrentLinksForQuestion(projectId, question.id);
    expect(unlinkedState.evidenceSetIds).toHaveLength(0);
    expect(unlinkedState.synthesisStatementIds).toHaveLength(0);
    expect(unlinkedState.claimIds).toHaveLength(0);
  });

  it("rejects mutations on archived research questions", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ_ARCH",
      label: "Archived question",
    });
    const field = await reviewServices.createExtractionField(projectId, {
      name: "Field 1",
      fieldType: "short_text",
    });

    // Archive question
    await reviewServices.archiveResearchQuestion(projectId, question.id);

    // Attempt to link must fail
    await expect(
      traceabilityServices.linkExtractionField({
        projectId,
        questionId: question.id,
        fieldId: field.id,
      }),
    ).rejects.toThrow(DomainError);

    try {
      await traceabilityServices.linkExtractionField({
        projectId,
        questionId: question.id,
        fieldId: field.id,
      });
    } catch (e: any) {
      expect(e.code).toBe("VALIDATION_ERROR");
      expect(e.message).toContain("archived");
    }
  });

  it("allows linking archived targets without error", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ_TGT_ARCH",
      label: "Target archive test question",
    });
    const field = await reviewServices.createExtractionField(projectId, {
      name: "Deprecated Metric",
      fieldType: "number",
    });

    // Archive field
    await reviewServices.archiveExtractionField(projectId, field.id);

    // Linking archived field must succeed
    const link = await traceabilityServices.linkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: field.id,
      note: "Preserving historical link to deprecated metric",
    });
    expect(link.action).toBe("linked");

    const links = await traceabilityServices.getCurrentLinksForQuestion(projectId, question.id);
    expect(links.extractionFieldIds).toEqual([field.id]);
  });

  it("enforces cross-project isolation", async () => {
    const question1 = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ_P1",
      label: "Project 1 question",
    });
    const otherField = await reviewServices.createExtractionField(otherProjectId, {
      name: "Other Project Field",
      fieldType: "short_text",
    });

    // Cross-project target link must fail
    await expect(
      traceabilityServices.linkExtractionField({
        projectId,
        questionId: question1.id,
        fieldId: otherField.id,
      }),
    ).rejects.toThrow(DomainError);

    try {
      await traceabilityServices.linkExtractionField({
        projectId,
        questionId: question1.id,
        fieldId: otherField.id,
      });
    } catch (e: any) {
      expect(["CROSS_PROJECT_REFERENCE", "NOT_FOUND"]).toContain(e.code);
    }
  });

  it("projects project-wide current links across multiple research questions", async () => {
    const q1 = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ1",
      label: "First Question",
    });
    const q2 = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ2",
      label: "Second Question",
    });
    const q3 = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ3",
      label: "Third Question with no links",
    });

    const field1 = await reviewServices.createExtractionField(projectId, {
      name: "Field 1",
      fieldType: "short_text",
    });
    const field2 = await reviewServices.createExtractionField(projectId, {
      name: "Field 2",
      fieldType: "number",
    });

    await traceabilityServices.linkExtractionField({
      projectId,
      questionId: q1.id,
      fieldId: field1.id,
    });
    await traceabilityServices.linkExtractionField({
      projectId,
      questionId: q2.id,
      fieldId: field2.id,
    });

    const projectLinks = await traceabilityServices.getCurrentLinksForProject(projectId, [
      q1.id,
      q2.id,
      q3.id,
    ]);

    expect(projectLinks.get(q1.id)?.extractionFieldIds).toEqual([field1.id]);
    expect(projectLinks.get(q2.id)?.extractionFieldIds).toEqual([field2.id]);
    expect(projectLinks.get(q3.id)?.extractionFieldIds).toEqual([]);
  });

  it("supports interleaved events across multiple target pairs without consecutive sequence rejection (Model A)", async () => {
    const question = await reviewServices.createResearchQuestion(projectId, {
      identifier: "RQ_INTERLEAVE",
      label: "Interleaved sequence test",
    });
    const fieldA = await reviewServices.createExtractionField(projectId, {
      name: "Field A",
      fieldType: "short_text",
    });
    const fieldB = await reviewServices.createExtractionField(projectId, {
      name: "Field B",
      fieldType: "number",
    });

    // Event 1: Pair A links (sequence = S1)
    const e1 = await traceabilityServices.linkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: fieldA.id,
      note: "Pair A initial link",
    });

    // Event 2: Pair B links (sequence = S2 > S1)
    const e2 = await traceabilityServices.linkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: fieldB.id,
      note: "Pair B initial link",
    });

    // Event 3: Pair A unlinks (sequence = S3 > S2)
    const e3 = await traceabilityServices.unlinkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: fieldA.id,
      note: "Pair A unlink",
    });

    // Event 4: Pair B unlinks (sequence = S4 > S3)
    const e4 = await traceabilityServices.unlinkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: fieldB.id,
      note: "Pair B unlink",
    });

    // Event 5: Pair A relinks (sequence = S5 > S4)
    const e5 = await traceabilityServices.linkExtractionField({
      projectId,
      questionId: question.id,
      fieldId: fieldA.id,
      note: "Pair A relink",
    });

    expect(e2.sequence).toBeGreaterThan(e1.sequence);
    expect(e3.sequence).toBeGreaterThan(e2.sequence);
    expect(e4.sequence).toBeGreaterThan(e3.sequence);
    expect(e5.sequence).toBeGreaterThan(e4.sequence);

    // Pair A sequence history is non-consecutive global generated bigints
    const historyA = (await traceabilityServices.getQuestionTraceabilityHistories(projectId, question.id))
      .fieldEvents.filter((e) => e.extractionFieldId === fieldA.id);
    expect(historyA.map((e) => e.sequence)).toEqual([e1.sequence, e3.sequence, e5.sequence]);

    // Reducer check: Pair A is currently linked, Pair B is currently unlinked
    const current = await traceabilityServices.getCurrentLinksForQuestion(projectId, question.id);
    expect(current.extractionFieldIds).toContain(fieldA.id);
    expect(current.extractionFieldIds).not.toContain(fieldB.id);
  });
});
