/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { serializeManuscriptMarkdown } from "@/application/manuscript-formatting";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview");
const services = createReviewServices(db) as any;

describe("Slice 23 manuscript editorial review threads", () => {
  beforeAll(async () => {
    const [existing] = await client`select to_regclass('public.manuscript_review_threads') as threads`;
    if (!existing?.threads) await migrate(db, { migrationsFolder: "./drizzle" });
  });

  afterAll(async () => {
    await client.unsafe("TRUNCATE TABLE pdf_intake_resolutions, pdf_intake_metadata_fields, pdf_intake_metadata_results, pdf_intakes, bibliographic_import_resolutions, bibliographic_import_records, bibliographic_imports, ai_synthesis_decisions, ai_synthesis_result_groundings, ai_synthesis_results, ai_synthesis_dispatches, ai_synthesis_request_sources, ai_synthesis_request_supports, ai_synthesis_requests, ai_extraction_decision_evidence, ai_extraction_decisions, ai_extraction_result_groundings, ai_extraction_results, ai_extraction_dispatches, ai_extraction_request_pages, ai_extraction_requests, manuscript_snapshot_warnings, manuscript_snapshot_claim_bibliography_members, manuscript_snapshot_bibliography_entries, manuscript_snapshot_claim_items, manuscript_snapshot_prose_items, manuscript_snapshot_items, manuscript_snapshot_sections, manuscript_snapshots, research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_extraction_field_events, research_question_evidence_set_events, research_question_synthesis_statement_events, research_question_claim_events, synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_review_events, manuscript_review_threads, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_revisions, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_set_composition_members, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, evidence_label_events, evidence_annotations, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects");
    await client.end();
  });

  async function fixture() {
    const project = await services.createProject({ title: `Slice 23 ${crypto.randomUUID()}` });
    const manuscript = await services.getOrCreateDefaultManuscript(project.id);
    const section = await services.createSection(project.id, manuscript.id, { title: "Discussion" });
    return { project, manuscript, section };
  }

  async function claimFixture(projectId: string, manuscriptId: string, sectionId: string) {
    const claim = await services.createClaim(projectId, { claimText: "Placed editorial claim" });
    const placement = await services.placeClaimRevision(projectId, manuscriptId, sectionId, claim.revision.id);
    return { claim, placement };
  }

  it("captures exact Prose opening text and rejects a fabricated direct-SQL snapshot", async () => {
    const { project, manuscript, section } = await fixture();
    const exact = "  Leading space\nsecond line\t  ";
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, exact);
    const thread = await services.openManuscriptReviewThread(project.id, manuscript.id, { sectionItemId: prose.id, title: "Exact text", initialComment: "Please review this wording." });
    expect(thread.openingProseText).toBe(exact);
    expect(thread.openingProseRevisionId).toBe(prose.currentRevisionId);

    await expect(client`
      insert into manuscript_review_threads
        (project_id, manuscript_id, section_id, section_item_id, target_item_type, title, opening_prose_text, opening_prose_revision_id)
      values (${project.id}, ${manuscript.id}, ${section.id}, ${prose.id}, 'prose', 'Forged', 'not the persisted text', ${prose.currentRevisionId})
    `).rejects.toThrow(/exact persisted Prose text/i);
  });

  it("captures exact placed ClaimRevision identity and rejects a fabricated opening revision", async () => {
    const { project, manuscript, section } = await fixture();
    const { claim, placement } = await claimFixture(project.id, manuscript.id, section.id);
    const thread = await services.openManuscriptReviewThread(project.id, manuscript.id, { sectionItemId: placement.id, title: "Claim concern", initialComment: "Check this claim." });
    expect(thread.openingClaimId).toBe(claim.id);
    expect(thread.openingClaimRevisionId).toBe(claim.revision.id);

    const forgedRevision = crypto.randomUUID();
    await expect(client`
      insert into manuscript_review_threads
        (project_id, manuscript_id, section_id, section_item_id, target_item_type, title, opening_claim_id, opening_claim_revision_id)
      values (${project.id}, ${manuscript.id}, ${section.id}, ${placement.id}, 'claim', 'Forged', ${claim.id}, ${forgedRevision})
    `).rejects.toThrow();
  });

  it("derives lifecycle from lifecycle events only and keeps comments neutral", async () => {
    const { project, manuscript, section } = await fixture();
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, "Review me");
    const thread = await services.openManuscriptReviewThread(project.id, manuscript.id, { sectionItemId: prose.id, title: "Lifecycle", initialComment: "Opening" });
    expect((await services.getManuscriptReviewProjection(project.id, manuscript.id)).threads[0].state).toBe("open");
    await services.commentOnManuscriptReviewThread(project.id, manuscript.id, thread.id, "A comment");
    await services.resolveManuscriptReviewThread(project.id, manuscript.id, thread.id);
    await services.commentOnManuscriptReviewThread(project.id, manuscript.id, thread.id, "Still resolved");
    expect((await services.getManuscriptReviewProjection(project.id, manuscript.id)).threads[0].state).toBe("resolved");
    await expect(services.resolveManuscriptReviewThread(project.id, manuscript.id, thread.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(client`insert into manuscript_review_events (project_id, thread_id, event_type) values (${project.id}, ${thread.id}, 'resolved')`).rejects.toThrow(/Only an open review thread can be resolved/i);
    await services.reopenManuscriptReviewThread(project.id, manuscript.id, thread.id, "Reconsidered");
    await expect(services.reopenManuscriptReviewThread(project.id, manuscript.id, thread.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const entry = (await services.getManuscriptReviewProjection(project.id, manuscript.id)).threads[0];
    expect(entry.state).toBe("open");
    expect(entry.events.map((event: any) => event.eventType)).toEqual(["opened", "commented", "resolved", "commented", "reopened"]);
  });

  it("serializes concurrent lifecycle events on the thread row", async () => {
    const { project, manuscript, section } = await fixture();
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, "Concurrent");
    const thread = await services.openManuscriptReviewThread(project.id, manuscript.id, { sectionItemId: prose.id, title: "Concurrency", initialComment: "Opening" });
    const results = await Promise.allSettled([
      services.resolveManuscriptReviewThread(project.id, manuscript.id, thread.id),
      services.resolveManuscriptReviewThread(project.id, manuscript.id, thread.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("keeps historical threads usable across edits, replacement/removal, and Section archival", async () => {
    const { project, manuscript, section } = await fixture();
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, "Original");
    const proseThread = await services.openManuscriptReviewThread(project.id, manuscript.id, { sectionItemId: prose.id, title: "Prose history", initialComment: "Opening" });
    await services.updateProseBlock(project.id, manuscript.id, prose.id, { text: "Edited", expectedCurrentRevisionId: prose.currentRevisionId });
    expect((await services.getManuscriptReviewProjection(project.id, manuscript.id)).threads.find((entry: any) => entry.thread.id === proseThread.id).state).toBe("open");
    await services.removeProseBlock(project.id, manuscript.id, prose.id);
    await services.commentOnManuscriptReviewThread(project.id, manuscript.id, proseThread.id, "Comment after removal");
    const proseProjection = await services.getManuscriptReviewProjection(project.id, manuscript.id);
    expect(proseProjection.threads.find((entry: any) => entry.thread.id === proseThread.id).target.targetActive).toBe(false);
    await expect(services.openManuscriptReviewThread(project.id, manuscript.id, { sectionItemId: prose.id, title: "New", initialComment: "Should fail" })).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION_ERROR|NOT_FOUND/) });

    const { claim, placement } = await claimFixture(project.id, manuscript.id, section.id);
    const claimThread = await services.openManuscriptReviewThread(project.id, manuscript.id, { sectionItemId: placement.id, title: "Claim history", initialComment: "Opening" });
    const replacement = await services.createClaimRevision(project.id, claim.id, { claimText: "Replacement", lifecycle: "active", supports: [], expectedCurrentRevisionId: claim.revision.id });
    await services.replacePlacedClaimRevision(project.id, manuscript.id, placement.id, replacement.revision.id, claim.revision.id);
    expect((await services.getManuscriptReviewProjection(project.id, manuscript.id)).threads.find((entry: any) => entry.thread.id === claimThread.id).state).toBe("open");
    await services.removeClaimPlacement(project.id, manuscript.id, placement.id);
    await services.resolveManuscriptReviewThread(project.id, manuscript.id, claimThread.id);
    const claimProjection = await services.getManuscriptReviewProjection(project.id, manuscript.id);
    expect(claimProjection.threads.find((entry: any) => entry.thread.id === claimThread.id).target.targetActive).toBe(false);

    await services.archiveSection(project.id, manuscript.id, section.id);
    await expect(client`
      insert into manuscript_review_threads
        (project_id, manuscript_id, section_id, section_item_id, target_item_type, title, opening_prose_text, opening_prose_revision_id)
      values (${project.id}, ${manuscript.id}, ${section.id}, ${prose.id}, 'prose', 'Archived new thread', 'Edited', ${prose.currentRevisionId})
    `).rejects.toThrow(/non-archived Section|active SectionItem/i);
    await services.reopenManuscriptReviewThread(project.id, manuscript.id, claimThread.id);
    const archivedProjection = await services.getManuscriptReviewProjection(project.id, manuscript.id);
    expect(archivedProjection.threads.find((entry: any) => entry.thread.id === claimThread.id).target.sectionArchived).toBe(true);
  });

  it("enforces immutable rows, deferred opening completeness, and export isolation", async () => {
    const { project, manuscript, section } = await fixture();
    const prose = await services.createProseBlock(project.id, manuscript.id, section.id, "Export stable");
    const before = serializeManuscriptMarkdown(await services.getFormattedManuscript(project.id, manuscript.id));
    const thread = await services.openManuscriptReviewThread(project.id, manuscript.id, { sectionItemId: prose.id, title: "Export boundary", initialComment: "Opening" });
    await services.commentOnManuscriptReviewThread(project.id, manuscript.id, thread.id, "Comment");
    await services.resolveManuscriptReviewThread(project.id, manuscript.id, thread.id);
    await services.reopenManuscriptReviewThread(project.id, manuscript.id, thread.id);
    const after = serializeManuscriptMarkdown(await services.getFormattedManuscript(project.id, manuscript.id));
    expect(after).toBe(before);
    await expect(client`update manuscript_review_threads set title = 'mutated' where id = ${thread.id}`).rejects.toThrow(/immutable/i);
    await expect(client`delete from manuscript_review_threads where id = ${thread.id}`).rejects.toThrow(/immutable/i);
    await expect(client`update manuscript_review_events set body = 'mutated' where thread_id = ${thread.id}`).rejects.toThrow(/append-only/i);
    await expect(client`delete from manuscript_review_events where thread_id = ${thread.id}`).rejects.toThrow(/append-only/i);
    await expect(client`
      insert into manuscript_review_threads
        (project_id, manuscript_id, section_id, section_item_id, target_item_type, title, opening_prose_text, opening_prose_revision_id)
      values (${project.id}, ${manuscript.id}, ${section.id}, ${prose.id}, 'prose', 'No event', 'Export stable', ${prose.currentRevisionId})
    `).rejects.toThrow(/exactly one opened|opened event/i);
  });
});
