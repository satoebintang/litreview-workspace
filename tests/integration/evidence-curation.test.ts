import "dotenv/config";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { evidence, evidenceLabelEvents } from "@/db/schema";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const { db, client } = createDb(DATABASE_URL);
const services = createReviewServices(db);
const lockClient = postgres(DATABASE_URL, { max: 2, prepare: false });
const supportClient = postgres(DATABASE_URL, { max: 1, prepare: false });
let projectId = "";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
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
    await client.unsafe("TRUNCATE TABLE research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_extraction_field_events, research_question_evidence_set_events, research_question_synthesis_statement_events, research_question_claim_events, synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_set_composition_members, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, evidence_label_events, evidence_annotations, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects");
    await Promise.all([lockClient.end(), supportClient.end(), client.end()]);
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
});
