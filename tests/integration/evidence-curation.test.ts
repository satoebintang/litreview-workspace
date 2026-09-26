import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { createDb, type Database } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createEvidenceWorkspaceReadServices } from "@/application/evidence-workspace-read-services";
import { evidence, evidenceLabelEvents, schema } from "@/db/schema";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const { db, client } = createDb(DATABASE_URL);
const services = createReviewServices(db);
const { db: writerDb, client: writerClient } = createDb(DATABASE_URL);
const writerServices = createReviewServices(writerDb);
const lockClient = postgres(DATABASE_URL, { max: 2, prepare: false });
const supportClient = postgres(DATABASE_URL, { max: 1, prepare: false });
let projectId = "";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createCountedEvidenceReads() {
  const selects: string[] = [];
  const queryClient = postgres(DATABASE_URL, {
    max: 1,
    prepare: false,
    debug: (_connection, query) => {
      if (/^\s*(select|with)\b/i.test(query)) selects.push(query);
    },
  });
  return {
    reads: createEvidenceWorkspaceReadServices(drizzle(queryClient, { schema })),
    selects,
    close: () => queryClient.end(),
  };
}

function pauseAfterFirstTransactionExecute(database: Database, afterFirstExecute: () => Promise<void>): Database {
  const originalTransaction = database.transaction.bind(database);
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return (callback: unknown, config?: unknown) => originalTransaction((async (tx: unknown) => {
        let executeCount = 0;
        const pausedTransaction = new Proxy(tx as object, {
          get(inner, key, innerReceiver) {
            const value = Reflect.get(inner, key, innerReceiver);
            if (key === "execute" && typeof value === "function") {
              return async (...args: unknown[]) => {
                const result = await Reflect.apply(value, inner, args);
                executeCount += 1;
                if (executeCount === 1) await afterFirstExecute();
                return result;
              };
            }
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
        return (callback as (transaction: unknown) => unknown)(pausedTransaction);
      }) as never, config as never);
    },
  }) as Database;
}

