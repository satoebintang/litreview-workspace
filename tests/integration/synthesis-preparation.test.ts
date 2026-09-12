import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview");
const services = createReviewServices(db);

let projectId = "";

describe("Slice 18 Synthesis Preparation from Evidence Sets", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
  });

  beforeEach(async () => {
    projectId = (await services.createProject({ title: `Synthesis Preparation ${crypto.randomUUID()}` })).id;
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

  it("lists synthesis fields available in an Evidence Set composition", async () => {
    const paperA = await includedPaper("Paper A");
    const paperB = await includedPaper("Paper B");

    const ev1 = await services.recordEvidence(projectId, { paperId: paperA.id, sourceText: "Passage 1", pageNumber: 1 });
    const ev2 = await services.recordEvidence(projectId, { paperId: paperB.id, sourceText: "Passage 2", pageNumber: 2 });

    const field1 = await services.createExtractionField(projectId, { name: "Effect Size", fieldType: "number" });
    const field2 = await services.createExtractionField(projectId, { name: "Method", fieldType: "short_text" });

    // Revise extraction values linking ev1 and ev2
    await services.reviseExtractionValue(projectId, paperA.id, field1.id, { value: 42, evidenceIds: [ev1.id] });
    await services.reviseExtractionValue(projectId, paperB.id, field1.id, { value: 84, evidenceIds: [ev2.id] });
    await services.reviseExtractionValue(projectId, paperA.id, field2.id, { value: "RCT", evidenceIds: [ev1.id] });

    // Create Evidence Set with only ev1 initially
    const set = (await services.createEvidenceSet(projectId, { name: "Evidence Set 1" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: ev1.id });

    // Field listing for set should find both fields (ev1 connects to field1 and field2)
    const fields = await services.listEvidenceSetSynthesisFields(projectId, set.id);
    expect(fields).toHaveLength(2);
    const field1Summary = fields.find((f) => f.field.id === field1.id);
    expect(field1Summary?.candidateRevisionCount).toBe(1);
    expect(field1Summary?.candidatePaperCount).toBe(1);

    // Add ev2 to Evidence Set
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: ev2.id });
    const updatedFields = await services.listEvidenceSetSynthesisFields(projectId, set.id);
    const updatedField1 = updatedFields.find((f) => f.field.id === field1.id);
    expect(updatedField1?.candidateRevisionCount).toBe(2);
    expect(updatedField1?.candidatePaperCount).toBe(2);
  });

  it("creates a synthesis preparation and pins the current composition revision", async () => {
    const paper = await includedPaper("Study");
    const ev = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Passage", pageNumber: 1 });
    const field = await services.createExtractionField(projectId, { name: "Outcome", fieldType: "short_text" });
    await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Positive", evidenceIds: [ev.id] });

    const set = (await services.createEvidenceSet(projectId, { name: "Pinned Set" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: ev.id });

    const prep = await services.createSynthesisPreparation(projectId, {
      evidenceSetId: set.id,
      extractionFieldId: field.id,
      workingTitle: "Initial Synthesis Prep",
      workingNote: "Comparing outcomes",
    });

    expect(prep.status).toBe("active");
    expect(prep.workingTitle).toBe("Initial Synthesis Prep");
    expect(prep.targetSynthesisStatementId).toBeNull();

    // Check workspace
    const workspace = await services.getSynthesisPreparationWorkspace(projectId, prep.id);
    expect(workspace.sourceSetChanged).toBe(false);
    expect(workspace.candidates).toHaveLength(1);
    expect(workspace.candidates[0].selected).toBe(false);
    expect(workspace.candidates[0].selectable).toBe(true);

    // Add another item to Evidence Set to create composition drift
    const evNew = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "New passage", pageNumber: 2 });
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: evNew.id });

    // Preparation pinned sequence has not changed, but sourceSetChanged is now true
    const driftedWorkspace = await services.getSynthesisPreparationWorkspace(projectId, prep.id);
    expect(driftedWorkspace.sourceSetChanged).toBe(true);
    expect(driftedWorkspace.pinnedCompositionSequence).toBe(workspace.pinnedCompositionSequence);
    expect(driftedWorkspace.latestCompositionSequence).toBeGreaterThan(driftedWorkspace.pinnedCompositionSequence);
  });

  it("manages selections, enforcing Approved Correction 3 isolation", async () => {
    const paperA = await includedPaper("Alpha");
    const paperB = await includedPaper("Beta");
    const evA = await services.recordEvidence(projectId, { paperId: paperA.id, sourceText: "Text A", pageNumber: 1 });
    const evB = await services.recordEvidence(projectId, { paperId: paperB.id, sourceText: "Text B", pageNumber: 1 });
    const field = await services.createExtractionField(projectId, { name: "Result", fieldType: "short_text" });
    const otherField = await services.createExtractionField(projectId, { name: "Other", fieldType: "short_text" });

    const revA = await services.reviseExtractionValue(projectId, paperA.id, field.id, { value: "Val A", evidenceIds: [evA.id] });
    const revB = await services.reviseExtractionValue(projectId, paperB.id, field.id, { value: "Val B", evidenceIds: [evB.id] });
    const revOther = await services.reviseExtractionValue(projectId, paperA.id, otherField.id, { value: "Other Val", evidenceIds: [evA.id] });

    const set = (await services.createEvidenceSet(projectId, { name: "Selection Set" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: evA.id });
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: evB.id });

    const prep = await services.createSynthesisPreparation(projectId, {
      evidenceSetId: set.id,
      extractionFieldId: field.id,
    });

    // 1. Select revA
    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [revA.id],
    });

    let ws = await services.getSynthesisPreparationWorkspace(projectId, prep.id);
    expect(ws.selectedCount).toBe(1);
    expect(ws.candidates.find((c) => c.extractionRevision.id === revA.id)?.selected).toBe(true);

    // 2. Reject adding candidate from a different extraction field
    await expect(
      services.replaceSynthesisPreparationSelections(projectId, prep.id, {
        extractionRevisionIds: [revA.id, revOther.id],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // 3. Reject adding unreachable candidate (not in pinned set)
    const paperUnreachable = await includedPaper("Gamma");
    const evUnreachable = await services.recordEvidence(projectId, { paperId: paperUnreachable.id, sourceText: "Unreachable", pageNumber: 1 });
    const revUnreachable = await services.reviseExtractionValue(projectId, paperUnreachable.id, field.id, { value: "Unreachable Val", evidenceIds: [evUnreachable.id] });

    await expect(
      services.replaceSynthesisPreparationSelections(projectId, prep.id, {
        extractionRevisionIds: [revA.id, revUnreachable.id],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // 4. Approved Correction 3:
    // If an existing selection drifts (e.g. revA value cleared), keeping revA unchanged in a new selection update must be permitted!
    await services.reviseExtractionValue(projectId, paperA.id, field.id, { state: "cleared", researcherNote: "Cleared" });

    // revA is now cleared. Desired list contains [revA.id, revB.id].
    // Since revA was already selected, it is UNCHANGED. Only revB is ADDED (and revB is eligible).
    // This MUST SUCCEED because replaceSynthesisPreparationSelections only validates newly added IDs!
    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [revA.id, revB.id],
    });

    ws = await services.getSynthesisPreparationWorkspace(projectId, prep.id);
    expect(ws.selectedCount).toBe(2);

    // 5. Removing the ineligible selection revA must also succeed
    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [revB.id],
    });
    ws = await services.getSynthesisPreparationWorkspace(projectId, prep.id);
    expect(ws.selectedCount).toBe(1);
    expect(ws.candidates.find((c) => c.extractionRevision.id === revB.id)?.selected).toBe(true);
  });

  it("finalizes a synthesis preparation to a new statement with exact supports", async () => {
    const paper = await includedPaper("Paper 1");
    const ev = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Text", pageNumber: 1 });
    const field = await services.createExtractionField(projectId, { name: "Theme", fieldType: "short_text" });
    const rev = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Theme A", evidenceIds: [ev.id] });

    const set = (await services.createEvidenceSet(projectId, { name: "Set 1" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: ev.id });

    const prep = await services.createSynthesisPreparation(projectId, {
      evidenceSetId: set.id,
      extractionFieldId: field.id,
      workingTitle: "Draft Synthesis Title",
      workingNote: "Working note",
    });

    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [rev.id],
    });

    // Finalize
    const finalized = await services.finalizeSynthesisPreparation(projectId, prep.id, {
      title: "Final Synthesis Title",
      statementText: "Final statement text derived from preparation",
      researcherNote: "Final note",
    });

    expect(finalized.preparation.status).toBe("finalized");
    expect(finalized.preparation.finalizedSynthesisRevisionId).toBe(finalized.revision.id);
    expect(finalized.preparation.targetSynthesisStatementId).toBe(finalized.statement.id);
    expect(finalized.revision.statementText).toBe("Final statement text derived from preparation");

    // Terminal freeze: Cannot update or change selections
    await expect(
      services.updateSynthesisPreparation(projectId, prep.id, { workingTitle: "Modified" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(
      services.replaceSynthesisPreparationSelections(projectId, prep.id, { extractionRevisionIds: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Approved Correction 4: Exact revision context
    const context = await services.getSynthesisPreparationContextForRevision(projectId, finalized.revision.id);
    expect(context).not.toBeNull();
    expect(context?.preparationId).toBe(prep.id);
    expect(context?.evidenceSetId).toBe(set.id);
    expect(context?.evidenceSetName).toBe("Set 1");

    // A subsequent direct revision on the statement without preparation does NOT have preparation context
    const directRevised = await services.reviseSynthesisStatement(projectId, finalized.statement.id, {
      statementText: "Direct revision on statement",
      extractionRevisionIds: [rev.id],
    });
    const directContext = await services.getSynthesisPreparationContextForRevision(projectId, directRevised.revision.id);
    expect(directContext).toBeNull();
  });

  it("finalizes a synthesis preparation to an existing withdrawn statement, reactivating it", async () => {
    const paper = await includedPaper("Paper 2");
    const ev = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Text 2", pageNumber: 1 });
    const field = await services.createExtractionField(projectId, { name: "Theme 2", fieldType: "short_text" });
    const rev = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Theme 2 Val", evidenceIds: [ev.id] });

    // Create an existing statement and withdraw it
    const stmt = await services.createSynthesisStatement(projectId, {
      statementText: "Statement to withdraw",
      extractionRevisionIds: [rev.id],
    });
    await services.withdrawSynthesisStatement(projectId, stmt.statement.id);

    const set = (await services.createEvidenceSet(projectId, { name: "Set 2" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: ev.id });

    // Create preparation targeted to existing withdrawn statement
    const prep = await services.createSynthesisPreparation(projectId, {
      evidenceSetId: set.id,
      extractionFieldId: field.id,
    });
    await services.updateSynthesisPreparation(projectId, prep.id, {
      targetSynthesisStatementId: stmt.statement.id,
    });
    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [rev.id],
    });

    // Finalize preparation to reactivate the statement
    const finalized = await services.finalizeSynthesisPreparation(projectId, prep.id, {
      statementText: "Reactivated through preparation",
    });

    expect(finalized.statement.id).toBe(stmt.statement.id);
    expect(finalized.revision.state).toBe("active");
    expect(finalized.revision.statementText).toBe("Reactivated through preparation");

    const current = await services.getCurrentSynthesis(projectId, stmt.statement.id);
    expect(current?.state).toBe("active");
    expect(current?.statementText).toBe("Reactivated through preparation");
  });

  it("allows zero-support finalization per Slice 4", async () => {
    const paper = await includedPaper("Paper Zero");
    const ev = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Zero support", pageNumber: 1 });
    const field = await services.createExtractionField(projectId, { name: "Theme Zero", fieldType: "short_text" });

    const set = (await services.createEvidenceSet(projectId, { name: "Zero Set" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: ev.id });

    const prep = await services.createSynthesisPreparation(projectId, {
      evidenceSetId: set.id,
      extractionFieldId: field.id,
    });

    // 0 selections made, finalize
    const finalized = await services.finalizeSynthesisPreparation(projectId, prep.id, {
      statementText: "Zero support finalized synthesis",
    });

    expect(finalized.preparation.status).toBe("finalized");
    expect(finalized.revision.statementText).toBe("Zero support finalized synthesis");

    const current = await services.getCurrentSynthesis(projectId, finalized.statement.id);
    expect(current?.supportStatus).toBe("unsupported");
    expect(current?.supportingRevisionCount).toBe(0);
  });

  it("abandons an active synthesis preparation and freezes it", async () => {
    const paper = await includedPaper("Paper Abandon");
    const ev = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Abandon text", pageNumber: 1 });
    const field = await services.createExtractionField(projectId, { name: "Field Abandon", fieldType: "short_text" });

    const set = (await services.createEvidenceSet(projectId, { name: "Abandon Set" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: ev.id });

    const prep = await services.createSynthesisPreparation(projectId, {
      evidenceSetId: set.id,
      extractionFieldId: field.id,
    });

    const abandoned = await services.abandonSynthesisPreparation(projectId, prep.id);
    expect(abandoned.status).toBe("abandoned");
    expect(abandoned.abandonedAt).not.toBeNull();

    // Terminal: cannot be abandoned again or finalized or updated
    await expect(services.abandonSynthesisPreparation(projectId, prep.id)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      services.finalizeSynthesisPreparation(projectId, prep.id, { statementText: "Will fail" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("database enforces deferred bidirectional support-set equality invariant on preparation finalization", async () => {
    const paperA = await includedPaper("Direct SQL Paper A");
    const paperB = await includedPaper("Direct SQL Paper B");

    const evA = await services.recordEvidence(projectId, { paperId: paperA.id, sourceText: "Passage A", pageNumber: 1 });
    const evB = await services.recordEvidence(projectId, { paperId: paperB.id, sourceText: "Passage B", pageNumber: 2 });

    const field = await services.createExtractionField(projectId, { name: "Direct SQL Field", fieldType: "short_text" });
    const revA = await services.reviseExtractionValue(projectId, paperA.id, field.id, { value: "Val A", evidenceIds: [evA.id] });
    const revB = await services.reviseExtractionValue(projectId, paperB.id, field.id, { value: "Val B", evidenceIds: [evB.id] });

    const set = (await services.createEvidenceSet(projectId, { name: "Direct SQL Set" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: evA.id });
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: evB.id });

    // Helper to create an active statement revision with given supports
    async function createStatementWithSupports(supportIds: string[]) {
      const stmt = await services.createSynthesisStatement(projectId, {
        statementText: `Statement supporting [${supportIds.join(", ")}]`,
        extractionRevisionIds: supportIds,
      });
      return stmt;
    }

    // Helper to create an active preparation with given selections
    async function createPreparationWithSelections(selectionIds: string[]) {
      const prep = await services.createSynthesisPreparation(projectId, {
        evidenceSetId: set.id,
        extractionFieldId: field.id,
      });
      if (selectionIds.length > 0) {
        await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
          extractionRevisionIds: selectionIds,
        });
      }
      return prep;
    }

    // Helper to attempt finalizing via direct SQL inside a transaction so deferred triggers run at commit
    async function tryDirectSqlFinalize(prepId: string, statementId: string, revisionId: string) {
      await client.begin(async (sqlTx) => {
        await sqlTx`
          UPDATE synthesis_preparations
          SET status = 'finalized',
              target_synthesis_statement_id = ${statementId},
              finalized_synthesis_revision_id = ${revisionId},
              finalized_at = now(),
              updated_at = now()
          WHERE project_id = ${projectId} AND id = ${prepId}
        `;
      });
    }

    // 1. Preparation has {A} but linked revision supports {A, B} -> fails
    {
      const stmt = await createStatementWithSupports([revA.id, revB.id]);
      const prep = await createPreparationWithSelections([revA.id]);
      await expect(tryDirectSqlFinalize(prep.id, stmt.statement.id, stmt.revision.id)).rejects.toThrow();
    }

    // 2. Preparation has {A, B} but linked revision supports {A} -> fails
    {
      const stmt = await createStatementWithSupports([revA.id]);
      const prep = await createPreparationWithSelections([revA.id, revB.id]);
      await expect(tryDirectSqlFinalize(prep.id, stmt.statement.id, stmt.revision.id)).rejects.toThrow();
    }

    // 3. Preparation has {A} but linked revision supports {B} -> fails
    {
      const stmt = await createStatementWithSupports([revB.id]);
      const prep = await createPreparationWithSelections([revA.id]);
      await expect(tryDirectSqlFinalize(prep.id, stmt.statement.id, stmt.revision.id)).rejects.toThrow();
    }

    // 4. Both sets empty -> valid
    {
      const stmt = await createStatementWithSupports([]);
      const prep = await createPreparationWithSelections([]);
      await expect(tryDirectSqlFinalize(prep.id, stmt.statement.id, stmt.revision.id)).resolves.not.toThrow();
    }

    // 5. Exact multi-support equality {A, B} -> valid
    {
      const stmt = await createStatementWithSupports([revA.id, revB.id]);
      const prep = await createPreparationWithSelections([revA.id, revB.id]);
      await expect(tryDirectSqlFinalize(prep.id, stmt.statement.id, stmt.revision.id)).resolves.not.toThrow();
    }
  });

  it("attaches preparation context strictly to exact finalized revision and not generally to the stable statement", async () => {
    const paper = await includedPaper("Paper Lifecycle");
    const ev = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Passage Lifecycle", pageNumber: 1 });
    const field = await services.createExtractionField(projectId, { name: "Field Lifecycle", fieldType: "short_text" });
    const rev = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Val Lifecycle", evidenceIds: [ev.id] });

    const set = (await services.createEvidenceSet(projectId, { name: "Lifecycle Set" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: ev.id });

    // 1. Create preparation and finalize -> creates Revision 1 on Statement S
    const prep = await services.createSynthesisPreparation(projectId, {
      evidenceSetId: set.id,
      extractionFieldId: field.id,
      workingTitle: "Statement S",
    });
    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [rev.id],
    });
    const finalized = await services.finalizeSynthesisPreparation(projectId, prep.id, {
      statementText: "Revision 1 text",
    });

    const rev1Id = finalized.revision.id;
    const stmtId = finalized.statement.id;

    // Check Revision 1 has preparation context
    const rev1Context = await services.getSynthesisPreparationContextForRevision(projectId, rev1Id);
    expect(rev1Context).not.toBeNull();
    expect(rev1Context?.preparationId).toBe(prep.id);
    expect(rev1Context?.evidenceSetId).toBe(set.id);
    expect(rev1Context?.evidenceSetName).toBe("Lifecycle Set");

    // Current synthesis of Statement S is Revision 1, so resolving current revision context yields Prep P
    const current1 = await services.getCurrentSynthesis(projectId, stmtId);
    expect(current1?.id).toBe(rev1Id);
    const current1Context = await services.getSynthesisPreparationContextForRevision(projectId, current1!.id);
    expect(current1Context?.preparationId).toBe(prep.id);

    // 2. Revision 2 later created normally (without preparation)
    const revised = await services.reviseSynthesisStatement(projectId, stmtId, {
      statementText: "Revision 2 text created normally",
      extractionRevisionIds: [rev.id],
    });
    const rev2Id = revised.revision.id;

    // Revision 2 does not claim Preparation P
    const rev2Context = await services.getSynthesisPreparationContextForRevision(projectId, rev2Id);
    expect(rev2Context).toBeNull();

    // The current synthesis is now Revision 2, so the statement is NOT globally described as prepared from P
    const current2 = await services.getCurrentSynthesis(projectId, stmtId);
    expect(current2?.id).toBe(rev2Id);
    const current2Context = await services.getSynthesisPreparationContextForRevision(projectId, current2!.id);
    expect(current2Context).toBeNull();

    // In history, Revision 1 still retains its preparation context
    const historyRev1Context = await services.getSynthesisPreparationContextForRevision(projectId, rev1Id);
    expect(historyRev1Context?.preparationId).toBe(prep.id);

    // Confirm that table synthesis_revisions does not have any preparation columns
    const [revRow] = (await client.unsafe(
      `SELECT * FROM synthesis_revisions WHERE id = '${rev1Id}'`
    )) as Array<Record<string, unknown>>;
    expect(revRow).toBeDefined();
    expect(revRow.evidence_set_id).toBeUndefined();
    expect(revRow.synthesis_preparation_id).toBeUndefined();
  });

  it("verifies drift-tolerant selection replacement when an existing selection becomes ineligible", async () => {
    const paperA = await includedPaper("Paper Drift A");
    const paperB = await includedPaper("Paper Drift B");
    const paperC = await includedPaper("Paper Drift C");

    const evA = await services.recordEvidence(projectId, { paperId: paperA.id, sourceText: "Passage Drift A", pageNumber: 1 });
    const evB = await services.recordEvidence(projectId, { paperId: paperB.id, sourceText: "Passage Drift B", pageNumber: 2 });
    const evC = await services.recordEvidence(projectId, { paperId: paperC.id, sourceText: "Passage Drift C", pageNumber: 3 });

    const field = await services.createExtractionField(projectId, { name: "Drift Field", fieldType: "short_text" });
    const revA = await services.reviseExtractionValue(projectId, paperA.id, field.id, { value: "Val A", evidenceIds: [evA.id] });
    const revB = await services.reviseExtractionValue(projectId, paperB.id, field.id, { value: "Val B", evidenceIds: [evB.id] });
    const revC = await services.reviseExtractionValue(projectId, paperC.id, field.id, { value: "Val C", evidenceIds: [evC.id] });

    const set = (await services.createEvidenceSet(projectId, { name: "Drift Set" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: evA.id });
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: evB.id });
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: evC.id });

    const prep = await services.createSynthesisPreparation(projectId, {
      evidenceSetId: set.id,
      extractionFieldId: field.id,
    });

    // 1. Initial selections: {A, B}
    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [revA.id, revB.id],
    });
    let ws = await services.getSynthesisPreparationWorkspace(projectId, prep.id);
    const criterion = await services.createScreeningCriterion(projectId, { type: "exclusion", text: "Out of scope" });

    // 2. Paper B becomes ineligible (e.g. excluded in screening)
    await services.recordScreeningDecision(projectId, paperB.id, { decision: "exclude", exclusionCriterionId: criterion.id });

    // Verify: desired {A, B} succeeds because unchanged existing selections are not re-validated
    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [revA.id, revB.id],
    });
    ws = await services.getSynthesisPreparationWorkspace(projectId, prep.id);
    expect(ws.selectedCount).toBe(2);

    // Verify: desired {A} succeeds (removing B)
    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [revA.id],
    });
    ws = await services.getSynthesisPreparationWorkspace(projectId, prep.id);
    expect(ws.selectedCount).toBe(1);

    // Re-add B by temporarily including B, adding B, then re-excluding B
    await services.recordScreeningDecision(projectId, paperB.id, { decision: "include" });
    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [revA.id, revB.id],
    });
    await services.recordScreeningDecision(projectId, paperB.id, { decision: "exclude", exclusionCriterionId: criterion.id });

    // Verify: desired {A, B, C} validates only C (and C is eligible, so it succeeds)
    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [revA.id, revB.id, revC.id],
    });
    ws = await services.getSynthesisPreparationWorkspace(projectId, prep.id);
    expect(ws.selectedCount).toBe(3);

    // Verify: finalization with still-ineligible B fails in the canonical shared writer!
    await expect(
      services.finalizeSynthesisPreparation(projectId, prep.id, {
        statementText: "Statement with ineligible support",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("New synthesis support is limited to currently finally included papers"),
    });

    // Removing B so selections are {A, C} allows finalization to succeed
    await services.replaceSynthesisPreparationSelections(projectId, prep.id, {
      extractionRevisionIds: [revA.id, revC.id],
    });
    const finalized = await services.finalizeSynthesisPreparation(projectId, prep.id, {
      statementText: "Finalized without ineligible B",
    });
    expect(finalized.preparation.status).toBe("finalized");
    expect(finalized.revision.statementText).toBe("Finalized without ineligible B");
  });
});