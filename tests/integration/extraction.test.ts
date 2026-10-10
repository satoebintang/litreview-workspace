import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createExtractionReadServices } from "@/application/extraction-read-services";
import { parseExtractionValueFormData } from "@/app/extraction-form-state";
import { extractionRevisionEvidence, extractionValueRevisions } from "@/db/schema";
import {
  completeWhileLockHeld,
  createLockRaceCoordinator,
  holdTransaction,
  lockTimeoutUrl,
  waitForBlockedSessions,
  type LockRaceCoordinator,
} from "./extraction-lock-race-helpers";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const { db, client } = createDb(databaseUrl);
const services = createReviewServices(db);
const extractionReads = createExtractionReadServices(db);
let projectId = "";
let raceConnection: ReturnType<typeof createDb> | undefined;
let raceServices: ReturnType<typeof createReviewServices>;
let locks: LockRaceCoordinator;

describe("Slice 3 extraction provenance", () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: "./drizzle" });
    raceConnection = createDb(lockTimeoutUrl(databaseUrl));
    raceServices = createReviewServices(raceConnection.db);
    locks = createLockRaceCoordinator(databaseUrl);
  });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Extraction project ${crypto.randomUUID()}` })).id; });
  afterAll(async () => {
    await raceConnection?.client.end();
    await locks?.close();
    await client.unsafe(`TRUNCATE TABLE doi_lookup_resolutions, doi_lookup_dispatches, bibliographic_metadata_result_authors, bibliographic_metadata_http_attempts, bibliographic_metadata_fetch_results, bibliographic_metadata_fetches, doi_lookup_requests, pdf_intake_resolutions, pdf_intake_metadata_fields, pdf_intake_metadata_results, pdf_intakes, bibliographic_import_resolutions, bibliographic_import_records, bibliographic_imports, ai_synthesis_decisions, ai_synthesis_result_groundings, ai_synthesis_results, ai_synthesis_dispatches, ai_synthesis_request_sources, ai_synthesis_request_supports, ai_synthesis_requests, ai_extraction_batch_items, ai_extraction_batches, ai_extraction_decision_evidence, ai_extraction_decisions, ai_extraction_result_groundings, ai_extraction_results, ai_extraction_dispatches, ai_extraction_request_pages, ai_extraction_requests, manuscript_snapshot_warnings, manuscript_snapshot_claim_bibliography_members, manuscript_snapshot_bibliography_entries, manuscript_snapshot_claim_items, manuscript_snapshot_prose_items, manuscript_snapshot_items, manuscript_snapshot_sections, manuscript_snapshots, research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_extraction_field_events, research_question_evidence_set_events, research_question_synthesis_statement_events, research_question_claim_events, synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_review_events, manuscript_review_threads, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_revisions, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_set_membership_order_versions, evidence_set_paper_member_counts, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, evidence_label_events, evidence_annotations, appraisal_revision_response_evidence, appraisal_revision_responses, appraisal_revisions, appraisals, appraisal_framework_overall_judgement_options, appraisal_framework_response_options, appraisal_framework_items, appraisal_framework_sections, appraisal_framework_versions, appraisal_frameworks, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects`);
    await client.end();
  });

  async function includedPaper() {
    const paper = await services.addPaper(projectId, { title: "Study" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    return paper;
  }

  async function finishHeld(held: Awaited<ReturnType<typeof holdTransaction>>) {
    held.release();
    await held.transaction;
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

  it("rejects duplicate Evidence IDs without appending a revision or changing current supports", async () => {
    const paper = await includedPaper();
    const field = await services.createExtractionField(projectId, { name: "Duplicate support guard", fieldType: "short_text" });
    const originalEvidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Original support", pageNumber: 1 });
    const duplicateEvidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Duplicate candidate", pageNumber: 2 });
    await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Original value", evidenceIds: [originalEvidence.id] });
    const before = await services.getExtractionValueHistory(projectId, paper.id, field.id);

    await expect(services.reviseExtractionValue(projectId, paper.id, field.id, {
      value: "Must not be written",
      evidenceIds: [duplicateEvidence.id, duplicateEvidence.id],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(await services.getExtractionValueHistory(projectId, paper.id, field.id)).toEqual(before);
    expect(await client`select count(*)::int as count from extraction_value_revisions where project_id=${projectId}::uuid and paper_id=${paper.id}::uuid and field_id=${field.id}::uuid`).toEqual([{ count: 1 }]);
    expect(await client`select evidence_id::text as evidence_id from extraction_revision_evidence where project_id=${projectId}::uuid and revision_id=${before[0]!.id}::uuid`).toEqual([{ evidence_id: originalEvidence.id }]);
  });

  it("serializes concurrent field appends on the Project row", async () => {
    const held = await holdTransaction(locks.blocker, (tx) => tx`select id from projects where id=${projectId}::uuid for update`.then(() => undefined));
    try {
      const creates = [
        raceServices.createExtractionField(projectId, { name: "First concurrent field", fieldType: "short_text" }),
        raceServices.createExtractionField(projectId, { name: "Second concurrent field", fieldType: "short_text" }),
      ];
      await waitForBlockedSessions(locks.observer, held.pid, 2, "projects");
      await finishHeld(held);
      const fields = await Promise.all(creates);
      expect(fields.map((field) => field.sortOrder).sort((left, right) => left - right)).toEqual([0, 1]);
    } finally {
      await finishHeld(held);
    }
  });

  it("serializes concurrent option appends on their Field row", async () => {
    const field = await raceServices.createExtractionField(projectId, { name: "Concurrent choices", fieldType: "single_select" });
    const held = await holdTransaction(locks.blocker, (tx) => tx`select id from extraction_fields where project_id=${projectId}::uuid and id=${field.id}::uuid for update`.then(() => undefined));
    try {
      const creates = [
        raceServices.createExtractionOption(projectId, { fieldId: field.id, label: "First concurrent option" }),
        raceServices.createExtractionOption(projectId, { fieldId: field.id, label: "Second concurrent option" }),
      ];
      await waitForBlockedSessions(locks.observer, held.pid, 2, "extraction_fields");
      await finishHeld(held);
      const options = await Promise.all(creates);
      expect(options.map((option) => option.sortOrder).sort((left, right) => left - right)).toEqual([0, 1]);
    } finally {
      await finishHeld(held);
    }
  });

  it("creates options for different Fields while the Project lock is held", async () => {
    const fields = await Promise.all([
      raceServices.createExtractionField(projectId, { name: "Independent A", fieldType: "single_select" }),
      raceServices.createExtractionField(projectId, { name: "Independent B", fieldType: "single_select" }),
    ]);
    const held = await holdTransaction(locks.blocker, (tx) => tx`select id from projects where id=${projectId}::uuid for update`.then(() => undefined));
    try {
      const optionsPromise = Promise.all(fields.map((field) => raceServices.createExtractionOption(projectId, { fieldId: field.id, label: "Independent option" })));
      const options = await completeWhileLockHeld(optionsPromise);
      expect(options.map((option) => option.sortOrder)).toEqual([0, 0]);
    } finally {
      await finishHeld(held);
    }
  });

  it("waits for Field archive before rejecting an ordinary revision", async () => {
    const paper = await includedPaper();
    const field = await raceServices.createExtractionField(projectId, { name: "Archived during write", fieldType: "short_text" });
    const held = await holdTransaction(locks.blocker, (tx) => tx`update extraction_fields set archived_at=now() where project_id=${projectId}::uuid and id=${field.id}::uuid returning id`.then(() => undefined));
    try {
      const revision = raceServices.reviseExtractionValue(projectId, paper.id, field.id, { value: "must not be written", evidenceIds: [] });
      await waitForBlockedSessions(locks.observer, held.pid, 1, "extraction_fields");
      await finishHeld(held);
      await expect(revision).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await client`select count(*)::int as count from extraction_value_revisions where project_id=${projectId}::uuid and paper_id=${paper.id}::uuid and field_id=${field.id}::uuid`).toEqual([{ count: 0 }]);
    } finally {
      await finishHeld(held);
    }
  });

  it("waits for Option archive before rejecting an ordinary revision", async () => {
    const paper = await includedPaper();
    const field = await raceServices.createExtractionField(projectId, { name: "Choice during write", fieldType: "single_select" });
    const option = await raceServices.createExtractionOption(projectId, { fieldId: field.id, label: "Archived choice" });
    const held = await holdTransaction(locks.blocker, (tx) => tx`update extraction_options set archived_at=now() where project_id=${projectId}::uuid and id=${option.id}::uuid returning id`.then(() => undefined));
    try {
      const revision = raceServices.reviseExtractionValue(projectId, paper.id, field.id, { value: option.id, evidenceIds: [] });
      await waitForBlockedSessions(locks.observer, held.pid, 1, "extraction_options");
      await finishHeld(held);
      await expect(revision).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
      expect(await client`select count(*)::int as count from extraction_value_revisions where project_id=${projectId}::uuid and paper_id=${paper.id}::uuid and field_id=${field.id}::uuid`).toEqual([{ count: 0 }]);
    } finally {
      await finishHeld(held);
    }
  });

  it("lets a locked Field definition update finish before the first analytical use", async () => {
    const paper = await includedPaper();
    const field = await raceServices.createExtractionField(projectId, { name: "Before first use", fieldType: "short_text" });
    const held = await holdTransaction(locks.blocker, (tx) => tx`select id from papers where project_id=${projectId}::uuid and id=${paper.id}::uuid for update`.then(() => undefined));
    try {
      const revision = raceServices.reviseExtractionValue(projectId, paper.id, field.id, { value: "after update", evidenceIds: [] });
      await waitForBlockedSessions(locks.observer, held.pid, 1, "papers");
      const updated = await raceServices.updateExtractionField(projectId, field.id, { name: "After first use" });
      expect(updated.name).toBe("After first use");
      await finishHeld(held);
      await expect(revision).resolves.toMatchObject({ field_id: field.id, text_value: "after update" });
    } finally {
      await finishHeld(held);
    }
  });

  it("lets a first revision lock the Field before definition update", async () => {
    const paper = await includedPaper();
    const field = await raceServices.createExtractionField(projectId, { name: "First use wins", fieldType: "short_text" });
    const held = await holdTransaction(locks.blocker, async (tx) => {
      await tx`lock table extraction_values in share mode`;
    });
    try {
      const revision = raceServices.reviseExtractionValue(projectId, paper.id, field.id, { value: "first use", evidenceIds: [] });
      const writerPid = (await waitForBlockedSessions(locks.observer, held.pid, 1, "insert into extraction_values"))[0];
      const update = raceServices.updateExtractionField(projectId, field.id, { name: "Too late" });
      await waitForBlockedSessions(locks.observer, writerPid, 1, "extraction_fields");
      await finishHeld(held);
      await expect(revision).resolves.toMatchObject({ field_id: field.id, text_value: "first use" });
      await expect(update).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await services.getExtractionValueHistory(projectId, paper.id, field.id)).toHaveLength(1);
    } finally {
      await finishHeld(held);
    }
  });

  it("serializes Field archive behind an Option create already holding that Field", async () => {
    const field = await raceServices.createExtractionField(projectId, { name: "Archive with option create", fieldType: "single_select" });
    const held = await holdTransaction(locks.blocker, async (tx) => {
      await tx`lock table extraction_options in share mode`;
    });
    try {
      const optionPromise = raceServices.createExtractionOption(projectId, { fieldId: field.id, label: "Created before archive" });
      const creatorPid = (await waitForBlockedSessions(locks.observer, held.pid, 1, "insert into extraction_options"))[0];
      const archivePromise = raceServices.archiveExtractionField(projectId, field.id);
      await waitForBlockedSessions(locks.observer, creatorPid, 1, "extraction_fields");
      await finishHeld(held);
      const [option, archived] = await Promise.all([optionPromise, archivePromise]);
      expect(option.sortOrder).toBe(0);
      expect(archived.archivedAt).toBeInstanceOf(Date);
      expect((await raceServices.listExtractionOptions(projectId, field.id, true)).map((item) => item.id)).toEqual([option.id]);
    } finally {
      await finishHeld(held);
    }
  });

  it("preserves researcher notes for not_reported and not_applicable through FormData parse to worksheet and exact history read paths while clearing notes for cleared", async () => {
    const paper = await includedPaper();
    const field = await services.createExtractionField(projectId, { name: "Methodology limitation", fieldType: "short_text" });
    const evidenceA = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Passage A explaining missing metric", pageNumber: 3 });
    const evidenceB = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "Passage B confirming omission", pageNumber: 4 });

    // Step 1: not_reported with researcher note and multiple Evidence IDs
    const notReportedForm = new FormData();
    notReportedForm.set("state", "not_reported");
    notReportedForm.set("researcherNote", "  Metric was not reported in results section  ");
    notReportedForm.append("evidenceIds", evidenceA.id);
    notReportedForm.append("evidenceIds", evidenceB.id);

    const parsedNotReported = parseExtractionValueFormData(notReportedForm);
    expect(parsedNotReported).toEqual({
      state: "not_reported",
      researcherNote: "Metric was not reported in results section",
      evidenceIds: [evidenceA.id, evidenceB.id],
    });

    const finalizedNotReported = await services.reviseExtractionValue(projectId, paper.id, field.id, parsedNotReported);
    expect(finalizedNotReported).toMatchObject({
      value_state: "not_reported",
      researcher_note: "Metric was not reported in results section",
    });

    const evidenceLinks = await client`select evidence_id::text as id from extraction_revision_evidence where project_id=${projectId}::uuid and revision_id=${finalizedNotReported.id}::uuid`;
    expect(evidenceLinks.map((item) => item.id).sort()).toEqual([evidenceA.id, evidenceB.id].sort());

    // Verify raw PostgreSQL row insertion
    const [rawNotReported] = await client`select id, value_state, researcher_note from extraction_value_revisions where project_id=${projectId}::uuid and id=${finalizedNotReported.id}::uuid`;
    expect(rawNotReported.value_state).toBe("not_reported");
    expect(rawNotReported.researcher_note).toBe("Metric was not reported in results section");

    // Verify current worksheet projection
    const worksheetAfterNotReported = await extractionReads.getPaperExtractionWorksheet(projectId, paper.id);
    const notReportedValue = worksheetAfterNotReported.values.find((val) => val.field.id === field.id);
    expect(notReportedValue?.currentRevision?.valueState).toBe("not_reported");
    expect(notReportedValue?.currentRevision?.researcherNote).toBe("Metric was not reported in results section");
    expect(notReportedValue?.supportStatus).toBe("grounded");
    expect(notReportedValue?.currentRevision?.evidence.map((item) => item.id).sort()).toEqual([evidenceA.id, evidenceB.id].sort());

    // Verify exact historical revision read model
    const exactNotReported = await extractionReads.getExtractionRevisionExact(projectId, paper.id, field.id, finalizedNotReported.id);
    expect(exactNotReported.revision.valueState).toBe("not_reported");
    expect(exactNotReported.revision.researcherNote).toBe("Metric was not reported in results section");
    expect(exactNotReported.revision.evidence.map((item) => item.id).sort()).toEqual([evidenceA.id, evidenceB.id].sort());
    expect(exactNotReported.isCurrentRevision).toBe(true);

    // Step 2: not_applicable with researcher note and single Evidence ID
    const notApplicableForm = new FormData();
    notApplicableForm.set("state", "not_applicable");
    notApplicableForm.set("researcherNote", "Field is not applicable to qualitative observational design");
    notApplicableForm.append("evidenceIds", evidenceA.id);

    const parsedNotApplicable = parseExtractionValueFormData(notApplicableForm);
    expect(parsedNotApplicable).toEqual({
      state: "not_applicable",
      researcherNote: "Field is not applicable to qualitative observational design",
      evidenceIds: [evidenceA.id],
    });

    const finalizedNotApplicable = await services.reviseExtractionValue(projectId, paper.id, field.id, parsedNotApplicable);
    expect(finalizedNotApplicable).toMatchObject({
      value_state: "not_applicable",
      researcher_note: "Field is not applicable to qualitative observational design",
    });

    // Verify current worksheet updated to not_applicable
    const worksheetAfterNA = await extractionReads.getPaperExtractionWorksheet(projectId, paper.id);
    const naValue = worksheetAfterNA.values.find((val) => val.field.id === field.id);
    expect(naValue?.currentRevision?.valueState).toBe("not_applicable");
    expect(naValue?.currentRevision?.researcherNote).toBe("Field is not applicable to qualitative observational design");
    expect(naValue?.supportStatus).toBe("grounded");
    expect(naValue?.currentRevision?.evidence.map((item) => item.id)).toEqual([evidenceA.id]);

    // Verify exact historical revision of both revisions (verifying immutability across revisions)
    const exactNA = await extractionReads.getExtractionRevisionExact(projectId, paper.id, field.id, finalizedNotApplicable.id);
    expect(exactNA.revision.valueState).toBe("not_applicable");
    expect(exactNA.revision.researcherNote).toBe("Field is not applicable to qualitative observational design");
    expect(exactNA.revision.evidence.map((item) => item.id)).toEqual([evidenceA.id]);
    expect(exactNA.isCurrentRevision).toBe(true);

    const exactPriorNotReported = await extractionReads.getExtractionRevisionExact(projectId, paper.id, field.id, finalizedNotReported.id);
    expect(exactPriorNotReported.revision.valueState).toBe("not_reported");
    expect(exactPriorNotReported.revision.researcherNote).toBe("Metric was not reported in results section");
    expect(exactPriorNotReported.revision.evidence.map((item) => item.id).sort()).toEqual([evidenceA.id, evidenceB.id].sort());
    expect(exactPriorNotReported.isCurrentRevision).toBe(false);

    // Step 3: cleared with note in FormData -> parser omits note -> persisted revision has null note
    const clearedForm = new FormData();
    clearedForm.set("state", "cleared");
    clearedForm.set("researcherNote", "This note must be omitted on clear");
    clearedForm.append("evidenceIds", evidenceA.id);

    const parsedCleared = parseExtractionValueFormData(clearedForm);
    expect(parsedCleared).toEqual({
      state: "cleared",
      evidenceIds: [evidenceA.id],
    });
    expect(parsedCleared).not.toHaveProperty("researcherNote");

    const finalizedCleared = await services.reviseExtractionValue(projectId, paper.id, field.id, parsedCleared);
    expect(finalizedCleared).toMatchObject({
      value_state: "cleared",
      researcher_note: null,
    });

    // Verify raw PostgreSQL row insertion for cleared
    const [rawCleared] = await client`select id, value_state, researcher_note from extraction_value_revisions where project_id=${projectId}::uuid and id=${finalizedCleared.id}::uuid`;
    expect(rawCleared.value_state).toBe("cleared");
    expect(rawCleared.researcher_note).toBeNull();

    // Verify current worksheet updated to cleared (cleared observation has null researcherNote and ungrounded support)
    const worksheetAfterCleared = await extractionReads.getPaperExtractionWorksheet(projectId, paper.id);
    const clearedValue = worksheetAfterCleared.values.find((val) => val.field.id === field.id);
    expect(clearedValue?.currentRevision?.valueState).toBe("cleared");
    expect(clearedValue?.currentRevision?.researcherNote).toBeNull();
    expect(clearedValue?.supportStatus).toBe("ungrounded");

    // Verify exact historical revision of cleared
    const exactCleared = await extractionReads.getExtractionRevisionExact(projectId, paper.id, field.id, finalizedCleared.id);
    expect(exactCleared.revision.valueState).toBe("cleared");
    expect(exactCleared.revision.researcherNote).toBeNull();
    expect(exactCleared.isCurrentRevision).toBe(true);

    // Verify immutable triggers reject mutation of the non-present revision with note
    await expect(db.update(extractionValueRevisions).set({ researcherNote: "mutated" }).where(eq(extractionValueRevisions.id, finalizedNotReported.id))).rejects.toThrow();

    // Step 4: Duplicate Evidence rejection on non-present state through FormData
    const duplicateEvidenceForm = new FormData();
    duplicateEvidenceForm.set("state", "not_reported");
    duplicateEvidenceForm.set("researcherNote", "duplicate guard");
    duplicateEvidenceForm.append("evidenceIds", evidenceA.id);
    duplicateEvidenceForm.append("evidenceIds", evidenceA.id);
    const parsedDuplicate = parseExtractionValueFormData(duplicateEvidenceForm);
    await expect(services.reviseExtractionValue(projectId, paper.id, field.id, parsedDuplicate)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Step 5: Cross-project Evidence rejection on non-present state through FormData
    const otherProject = await services.createProject({ title: `Foreign project ${crypto.randomUUID()}` });
    const otherPaper = await services.addPaper(otherProject.id, { title: "Foreign Paper" });
    const foreignEvidence = await services.recordEvidence(otherProject.id, { paperId: otherPaper.id, sourceText: "Foreign source", pageNumber: 1 });
    const foreignEvidenceForm = new FormData();
    foreignEvidenceForm.set("state", "not_applicable");
    foreignEvidenceForm.set("researcherNote", "foreign guard");
    foreignEvidenceForm.append("evidenceIds", foreignEvidence.id);
    const parsedForeign = parseExtractionValueFormData(foreignEvidenceForm);
    await expect(services.reviseExtractionValue(projectId, paper.id, field.id, parsedForeign)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
  });
});
