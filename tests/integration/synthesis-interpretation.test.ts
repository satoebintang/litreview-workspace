import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import {
  synthesisInterpretations,
  synthesisInterpretationLimitations,
  synthesisInterpretationQuestions,
} from "@/db/schema";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview");
const services = createReviewServices(db);

let projectId = "";

describe("Slice 19 Synthesis Interpretation Context", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  beforeEach(async () => {
    projectId = (await services.createProject({ title: `Synthesis Interpretation ${crypto.randomUUID()}` })).id;
  });

  afterAll(async () => {
    await client.unsafe(
      "TRUNCATE TABLE synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_set_composition_members, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, evidence_label_events, evidence_annotations, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects",
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

  it("appends complete snapshots, maintains sequence ordering and projections", async () => {
    const paperA = await includedPaper("Paper A");
    const paperB = await includedPaper("Paper B");

    const evA = await services.recordEvidence(projectId, { paperId: paperA.id, sourceText: "Passage A", pageNumber: 1 });
    const evB = await services.recordEvidence(projectId, { paperId: paperB.id, sourceText: "Passage B", pageNumber: 2 });

    const field = await services.createExtractionField(projectId, { name: "Outcome", fieldType: "short_text" });
    const extA = await services.reviseExtractionValue(projectId, paperA.id, field.id, { value: "Positive", evidenceIds: [evA.id] });
    const extB = await services.reviseExtractionValue(projectId, paperB.id, field.id, { value: "Negative", evidenceIds: [evB.id] });

    const stmt = await services.createSynthesisStatement(projectId, {
      statementText: "Outcomes differ across study designs.",
      extractionRevisionIds: [extA.id, extB.id],
    });

    const [leftId, rightId] = [extA.id, extB.id].sort();

    // 1. Append first interpretation: mixed
    const interp1 = await services.appendSynthesisInterpretation(
      projectId,
      stmt.statement.id,
      stmt.revision.id,
      {
        convergenceState: "mixed",
        summary: "Preliminary analysis shows mixed effects.",
        researcherNote: "Initial draft note",
        limitations: [
          { category: "methodological", body: "Small sample size in study A" },
          { category: "reporting", body: "Unblinded outcome assessment in study B" },
        ],
        questions: [
          { body: "Did dosage vary significantly?" },
        ],
        contradictions: [],
      },
    );

    expect(interp1.sequence).toBeGreaterThan(0);
    expect(interp1.convergenceState).toBe("mixed");
    expect(interp1.summary).toBe("Preliminary analysis shows mixed effects.");
    expect(interp1.researcherNote).toBe("Initial draft note");
    expect(interp1.finalizedAt).toBeInstanceOf(Date);
    expect(interp1.limitations).toHaveLength(2);
    expect(interp1.limitations[0].category).toBe("methodological");
    expect(interp1.limitations[0].sortOrder).toBe(0);
    expect(interp1.limitations[1].category).toBe("reporting");
    expect(interp1.limitations[1].sortOrder).toBe(1);
    expect(interp1.questions).toHaveLength(1);
    expect(interp1.questions[0].body).toBe("Did dosage vary significantly?");
    expect(interp1.contradictions).toHaveLength(0);

    // 2. Append second interpretation: contradictory with canonical contradiction pair
    const interp2 = await services.appendSynthesisInterpretation(
      projectId,
      stmt.statement.id,
      stmt.revision.id,
      {
        convergenceState: "contradictory",
        summary: "Direct conflict between findings of Paper A and Paper B.",
        researcherNote: "Confirmed direct contradiction",
        limitations: [],
        questions: [
          { body: "Was there an unmeasured confounder?" },
        ],
        contradictions: [
          // Pass in reversed order to verify canonicalization
          { leftExtractionRevisionId: rightId, rightExtractionRevisionId: leftId, note: "Conflicting outcomes under identical protocols" },
        ],
      },
    );

    expect(interp2.sequence).toBe(interp1.sequence + 1);
    expect(interp2.convergenceState).toBe("contradictory");
    expect(interp2.contradictions).toHaveLength(1);
    expect(interp2.contradictions[0].leftExtractionRevisionId).toBe(leftId);
    expect(interp2.contradictions[0].rightExtractionRevisionId).toBe(rightId);
    expect(interp2.contradictions[0].note).toBe("Conflicting outcomes under identical protocols");

    // 3. Query projection
    const projection = await services.getSynthesisInterpretationProjection(projectId, stmt.statement.id, stmt.revision.id);
    expect(projection.currentInterpretation).not.toBeNull();
    expect(projection.currentInterpretation?.id).toBe(interp2.id);
    expect(projection.currentInterpretation?.sequence).toBe(interp1.sequence + 1);
    expect(projection.history).toHaveLength(2);
    expect(projection.history[0].id).toBe(interp2.id);
    expect(projection.history[1].id).toBe(interp1.id);

    // Contradiction view has resolved left and right supports
    const currentContradiction = projection.currentInterpretation?.contradictions[0];
    expect(currentContradiction?.leftSupport).not.toBeNull();
    expect(currentContradiction?.rightSupport).not.toBeNull();
    expect(currentContradiction?.leftSupport?.extractionRevisionId).toBe(leftId);
    expect(currentContradiction?.rightSupport?.extractionRevisionId).toBe(rightId);

    // 4. Query snapshot directly
    const snapshot1 = await services.getSynthesisInterpretationSnapshot(projectId, interp1.id);
    expect(snapshot1.id).toBe(interp1.id);
    expect(snapshot1.sequence).toBe(interp1.sequence);
    expect(snapshot1.limitations).toHaveLength(2);
  });

  it("verifies both contradiction pair members must be exact supports of the interpreted synthesis revision", async () => {
    const paperA = await includedPaper("Paper A");
    const paperB = await includedPaper("Paper B");
    const paperC = await includedPaper("Paper C (Not supported)");

    const field = await services.createExtractionField(projectId, { name: "Outcome", fieldType: "short_text" });
    const extA = await services.reviseExtractionValue(projectId, paperA.id, field.id, { value: "A", evidenceIds: [] });
    const extB = await services.reviseExtractionValue(projectId, paperB.id, field.id, { value: "B", evidenceIds: [] });
    const extC = await services.reviseExtractionValue(projectId, paperC.id, field.id, { value: "C", evidenceIds: [] });

    // Synthesis only supports extA and extB
    const stmt = await services.createSynthesisStatement(projectId, {
      statementText: "Synthesis supported by A and B.",
      extractionRevisionIds: [extA.id, extB.id],
    });

    // Attempting to append contradiction referencing extC (foreign to this synthesis revision)
    await expect(
      services.appendSynthesisInterpretation(
        projectId,
        stmt.statement.id,
        stmt.revision.id,
        {
          convergenceState: "contradictory",
          summary: "Invalid support pair",
          contradictions: [
            { leftExtractionRevisionId: extA.id, rightExtractionRevisionId: extC.id },
          ],
        },
      ),
    ).rejects.toThrow();
  });

  it("rejects direct database mutation of finalized interpretations and child records", async () => {
    const paper = await includedPaper("Paper A");
    const field = await services.createExtractionField(projectId, { name: "Outcome", fieldType: "short_text" });
    const ext = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Result", evidenceIds: [] });

    const stmt = await services.createSynthesisStatement(projectId, {
      statementText: "Statement text",
      extractionRevisionIds: [ext.id],
    });

    const interp = await services.appendSynthesisInterpretation(
      projectId,
      stmt.statement.id,
      stmt.revision.id,
      {
        convergenceState: "inconclusive",
        summary: "Inconclusive results",
        limitations: [{ category: "methodological", body: "Early phase" }],
        questions: [{ body: "Needs more data?" }],
      },
    );

    // Direct UPDATE on parent
    await expect(
      db.update(synthesisInterpretations)
        .set({ summary: "Mutated summary" })
        .where(and(eq(synthesisInterpretations.projectId, projectId), eq(synthesisInterpretations.id, interp.id))),
    ).rejects.toThrow();

    // Direct DELETE on parent
    await expect(
      db.delete(synthesisInterpretations)
        .where(and(eq(synthesisInterpretations.projectId, projectId), eq(synthesisInterpretations.id, interp.id))),
    ).rejects.toThrow();

    // Direct UPDATE on limitation child
    await expect(
      db.update(synthesisInterpretationLimitations)
        .set({ body: "Mutated body" })
        .where(and(eq(synthesisInterpretationLimitations.projectId, projectId), eq(synthesisInterpretationLimitations.interpretationId, interp.id))),
    ).rejects.toThrow();

    // Direct DELETE on limitation child
    await expect(
      db.delete(synthesisInterpretationLimitations)
        .where(and(eq(synthesisInterpretationLimitations.projectId, projectId), eq(synthesisInterpretationLimitations.interpretationId, interp.id))),
    ).rejects.toThrow();

    // Direct UPDATE on question child
    await expect(
      db.update(synthesisInterpretationQuestions)
        .set({ body: "Mutated question" })
        .where(and(eq(synthesisInterpretationQuestions.projectId, projectId), eq(synthesisInterpretationQuestions.interpretationId, interp.id))),
    ).rejects.toThrow();

    // Direct DELETE on question child
    await expect(
      db.delete(synthesisInterpretationQuestions)
        .where(and(eq(synthesisInterpretationQuestions.projectId, projectId), eq(synthesisInterpretationQuestions.interpretationId, interp.id))),
    ).rejects.toThrow();
  });

  it("enforces deferred finalization trigger: unfinalized commit and convergence rule violations are rejected", async () => {
    const paper = await includedPaper("Paper A");
    const field = await services.createExtractionField(projectId, { name: "Outcome", fieldType: "short_text" });
    const ext = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Result", evidenceIds: [] });

    const stmt = await services.createSynthesisStatement(projectId, {
      statementText: "Statement text",
      extractionRevisionIds: [ext.id],
    });

    // 1. Unfinalized commit rejection: insert parent with finalized_at = NULL and commit
    await expect(
      client.begin(async (tx) => {
        await tx`
          INSERT INTO synthesis_interpretations (
            project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary, finalized_at
          ) VALUES (
            ${projectId}, ${stmt.statement.id}, ${stmt.revision.id}, 'convergent', 'Unfinalized snapshot', NULL
          )
        `;
      }),
    ).rejects.toThrow(/cannot survive transaction commit/);

    // 2. Contradictory state with 0 pairs deferred rejection
    await expect(
      client.begin(async (tx) => {
        const [draft] = await tx`
          INSERT INTO synthesis_interpretations (
            project_id, synthesis_statement_id, synthesis_revision_id, convergence_state, summary, finalized_at
          ) VALUES (
            ${projectId}, ${stmt.statement.id}, ${stmt.revision.id}, 'contradictory', 'Contradictory but zero pairs', NULL
          ) RETURNING id
        `;
        await tx`
          UPDATE synthesis_interpretations
          SET finalized_at = NOW()
          WHERE id = ${draft.id}
        `;
      }),
    ).rejects.toThrow(/must have at least 1 contradiction pair/);
  });

  it("reflects live Evidence curation warnings without mutating interpretation snapshots", async () => {
    const paper = await includedPaper("Paper A");
    const ev = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Passage", pageNumber: 1 });
    const field = await services.createExtractionField(projectId, { name: "Outcome", fieldType: "short_text" });
    const ext = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Result", evidenceIds: [ev.id] });

    const stmt = await services.createSynthesisStatement(projectId, {
      statementText: "Statement text",
      extractionRevisionIds: [ext.id],
    });

    const interp = await services.appendSynthesisInterpretation(
      projectId,
      stmt.statement.id,
      stmt.revision.id,
      {
        convergenceState: "convergent",
        summary: "Convergent findings",
      },
    );

    // 1. Initial state: never_reviewed
    let proj = await services.getSynthesisInterpretationProjection(projectId, stmt.statement.id, stmt.revision.id);
    expect(proj.evidenceWarnings).toHaveLength(1);
    expect(proj.evidenceWarnings[0].evidenceId).toBe(ev.id);
    expect(proj.evidenceWarnings[0].warning).toBe("never_reviewed");

    // 2. Record needs_review curation decision
    await services.appendEvidenceReviewDecision(projectId, ev.id, { decision: "needs_review", note: "Questionable methodology" });
    proj = await services.getSynthesisInterpretationProjection(projectId, stmt.statement.id, stmt.revision.id);
    expect(proj.evidenceWarnings[0].warning).toBe("needs_review");

    // 3. Record rejected curation decision
    await services.appendEvidenceReviewDecision(projectId, ev.id, { decision: "rejected", note: "Artifact identified" });
    proj = await services.getSynthesisInterpretationProjection(projectId, stmt.statement.id, stmt.revision.id);
    expect(proj.evidenceWarnings[0].warning).toBe("currently_rejected");

    // 4. Record accepted curation decision
    await services.appendEvidenceReviewDecision(projectId, ev.id, { decision: "accepted", note: "Verified valid" });
    proj = await services.getSynthesisInterpretationProjection(projectId, stmt.statement.id, stmt.revision.id);
    expect(proj.evidenceWarnings[0].warning).toBeNull();

    // Verify snapshot was completely unaffected
    const snapshot = await services.getSynthesisInterpretationSnapshot(projectId, interp.id);
    expect(snapshot.summary).toBe("Convergent findings");
    expect(snapshot.sequence).toBe(interp.sequence);
  });

  it("handles concurrent appends gracefully with strict sequence serialization", async () => {
    const paper = await includedPaper("Paper A");
    const field = await services.createExtractionField(projectId, { name: "Outcome", fieldType: "short_text" });
    const ext = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Result", evidenceIds: [] });

    const stmt = await services.createSynthesisStatement(projectId, {
      statementText: "Statement text",
      extractionRevisionIds: [ext.id],
    });

    // Execute 3 concurrent append operations on the same synthesis revision
    const results = await Promise.all([
      services.appendSynthesisInterpretation(projectId, stmt.statement.id, stmt.revision.id, {
        convergenceState: "inconclusive",
        summary: "Concurrent 1",
      }),
      services.appendSynthesisInterpretation(projectId, stmt.statement.id, stmt.revision.id, {
        convergenceState: "inconclusive",
        summary: "Concurrent 2",
      }),
      services.appendSynthesisInterpretation(projectId, stmt.statement.id, stmt.revision.id, {
        convergenceState: "inconclusive",
        summary: "Concurrent 3",
      }),
    ]);

    const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
    expect(sequences).toHaveLength(3);
    expect(sequences[1]).toBe(sequences[0] + 1);
    expect(sequences[2]).toBe(sequences[1] + 1);

    const proj = await services.getSynthesisInterpretationProjection(projectId, stmt.statement.id, stmt.revision.id);
    expect(proj.history).toHaveLength(3);
    expect(proj.currentInterpretation?.sequence).toBe(sequences[2]);
  });
});