async function sleep(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("Slice 16 Evidence curation", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => {
    projectId = (await services.createProject({ title: `Evidence curation ${crypto.randomUUID()}` })).id;
  });
  afterAll(async () => {
    await client.unsafe("TRUNCATE TABLE doi_lookup_resolutions, doi_lookup_dispatches, bibliographic_metadata_result_authors, bibliographic_metadata_http_attempts, bibliographic_metadata_fetch_results, bibliographic_metadata_fetches, doi_lookup_requests, pdf_intake_resolutions, pdf_intake_metadata_fields, pdf_intake_metadata_results, pdf_intakes, bibliographic_import_resolutions, bibliographic_import_records, bibliographic_imports, ai_synthesis_decisions, ai_synthesis_result_groundings, ai_synthesis_results, ai_synthesis_dispatches, ai_synthesis_request_sources, ai_synthesis_request_supports, ai_synthesis_requests, ai_extraction_batch_items, ai_extraction_batches, ai_extraction_decision_evidence, ai_extraction_decisions, ai_extraction_result_groundings, ai_extraction_results, ai_extraction_dispatches, ai_extraction_request_pages, ai_extraction_requests, manuscript_snapshot_warnings, manuscript_snapshot_claim_bibliography_members, manuscript_snapshot_bibliography_entries, manuscript_snapshot_claim_items, manuscript_snapshot_prose_items, manuscript_snapshot_items, manuscript_snapshot_sections, manuscript_snapshots, research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_extraction_field_events, research_question_evidence_set_events, research_question_synthesis_statement_events, research_question_claim_events, synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_review_events, manuscript_review_threads, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_revisions, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_set_composition_members, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, evidence_label_events, evidence_annotations, appraisal_revision_response_evidence, appraisal_revision_responses, appraisal_revisions, appraisals, appraisal_framework_overall_judgement_options, appraisal_framework_response_options, appraisal_framework_items, appraisal_framework_sections, appraisal_framework_versions, appraisal_frameworks, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects");
    await Promise.all([lockClient.end(), supportClient.end(), writerClient.end(), client.end()]);
  });

  async function paper() {
    return services.addPaper(projectId, { title: `Study ${crypto.randomUUID()}`, authors: ["Author"] });
  }

  async function includedPaper() {
    const item = await paper();
    await services.recordScreeningDecision(projectId, item.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, item.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(projectId, item.id, { decision: "include" });
    return item;
  }

  async function draftClaim(claimText: string) {
    const claim = await services.createClaim(projectId, { claimText });
    const rows = await client`insert into claim_revisions (project_id, claim_id, state, claim_text) values (${projectId}, ${claim.id}, 'active', ${claimText}) returning id`;
    return { claim, draftRevisionId: String(rows[0].id) };
  }

  it("derives unreviewed state and normalizes append-only review notes and annotations", async () => {
    const item = await paper();
    const itemEvidence = await services.recordEvidence(projectId, { paperId: item.id, sourceText: "Exact passage", pageNumber: 3 });
    expect((await services.getEvidenceReviewState(projectId, itemEvidence.id)).state).toBe("unreviewed");

    const first = await services.appendEvidenceReviewDecision(projectId, itemEvidence.id, { decision: "needs_review", note: "  Needs a closer look  " });
    expect(first.note).toBe("Needs a closer look");
    const blank = await services.appendEvidenceReviewDecision(projectId, itemEvidence.id, { decision: "accepted", note: " \t " });
    expect(blank.note).toBeNull();
    const [directBlank] = await client`insert into evidence_review_decisions (project_id, evidence_id, decision, note) values (${projectId}, ${itemEvidence.id}, 'accepted', ${" \t "}) returning note`;
    expect(directBlank.note).toBeNull();
    const history = await services.listEvidenceReviewHistory(projectId, itemEvidence.id);
    expect(history.map((entry) => entry.decision)).toEqual(["needs_review", "accepted", "accepted"]);

    const annotation = await services.appendEvidenceAnnotation(projectId, itemEvidence.id, { body: "  Verify wording  " });
    expect(annotation.body).toBe("Verify wording");
    const [directAnnotation] = await client`insert into evidence_annotations (project_id, evidence_id, body) values (${projectId}, ${itemEvidence.id}, ${"  Direct SQL wording  "}) returning body`;
    expect(directAnnotation.body).toBe("Direct SQL wording");
    await expect(services.appendEvidenceAnnotation(projectId, itemEvidence.id, { body: " \n\t " })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(services.appendEvidenceReviewDecision(projectId, itemEvidence.id, { decision: "rejected", note: "x".repeat(2001) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await services.getEvidenceCurationDetail(projectId, itemEvidence.id)).warnings).toEqual([]);
  });

  it("serializes label transitions, archives labels, and prevents duplicate/no-op events", async () => {
    const item = await paper();
    const itemEvidence = await services.recordEvidence(projectId, { paperId: item.id, sourceText: "Labelled passage", pageNumber: 2 });
    const label = await services.createEvidenceLabel(projectId, { name: "  Important  ", description: "  Triage  " });
    expect(label.name).toBe("Important");
    expect(label.description).toBe("Triage");
    await expect(services.createEvidenceLabel(projectId, { name: "important" })).rejects.toMatchObject({ code: "DATABASE_CONSTRAINT" });

    const concurrentAssign = await Promise.allSettled([
      services.assignEvidenceLabel(projectId, itemEvidence.id, label.id),
      services.assignEvidenceLabel(projectId, itemEvidence.id, label.id),
    ]);
    expect(concurrentAssign.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await services.listEvidenceLabelHistory(projectId, itemEvidence.id)).filter((event) => event.event === "assigned")).toHaveLength(1);

    const concurrentRemove = await Promise.allSettled([
      services.removeEvidenceLabel(projectId, itemEvidence.id, label.id),
      services.removeEvidenceLabel(projectId, itemEvidence.id, label.id),
    ]);
    expect(concurrentRemove.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await services.getEvidenceCurationDetail(projectId, itemEvidence.id)).labels).toHaveLength(0);

    const assignRemove = await Promise.allSettled([
      services.assignEvidenceLabel(projectId, itemEvidence.id, label.id),
      services.removeEvidenceLabel(projectId, itemEvidence.id, label.id),
    ]);
    expect(assignRemove.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const events = await services.listEvidenceLabelHistory(projectId, itemEvidence.id);
    expect(events.filter((event) => event.event === "assigned").length - events.filter((event) => event.event === "removed").length).toBeGreaterThanOrEqual(0);

    const archived = await services.archiveEvidenceLabel(projectId, label.id);
    expect(archived.archivedAt).not.toBeNull();
    await expect(services.assignEvidenceLabel(projectId, itemEvidence.id, label.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(db.update(evidenceLabelEvents).set({ event: "removed" }).where(sql`project_id=${projectId}`)).rejects.toThrow();
  });

  it("preserves historical support, blocks rejected direct snapshots, and restores eligibility after re-acceptance", async () => {
    const item = await includedPaper();
    const itemEvidence = await services.recordEvidence(projectId, { paperId: item.id, sourceText: "Stable passage", pageNumber: 5 });
    const field = await services.createExtractionField(projectId, { name: "Finding", fieldType: "short_text" });
    const oldExtraction = await services.reviseExtractionValue(projectId, item.id, field.id, { value: "Observed", evidenceIds: [itemEvidence.id] });
    const oldClaim = await services.createClaim(projectId, { claimText: "Historical direct claim" });
    const oldDirect = await services.createClaimRevision(projectId, oldClaim.id, {
      claimText: oldClaim.claimText,
      supports: [{ kind: "evidence", evidenceId: itemEvidence.id }],
      expectedCurrentRevisionId: oldClaim.revision.id,
    });

    await services.appendEvidenceReviewDecision(projectId, itemEvidence.id, { decision: "rejected", note: "Not reliable for new use" });
    expect((await services.getEvidenceReviewState(projectId, itemEvidence.id)).state).toBe("rejected");
    expect((await services.getClaimRevision(projectId, oldClaim.id, oldDirect.revision.id)).revision.supports.evidence).toHaveLength(1);

    const indirectClaim = await services.createClaim(projectId, { claimText: "Indirect historical claim" });
    const indirectRevision = await services.createClaimRevision(projectId, indirectClaim.id, {
      claimText: indirectClaim.claimText,
      supports: [{ kind: "extractionRevision", extractionRevisionId: oldExtraction.id }],
      expectedCurrentRevisionId: indirectClaim.revision.id,
    });
    expect(indirectRevision.revision.supports.extractionRevisions).toHaveLength(1);

    const blockedClaim = await services.createClaim(projectId, { claimText: "Blocked direct claim" });
    await expect(services.createClaimRevision(projectId, blockedClaim.id, {
      claimText: blockedClaim.claimText,
      supports: [{ kind: "evidence", evidenceId: itemEvidence.id }],
      expectedCurrentRevisionId: blockedClaim.revision.id,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(services.reviseExtractionValue(projectId, item.id, field.id, { value: "New observation", evidenceIds: [itemEvidence.id] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const rawBlockedClaim = await draftClaim("Blocked SQL claim");
    await expect(client`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${projectId}, ${rawBlockedClaim.draftRevisionId}, ${itemEvidence.id})`).rejects.toThrow();
    const slotRows = await client`select id from extraction_values where project_id=${projectId} and paper_id=${item.id} and field_id=${field.id}`;
    const draftExtractionRows = await client`insert into extraction_value_revisions (project_id, paper_id, field_id, extraction_value_id, field_type, value_state, text_value) values (${projectId}, ${item.id}, ${field.id}, ${slotRows[0].id}, 'short_text', 'present', 'No direct evidence') returning id`;
    await expect(client`insert into extraction_revision_evidence (project_id, paper_id, revision_id, evidence_id) values (${projectId}, ${item.id}, ${draftExtractionRows[0].id}, ${itemEvidence.id})`).rejects.toThrow();

    expect((await services.listClaimSupportOptions(projectId)).evidence.some((option) => option.id === itemEvidence.id)).toBe(false);
    await services.appendEvidenceReviewDecision(projectId, itemEvidence.id, { decision: "accepted" });
    const restoredClaim = await services.createClaim(projectId, { claimText: "Restored direct claim" });
    const restored = await services.createClaimRevision(projectId, restoredClaim.id, {
      claimText: restoredClaim.claimText,
      supports: [{ kind: "evidence", evidenceId: itemEvidence.id }],
      expectedCurrentRevisionId: restoredClaim.revision.id,
    });
    expect(restored.revision.supports.evidence).toHaveLength(1);
    await services.reviseExtractionValue(projectId, item.id, field.id, { value: "Restored observation", evidenceIds: [itemEvidence.id] });
  });

  it("serializes support-before-rejection and rejection-before-support on the Evidence row", async () => {
    const item = await paper();
    const itemEvidence = await services.recordEvidence(projectId, { paperId: item.id, sourceText: "Race passage", pageNumber: 1 });
    await services.appendEvidenceReviewDecision(projectId, itemEvidence.id, { decision: "accepted" });
    const supportFirstClaim = await draftClaim("Support-first");
    const supportFirstGate = deferred();
    const supportFirstEntered = deferred();
    const supportFirstTransaction = lockClient.begin(async (tx) => {
      await tx`select id from evidence where project_id=${projectId} and id=${itemEvidence.id} for update`;
      await tx`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${projectId}, ${supportFirstClaim.draftRevisionId}, ${itemEvidence.id})`;
      await tx`update claim_revisions set finalized_at=now() where project_id=${projectId} and id=${supportFirstClaim.draftRevisionId}`;
      supportFirstEntered.resolve();
      await supportFirstGate.promise;
    });
    await supportFirstEntered.promise;
    let rejectionFinished = false;
    const waitingRejection = services.appendEvidenceReviewDecision(projectId, itemEvidence.id, { decision: "rejected" }).finally(() => { rejectionFinished = true; });
    await sleep(75);
    expect(rejectionFinished).toBe(false);
    supportFirstGate.resolve();
    await Promise.all([supportFirstTransaction, waitingRejection]);
    const supportRows = await client`select 1 from claim_revision_evidence_supports where project_id=${projectId} and claim_revision_id=${supportFirstClaim.draftRevisionId} and evidence_id=${itemEvidence.id}`;
    expect(supportRows).toHaveLength(1);

    const rejectedEvidence = await services.recordEvidence(projectId, { paperId: item.id, sourceText: "Rejected-first passage", pageNumber: 2 });
    await services.appendEvidenceReviewDecision(projectId, rejectedEvidence.id, { decision: "accepted" });
    const rejectedFirstClaim = await draftClaim("Rejection-first");
    const rejectedFirstGate = deferred();
    const rejectedFirstEntered = deferred();
    const rejectedFirstTransaction = lockClient.begin(async (tx) => {
      await tx`select id from evidence where project_id=${projectId} and id=${rejectedEvidence.id} for update`;
      await tx`insert into evidence_review_decisions (project_id, evidence_id, decision, note) values (${projectId}, ${rejectedEvidence.id}, 'rejected', null)`;
      rejectedFirstEntered.resolve();
      await rejectedFirstGate.promise;
    });
    await rejectedFirstEntered.promise;
    const waitingSupport = supportClient`insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id) values (${projectId}, ${rejectedFirstClaim.draftRevisionId}, ${rejectedEvidence.id})`;
    await sleep(75);
    rejectedFirstGate.resolve();
    await rejectedFirstTransaction;
    await expect(waitingSupport).rejects.toThrow();
  });

  it("protects curated Evidence while retaining pristine deletion", async () => {
    const item = await paper();
    const pristine = await services.recordEvidence(projectId, { paperId: item.id, sourceText: "Unused", pageNumber: 1 });
    await services.deleteEvidence(projectId, pristine.id);
    await expect(services.getEvidenceCurationDetail(projectId, pristine.id)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });

    const curated = await services.recordEvidence(projectId, { paperId: item.id, sourceText: "Curated", pageNumber: 2 });
    await services.appendEvidenceAnnotation(projectId, curated.id, { body: "Keep this history" });
    await expect(services.deleteEvidence(projectId, curated.id)).rejects.toMatchObject({ code: "PROTECTED_DELETE" });
    await expect(db.delete(evidence).where(sql`project_id=${projectId} and id=${curated.id}`)).rejects.toThrow();
    expect((await services.listEvidenceWorkspace(projectId, { state: "all" })).items.some((entry) => entry.id === curated.id)).toBe(true);
  });

  it("matches the released Evidence projection across review, labels, provenance, filters, and all historical usage paths", async () => {
    const paper1 = await includedPaper();
    const paper2 = await includedPaper();
    const paper3 = await includedPaper();
    const paper4 = await includedPaper();
    const paper5 = await includedPaper();
    const paper6 = await includedPaper();
    const paper7 = await includedPaper();

    const doc1Id = crypto.randomUUID();
    const doc1StorageKey = `projects/${projectId}/papers/${paper1.id}/documents/${doc1Id}/source.pdf`;
    await client`insert into full_text_documents
      (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256, storage_state, staged_storage_key)
      values (${doc1Id}, ${projectId}, ${paper1.id}, ${doc1StorageKey}, 'source-one.pdf', 'application/pdf', 24, ${"a".repeat(64)}, 'ready', null)`;
    const documentEvidence = await services.recordEvidence(projectId, {
      paperId: paper1.id,
      fullTextDocumentId: doc1Id,
      sourceText: "Document-backed passage",
      pageNumber: 6,
      note: "Document provenance note",
    });

    const doc2Id = crypto.randomUUID();
    const doc2StorageKey = `projects/${projectId}/papers/${paper2.id}/documents/${doc2Id}/source.pdf`;
    await client`insert into full_text_documents
      (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256, storage_state, staged_storage_key)
      values (${doc2Id}, ${projectId}, ${paper2.id}, ${doc2StorageKey}, 'source-two.pdf', 'application/pdf', 24, ${"b".repeat(64)}, 'ready', null)`;
    const extractedText = "Extracted source passage with exact offsets.";
    const textExtractionId = await client.begin(async (tx) => {
      const extractionRows = await tx`insert into document_text_extractions
        (project_id, paper_id, full_text_document_id, extractor_key, extractor_version,
         algorithm_version, status, page_count, character_count, started_at, completed_at)
        values (${projectId}, ${paper2.id}, ${doc2Id}, 'fixture-extractor', '1', '1', 'succeeded', 1,
          ${Array.from(extractedText).length}, now(), now()) returning id`;
      const id = String(extractionRows[0].id);
      await tx`insert into document_text_extraction_pages
        (project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count)
        values (${projectId}, ${paper2.id}, ${id}, 1, 'succeeded', ${extractedText}, ${Array.from(extractedText).length})`;
      return id;
    });
    const extractedEvidence = await services.recordEvidenceFromExtractedPage(projectId, {
      paperId: paper2.id,
      fullTextDocumentId: doc2Id,
      documentTextExtractionId: textExtractionId,
      pageNumber: 1,
      startOffset: 0,
      endOffset: Array.from(extractedText).length,
      note: "Extracted provenance note",
    });

    const extractionField = await services.createExtractionField(projectId, { name: "Read fixture", fieldType: "short_text" });
    await services.reviseExtractionValue(projectId, paper1.id, extractionField.id, {
      value: "Document finding",
      evidenceIds: [documentEvidence.id],
    });
    await services.appendEvidenceReviewDecision(projectId, documentEvidence.id, { decision: "accepted" });
    await services.appendEvidenceReviewDecision(projectId, documentEvidence.id, { decision: "rejected" });

    const archivedLabel = await services.createEvidenceLabel(projectId, { name: "Archived assignment" });
    const currentLabel = await services.createEvidenceLabel(projectId, { name: "Current assignment" });
    const removedLabel = await services.createEvidenceLabel(projectId, { name: "Removed assignment" });
    const neverAssignedLabel = await services.createEvidenceLabel(projectId, { name: "Never assigned" });
    await services.assignEvidenceLabel(projectId, documentEvidence.id, currentLabel.id);
    await services.removeEvidenceLabel(projectId, documentEvidence.id, currentLabel.id);
    await services.assignEvidenceLabel(projectId, documentEvidence.id, currentLabel.id);
    await services.assignEvidenceLabel(projectId, documentEvidence.id, archivedLabel.id);
    await services.archiveEvidenceLabel(projectId, archivedLabel.id);
    await services.assignEvidenceLabel(projectId, documentEvidence.id, removedLabel.id);
    await services.removeEvidenceLabel(projectId, documentEvidence.id, removedLabel.id);
    await services.archiveEvidenceLabel(projectId, removedLabel.id);

    await services.appendEvidenceReviewDecision(projectId, extractedEvidence.id, { decision: "accepted" });
    const directEvidenceClaim = await services.createClaim(projectId, { claimText: "Historical direct Evidence claim" });
    const directEvidenceRevision = await services.createClaimRevision(projectId, directEvidenceClaim.id, {
      claimText: directEvidenceClaim.claimText,
      supports: [{ kind: "evidence", evidenceId: extractedEvidence.id }],
      expectedCurrentRevisionId: directEvidenceClaim.revision.id,
    });
    await services.withdrawClaim(projectId, directEvidenceClaim.id, {
      researcherNote: "Withdrawn after review",
      expectedCurrentRevisionId: directEvidenceRevision.revision.id,
    });
    const exclusionCriterion = await services.createScreeningCriterion(projectId, { type: "exclusion", text: "Historical exclusion fixture" });
    await services.recordScreeningDecision(projectId, paper2.id, { decision: "exclude", exclusionCriterionId: exclusionCriterion.id });
    await services.appendEvidenceReviewDecision(projectId, extractedEvidence.id, { decision: "rejected" });

    const extractionEvidence = await services.recordEvidence(projectId, { paperId: paper3.id, sourceText: "Extraction support passage", pageNumber: 7 });
    await services.appendEvidenceReviewDecision(projectId, extractionEvidence.id, { decision: "needs_review" });
    const oldExtraction = await services.reviseExtractionValue(projectId, paper3.id, extractionField.id, {
      value: "Original extraction",
      evidenceIds: [extractionEvidence.id],
    });
    const extractionClaim = await services.createClaim(projectId, { claimText: "Claim supported by an Extraction Revision" });
    await services.createClaimRevision(projectId, extractionClaim.id, {
      claimText: extractionClaim.claimText,
      supports: [{ kind: "extractionRevision", extractionRevisionId: oldExtraction.id }],
      expectedCurrentRevisionId: extractionClaim.revision.id,
    });
    await services.reviseExtractionValue(projectId, paper3.id, extractionField.id, { value: "Replacement extraction", evidenceIds: [] });

    const synthesisEvidence = await services.recordEvidence(projectId, { paperId: paper4.id, sourceText: "Synthesis support passage", pageNumber: 8 });
    const synthesisExtraction = await services.reviseExtractionValue(projectId, paper4.id, extractionField.id, {
      value: "Synthesis observation",
      evidenceIds: [synthesisEvidence.id],
    });
    const supersededSynthesis = await services.createSynthesisStatement(projectId, {
      statementText: "Historical synthesis through Extraction",
      extractionRevisionIds: [synthesisExtraction.id],
    });
    await services.reviseSynthesisStatement(projectId, supersededSynthesis.statement.id, {
      statementText: "Replacement synthesis without the old support",
      extractionRevisionIds: [],
    });

    const claimSynthesisEvidence = await services.recordEvidence(projectId, { paperId: paper5.id, sourceText: "Claim through synthesis passage", pageNumber: 9 });
    await services.appendEvidenceReviewDecision(projectId, claimSynthesisEvidence.id, { decision: "accepted" });
    const claimSynthesisExtraction = await services.reviseExtractionValue(projectId, paper5.id, extractionField.id, {
      value: "Claim synthesis observation",
      evidenceIds: [claimSynthesisEvidence.id],
    });
    const claimSynthesis = await services.createSynthesisStatement(projectId, {
      statementText: "Synthesis for the historical Claim path",
      extractionRevisionIds: [claimSynthesisExtraction.id],
    });
    const synthesisClaim = await services.createClaim(projectId, { claimText: "Claim supported by a Synthesis Revision" });
    await services.createClaimRevision(projectId, synthesisClaim.id, {
      claimText: synthesisClaim.claimText,
      supports: [{ kind: "synthesisRevision", synthesisRevisionId: claimSynthesis.revision.id }],
      expectedCurrentRevisionId: synthesisClaim.revision.id,
    });

    const multiPathEvidence = await services.recordEvidence(projectId, { paperId: paper6.id, sourceText: "Multiple downstream paths passage", pageNumber: 10 });
    await services.appendEvidenceReviewDecision(projectId, multiPathEvidence.id, { decision: "accepted" });
    const multiPathExtraction = await services.reviseExtractionValue(projectId, paper6.id, extractionField.id, {
      value: "Multiple path observation",
      evidenceIds: [multiPathEvidence.id],
    });
    const multiPathClaim = await services.createClaim(projectId, { claimText: "Second path for the same Evidence" });
    await services.createClaimRevision(projectId, multiPathClaim.id, {
      claimText: multiPathClaim.claimText,
      supports: [{ kind: "evidence", evidenceId: multiPathEvidence.id }],
      expectedCurrentRevisionId: multiPathClaim.revision.id,
    });
    expect(multiPathExtraction.id).toBeTruthy();

    const unusedEvidence = await services.recordEvidence(projectId, { paperId: paper7.id, sourceText: "Unused passage", pageNumber: 11 });

    const all = await createEvidenceWorkspaceReadServices(db).getEvidenceWorkspacePage(projectId, { state: "all", pageSize: 100 });
    expect(all.totalCount).toBe(7);
    const usageById = new Map(all.items.map((item) => [item.id, item.usage]));
    expect([documentEvidence.id, extractedEvidence.id, extractionEvidence.id, synthesisEvidence.id, claimSynthesisEvidence.id, multiPathEvidence.id]
      .every((id) => usageById.get(id) === "used")).toBe(true);
    expect(usageById.get(unusedEvidence.id)).toBe("unused");
    expect(all.items.filter((item) => item.id === multiPathEvidence.id)).toHaveLength(1);
    expect(all.items.find((item) => item.id === documentEvidence.id)?.labels.map((label) => label.id)).toEqual([archivedLabel.id, currentLabel.id]);
    expect(all.items.find((item) => item.id === documentEvidence.id)?.labels[0].archivedAt).not.toBeNull();
    expect(all.items.find((item) => item.id === documentEvidence.id)?.labels.some((label) => label.id === neverAssignedLabel.id || label.id === removedLabel.id)).toBe(false);
    expect(all.items.find((item) => item.id === extractedEvidence.id)?.documentTextExtractionId).toBe(textExtractionId);
    expect(all.items.find((item) => item.id === extractedEvidence.id)?.extractionStartOffset).toBe(0);
    expect(all.items.find((item) => item.id === extractedEvidence.id)?.extractionEndOffset).toBe(Array.from(extractedText).length);
    expect(all.items.find((item) => item.id === documentEvidence.id)?.reviewState).toBe("rejected");

    const filterCases = [
      { state: "attention" as const },
      { state: "unreviewed" as const },
      { state: "needs_review" as const },
      { state: "accepted" as const },
      { state: "rejected" as const },
      { state: "all" as const },
      { state: "all" as const, paperId: paper1.id },
      { state: "all" as const, labelId: archivedLabel.id },
      { state: "all" as const, labelId: removedLabel.id },
      { state: "all" as const, labelId: neverAssignedLabel.id },
      { state: "all" as const, fullTextDocumentId: doc1Id },
      { state: "all" as const, documentProvenance: "document" as const },
      { state: "all" as const, documentProvenance: "extraction" as const },
      { state: "all" as const, documentProvenance: "none" as const },
      { state: "all" as const, documentTextExtractionId: textExtractionId },
      { state: "all" as const, pageNumber: 7 },
      { state: "all" as const, usage: "used" as const },
      { state: "all" as const, usage: "unused" as const },
    ];
    for (const filters of filterCases) {
      const options = { ...filters, page: 1, pageSize: 100 };
      const legacy = await services.listEvidenceWorkspace(projectId, options);
      const current = await createEvidenceWorkspaceReadServices(db).getEvidenceWorkspacePage(projectId, options);
      expect(current.totalCount).toBe(legacy.total);
      expect(JSON.parse(JSON.stringify(current.items))).toEqual(JSON.parse(JSON.stringify(legacy.items)));
    }
  });

  it("keeps the workspace query count at four while clamping pages and returns true empty counts", async () => {
    const item = await includedPaper();
    const timestamp = "2026-09-26T00:00:00.000Z";
    await client`insert into evidence (project_id, paper_id, source_text, page_number, created_at, updated_at)
      select ${projectId}, ${item.id}, 'Bounded fixture ' || series::text, series, ${timestamp}::timestamptz, ${timestamp}::timestamptz
      from generate_series(1, 100) as series`;
    const denseLabels = await Promise.all([1, 2, 3].map((number) =>
      services.createEvidenceLabel(projectId, { name: `Bounded label ${number}` }),
    ));
    for (const label of denseLabels) {
      await client`insert into evidence_label_events (project_id, evidence_id, label_id, event)
        select ${projectId}, page.evidence_id, ${label.id}, 'assigned'
        from (
          select id as evidence_id, row_number() over (order by created_at asc, id asc) as position
          from evidence where project_id=${projectId} and paper_id=${item.id}
        ) page
        where page.position <= 80`;
    }
    const firstEvidence = await client`select id, paper_id from evidence
      where project_id=${projectId} and paper_id=${item.id}
      order by created_at asc, id asc limit 1`;
    const field = await services.createExtractionField(projectId, { name: "Bounded usage fixture", fieldType: "short_text" });
    await services.reviseExtractionValue(projectId, item.id, field.id, {
      value: "Used in one extraction revision",
      evidenceIds: [String(firstEvidence[0].id)],
    });

    const captured = createCountedEvidenceReads();
    try {
      // postgres.js loads PostgreSQL array type metadata on first use; warm the
      // connection so the measurement covers workspace projection statements.
      await captured.reads.getEvidenceWorkspacePage(projectId, { state: "all", page: 1, pageSize: 1 });
      captured.selects.length = 0;
      for (const pageSize of [1, 25, 50, 100]) {
        captured.selects.length = 0;
        const result = await captured.reads.getEvidenceWorkspacePage(projectId, { state: "all", page: 1, pageSize });
        expect(result.items).toHaveLength(pageSize);
        expect(captured.selects).toHaveLength(4);
        if (pageSize === 100) {
          expect(result.items.slice(0, 80).every((entry) => entry.labels.length === 3)).toBe(true);
          expect(result.items.slice(80).every((entry) => entry.labels.length === 0)).toBe(true);
          expect(result.items[0].usage).toBe("used");
          expect(result.items.slice(1).every((entry) => entry.usage === "unused")).toBe(true);
        }
      }
      captured.selects.length = 0;
      const unlabeledPage = await captured.reads.getEvidenceWorkspacePage(projectId, { state: "all", page: 5, pageSize: 25 });
      expect(unlabeledPage.items).toHaveLength(25);
      expect(unlabeledPage.items.slice(5).every((entry) => entry.labels.length === 0)).toBe(true);
      expect(captured.selects).toHaveLength(4);
      captured.selects.length = 0;
      const outOfRange = await captured.reads.getEvidenceWorkspacePage(projectId, { state: "all", page: 99, pageSize: 25 });
      expect(outOfRange.page).toBe(4);
      expect(outOfRange.from).toBe(76);
      expect(outOfRange.to).toBe(100);
      expect(outOfRange.items).toHaveLength(25);
      expect(captured.selects).toHaveLength(4);

      captured.selects.length = 0;
      const empty = await captured.reads.getEvidenceWorkspacePage(projectId, { state: "accepted", page: 99, pageSize: 25 });
      expect(empty).toMatchObject({ page: 1, totalCount: 0, totalPages: 0, from: 0, to: 0, items: [] });
      expect(captured.selects).toHaveLength(4);

      captured.selects.length = 0;
      await expect(captured.reads.getEvidenceWorkspacePage(crypto.randomUUID(), { state: "all" })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
      expect(captured.selects).toHaveLength(1);
    } finally {
      await captured.close();
    }
  });

  it("pages exact filtered counts at the empty, single-row, 49/50/51-row, and tied-timestamp boundaries", async () => {
    const sizes = [0, 1, 49, 50, 51] as const;
    const papers = await Promise.all(sizes.map((size) =>
      services.addPaper(projectId, { title: `Pagination boundary ${size} ${crypto.randomUUID()}` }),
    ));
    const timestamp = "2026-09-26T00:00:00.000Z";
    for (let index = 0; index < sizes.length; index += 1) {
      const size = sizes[index];
      if (size === 0) continue;
      await client`insert into evidence (project_id, paper_id, source_text, page_number, created_at, updated_at)
        select ${projectId}, ${papers[index].id}, 'Pagination boundary passage ' || series::text, series,
          ${timestamp}::timestamptz, ${timestamp}::timestamptz
        from generate_series(1, ${size}) as series`;
    }

    const reads = createEvidenceWorkspaceReadServices(db);
    for (let index = 0; index < sizes.length; index += 1) {
      const size = sizes[index];
      const firstPage = await reads.getEvidenceWorkspacePage(projectId, {
        state: "all", paperId: papers[index].id, page: 1, pageSize: 50,
      });
      expect(firstPage.totalCount).toBe(size);
      if (size === 0) {
        expect(firstPage).toMatchObject({ page: 1, totalPages: 0, from: 0, to: 0, items: [] });
        continue;
      }
      expect(firstPage.items).toHaveLength(Math.min(size, 50));
      expect(firstPage.from).toBe(1);
      expect(firstPage.to).toBe(Math.min(size, 50));

      const excessivePage = await reads.getEvidenceWorkspacePage(projectId, {
        state: "all", paperId: papers[index].id, page: 99, pageSize: 50,
      });
      const finalPage = size === 51 ? 2 : 1;
      expect(excessivePage.page).toBe(finalPage);
      expect(excessivePage.totalCount).toBe(size);
      expect(excessivePage.items).toHaveLength(size === 51 ? 1 : size);
      if (size === 51) {
        const orderedIds = await client`select id from evidence
          where project_id=${projectId} and paper_id=${papers[index].id}
          order by created_at asc, id asc`;
        expect([...firstPage.items, ...excessivePage.items].map((entry) => entry.id))
          .toEqual(orderedIds.map((row) => String(row.id)));
        const legacyEmptyPage = await services.listEvidenceWorkspace(projectId, {
          state: "all", paperId: papers[index].id, page: 99, pageSize: 50,
        });
        expect(legacyEmptyPage.total).toBe(0);
        expect(excessivePage.totalCount).toBe(51);
      }
    }
  });

  it("uses one deterministic REPEATABLE READ snapshot across count, page, Labels, and usage", async () => {
    const item = await includedPaper();
    const itemEvidence = await services.recordEvidence(projectId, { paperId: item.id, sourceText: "Snapshot-race passage", pageNumber: 1 });
    const field = await services.createExtractionField(projectId, { name: "Snapshot race", fieldType: "short_text" });
    const label = await services.createEvidenceLabel(projectId, { name: "Snapshot race label" });
    const countCompleted = deferred();
    const allowReadToContinue = deferred();
    const pausedDatabase = pauseAfterFirstTransactionExecute(db, async () => {
      countCompleted.resolve();
      await allowReadToContinue.promise;
    });
    const pausedRead = createEvidenceWorkspaceReadServices(pausedDatabase);
    const inFlight = pausedRead.getEvidenceWorkspacePage(projectId, { state: "all", pageSize: 20 });

    await countCompleted.promise;
    try {
      await writerServices.appendEvidenceReviewDecision(projectId, itemEvidence.id, { decision: "accepted" });
      await writerServices.assignEvidenceLabel(projectId, itemEvidence.id, label.id);
      await writerServices.reviseExtractionValue(projectId, item.id, field.id, { value: "Created after count", evidenceIds: [itemEvidence.id] });
    } finally {
      allowReadToContinue.resolve();
    }

    const snapshot = await inFlight;
    const inFlightItem = snapshot.items.find((entry) => entry.id === itemEvidence.id);
    expect(inFlightItem).toMatchObject({ reviewState: "unreviewed", labels: [], usage: "unused" });
    const later = await createEvidenceWorkspaceReadServices(db).getEvidenceWorkspacePage(projectId, { state: "all", pageSize: 20 });
    expect(later.items.find((entry) => entry.id === itemEvidence.id)).toMatchObject({ reviewState: "accepted", usage: "used" });
    expect(later.items.find((entry) => entry.id === itemEvidence.id)?.labels.map((entry) => entry.id)).toEqual([label.id]);
  });

  it("bounds Paper search, preserves exact selected resolution, and measures its query limit in Unicode code points", async () => {
    const papers = [];
    for (let index = 1; index <= 21; index += 1) {
      papers.push(await services.addPaper(projectId, { title: `Evidence Search Study ${String(index).padStart(2, "0")}` }));
    }
    await client`insert into papers (project_id, title)
      select ${projectId}, 'Unrelated Paper ' || series::text from generate_series(22, 60) as series`;
    const reads = createEvidenceWorkspaceReadServices(db);
    const first = await reads.searchEvidencePaperOptions({ projectId, query: "eViDeNcE sEaRcH", page: 1 });
    expect(first.totalCount).toBe(21);
    expect(first.items).toHaveLength(20);
    expect(first.items.every((paperOption) => !("abstract" in paperOption))).toBe(true);
    const second = await reads.searchEvidencePaperOptions({ projectId, query: "eViDeNcE sEaRcH", page: 2 });
    expect(second.totalCount).toBe(21);
    expect(second.items).toHaveLength(1);
    expect(second.items.every((item) => !first.items.some((firstItem) => firstItem.id === item.id))).toBe(true);
    const offPagePaperId = second.items[0].id;
    const exact = await reads.getEvidencePaperOption(projectId, offPagePaperId);
    expect(exact?.id).toBe(offPagePaperId);
    const otherProject = await services.createProject({ title: "Evidence Paper Search isolation" });
    const foreignPaper = await services.addPaper(otherProject.id, { title: "Private foreign Paper" });
    expect(await reads.getEvidencePaperOption(projectId, foreignPaper.id)).toBeNull();
    const onePaperSearch = await reads.searchEvidencePaperOptions({ projectId: otherProject.id });
    expect(onePaperSearch).toMatchObject({ totalCount: 1, totalPages: 1 });
    expect(onePaperSearch.items.map((item) => item.id)).toEqual([foreignPaper.id]);
    const emptyProject = await services.createProject({ title: "Empty Evidence Paper Search" });
    expect(await reads.searchEvidencePaperOptions({ projectId: emptyProject.id })).toMatchObject({
      page: 1, totalCount: 0, totalPages: 0, from: 0, to: 0, items: [],
    });
    const blank = await reads.searchEvidencePaperOptions({ projectId, query: "", page: 1, pageSize: 500 });
    expect(blank.totalCount).toBe(60);
    expect(blank.items).toHaveLength(50);

    await expect(reads.searchEvidencePaperOptions({ projectId, query: "😀".repeat(201) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await reads.searchEvidencePaperOptions({ projectId, query: "😀".repeat(200) })).items).toHaveLength(0);
  });
});
