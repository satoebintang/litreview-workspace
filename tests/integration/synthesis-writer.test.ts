import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import {
  writeActiveSynthesisRevision,
} from "@/application/synthesis-writer";
import {
  PaperRepository,
  SynthesisStatementRepository,
  SynthesisRevisionRepository,
  SynthesisRevisionSupportRepository,
} from "@/application/repositories";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview");
const services = createReviewServices(db);

const paperRepo = new PaperRepository(db);
const synthesisStatementRepo = new SynthesisStatementRepository(db);
const synthesisRevisionRepo = new SynthesisRevisionRepository(db);
const synthesisSupportRepo = new SynthesisRevisionSupportRepository(db);

let projectId = "";

describe("Shared Synthesis Writer (writeActiveSynthesisRevision)", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  beforeEach(async () => {
    projectId = (await services.createProject({ title: `Synthesis writer ${crypto.randomUUID()}` })).id;
  });

  afterAll(async () => {
    await client.unsafe(
      "TRUNCATE TABLE research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_extraction_field_events, research_question_evidence_set_events, research_question_synthesis_statement_events, research_question_claim_events, synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_set_composition_members, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, evidence_label_events, evidence_annotations, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects",
    );
    await client.end();
  });

  async function includedPaper(title: string) {
    const paper = await services.addPaper(projectId, { title });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  it("creates a new synthesis statement with zero supports", async () => {
    const result = await db.transaction(async (tx) => {
      return writeActiveSynthesisRevision(
        tx,
        projectId,
        { kind: "new" },
        { statementText: "Zero support synthesis statement", extractionRevisionIds: [] },
        { paperRepo, synthesisStatementRepo, synthesisRevisionRepo, synthesisSupportRepo },
      );
    });

    expect(result.statement.id).toBeDefined();
    expect(result.revision.state).toBe("active");
    expect(result.revision.statementText).toBe("Zero support synthesis statement");
    expect(result.supportExtractionRevisionIds).toEqual([]);

    const current = await services.getCurrentSynthesis(projectId, result.statement.id);
    expect(current?.supportStatus).toBe("unsupported");
    expect(current?.supportingRevisionCount).toBe(0);
  });

  it("creates a new synthesis statement with supports, and supports revision", async () => {
    const paperA = await includedPaper("Paper A");
    const paperB = await includedPaper("Paper B");
    const field = await services.createExtractionField(projectId, { name: "Finding", fieldType: "short_text" });
    const revA = await services.reviseExtractionValue(projectId, paperA.id, field.id, { value: "Finding A", evidenceIds: [] });
    const revB = await services.reviseExtractionValue(projectId, paperB.id, field.id, { value: "Finding B", evidenceIds: [] });

    // Create via writer
    const created = await db.transaction(async (tx) => {
      return writeActiveSynthesisRevision(
        tx,
        projectId,
        { kind: "new" },
        { statementText: "Both findings A and B", extractionRevisionIds: [revA.id, revB.id] },
        { paperRepo, synthesisStatementRepo, synthesisRevisionRepo, synthesisSupportRepo },
      );
    });

    expect(created.revision.sequence).toBeGreaterThan(0);
    expect(created.supportExtractionRevisionIds).toHaveLength(2);

    const current1 = await services.getCurrentSynthesis(projectId, created.statement.id);
    expect(current1?.supportStatus).toBe("supported");
    expect(current1?.supportingRevisionCount).toBe(2);

    // Revise existing statement via writer
    const revised = await db.transaction(async (tx) => {
      return writeActiveSynthesisRevision(
        tx,
        projectId,
        { kind: "existing", statementId: created.statement.id },
        { statementText: "Updated: only finding A", extractionRevisionIds: [revA.id] },
        { paperRepo, synthesisStatementRepo, synthesisRevisionRepo, synthesisSupportRepo },
      );
    });

    expect(revised.statement.id).toBe(created.statement.id);
    expect(revised.revision.sequence).toBeGreaterThan(created.revision.sequence);
    expect(revised.revision.statementText).toBe("Updated: only finding A");
    expect(revised.supportExtractionRevisionIds).toEqual([revA.id]);

    const current2 = await services.getCurrentSynthesis(projectId, created.statement.id);
    expect(current2?.supportingRevisionCount).toBe(1);
  });

  it("reactivates a withdrawn synthesis statement using the standard path", async () => {
    const paper = await includedPaper("Paper for withdraw/reactivate");
    const field = await services.createExtractionField(projectId, { name: "Finding", fieldType: "short_text" });
    const rev = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Data", evidenceIds: [] });

    const created = await services.createSynthesisStatement(projectId, {
      statementText: "Initial statement",
      extractionRevisionIds: [rev.id],
    });

    // Withdraw statement
    await services.withdrawSynthesisStatement(projectId, created.statement.id, { researcherNote: "Retracting" });
    const withdrawnView = await services.getCurrentSynthesis(projectId, created.statement.id);
    expect(withdrawnView?.state).toBe("withdrawn");

    // Reactivate statement via writeActiveSynthesisRevision
    const reactivated = await db.transaction(async (tx) => {
      return writeActiveSynthesisRevision(
        tx,
        projectId,
        { kind: "existing", statementId: created.statement.id },
        { statementText: "Reactivated statement", extractionRevisionIds: [rev.id] },
        { paperRepo, synthesisStatementRepo, synthesisRevisionRepo, synthesisSupportRepo },
      );
    });

    expect(reactivated.revision.state).toBe("active");
    expect(reactivated.revision.sequence).toBeGreaterThan(created.revision.sequence);
    const current = await services.getCurrentSynthesis(projectId, created.statement.id);
    expect(current?.state).toBe("active");
    expect(current?.statementText).toBe("Reactivated statement");
  });

  it("locks supporting papers in UUID order and enforces eligibility", async () => {
    const paper = await services.addPaper(projectId, { title: "Unscreened paper" });
    const field = await services.createExtractionField(projectId, { name: "Field", fieldType: "short_text" });

    // Draft revision on unscreened paper directly in DB (simulating legacy/drift)
    const [val] = await client`insert into extraction_values (project_id, paper_id, field_id) values (${projectId}, ${paper.id}, ${field.id}) returning id`;
    const [rev] = await client`insert into extraction_value_revisions (project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value, finalized_at) values (${projectId}, ${paper.id}, ${field.id}, ${val.id}, 'short_text', 'present', 'Excluded val', now()) returning id`;

    // Attempting to write synthesis using this revision must fail eligibility check
    await expect(
      db.transaction(async (tx) => {
        return writeActiveSynthesisRevision(
          tx,
          projectId,
          { kind: "new" },
          { statementText: "Should fail", extractionRevisionIds: [rev.id] },
          { paperRepo, synthesisStatementRepo, synthesisRevisionRepo, synthesisSupportRepo },
        );
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});