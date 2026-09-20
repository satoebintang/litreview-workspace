import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { fullTextScreeningDecisions } from "@/db/schema";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview");
const services = createReviewServices(db);
let projectId = "";

describe("Slice 12 full-text eligibility screening", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `Full-text project ${crypto.randomUUID()}` })).id; });
  afterAll(async () => {
    await client.unsafe("TRUNCATE TABLE doi_lookup_resolutions, doi_lookup_dispatches, bibliographic_metadata_result_authors, bibliographic_metadata_http_attempts, bibliographic_metadata_fetch_results, bibliographic_metadata_fetches, doi_lookup_requests, pdf_intake_resolutions, pdf_intake_metadata_fields, pdf_intake_metadata_results, pdf_intakes, bibliographic_import_resolutions, bibliographic_import_records, bibliographic_imports, ai_synthesis_decisions, ai_synthesis_result_groundings, ai_synthesis_results, ai_synthesis_dispatches, ai_synthesis_request_sources, ai_synthesis_request_supports, ai_synthesis_requests, ai_extraction_decision_evidence, ai_extraction_decisions, ai_extraction_result_groundings, ai_extraction_results, ai_extraction_dispatches, ai_extraction_request_pages, ai_extraction_requests, manuscript_snapshot_warnings, manuscript_snapshot_claim_bibliography_members, manuscript_snapshot_bibliography_entries, manuscript_snapshot_claim_items, manuscript_snapshot_prose_items, manuscript_snapshot_items, manuscript_snapshot_sections, manuscript_snapshots, research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_extraction_field_events, research_question_evidence_set_events, research_question_synthesis_statement_events, research_question_claim_events, synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_review_events, manuscript_review_threads, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_revisions, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_set_composition_members, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, evidence_label_events, evidence_annotations, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects");
    await client.end();
  });

  async function paper(title: string, decision: "include" | "exclude" | "maybe" = "include") {
    const item = await services.addPaper(projectId, { title });
    if (decision === "exclude") {
      const criterion = await services.createScreeningCriterion(projectId, { type: "exclusion", text: `Exclude ${title}` });
      await services.recordScreeningDecision(projectId, item.id, { decision, exclusionCriterionId: criterion.id });
    } else await services.recordScreeningDecision(projectId, item.id, { decision });
    return item;
  }

  it("derives current-stage full-text metrics and isolates cross-stage conflicts", async () => {
    const criterion = await services.createFullTextScreeningCriterion(projectId, { text: "No eligible population" });
    const included = await paper("Included");
    const awaiting = await paper("Awaiting");
    const excluded = await paper("Excluded");
    const maybe = await paper("Maybe");
    const conflict = await paper("Conflict");
    for (const item of [included, excluded, maybe, conflict]) await services.recordFullTextRetrievalAttempt(projectId, item.id, { outcome: "retrieved", attemptedAt: new Date() });
    expect(awaiting.id).toBeTruthy();
    await services.recordFullTextScreeningDecision(projectId, included.id, { decision: "include" });
    await services.recordFullTextScreeningDecision(projectId, excluded.id, { decision: "exclude", exclusionCriterionId: criterion.id });
    await services.recordFullTextScreeningDecision(projectId, maybe.id, { decision: "maybe" });
    await services.recordFullTextScreeningDecision(projectId, conflict.id, { decision: "include" });
    const taCriterion = await services.createScreeningCriterion(projectId, { type: "exclusion", text: "Not relevant" });
    await services.recordScreeningDecision(projectId, conflict.id, { decision: "exclude", exclusionCriterionId: taCriterion.id });

    const summary = await services.getReviewFlowSummary(projectId);
    expect(summary).toMatchObject({ fullTextEligible: 4, fullTextAwaiting: 1, fullTextAssessed: 3, fullTextIncluded: 1, fullTextExcluded: 1, fullTextMaybe: 1, fullTextConflicts: 1, finallyIncluded: 1 });
    expect((await services.getPaperReviewStatus(projectId, conflict.id)).crossStageConflict).toBe(true);
    expect((await services.getPaperReviewStatus(projectId, conflict.id)).finalEligibility).toBe("not_eligible");
    expect((await services.getReviewReport(projectId)).fullTextEligibility.exclusionReasons[0].text).toBe("No eligible population");
  });

  it("keeps FT history append-only, requires TA inclusion, and gates new extraction while preserving direct Evidence support", async () => {
    const item = await paper("Study");
    await services.recordFullTextRetrievalAttempt(projectId, item.id, { outcome: "retrieved", attemptedAt: new Date() });
    await expect(services.recordFullTextScreeningDecision(projectId, item.id, { decision: "include" })).resolves.toBeTruthy();
    const current = await services.getPaperFullTextScreening(projectId, item.id);
    await services.recordFullTextScreeningDecision(projectId, item.id, { decision: "maybe" });
    expect((await services.getPaperFullTextScreening(projectId, item.id)).history).toHaveLength(2);
    await expect(db.update(fullTextScreeningDecisions).set({ note: "mutated" }).where(and(eq(fullTextScreeningDecisions.projectId, projectId), eq(fullTextScreeningDecisions.id, current.history[0].id)))).rejects.toThrow();
    await expect(db.delete(fullTextScreeningDecisions).where(eq(fullTextScreeningDecisions.id, current.history[0].id))).rejects.toThrow();

    const notIncluded = await paper("Not included", "maybe");
    await expect(services.recordFullTextScreeningDecision(projectId, notIncluded.id, { decision: "include" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const evidence = await services.recordEvidence(projectId, { paperId: notIncluded.id, sourceText: "Direct passage", pageNumber: 1 });
    const claim = await services.createClaim(projectId, { claimText: "Direct evidence remains valid" });
    await expect(services.createClaimRevision(projectId, claim.id, { claimText: claim.claimText, supports: [{ kind: "evidence", evidenceId: evidence.id }], expectedCurrentRevisionId: claim.revision.id })).resolves.toBeTruthy();
  });
});
