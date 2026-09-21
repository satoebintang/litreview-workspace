import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createAiExtractionSuggestionServices } from "@/application/ai-extraction-suggestion-services";
import { createAiExtractionBatchServices } from "@/application/ai-extraction-batch-services";
import type { ExtractionSuggestionProvider, ProviderSuggestionResult } from "@/application/ai/extraction-suggestion-provider";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice26_ai_${Date.now()}_${randomUUID().slice(0, 8)}`;
const DATABASE_URL = `${BASE_URL.replace(/\/[^/]+$/, "")}/${DATABASE_NAME}`;

function candidateResult(pageId: string, value: string): ProviderSuggestionResult {
  return {
    kind: "success",
    suggestion: {
      outcome: "candidate",
      state: "present",
      value,
      explanation: "The value is explicitly reported in the page.",
      groundings: [{ pageId, quote: "42 participants" }],
    },
    metadata: {
      provider: "fake",
      configuredModel: "fake-model",
      returnedModel: "fake-model",
      responseId: "fake-response",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      durationMs: 1,
    },
  };
}

class CountingProvider implements ExtractionSuggestionProvider {
  invocationCount = 0;

  constructor(private readonly resultOrError: ProviderSuggestionResult | Error) {}

  async suggest(): Promise<ProviderSuggestionResult> {
    this.invocationCount += 1;
    if (this.resultOrError instanceof Error) throw this.resultOrError;
    return structuredClone(this.resultOrError);
  }
}

describe("Slice 26 AI extraction suggestion persistence boundary", () => {
  let admin: postgres.Sql;
  let client: postgres.Sql;
  let db: ReturnType<typeof createDb>["db"];
  let services: ReturnType<typeof createReviewServices>;

  beforeAll(async () => {
    admin = postgres(BASE_URL, { max: 1 });
    await admin.unsafe(`create database "${DATABASE_NAME}"`);
    const created = createDb(DATABASE_URL);
    db = created.db;
    client = created.client;
    services = createReviewServices(db);
    await migrate(db, { migrationsFolder: "./drizzle" });
  }, 120_000);

  afterAll(async () => {
    await client.end();
    await admin.unsafe(`drop database if exists "${DATABASE_NAME}" with (force)`);
    await admin.end();
  }, 120_000);

  async function fixture(fieldType: "short_text" | "number" = "number") {
    const project = await services.createProject({ title: `Slice 26 project ${randomUUID()}` });
    const paper = await services.addPaper(project.id, { title: "AI extraction study" });
    await services.recordScreeningDecision(project.id, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(project.id, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(project.id, paper.id, { decision: "include" });
    const field = await services.createExtractionField(project.id, { name: "Participants", fieldType, required: true });
    const documentId = randomUUID();
    const extractionId = randomUUID();
    const pageId = randomUUID();
    const text = "Study reports 42 participants.\nNo adverse events were reported.";
    const bytes = Buffer.from("%PDF-1.7\nfixture");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await client`insert into full_text_documents (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256) values (${documentId}::uuid, ${project.id}::uuid, ${paper.id}::uuid, ${`projects/${project.id}/papers/${paper.id}/documents/${documentId}/source.pdf`}, 'study.pdf', 'application/pdf', ${bytes.byteLength}, ${sha256})`;
    await client.begin(async (tx) => {
      await tx`insert into document_text_extractions (id, project_id, paper_id, full_text_document_id, extractor_key, extractor_version, algorithm_version, status, page_count, character_count, started_at, completed_at) values (${extractionId}::uuid, ${project.id}::uuid, ${paper.id}::uuid, ${documentId}::uuid, 'fixture', '1', '1', 'succeeded', 1, ${Array.from(text).length}, now(), now())`;
      await tx`insert into document_text_extraction_pages (id, project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count) values (${pageId}::uuid, ${project.id}::uuid, ${paper.id}::uuid, ${extractionId}::uuid, 1, 'succeeded', ${text}, ${Array.from(text).length})`;
    });
    return { project, paper, field, documentId, extractionId, pageId, text };
  }

  async function begin(fixtureValue: Awaited<ReturnType<typeof fixture>>, provider: ExtractionSuggestionProvider) {
    const ai = createAiExtractionSuggestionServices(db, provider);
    const request = await ai.beginAiExtractionSuggestion({
      projectId: fixtureValue.project.id,
      paperId: fixtureValue.paper.id,
      fieldId: fixtureValue.field.id,
      fullTextDocumentId: fixtureValue.documentId,
      documentTextExtractionId: fixtureValue.extractionId,
      idempotencyKey: randomUUID(),
      externalTransmissionAcknowledged: true,
      disclosureVersion: "openai-extraction-transmission-v1",
    });
    return { ai, requestId: String(request.requestId) };
  }

  it("replays one normalized provider result after transient result persistence failure", async () => {
    const value = await fixture();
    const provider = new CountingProvider(candidateResult(value.pageId, "42"));
    const { ai, requestId } = await begin(value, provider);
    await client.unsafe("create sequence ai_result_replay_fail_seq");
    await client.unsafe(`create function ai_result_replay_fail_once() returns trigger language plpgsql as $$ begin if nextval('ai_result_replay_fail_seq') = 1 then raise exception 'transient result persistence failure' using errcode = '40001'; end if; return new; end; $$`);
    await client.unsafe("create trigger ai_result_replay_fail_trigger before insert on ai_extraction_results for each row execute function ai_result_replay_fail_once()");
    try {
      await expect(ai.executeAiExtractionSuggestion(requestId)).rejects.toThrow();
      expect(provider.invocationCount).toBe(1);
      expect(await client`select count(*)::int as count from ai_extraction_results where request_id=${requestId}::uuid`).toEqual([{ count: 0 }]);
    } finally {
      await client.unsafe("drop trigger ai_result_replay_fail_trigger on ai_extraction_results");
      await client.unsafe("drop function ai_result_replay_fail_once()");
      await client.unsafe("drop sequence ai_result_replay_fail_seq");
    }
    const persisted = await ai.executeAiExtractionSuggestion(requestId);
    expect(persisted.outcome).toBe("succeeded");
    expect(provider.invocationCount).toBe(1);
    expect(await client`select count(*)::int as count from ai_extraction_results where request_id=${requestId}::uuid`).toEqual([{ count: 1 }]);
    const [grounding] = await client`select source_text, locator_quote, start_offset, end_offset from ai_extraction_result_groundings where request_id=${requestId}::uuid`;
    expect(grounding).toMatchObject({ source_text: "42 participants", locator_quote: "42 participants", start_offset: 14, end_offset: 29 });
  });

  it("terminalizes an ambiguous transport outcome without a provider retry", async () => {
    const value = await fixture("short_text");
    const provider = new CountingProvider(new Error("connection reset after transmission"));
    const { ai, requestId } = await begin(value, provider);
    const first = await ai.executeAiExtractionSuggestion(requestId);
    expect(first).toMatchObject({ outcome: "outcome_unknown", errorCode: "outcome_unknown" });
    expect(provider.invocationCount).toBe(1);
    const second = await ai.executeAiExtractionSuggestion(requestId);
    expect(second).toMatchObject({ outcome: "outcome_unknown" });
    expect(provider.invocationCount).toBe(1);
  });

  it("persists an unresolvable grounding as a terminal non-candidate result", async () => {
    const value = await fixture("short_text");
    const provider = new CountingProvider({
      kind: "success",
      suggestion: {
        outcome: "candidate",
        state: "present",
        value: "42 participants",
        explanation: "The quote does not occur exactly in the persisted page.",
        groundings: [{ pageId: value.pageId, quote: "not in the page" }],
      },
      metadata: {
        provider: "fake",
        configuredModel: "fake-model",
        returnedModel: "fake-model",
        responseId: "fake-unresolvable",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        durationMs: 1,
      },
    });
    const { ai, requestId } = await begin(value, provider);
    const persisted = await ai.executeAiExtractionSuggestion(requestId);
    expect(persisted).toMatchObject({ outcome: "unresolvable_grounding", state: null });
    expect(provider.invocationCount).toBe(1);
    expect(await client`select count(*)::int as count from ai_extraction_result_groundings where request_id=${requestId}::uuid`).toEqual([{ count: 0 }]);
  });

  it("keeps acceptance researcher-controlled while creating ordinary Evidence and ExtractionRevision rows", async () => {
    const value = await fixture();
    const provider = new CountingProvider(candidateResult(value.pageId, "42"));
    const { ai, requestId } = await begin(value, provider);
    await ai.executeAiExtractionSuggestion(requestId);
    const snapshot = await ai.getAiExtractionSuggestion(requestId, value.project.id);
    const grounding = (snapshot.groundings as Record<string, unknown>[])[0];
    const accepted = await ai.acceptAiExtractionSuggestion({
      projectId: value.project.id,
      requestId,
      mode: "edit_and_accept",
      expectedCurrentRevisionId: null,
      state: "present",
      value: "43",
      researcherNote: "Researcher corrected the proposed count.",
      groundingIds: [String(grounding.id)],
    });
    expect(accepted.evidenceIds).toHaveLength(1);
    const extraction = await services.getPaperExtraction(value.project.id, value.paper.id);
    expect(extraction.values.find((item) => item.field.id === value.field.id)?.currentRevision).toMatchObject({ numberValue: "43.0000000000", valueState: "present" });
    const [decisionCounts] = await client`select (select count(*) from ai_extraction_decisions where request_id=${requestId}::uuid and decision='accepted')::int as decisions, (select count(*) from ai_extraction_decision_evidence where decision_id=${String((accepted.decision as Record<string, unknown>).id)}::uuid)::int as grounding_evidence`;
    expect(decisionCounts).toMatchObject({ decisions: 1, grounding_evidence: 1 });
  });

  it("keeps accept-exact immutable and rejects conflicting Evidence reuse retries", async () => {
    const value = await fixture();
    const provider = new CountingProvider(candidateResult(value.pageId, "42"));
    const { ai, requestId } = await begin(value, provider);
    await ai.executeAiExtractionSuggestion(requestId);
    const snapshot = await ai.getAiExtractionSuggestion(requestId, value.project.id);
    const grounding = (snapshot.groundings as Record<string, unknown>[])[0];

    await expect(ai.acceptAiExtractionSuggestion({
      projectId: value.project.id,
      requestId,
      mode: "accept",
      expectedCurrentRevisionId: null,
      state: "not_applicable",
      groundingIds: [],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(ai.acceptAiExtractionSuggestion({
      projectId: value.project.id,
      requestId,
      mode: "accept",
      expectedCurrentRevisionId: null,
      state: "present",
      value: "43",
      groundingIds: [],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const accepted = await ai.acceptAiExtractionSuggestion({
      projectId: value.project.id,
      requestId,
      mode: "accept",
      expectedCurrentRevisionId: null,
      groundingIds: [],
    });
    expect((accepted.decision as Record<string, unknown>).acceptance_mode).toBe("accept");
    await expect(ai.acceptAiExtractionSuggestion({
      projectId: value.project.id,
      requestId,
      mode: "accept",
      expectedCurrentRevisionId: null,
      groundingIds: [],
      reusedEvidenceByGroundingId: { [String(grounding.id)]: randomUUID() },
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("database acceptance guards reject a live field-type drift", async () => {
    const value = await fixture();
    const provider = new CountingProvider(candidateResult(value.pageId, "42"));
    const { ai, requestId } = await begin(value, provider);
    await ai.executeAiExtractionSuggestion(requestId);

    const extractionValueId = randomUUID();
    const resultingRevisionId = randomUUID();
    await client`update extraction_fields set field_type = 'short_text' where project_id=${value.project.id}::uuid and id=${value.field.id}::uuid`;
    await client`insert into extraction_values (id, project_id, paper_id, field_id) values (${extractionValueId}::uuid, ${value.project.id}::uuid, ${value.paper.id}::uuid, ${value.field.id}::uuid)`;
    await client`insert into extraction_value_revisions (id, project_id, paper_id, field_id, extraction_value_id, field_type, value_state, finalized_at) values (${resultingRevisionId}::uuid, ${value.project.id}::uuid, ${value.paper.id}::uuid, ${value.field.id}::uuid, ${extractionValueId}::uuid, 'number', 'cleared', now())`;

    await expect(client`insert into ai_extraction_decisions (project_id, request_id, decision, acceptance_mode, expected_current_extraction_revision_id, preceding_extraction_revision_id, resulting_extraction_revision_id, value_state) values (${value.project.id}::uuid, ${requestId}::uuid, 'accepted', 'edit_and_accept', null, null, ${resultingRevisionId}::uuid, 'cleared')`).rejects.toThrow(/field type does not match/i);
  });

  it("requires idempotency intent equality and rejects conflicting repeat decisions", async () => {
    const value = await fixture();
    const provider = new CountingProvider(candidateResult(value.pageId, "42"));
    const ai = createAiExtractionSuggestionServices(db, provider);
    const idempotencyKey = randomUUID();
    const beginInput = {
      projectId: value.project.id,
      paperId: value.paper.id,
      fieldId: value.field.id,
      fullTextDocumentId: value.documentId,
      documentTextExtractionId: value.extractionId,
      idempotencyKey,
      externalTransmissionAcknowledged: true,
      disclosureVersion: "openai-extraction-transmission-v1",
    } as const;
    const first = await ai.beginAiExtractionSuggestion(beginInput);
    const replay = await ai.beginAiExtractionSuggestion(beginInput);
    expect(replay).toMatchObject({ created: false, requestId: first.requestId });
    await expect(ai.beginAiExtractionSuggestion({ ...beginInput, model: "another-configured-model" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await ai.executeAiExtractionSuggestion(String(first.requestId));
    const snapshot = await ai.getAiExtractionSuggestion(String(first.requestId), value.project.id);
    const grounding = (snapshot.groundings as Record<string, unknown>[])[0];
    const accepted = await ai.acceptAiExtractionSuggestion({ projectId: value.project.id, requestId: String(first.requestId), mode: "edit_and_accept", expectedCurrentRevisionId: null, state: "present", value: "43", researcherNote: "corrected", groundingIds: [String(grounding.id)] });
    const duplicate = await ai.acceptAiExtractionSuggestion({ projectId: value.project.id, requestId: String(first.requestId), mode: "edit_and_accept", expectedCurrentRevisionId: null, state: "present", value: "43", researcherNote: "corrected", groundingIds: [String(grounding.id)] });
    expect((duplicate as Record<string, unknown>).id).toBe((accepted.decision as Record<string, unknown>).id);
    await expect(ai.acceptAiExtractionSuggestion({ projectId: value.project.id, requestId: String(first.requestId), mode: "edit_and_accept", expectedCurrentRevisionId: null, state: "cleared", groundingIds: [] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(ai.rejectAiExtractionSuggestion(value.project.id, String(first.requestId))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("preserves the Slice 26 unresolved-request guard after a terminal undecided result", async () => {
    const value = await fixture("short_text");
    const provider = new CountingProvider(candidateResult(value.pageId, "42"));
    const ai = createAiExtractionSuggestionServices(db, provider);
    const base = {
      projectId: value.project.id,
      paperId: value.paper.id,
      fieldId: value.field.id,
      fullTextDocumentId: value.documentId,
      documentTextExtractionId: value.extractionId,
      externalTransmissionAcknowledged: true,
      disclosureVersion: "openai-extraction-transmission-v1",
    } as const;
    const first = await ai.beginAiExtractionSuggestion({ ...base, idempotencyKey: randomUUID() });
    await ai.executeAiExtractionSuggestion(String(first.requestId));
    const second = await ai.beginAiExtractionSuggestion({ ...base, idempotencyKey: randomUUID() });
    expect(second).toMatchObject({ created: true });
    expect(String(second.requestId)).not.toBe(String(first.requestId));
    await expect(ai.beginAiExtractionSuggestion({ ...base, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(provider.invocationCount).toBe(1);
  });

  it("creates an immutable batch, claims through Slice 26, and leaves acceptance researcher-controlled", async () => {
    const value = await fixture("short_text");
    await client`insert into paper_full_text_preferences (project_id, paper_id, full_text_document_id) values (${value.project.id}::uuid, ${value.paper.id}::uuid, ${value.documentId}::uuid)`;
    const provider = new CountingProvider(candidateResult(value.pageId, "42 participants"));
    const ai = createAiExtractionSuggestionServices(db, provider, { defaultModel: "fake-model", defaultReasoningEffort: "low" });
    const batches = createAiExtractionBatchServices(db, ai, { configuredModel: "fake-model" });
    const input = { projectId: value.project.id, items: [{ paperId: value.paper.id, fieldId: value.field.id, fullTextDocumentId: value.documentId, documentTextExtractionId: value.extractionId, idempotencyKey: randomUUID() }], externalTransmissionAcknowledged: true } as const;
    const preview = await batches.previewAiExtractionBatch(input);
    expect(preview.items[0]).toMatchObject({ ordinal: 0, initialDisposition: "executable", initialReasonCode: "eligible" });
    const created = await batches.createAiExtractionBatch(preview, preview.confirmationHash);
    expect(created.items[0]).toMatchObject({ state: "pending", requestId: null });
    const processed = await batches.executeAiExtractionBatch(value.project.id, created.batchId);
    expect(provider.invocationCount).toBe(1);
    expect(processed.items[0]).toMatchObject({ state: "suggestion_ready", requestRelationship: "authoritative" });
    expect(await client`select count(*)::int as count from extraction_value_revisions where project_id=${value.project.id}::uuid and paper_id=${value.paper.id}::uuid and field_id=${value.field.id}::uuid`).toEqual([{ count: 0 }]);
    const requestId = processed.items[0].requestId;
    expect(requestId).toBeTruthy();
    expect(await client`select count(*)::int as count from ai_extraction_dispatches where request_id=${requestId}::uuid`).toEqual([{ count: 1 }]);

    const reusePreview = await batches.previewAiExtractionBatch({ ...input, items: [{ ...input.items[0], idempotencyKey: randomUUID() }] });
    expect(reusePreview.items[0]).toMatchObject({ initialDisposition: "reusable", initialReasonCode: "existing_successful_undecided" });
    const reusedBatch = await batches.createAiExtractionBatch(reusePreview, reusePreview.confirmationHash);
    const reusedProcessed = await batches.executeAiExtractionBatch(value.project.id, reusedBatch.batchId);
    expect(provider.invocationCount).toBe(1);
    expect(reusedProcessed.items[0]).toMatchObject({ state: "suggestion_ready", requestId, requestRelationship: "authoritative" });
  });
});
