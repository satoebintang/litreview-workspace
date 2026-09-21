import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { sql } from "drizzle-orm";
import { createReviewServices } from "@/application/services";
import { createAiSynthesisSuggestionServices } from "@/application/ai-synthesis-suggestion-services";
import type { ProviderSynthesisSuggestionResult, SynthesisSuggestionProvider } from "@/application/ai/synthesis-suggestion-provider";

const { db, client } = createDb(process.env.DATABASE_URL ?? "postgres://litreview:litreview@localhost:5432/litreview");
const services = createReviewServices(db);
let projectId = "";

describe("Slice 29 AI synthesis suggestions", () => {
  beforeAll(async () => { await migrate(db, { migrationsFolder: "./drizzle" }); });
  beforeEach(async () => { projectId = (await services.createProject({ title: `AI synthesis ${crypto.randomUUID()}` })).id; });
  afterAll(async () => {
    await client.unsafe("TRUNCATE TABLE doi_lookup_resolutions, doi_lookup_dispatches, bibliographic_metadata_result_authors, bibliographic_metadata_http_attempts, bibliographic_metadata_fetch_results, bibliographic_metadata_fetches, doi_lookup_requests, pdf_intake_resolutions, pdf_intake_metadata_fields, pdf_intake_metadata_results, pdf_intakes, bibliographic_import_resolutions, bibliographic_import_records, bibliographic_imports, ai_synthesis_decisions, ai_synthesis_result_groundings, ai_synthesis_results, ai_synthesis_dispatches, ai_synthesis_request_sources, ai_synthesis_request_supports, ai_synthesis_requests, ai_extraction_batch_items, ai_extraction_batches, ai_extraction_decision_evidence, ai_extraction_decisions, ai_extraction_result_groundings, ai_extraction_results, ai_extraction_dispatches, ai_extraction_request_pages, ai_extraction_requests, manuscript_snapshot_warnings, manuscript_snapshot_claim_bibliography_members, manuscript_snapshot_bibliography_entries, manuscript_snapshot_claim_items, manuscript_snapshot_prose_items, manuscript_snapshot_items, manuscript_snapshot_sections, manuscript_snapshots, research_question_answer_claim_contexts, research_question_answer_synthesis_contexts, research_question_answers, research_question_extraction_field_events, research_question_evidence_set_events, research_question_synthesis_statement_events, research_question_claim_events, synthesis_interpretation_contradictions, synthesis_interpretation_questions, synthesis_interpretation_limitations, synthesis_interpretations, synthesis_preparation_selections, synthesis_preparations, retrieved_record_deduplication_decisions, retrieved_record_matches, retrieved_records, search_runs, search_strategies, search_sources, research_questions, manuscript_review_events, manuscript_review_threads, manuscript_claim_placement_events, manuscript_section_item_claims, manuscript_prose_revisions, manuscript_prose_blocks, manuscript_section_items, manuscript_claim_placements, manuscript_sections, manuscripts, claim_revision_synthesis_supports, claim_revision_extraction_supports, claim_revision_evidence_supports, claim_revisions, synthesis_revision_supports, synthesis_revisions, synthesis_statements, extraction_revision_evidence, extraction_value_revisions, extraction_values, extraction_options, extraction_fields, document_text_extraction_pages, document_text_extractions, full_text_screening_decisions, full_text_retrieval_attempts, full_text_screening_criteria, screening_decisions, screening_criteria, paper_full_text_preferences, full_text_documents, evidence_set_composition_members, evidence_set_composition_revisions, evidence_set_annotations, evidence_set_memberships, evidence_sets, evidence_label_events, evidence_annotations, evidence_review_decisions, evidence_labels, evidence, claims, papers, projects");
    await client.end();
  });

  async function setup() {
    const paper = await services.addPaper(projectId, { title: "Study" });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: "The intervention improved outcomes.", pageNumber: 1 });
    const field = await services.createExtractionField(projectId, { name: "Outcome", fieldType: "short_text" });
    const revision = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: "Improved", evidenceIds: [evidence.id] });
    const set = (await services.createEvidenceSet(projectId, { name: "Set" })).set;
    await services.addEvidenceToSet(projectId, set.id, { evidenceId: evidence.id });
    const preparation = await services.createSynthesisPreparation(projectId, { evidenceSetId: set.id, extractionFieldId: field.id });
    await services.replaceSynthesisPreparationSelections(projectId, preparation.id, { extractionRevisionIds: [revision.id] });
    return { preparation, evidence, revision, field, set, paper };
  }

  async function setupSupports(count: number, initialSelectionCount = count) {
    const field = await services.createExtractionField(projectId, { name: "Outcome", fieldType: "short_text" });
    const papers = [] as Array<{ id: string }>;
    const evidences = [] as Array<{ id: string }>;
    const revisions = [] as Array<{ id: string }>;
    for (const index of Array.from({ length: count }, (_, value) => value)) {
      const title = `Study ${String.fromCharCode(65 + index)}`;
      const paper = await services.addPaper(projectId, { title });
      await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
      await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
      await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
      const evidence = await services.recordEvidence(projectId, { paperId: paper.id, sourceText: `The intervention improved outcome ${index + 1}.`, pageNumber: 1 });
      const revision = await services.reviseExtractionValue(projectId, paper.id, field.id, { value: `Improved ${index + 1}`, evidenceIds: [evidence.id] });
      papers.push(paper); evidences.push(evidence); revisions.push(revision);
    }
    const set = (await services.createEvidenceSet(projectId, { name: "Set" })).set;
    // Deliberately reverse insertion order so source ordering is proven by the
    // frozen membership order rather than Evidence creation time.
    for (const evidence of [...evidences].reverse()) await services.addEvidenceToSet(projectId, set.id, { evidenceId: evidence.id });
    const preparation = await services.createSynthesisPreparation(projectId, { evidenceSetId: set.id, extractionFieldId: field.id });
    await services.replaceSynthesisPreparationSelections(projectId, preparation.id, { extractionRevisionIds: revisions.slice(0, initialSelectionCount).map((revision) => revision.id) });
    return { preparation, field, set, papers, evidences, revisions };
  }

  async function setupTwoSupports() { return setupSupports(2); }
  async function setupThreeSupports() { return setupSupports(3, 2); }

  function provider(result?: ProviderSynthesisSuggestionResult | ((input: Parameters<SynthesisSuggestionProvider["suggest"]>[0]) => ProviderSynthesisSuggestionResult | Promise<ProviderSynthesisSuggestionResult>)): SynthesisSuggestionProvider {
    return {
      async suggest(input) {
        if (result) return typeof result === "function" ? await result(input) : result;
        return {
          kind: "success",
          suggestion: {
            outcome: "candidate",
            title: "Intervention outcomes",
            statementText: "The intervention improved outcomes.",
            explanation: "The statement is grounded in the selected passage.",
            groundings: input.supports.map((support) => {
              const evidence = support.connectingEvidence[0];
              return { supportId: support.id, evidenceId: String(evidence.evidenceId ?? evidence.id), quote: String(evidence.text ?? evidence.sourceText) };
            }),
          },
          metadata: { provider: "fake", configuredModel: input.model, returnedModel: "fake", responseId: "fake-1", inputTokens: 1, outputTokens: 1, totalTokens: 2, durationMs: 1 },
        };
      },
    };
  }

  it("freezes request input, dispatches once, grounds the candidate, and accepts through canonical synthesis", async () => {
    const { preparation, evidence, revision } = await setup();
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const began = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    const executed = await ai.executeAiSynthesisSuggestion(String(began.requestId), projectId);
    expect(executed.outcome).toBe("succeeded");
    expect(executed.groundingCount).toBe(1);
    const detail = await ai.getAiSynthesisSuggestion(String(began.requestId), projectId) as unknown as { sources: Array<Record<string, unknown>>; supports: Array<Record<string, unknown>> };
    expect(detail.sources).toHaveLength(1);
    expect(String(detail.sources[0].evidence_id)).toBe(evidence.id);
    expect(String(detail.supports[0].option_label_snapshot ?? "")).toBe("");
    const accepted = await ai.acceptAiSynthesisSuggestion({ projectId, requestId: String(began.requestId), mode: "accept" });
    expect((accepted.revision as { statementText: string }).statementText).toBe("The intervention improved outcomes.");
    expect((await services.getSynthesisPreparationWorkspace(projectId, preparation.id)).preparation.status).toBe("finalized");
    const supports = await db.execute(sql`select extraction_revision_id from synthesis_revision_supports where project_id=${projectId}::uuid and synthesis_revision_id=${String((accepted.revision as { id: string }).id)}::uuid`);
    expect((supports as unknown as Array<Record<string, unknown>>).map((row) => String(row.extraction_revision_id))).toEqual([revision.id]);
    await expect(ai.acceptAiSynthesisSuggestion({ projectId, requestId: String(began.requestId), mode: "accept" })).resolves.toMatchObject({ decision: { decision: "accepted" } });
    await expect(ai.rejectAiSynthesisSuggestion(projectId, String(began.requestId))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("freezes and accepts an existing target with its baseline revision", async () => {
    const { preparation, revision } = await setup();
    const existing = await services.createSynthesisStatement(projectId, {
      statementText: "Earlier synthesis",
      extractionRevisionIds: [revision.id],
    });
    await services.updateSynthesisPreparation(projectId, preparation.id, {
      targetSynthesisStatementId: existing.statement.id,
    });
    const ai = createAiSynthesisSuggestionServices(db, provider(), {
      defaultModel: "fake-model",
      defaultReasoningEffort: "low",
      finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction,
    });
    const began = await ai.beginAiSynthesisSuggestion({
      projectId,
      preparationId: preparation.id,
      idempotencyKey: crypto.randomUUID(),
      externalTransmissionAcknowledged: true,
      disclosureVersion: "openai-synthesis-transmission-v1",
    });
    const request = await ai.getAiSynthesisSuggestion(String(began.requestId), projectId) as unknown as { request: Record<string, unknown> };
    expect(String(request.request.targetSynthesisStatementId)).toBe(existing.statement.id);
    expect(String(request.request.targetBaselineRevisionId)).toBe(existing.revision.id);
    await expect(ai.executeAiSynthesisSuggestion(String(began.requestId), projectId)).resolves.toMatchObject({ outcome: "succeeded" });
    const accepted = await ai.acceptAiSynthesisSuggestion({ projectId, requestId: String(began.requestId), mode: "accept" });
    expect((accepted.statement as { id: string }).id).toBe(existing.statement.id);
    expect((accepted.revision as { statementText: string }).statementText).toBe("The intervention improved outcomes.");
  });

  it("rejects acceptance after the live ExtractionField is archived without canonical writes", async () => {
    const { preparation, revision, field } = await setup();
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const began = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    await services.archiveExtractionField(projectId, field.id);
    await ai.executeAiSynthesisSuggestion(String(began.requestId), projectId);
    await expect(ai.acceptAiSynthesisSuggestion({ projectId, requestId: String(began.requestId), mode: "accept" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const revisionRows = await db.execute(sql`select id from synthesis_revisions where project_id=${projectId}::uuid`);
    const decisionRows = await db.execute(sql`select id from ai_synthesis_decisions where project_id=${projectId}::uuid`);
    expect(revisionRows).toHaveLength(0);
    expect(decisionRows).toHaveLength(0);
    expect((await services.getSynthesisPreparationWorkspace(projectId, preparation.id)).preparation.status).toBe("active");
    expect(revision.id).toBeTruthy();
  });

  it.each(["name", "description", "type"] as const)("rejects acceptance after live ExtractionField %s drift without canonical writes", async (drift) => {
    const { preparation, field } = await setup();
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const began = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    await ai.executeAiSynthesisSuggestion(String(began.requestId), projectId);

    // Used fields are normally definition-immutable (0004). Temporarily
    // bypass that invariant only to exercise the acceptance-time stale check;
    // always restore the trigger before this test returns.
    await client`alter table extraction_fields disable trigger extraction_fields_immutable_used`;
    try {
      if (drift === "name") await client`update extraction_fields set name = 'Outcome changed' where project_id=${projectId}::uuid and id=${field.id}::uuid`;
      if (drift === "description") await client`update extraction_fields set description = 'Changed definition' where project_id=${projectId}::uuid and id=${field.id}::uuid`;
      if (drift === "type") await client`update extraction_fields set field_type = 'long_text' where project_id=${projectId}::uuid and id=${field.id}::uuid`;
      await expect(ai.acceptAiSynthesisSuggestion({ projectId, requestId: String(began.requestId), mode: "accept" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    } finally {
      await client`alter table extraction_fields enable trigger extraction_fields_immutable_used`;
    }
    expect(await client`select count(*)::int as count from synthesis_revisions where project_id=${projectId}`).toEqual([{ count: 0 }]);
    expect(await client`select count(*)::int as count from ai_synthesis_decisions where project_id=${projectId}`).toEqual([{ count: 0 }]);
    expect((await services.getSynthesisPreparationWorkspace(projectId, preparation.id)).preparation.status).toBe("active");
  });

  it("converges concurrent begins with the same idempotency key and intent", async () => {
    const { preparation } = await setup();
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const idempotencyKey = crypto.randomUUID();
    const results = await Promise.all([
      ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey, externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" }),
      ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey, externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" }),
    ]);
    expect(results[0].requestId).toBe(results[1].requestId);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await client`select count(*)::int as count from ai_synthesis_requests where project_id=${projectId}`).toEqual([{ count: 1 }]);
    expect(await client`select count(*)::int as count from ai_synthesis_request_sources where project_id=${projectId}`).toEqual([{ count: 1 }]);
  });

  it("replays the same idempotency intent, rejects a changed intent, and preserves a deterministic source hash", async () => {
    const { preparation } = await setup();
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const idempotencyKey = crypto.randomUUID();
    const first = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey, externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    const firstDetail = await ai.getAiSynthesisSuggestion(String(first.requestId), projectId) as unknown as { request: Record<string, unknown> };
    await ai.executeAiSynthesisSuggestion(String(first.requestId), projectId);
    await ai.rejectAiSynthesisSuggestion(projectId, String(first.requestId));
    const replay = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey, externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    const replayDetail = await ai.getAiSynthesisSuggestion(String(replay.requestId), projectId) as unknown as { request: Record<string, unknown> };
    expect(replay.created).toBe(false);
    expect(replay.requestId).toBe(first.requestId);
    expect(replayDetail.request.sourceStateHash).toBe(firstDetail.request.sourceStateHash);
    await expect(ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey, reasoningEffort: "high", externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("allows only one unresolved request for the same frozen state across different keys", async () => {
    const { preparation } = await setup();
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const attempts = await Promise.allSettled([
      ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" }),
      ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(await client`select count(*)::int as count from ai_synthesis_requests where project_id=${projectId}`).toEqual([{ count: 1 }]);
  });

  it("concurrent execute calls dispatch once and both observe one terminal result", async () => {
    const { preparation } = await setup();
    let calls = 0;
    const ai = createAiSynthesisSuggestionServices(db, provider(async (input) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      const support = input.supports[0];
      const evidence = support.connectingEvidence[0];
      return { kind: "success", suggestion: { outcome: "candidate", title: "Concurrent", statementText: "Concurrent result", explanation: null, groundings: [{ supportId: support.id, evidenceId: String(evidence.id ?? evidence.evidenceId), quote: String(evidence.text ?? evidence.sourceText) }] }, metadata: { provider: "fake", configuredModel: input.model, returnedModel: "fake", responseId: "concurrent", inputTokens: null, outputTokens: null, totalTokens: null, durationMs: 30 } };
    }), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const began = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    const results = await Promise.all([ai.executeAiSynthesisSuggestion(String(began.requestId), projectId), ai.executeAiSynthesisSuggestion(String(began.requestId), projectId)]);
    expect(calls).toBe(1);
    expect(results[0].outcome).toBe("succeeded");
    expect(results[1].outcome).toBe("succeeded");
    expect(await client`select count(*)::int as count from ai_synthesis_dispatches where project_id=${projectId}`).toEqual([{ count: 1 }]);
    expect(await client`select count(*)::int as count from ai_synthesis_results where project_id=${projectId}`).toEqual([{ count: 1 }]);
  });

  it("materializes an expired undispatched request before beginning the next one and never dispatches the predecessor", async () => {
    const { preparation } = await setup();
    let calls = 0;
    const ai = createAiSynthesisSuggestionServices(db, provider(async (input) => {
      calls += 1;
      const support = input.supports[0];
      const evidence = support.connectingEvidence[0];
      return { kind: "success", suggestion: { outcome: "candidate", title: "Fresh", statementText: "Fresh result", explanation: null, groundings: [{ supportId: support.id, evidenceId: String(evidence.id ?? evidence.evidenceId), quote: String(evidence.text ?? evidence.sourceText) }] }, metadata: { provider: "fake", configuredModel: input.model, returnedModel: "fake", responseId: "fresh", inputTokens: null, outputTokens: null, totalTokens: null, durationMs: 0 } };
    }), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const first = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 6 * 60 * 1000));
    try {
      const second = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
      const firstResult = await ai.executeAiSynthesisSuggestion(String(first.requestId), projectId);
      expect(firstResult).toMatchObject({ outcome: "failed", errorCode: "request_expired" });
      expect(await ai.executeAiSynthesisSuggestion(String(first.requestId), projectId)).toMatchObject({ outcome: "failed", errorCode: "request_expired" });
      expect(calls).toBe(0);
      vi.useRealTimers();
      await expect(ai.executeAiSynthesisSuggestion(String(second.requestId), projectId)).resolves.toMatchObject({ outcome: "succeeded" });
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes manual finalization and AI acceptance so only one canonical revision wins", async () => {
    const { preparation } = await setup();
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const began = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    await ai.executeAiSynthesisSuggestion(String(began.requestId), projectId);
    const outcomes = await Promise.allSettled([
      services.finalizeSynthesisPreparation(projectId, preparation.id, { title: "Manual", statementText: "Manual finalization" }),
      ai.acceptAiSynthesisSuggestion({ projectId, requestId: String(began.requestId), mode: "accept" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await client`select count(*)::int as count from synthesis_revisions where project_id=${projectId}`).toEqual([{ count: 1 }]);
    expect((await services.getSynthesisPreparationWorkspace(projectId, preparation.id)).preparation.status).toBe("finalized");
  });

  it("rejects conflicting second decisions and conflicting acceptance text", async () => {
    const { preparation } = await setup();
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const rejected = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    await ai.executeAiSynthesisSuggestion(String(rejected.requestId), projectId);
    await ai.rejectAiSynthesisSuggestion(projectId, String(rejected.requestId));
    await expect(ai.acceptAiSynthesisSuggestion({ projectId, requestId: String(rejected.requestId), mode: "accept" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const accepted = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    await ai.executeAiSynthesisSuggestion(String(accepted.requestId), projectId);
    await ai.acceptAiSynthesisSuggestion({ projectId, requestId: String(accepted.requestId), mode: "edit_and_accept", title: "Edited", statementText: "Edited statement", researcherNote: "Note" });
    await expect(ai.acceptAiSynthesisSuggestion({ projectId, requestId: String(accepted.requestId), mode: "edit_and_accept", title: "Different", statementText: "Different", researcherNote: "Different" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects acceptance after target revision and after the exact selection set changes", async () => {
    const first = await setup();
    const existing = await services.createSynthesisStatement(projectId, { statementText: "Baseline", extractionRevisionIds: [first.revision.id] });
    await services.updateSynthesisPreparation(projectId, first.preparation.id, { targetSynthesisStatementId: existing.statement.id });
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const began = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: first.preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    await ai.executeAiSynthesisSuggestion(String(began.requestId), projectId);
    await services.reviseSynthesisStatement(projectId, existing.statement.id, { statementText: "Concurrent baseline", extractionRevisionIds: [first.revision.id] });
    await expect(ai.acceptAiSynthesisSuggestion({ projectId, requestId: String(began.requestId), mode: "accept" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await client`select count(*)::int as count from synthesis_revisions where project_id=${projectId} and synthesis_statement_id=${existing.statement.id}`).toEqual([{ count: 2 }]);
  });

  it("freezes sources in membership, page, Evidence-ID order without creation-time tie breaking", async () => {
    const { preparation, evidences } = await setupTwoSupports();
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const began = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    const detail = await ai.getAiSynthesisSuggestion(String(began.requestId), projectId) as unknown as { sources: Array<Record<string, unknown>> };
    expect(detail.sources.map((source) => String(source.evidence_id))).toEqual([evidences[1].id, evidences[0].id]);
    expect(detail.sources.map((source) => Number(source.membership_sort_order))).toEqual([1, 2]);
  });

  it("rejects acceptance when the Preparation selection set changes to a different revision with the same count", async () => {
    const { preparation, revisions } = await setupThreeSupports();
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const began = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    await ai.executeAiSynthesisSuggestion(String(began.requestId), projectId);
    await services.replaceSynthesisPreparationSelections(projectId, preparation.id, { extractionRevisionIds: [revisions[1].id, revisions[2].id] });
    await expect(ai.acceptAiSynthesisSuggestion({ projectId, requestId: String(began.requestId), mode: "accept" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await client`select count(*)::int as count from synthesis_revisions where project_id=${projectId}`).toEqual([{ count: 0 }]);
  });

  it("changes the source-state hash when one selected ExtractionRevision changes at the same count", async () => {
    const { preparation, revisions } = await setupThreeSupports();
    const ai = createAiSynthesisSuggestionServices(db, provider(), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const first = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    const firstDetail = await ai.getAiSynthesisSuggestion(String(first.requestId), projectId) as unknown as { request: Record<string, unknown> };
    await ai.executeAiSynthesisSuggestion(String(first.requestId), projectId);
    await ai.rejectAiSynthesisSuggestion(projectId, String(first.requestId));
    await services.replaceSynthesisPreparationSelections(projectId, preparation.id, { extractionRevisionIds: [revisions[1].id, revisions[2].id] });
    const second = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    const secondDetail = await ai.getAiSynthesisSuggestion(String(second.requestId), projectId) as unknown as { request: Record<string, unknown> };
    expect(secondDetail.request.sourceStateHash).not.toBe(firstDetail.request.sourceStateHash);
  });

  it.each([
    ["refusal", { kind: "failure", failure: "provider_refusal", code: "refusal" }, "failed"],
    ["incomplete", { kind: "failure", failure: "provider_incomplete", code: "incomplete" }, "failed"],
    ["schema-invalid", { kind: "failure", failure: "schema_invalid", code: "response_schema_invalid" }, "invalid_output"],
    ["api-error", { kind: "failure", failure: "api_error", code: "rate_limit" }, "failed"],
    ["transport", { kind: "failure", failure: "transport_error", code: "outcome_unknown" }, "outcome_unknown"],
  ])("persists provider %s as a terminal non-candidate result", async (_label, failure, expectedOutcome) => {
    const { preparation } = await setup();
    const metadata = { provider: "fake" as const, configuredModel: "fake-model", returnedModel: null, responseId: null, inputTokens: null, outputTokens: null, totalTokens: null, durationMs: 0 };
    const result = { ...(failure as Record<string, unknown>), metadata } as ProviderSynthesisSuggestionResult;
    const ai = createAiSynthesisSuggestionServices(db, provider(result), { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const began = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    await expect(ai.executeAiSynthesisSuggestion(String(began.requestId), projectId)).resolves.toMatchObject({ outcome: expectedOutcome });
    expect(await client`select count(*)::int as count from synthesis_revisions where project_id=${projectId}`).toEqual([{ count: 0 }]);
  });

  it("persists missing provider configuration as provider_unavailable", async () => {
    const { preparation } = await setup();
    const ai = createAiSynthesisSuggestionServices(db, undefined, { defaultModel: "fake-model", defaultReasoningEffort: "low", finalizePreparationInTransaction: services.finalizeSynthesisPreparationInTransaction });
    const began = await ai.beginAiSynthesisSuggestion({ projectId, preparationId: preparation.id, idempotencyKey: crypto.randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-synthesis-transmission-v1" });
    await expect(ai.executeAiSynthesisSuggestion(String(began.requestId), projectId)).resolves.toMatchObject({ outcome: "provider_unavailable", errorCode: "configuration_missing" });
  });
});
