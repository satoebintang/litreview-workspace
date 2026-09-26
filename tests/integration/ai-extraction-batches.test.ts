import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "@/db/client";
import { createReviewServices } from "@/application/services";
import { createAiExtractionSuggestionServices } from "@/application/ai-extraction-suggestion-services";
import { createAiExtractionBatchServices } from "@/application/ai-extraction-batch-services";
import type { ExtractionSuggestionInput, ExtractionSuggestionProvider, ProviderSuggestionResult } from "@/application/ai/extraction-suggestion-provider";

const BASE_URL = process.env.DATABASE_URL ?? "postgres://litreview:litreview@127.0.0.1:5432/litreview";
const DATABASE_NAME = `slice31_batch_${Date.now()}_${randomUUID().slice(0, 8)}`;
const DATABASE_URL = `${BASE_URL.replace(/\/[^/]+$/, "")}/${DATABASE_NAME}`;

type Cell = {
  paper: { id: string; title: string };
  field: { id: string; name: string };
  documentId: string;
  extractionId: string;
  pageId: string;
  text: string;
};

type ProviderMode = "candidate" | "no_candidate" | "failure" | "invalid" | "unresolvable" | "unknown";

function candidateResult(input: ExtractionSuggestionInput, mode: ProviderMode): ProviderSuggestionResult {
  const metadata = { provider: "fake" as const, configuredModel: input.model, returnedModel: input.model, responseId: `slice31-${input.field.id}`, inputTokens: 1, outputTokens: 1, totalTokens: 2, durationMs: 1 };
  if (mode === "failure") return { kind: "failure", failure: "api_error", code: "slice31_failure", metadata };
  if (mode === "unknown") throw new Error("slice31 transport reset");
  if (mode === "no_candidate") return { kind: "success", suggestion: { outcome: "no_candidate", state: null, value: null, explanation: "No candidate was reported.", groundings: [] }, metadata };
  const page = input.pages[0];
  if (mode === "invalid") return { kind: "success", suggestion: { outcome: "candidate", state: "present", value: true, explanation: "Invalid value for a text field.", groundings: [{ pageId: page.id, quote: page.text.slice(0, 8) }] }, metadata };
  return { kind: "success", suggestion: { outcome: "candidate", state: "present", value: mode === "unresolvable" ? "42" : page.text.slice(0, 12), explanation: "Deterministic Slice 31 result.", groundings: [{ pageId: page.id, quote: mode === "unresolvable" ? "not persisted" : page.text.slice(0, 12) }] }, metadata };
}

class InstrumentedProvider implements ExtractionSuggestionProvider {
  invocationCount = 0;
  active = 0;
  maxActive = 0;
  private startedResolve: (() => void) | null = null;
  private releaseResolve: (() => void) | null = null;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });
  readonly release = new Promise<void>((resolve) => { this.releaseResolve = resolve; });

  constructor(private readonly modeFor: (input: ExtractionSuggestionInput) => ProviderMode = () => "candidate", private readonly hold = false, private readonly delayMs = 0) {}

  releaseProvider() { this.releaseResolve?.(); }

  async suggest(input: ExtractionSuggestionInput): Promise<ProviderSuggestionResult> {
    this.invocationCount += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.startedResolve?.();
    try {
      if (this.hold) await this.release;
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return candidateResult(input, this.modeFor(input));
    } finally {
      this.active -= 1;
    }
  }
}

describe("Slice 31 batch orchestration race and boundary matrix", () => {
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

  async function createCell(projectId: string, index: number, fieldName = `Outcome ${index}`, fieldType: "short_text" | "single_select" = "short_text"): Promise<Cell> {
    const paper = await services.addPaper(projectId, { title: `Slice 31 paper ${index}`, abstract: `Abstract ${index}` });
    await services.recordScreeningDecision(projectId, paper.id, { decision: "include" });
    await services.recordFullTextRetrievalAttempt(projectId, paper.id, { outcome: "retrieved", attemptedAt: new Date() });
    await services.recordFullTextScreeningDecision(projectId, paper.id, { decision: "include" });
    const field = await services.createExtractionField(projectId, { name: fieldName, description: `Description ${index}`, fieldType, required: true });
    if (fieldType === "single_select") await services.createExtractionOption(projectId, { fieldId: field.id, label: "Yes" });
    const documentId = randomUUID();
    const extractionId = randomUUID();
    const pageId = randomUUID();
    const text = `Paper ${index} reports 42 participants.`;
    const bytes = Buffer.from(`%PDF-1.7\nfixture-${index}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await client`insert into full_text_documents (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256, storage_state, staged_storage_key) values (${documentId}::uuid, ${projectId}::uuid, ${paper.id}::uuid, ${`projects/${projectId}/papers/${paper.id}/documents/${documentId}/source.pdf`}, ${`study-${index}.pdf`}, 'application/pdf', ${bytes.byteLength}, ${sha256}, 'ready', null)`;
    await services.setPreferredFullTextDocument(projectId, paper.id, documentId);
    await client.begin(async (tx) => {
      await tx`insert into document_text_extractions (id, project_id, paper_id, full_text_document_id, extractor_key, extractor_version, algorithm_version, status, page_count, character_count, started_at, completed_at) values (${extractionId}::uuid, ${projectId}::uuid, ${paper.id}::uuid, ${documentId}::uuid, 'fixture', '1', '1', 'succeeded', 1, ${Array.from(text).length}, now(), now())`;
      await tx`insert into document_text_extraction_pages (id, project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count) values (${pageId}::uuid, ${projectId}::uuid, ${paper.id}::uuid, ${extractionId}::uuid, 1, 'succeeded', ${text}, ${Array.from(text).length})`;
    });
    return { paper: { id: paper.id, title: paper.title }, field: { id: field.id, name: field.name }, documentId, extractionId, pageId, text };
  }

  async function createFixture(count = 1, names?: string[], fieldType: "short_text" | "single_select" = "short_text") {
    const project = await services.createProject({ title: `Slice 31 batch project ${randomUUID()}` });
    const cells: Cell[] = [];
    for (let index = 0; index < count; index += 1) cells.push(await createCell(project.id, index + 1, names?.[index] ?? `Outcome ${index + 1}`, fieldType));
    return { project, cells };
  }

  function makeServices(provider: ExtractionSuggestionProvider, providerAvailable = true) {
    const suggestions = createAiExtractionSuggestionServices(db, provider, { defaultModel: "fake-model", defaultReasoningEffort: "low" });
    return createAiExtractionBatchServices(db, suggestions, { configuredModel: "fake-model", providerAvailable });
  }

  async function previewAndCreate(projectId: string, cells: readonly Cell[], batches: ReturnType<typeof createAiExtractionBatchServices>) {
    const preview = await batches.previewAiExtractionBatch({ projectId, items: cells.map((cell) => ({ paperId: cell.paper.id, fieldId: cell.field.id, fullTextDocumentId: cell.documentId, documentTextExtractionId: cell.extractionId, idempotencyKey: randomUUID() })), externalTransmissionAcknowledged: true });
    const batch = await batches.createAiExtractionBatch(preview, preview.confirmationHash);
    return { preview, batch };
  }

  async function addExtraction(cell: Cell, sequence: number, status: "succeeded" | "partial" | "failed") {
    void sequence;
    const extractionId = randomUUID();
    const withPage = status !== "failed";
    const partial = status === "partial";
    const startedAt = new Date(Date.now() - 1000).toISOString();
    await client.begin(async (tx) => {
      await tx`insert into document_text_extractions (id, project_id, paper_id, full_text_document_id, extractor_key, extractor_version, algorithm_version, status, page_count, character_count, started_at, completed_at) values (${extractionId}::uuid, (select project_id from papers where id=${cell.paper.id}::uuid), ${cell.paper.id}::uuid, ${cell.documentId}::uuid, 'fixture', '1', '1', ${status}, ${withPage ? (partial ? 2 : 1) : null}, ${withPage ? Array.from(cell.text).length : null}, ${startedAt}, ${withPage ? new Date().toISOString() : null})`;
      if (withPage) {
        await tx`insert into document_text_extraction_pages (id, project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count) values (${randomUUID()}::uuid, (select project_id from papers where id=${cell.paper.id}::uuid), ${cell.paper.id}::uuid, ${extractionId}::uuid, 1, 'succeeded', ${cell.text}, ${Array.from(cell.text).length})`;
        if (partial) await tx`insert into document_text_extraction_pages (id, project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count, error_code) values (${randomUUID()}::uuid, (select project_id from papers where id=${cell.paper.id}::uuid), ${cell.paper.id}::uuid, ${extractionId}::uuid, 2, 'failed', '', 0, 'fixture_failed_page')`;
      }
    });
    return extractionId;
  }

  it("uses complete provider-input validation during preview and never calls the provider", async () => {
    const { project, cells } = await createFixture();
    const provider = new InstrumentedProvider();
    const batches = makeServices(provider);
    await client`update extraction_fields set description=${"x".repeat(330_000)} where project_id=${project.id}::uuid and id=${cells[0].field.id}::uuid`;
    const preview = await batches.previewAiExtractionBatch({ projectId: project.id, items: [{ paperId: cells[0].paper.id, fieldId: cells[0].field.id, fullTextDocumentId: cells[0].documentId, documentTextExtractionId: cells[0].extractionId, idempotencyKey: randomUUID() }], externalTransmissionAcknowledged: true });
    expect(preview.items[0]).toMatchObject({ initialDisposition: "ineligible", initialReasonCode: "stale_source_limits" });
    expect(provider.invocationCount).toBe(0);
  });

  it("keeps a failed newer extraction from superseding the latest non-failed source", async () => {
    const { project, cells } = await createFixture();
    await addExtraction(cells[0], 2, "failed");
    const provider = new InstrumentedProvider();
    const batches = makeServices(provider);
    const { preview, batch } = await previewAndCreate(project.id, cells, batches);
    expect(preview.items[0]).toMatchObject({ initialDisposition: "executable" });
    const processed = await batches.executeAiExtractionBatch(project.id, batch.batchId);
    expect(processed.items[0]).toMatchObject({ state: "suggestion_ready" });
    expect(provider.invocationCount).toBe(1);
  });

  it.each(["succeeded", "partial"] as const)("stales a pinned source behind a newer %s non-failed extraction", async (status) => {
    const { project, cells } = await createFixture();
    const provider = new InstrumentedProvider();
    const batches = makeServices(provider);
    const { batch } = await previewAndCreate(project.id, cells, batches);
    await addExtraction(cells[0], 2, status);
    const currentPreview = await batches.previewAiExtractionBatch({ projectId: project.id, items: [{ paperId: cells[0].paper.id, fieldId: cells[0].field.id, fullTextDocumentId: cells[0].documentId, documentTextExtractionId: cells[0].extractionId, idempotencyKey: randomUUID() }], externalTransmissionAcknowledged: true });
    expect(currentPreview.items[0]).toMatchObject({ initialDisposition: "ineligible", initialReasonCode: "stale_text_extraction" });
    const processed = await batches.executeAiExtractionBatch(project.id, batch.batchId);
    expect(processed.items[0]).toMatchObject({ state: "stale", terminalCode: "stale_text_extraction" });
    expect(provider.invocationCount).toBe(0);
  });

  it("rejects cross-project execution before mutation or provider work", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const provider = new InstrumentedProvider();
    const batches = makeServices(provider);
    const { batch } = await previewAndCreate(first.project.id, first.cells, batches);
    const before = await client`select (select count(*) from ai_extraction_requests)::int as requests, (select count(*) from ai_extraction_dispatches)::int as dispatches, (select count(*) from ai_extraction_batch_items where batch_id=${batch.batchId}::uuid)::int as items`;
    await expect(batches.executeAiExtractionBatch(second.project.id, batch.batchId)).rejects.toMatchObject({ code: "CROSS_PROJECT_REFERENCE" });
    const after = await client`select (select count(*) from ai_extraction_requests)::int as requests, (select count(*) from ai_extraction_dispatches)::int as dispatches, (select count(*) from ai_extraction_batch_items where batch_id=${batch.batchId}::uuid)::int as items`;
    expect(after).toEqual(before);
    expect(provider.invocationCount).toBe(0);
  });

  it("links an unresolved request as blocking both before and after batch creation", async () => {
    const first = await createFixture(2);
    const provider = new InstrumentedProvider();
    const suggestions = createAiExtractionSuggestionServices(db, provider, { defaultModel: "fake-model", defaultReasoningEffort: "low" });
    const batches = createAiExtractionBatchServices(db, suggestions, { configuredModel: "fake-model" });
    const unresolved = await suggestions.beginAiExtractionSuggestion({ projectId: first.project.id, paperId: first.cells[0].paper.id, fieldId: first.cells[0].field.id, fullTextDocumentId: first.cells[0].documentId, documentTextExtractionId: first.cells[0].extractionId, idempotencyKey: randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-extraction-transmission-v1" });
    const { preview, batch } = await previewAndCreate(first.project.id, first.cells, batches);
    expect(preview.items.find((item) => item.paperId === first.cells[0].paper.id)).toMatchObject({ initialDisposition: "blocked", initialReasonCode: "blocked_existing_request" });
    const linked = (await batches.getAiExtractionBatch(batch.batchId, first.project.id))!.items.find((item) => item.paperId === first.cells[0].paper.id)!;
    expect(linked).toMatchObject({ state: "blocked", requestId: unresolved.requestId, requestRelationship: "blocking", terminalCode: "blocked_existing_request" });
    const beforeRequests = await client`select count(*)::int as count from ai_extraction_requests where project_id=${first.project.id}::uuid`;
    const afterCreated = await batches.executeAiExtractionBatch(first.project.id, batch.batchId);
    expect(afterCreated.items.find((item) => item.paperId === first.cells[0].paper.id)).toMatchObject({ state: "blocked", requestId: unresolved.requestId });
    expect(await client`select count(*)::int as count from ai_extraction_requests where project_id=${first.project.id}::uuid`).toEqual([{ count: Number(beforeRequests[0].count) + 1 }]);

    const late = await createFixture();
    const lateProvider = new InstrumentedProvider();
    const lateSuggestions = createAiExtractionSuggestionServices(db, lateProvider, { defaultModel: "fake-model", defaultReasoningEffort: "low" });
    const lateBatches = createAiExtractionBatchServices(db, lateSuggestions, { configuredModel: "fake-model" });
    const lateBatch = await previewAndCreate(late.project.id, late.cells, lateBatches);
    const lateRequest = await lateSuggestions.beginAiExtractionSuggestion({ projectId: late.project.id, paperId: late.cells[0].paper.id, fieldId: late.cells[0].field.id, fullTextDocumentId: late.cells[0].documentId, documentTextExtractionId: late.cells[0].extractionId, idempotencyKey: randomUUID(), externalTransmissionAcknowledged: true, disclosureVersion: "openai-extraction-transmission-v1" });
    const lateProcessed = await lateBatches.executeAiExtractionBatch(late.project.id, lateBatch.batch.batchId);
    expect(lateProcessed.items[0]).toMatchObject({ state: "blocked", requestId: lateRequest.requestId, requestRelationship: "blocking", terminalCode: "blocked_existing_request" });
    expect(lateProvider.invocationCount).toBe(0);
  });

  it("stales screening and field mutations without provider calls", async () => {
    const screening = await createFixture();
    const screeningProvider = new InstrumentedProvider();
    const screeningBatches = makeServices(screeningProvider);
    const screeningBatch = await previewAndCreate(screening.project.id, screening.cells, screeningBatches);
    await services.recordScreeningDecision(screening.project.id, screening.cells[0].paper.id, { decision: "include" });
    expect((await screeningBatches.executeAiExtractionBatch(screening.project.id, screeningBatch.batch.batchId)).items[0]).toMatchObject({ state: "stale", terminalCode: "stale_screening" });
    expect(screeningProvider.invocationCount).toBe(0);

    for (const mutation of ["archive", "rename", "description", "required", "type"] as const) {
      const value = await createFixture();
      const mutationProvider = new InstrumentedProvider();
      const mutationBatches = makeServices(mutationProvider);
      const mutationBatch = await previewAndCreate(value.project.id, value.cells, mutationBatches);
      if (mutation === "archive") await services.archiveExtractionField(value.project.id, value.cells[0].field.id);
      if (mutation === "rename") await services.updateExtractionField(value.project.id, value.cells[0].field.id, { name: "Renamed field" });
      if (mutation === "description") await services.updateExtractionField(value.project.id, value.cells[0].field.id, { description: "Changed description" });
      if (mutation === "required") await services.updateExtractionField(value.project.id, value.cells[0].field.id, { required: false });
      if (mutation === "type") await client`update extraction_fields set field_type='long_text' where project_id=${value.project.id}::uuid and id=${value.cells[0].field.id}::uuid`;
      const processed = await mutationBatches.executeAiExtractionBatch(value.project.id, mutationBatch.batch.batchId);
      expect(processed.items[0], mutation).toMatchObject({ state: "stale", terminalCode: "stale_field" });
      expect(mutationProvider.invocationCount, mutation).toBe(0);
    }
  });

  it("stales single-select option vocabulary changes", async () => {
    for (const mutation of ["add", "archive", "rename", "sort"] as const) {
      const value = await createFixture(1, undefined, "single_select");
      const option = (await services.listExtractionOptions(value.project.id, value.cells[0].field.id, true))[0];
      const provider = new InstrumentedProvider();
      const batches = makeServices(provider);
      const batch = await previewAndCreate(value.project.id, value.cells, batches);
      if (mutation === "add") await services.createExtractionOption(value.project.id, { fieldId: value.cells[0].field.id, label: "No" });
      if (mutation === "archive") await services.archiveExtractionOption(value.project.id, option.id);
      if (mutation === "rename") await client`update extraction_options set label='Renamed option' where project_id=${value.project.id}::uuid and id=${option.id}::uuid`;
      if (mutation === "sort") await client`update extraction_options set sort_order=5 where project_id=${value.project.id}::uuid and id=${option.id}::uuid`;
      const processed = await batches.executeAiExtractionBatch(value.project.id, batch.batch.batchId);
      expect(processed.items[0], mutation).toMatchObject({ state: "stale", terminalCode: "stale_field" });
      expect(provider.invocationCount, mutation).toBe(0);
    }
  });

  it("stales a manually created canonical revision and preferred-document changes", async () => {
    const revision = await createFixture();
    const revisionProvider = new InstrumentedProvider();
    const revisionBatches = makeServices(revisionProvider);
    const revisionBatch = await previewAndCreate(revision.project.id, revision.cells, revisionBatches);
    await services.reviseExtractionValue(revision.project.id, revision.cells[0].paper.id, revision.cells[0].field.id, { state: "cleared", researcherNote: "manual clear", evidenceIds: [] });
    const revisionProcessed = await revisionBatches.executeAiExtractionBatch(revision.project.id, revisionBatch.batch.batchId);
    expect(revisionProcessed.items[0]).toMatchObject({ state: "stale", terminalCode: "stale_current_revision" });
    expect(revisionProvider.invocationCount).toBe(0);

    for (const mutation of ["switch", "clear", "archive"] as const) {
      const value = await createFixture();
      const secondDocumentId = randomUUID();
      await client`insert into full_text_documents (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256, storage_state, staged_storage_key) values (${secondDocumentId}::uuid, ${value.project.id}::uuid, ${value.cells[0].paper.id}::uuid, ${`projects/${value.project.id}/papers/${value.cells[0].paper.id}/documents/${secondDocumentId}/source.pdf`}, 'second.pdf', 'application/pdf', 8, ${"b".repeat(64)}, 'ready', null)`;
      const provider = new InstrumentedProvider();
      const batches = makeServices(provider);
      const batch = await previewAndCreate(value.project.id, value.cells, batches);
      if (mutation === "switch") await services.setPreferredFullTextDocument(value.project.id, value.cells[0].paper.id, secondDocumentId);
      if (mutation === "clear") await services.clearPreferredFullTextDocument(value.project.id, value.cells[0].paper.id);
      if (mutation === "archive") { await services.clearPreferredFullTextDocument(value.project.id, value.cells[0].paper.id); await client`update full_text_documents set archived_at=now() where project_id=${value.project.id}::uuid and id=${value.cells[0].documentId}::uuid`; }
      const processed = await batches.executeAiExtractionBatch(value.project.id, batch.batch.batchId);
      expect(processed.items[0], mutation).toMatchObject({ state: "stale", terminalCode: "stale_full_text_document" });
      expect(provider.invocationCount, mutation).toBe(0);
    }
  });

  it("reuses exactly one successful undecided request and is safe under repeated processing", async () => {
    const value = await createFixture();
    const provider = new InstrumentedProvider();
    const batches = makeServices(provider);
    const first = await previewAndCreate(value.project.id, value.cells, batches);
    const processed = await batches.executeAiExtractionBatch(value.project.id, first.batch.batchId);
    const requestId = processed.batchId && processed.items[0].requestId;
    expect(requestId).toBeTruthy();
    const secondPreview = await batches.previewAiExtractionBatch({ projectId: value.project.id, items: [{ paperId: value.cells[0].paper.id, fieldId: value.cells[0].field.id, fullTextDocumentId: value.cells[0].documentId, documentTextExtractionId: value.cells[0].extractionId, idempotencyKey: randomUUID() }], externalTransmissionAcknowledged: true });
    expect(secondPreview.items[0]).toMatchObject({ initialDisposition: "reusable" });
    const second = await batches.createAiExtractionBatch(secondPreview, secondPreview.confirmationHash);
    const reused = await batches.executeAiExtractionBatch(value.project.id, second.batchId);
    await batches.executeAiExtractionBatch(value.project.id, second.batchId);
    expect(reused.items[0]).toMatchObject({ requestId, requestRelationship: "authoritative", state: "suggestion_ready" });
    expect(provider.invocationCount).toBe(1);
    expect(await client`select count(*)::int as count from ai_extraction_requests where project_id=${value.project.id}::uuid and paper_id=${value.cells[0].paper.id}::uuid and extraction_field_id=${value.cells[0].field.id}::uuid`).toEqual([{ count: 1 }]);
    expect(await client`select idempotency_key from ai_extraction_batch_items where project_id=${value.project.id}::uuid order by created_at, item_ordinal`).toHaveLength(2);
  });

  it("wins cross-batch and same-batch collisions with one request and one dispatch", async () => {
    const value = await createFixture();
    const provider = new InstrumentedProvider(() => "candidate", true);
    const batches = makeServices(provider);
    const first = await previewAndCreate(value.project.id, value.cells, batches);
    const secondPreview = await batches.previewAiExtractionBatch({ projectId: value.project.id, items: [{ paperId: value.cells[0].paper.id, fieldId: value.cells[0].field.id, fullTextDocumentId: value.cells[0].documentId, documentTextExtractionId: value.cells[0].extractionId, idempotencyKey: randomUUID() }], externalTransmissionAcknowledged: true });
    const second = await batches.createAiExtractionBatch(secondPreview, secondPreview.confirmationHash);
    const firstRun = batches.executeAiExtractionBatch(value.project.id, first.batch.batchId);
    await provider.started;
    const secondRun = batches.executeAiExtractionBatch(value.project.id, second.batchId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    provider.releaseProvider();
    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
    expect(provider.invocationCount).toBe(1);
    expect(await client`select count(*)::int as count from ai_extraction_requests where project_id=${value.project.id}::uuid and paper_id=${value.cells[0].paper.id}::uuid and extraction_field_id=${value.cells[0].field.id}::uuid`).toEqual([{ count: 1 }]);
    expect(await client`select count(*)::int as count from ai_extraction_dispatches where project_id=${value.project.id}::uuid and request_id=${firstResult.items[0].requestId}::uuid`).toEqual([{ count: 1 }]);
    expect([firstResult.items[0].state, secondResult.items[0].state].sort()).toEqual(["blocked", "suggestion_ready"]);

    const sameBatch = await createFixture(2);
    const sameProvider = new InstrumentedProvider(() => "candidate", false, 10);
    const sameBatches = makeServices(sameProvider);
    const same = await previewAndCreate(sameBatch.project.id, sameBatch.cells, sameBatches);
    await Promise.all([sameBatches.executeAiExtractionBatch(sameBatch.project.id, same.batch.batchId), sameBatches.executeAiExtractionBatch(sameBatch.project.id, same.batch.batchId)]);
    expect(sameProvider.invocationCount).toBe(2);
    expect(await client`select count(*)::int as count from ai_extraction_requests where project_id=${sameBatch.project.id}::uuid`).toEqual([{ count: 2 }]);
    expect(await client`select count(*)::int as count from ai_extraction_dispatches where project_id=${sameBatch.project.id}::uuid`).toEqual([{ count: 2 }]);
  });

  it("keeps cancellation atomic before dispatch and preserves an in-flight suggestion after cancellation", async () => {
    const before = await createFixture();
    const beforeProvider = new InstrumentedProvider();
    const beforeBatches = makeServices(beforeProvider);
    const beforeBatch = await previewAndCreate(before.project.id, before.cells, beforeBatches);
    await beforeBatches.cancelAiExtractionBatch(beforeBatch.batch.batchId, before.project.id);
    const beforeProcessed = await beforeBatches.executeAiExtractionBatch(before.project.id, beforeBatch.batch.batchId);
    expect(beforeProcessed.items[0]).toMatchObject({ state: "cancelled" });
    expect(beforeProvider.invocationCount).toBe(0);
    expect(await client`select count(*)::int as count from ai_extraction_requests where project_id=${before.project.id}::uuid`).toEqual([{ count: 0 }]);

    const during = await createFixture();
    const duringProvider = new InstrumentedProvider(() => "candidate", true);
    const duringBatches = makeServices(duringProvider);
    const duringBatch = await previewAndCreate(during.project.id, during.cells, duringBatches);
    const execution = duringBatches.executeAiExtractionBatch(during.project.id, duringBatch.batch.batchId);
    await duringProvider.started;
    await duringBatches.cancelAiExtractionBatch(duringBatch.batch.batchId, during.project.id);
    duringProvider.releaseProvider();
    const completed = await execution;
    expect(completed.cancelledAt).toBeInstanceOf(Date);
    expect(completed.items[0]).toMatchObject({ state: "suggestion_ready" });
    expect(await client`select count(*)::int as count from ai_extraction_results where project_id=${during.project.id}::uuid`).toEqual([{ count: 1 }]);
    expect(await client`select count(*)::int as count from extraction_value_revisions where project_id=${during.project.id}::uuid`).toEqual([{ count: 0 }]);
  });

  it("processes mixed terminal outcomes in bounded chunks without retransmission", async () => {
    const value = await createFixture(6, ["Candidate", "No candidate", "Failure", "Invalid", "Unresolvable", "Unknown"]);
    const provider = new InstrumentedProvider((input) => {
      const name = input.field.name.toLowerCase();
      if (name.includes("no candidate")) return "no_candidate";
      if (name.includes("failure")) return "failure";
      if (name.includes("invalid")) return "invalid";
      if (name.includes("unresolvable")) return "unresolvable";
      if (name.includes("unknown")) return "unknown";
      return "candidate";
    });
    const batches = makeServices(provider);
    const { batch } = await previewAndCreate(value.project.id, value.cells, batches);
    await batches.executeAiExtractionBatch(value.project.id, batch.batchId);
    await batches.executeAiExtractionBatch(value.project.id, batch.batchId);
    const processed = await batches.executeAiExtractionBatch(value.project.id, batch.batchId);
    const states = processed.items.reduce<Record<string, number>>((all, item) => { all[item.state] = (all[item.state] ?? 0) + 1; return all; }, {});
    expect(states).toMatchObject({ suggestion_ready: 1, no_candidate: 1, failed: 3, outcome_unknown: 1 });
    const invocations = provider.invocationCount;
    await batches.executeAiExtractionBatch(value.project.id, batch.batchId);
    expect(provider.invocationCount).toBe(invocations);
    expect(provider.maxActive).toBeLessThanOrEqual(2);
  });

  it("enforces a maximum of two provider calls per action and keeps durable resume state", async () => {
    const value = await createFixture(3);
    const provider = new InstrumentedProvider(() => "candidate", false, 15);
    const batches = makeServices(provider);
    const { batch } = await previewAndCreate(value.project.id, value.cells, batches);
    const first = await batches.executeAiExtractionBatch(value.project.id, batch.batchId);
    expect(provider.invocationCount).toBe(2);
    expect(first.items.filter((item) => item.state === "suggestion_ready")).toHaveLength(2);
    const second = await batches.executeAiExtractionBatch(value.project.id, batch.batchId);
    expect(provider.invocationCount).toBe(3);
    expect(second.items.filter((item) => item.state === "suggestion_ready")).toHaveLength(3);
    expect(provider.maxActive).toBeLessThanOrEqual(2);
  });
});
