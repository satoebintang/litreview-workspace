import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { idSchema } from "@/domain/validation";
import {
  AI_EXTRACTION_LIMITS,
  type ExtractionSuggestionProvider,
  type ExtractionSuggestionInput,
  validateProviderSuggestion,
  validateSuggestionInput,
  type ProviderSuggestionResult,
} from "@/application/ai/extraction-suggestion-provider";
import { resolveSuggestionGroundings } from "@/application/ai/extraction-suggestion-grounding";
import { requireEvidenceUsableForNewDirectSupport } from "@/application/evidence-curation-services";
import { writeExtractedExtractionRevision } from "@/application/extraction-value-writer";
import { lockExtractionEvidenceRowsForUpdate } from "@/application/repositories/extraction";
import { derivePaperReviewStatus, isFinallyIncluded } from "@/domain/paper-review";
import { buildPinnedExtractionPageManifest, hashFieldSnapshot, hashOptionSnapshot, hashSourceSnapshot, hashSuggestionIntent, canonicalUuid, type BatchFieldSnapshot, type BatchPinnedSourceInput } from "@/application/ai-extraction-batch-domain";
import { withSerializableRetry, type DatabaseTransaction } from "@/application/serializable-retry";

type Executor = Pick<Database, "execute">;
type Outcome = "succeeded" | "no_candidate" | "provider_unavailable" | "failed" | "invalid_output" | "unresolvable_grounding" | "outcome_unknown";
type TerminalOverride = { outcome: Outcome; diagnostic: "success" | "refusal" | "incomplete" | "schema_invalid" | "transport_error" | "api_error" | "unknown"; errorCode: string | null };

export type BeginAiExtractionSuggestionInput = { projectId: string; paperId: string; fieldId: string; fullTextDocumentId: string; documentTextExtractionId: string; pageNumbers?: number[]; idempotencyKey: string; model?: string; reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"; externalTransmissionAcknowledged: boolean; disclosureVersion: string };
export type AcceptAiExtractionSuggestionInput = { requestId: string; projectId: string; mode: "accept" | "edit_and_accept"; expectedCurrentRevisionId: string | null; state?: "present" | "not_reported" | "not_applicable" | "cleared"; value?: string | boolean; researcherNote?: string | null; groundingIds: string[]; reusedEvidenceByGroundingId?: Record<string, string> };
export type AiExtractionSuggestionServices = { beginAiExtractionSuggestion(input: BeginAiExtractionSuggestionInput): Promise<Record<string, unknown>>; executeAiExtractionSuggestion(requestId: string, projectId?: string): Promise<Record<string, unknown>>; expireAiExtractionSuggestion(requestId: string, projectId?: string): Promise<Record<string, unknown>>; getAiExtractionSuggestion(requestId: string, projectId?: string): Promise<Record<string, unknown>>; listAiExtractionSuggestions(projectId: string, paperId: string, fieldId?: string): Promise<Record<string, unknown>[]>; acceptAiExtractionSuggestion(input: AcceptAiExtractionSuggestionInput): Promise<Record<string, unknown>>; rejectAiExtractionSuggestion(projectId: string, requestId: string): Promise<Record<string, unknown>>; _batchTransactionSeams: AiExtractionBatchTransactionSeams };

const REQUEST_EXPIRY_MS = 5 * 60_000;
const PROVIDER_TIMEOUT_MS = 45_000;
function rows(value: unknown): Record<string, unknown>[] { return value as Record<string, unknown>[]; }
function id(value: string, label: string): string { const parsed = idSchema.safeParse(value); if (!parsed.success) throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`); return parsed.data.toLowerCase(); }
function asDate(value: unknown): Date | null { if (value == null) return null; const date = value instanceof Date ? value : new Date(String(value)); return Number.isNaN(date.getTime()) ? null : date; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function textHash(value: string): string { return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex"); }
function pageManifestHash(paperId: string, extractionId: string, pages: readonly Record<string, unknown>[]): string {
  return buildPinnedExtractionPageManifest({
    paper: { projectId: "00000000-0000-0000-0000-000000000000", paperId, title: "", finallyIncluded: true },
    document: { id: "00000000-0000-0000-0000-000000000000", paperId, archivedAt: null },
    extraction: { id: extractionId, paperId, fullTextDocumentId: "00000000-0000-0000-0000-000000000000", sequence: 0, status: "succeeded" },
    pages: pages.map((page) => ({ id: String(page.id), paperId, documentTextExtractionId: extractionId, pageNumber: Number(page.page_number), status: "succeeded", text: String(page.text) })),
  }).hash;
}
function normalizedDecimal(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart, fractionPart = ""] = unsigned.split(".");
  const integer = integerPart.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionPart.replace(/0+$/, "");
  const normalized = fraction ? `${integer}.${fraction}` : integer;
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}
function mapRequest(row: Record<string, unknown>) { return { id: String(row.id), projectId: String(row.project_id), paperId: String(row.paper_id), fieldId: String(row.extraction_field_id), fullTextDocumentId: String(row.full_text_document_id), documentTextExtractionId: String(row.document_text_extraction_id), baselineRevisionId: row.baseline_extraction_revision_id == null ? null : String(row.baseline_extraction_revision_id), idempotencyKey: String(row.idempotency_key), fieldName: String(row.field_name_snapshot), fieldDescription: row.field_description_snapshot == null ? null : String(row.field_description_snapshot), fieldType: String(row.field_type), optionSnapshot: Array.isArray(row.option_snapshot) ? row.option_snapshot : [], provider: String(row.provider), model: String(row.configured_model), reasoningEffort: String(row.configured_reasoning_effort), promptVersion: String(row.prompt_version), responseSchemaVersion: String(row.response_schema_version), sourceCharacterCount: Number(row.source_character_count), sourceByteSize: Number(row.source_byte_size), createdAt: asDate(row.created_at), finalizedAt: asDate(row.finalized_at), disclosureVersion: String(row.disclosure_version) }; }
function mapResult(row: Record<string, unknown>) { return { id: String(row.id), requestId: String(row.request_id), outcome: String(row.outcome), providerDiagnostic: String(row.provider_diagnostic), errorCode: row.error_code == null ? null : String(row.error_code), state: row.candidate_state == null ? null : String(row.candidate_state), value: row.text_value ?? row.number_value ?? row.boolean_value ?? row.option_id ?? null, explanation: row.explanation == null ? null : String(row.explanation), providerResponseId: row.provider_request_id == null ? null : String(row.provider_request_id), configuredModel: row.configured_model == null ? null : String(row.configured_model), returnedModel: row.returned_model == null ? null : String(row.returned_model), inputTokens: row.input_tokens == null ? null : Number(row.input_tokens), outputTokens: row.output_tokens == null ? null : Number(row.output_tokens), durationMs: row.duration_ms == null ? null : Number(row.duration_ms), createdAt: asDate(row.created_at), finalizedAt: asDate(row.finalized_at) }; }
function outcomeOf(result: ProviderSuggestionResult): { outcome: Outcome; diagnostic: string; errorCode: string | null } { if (result.kind === "success") return { outcome: result.suggestion.outcome === "no_candidate" ? "no_candidate" : "succeeded", diagnostic: "success", errorCode: null }; if (result.failure === "provider_refusal") return { outcome: "failed", diagnostic: "refusal", errorCode: result.code }; if (result.failure === "provider_incomplete") return { outcome: "failed", diagnostic: "incomplete", errorCode: result.code }; if (result.failure === "schema_invalid") return { outcome: "invalid_output", diagnostic: "schema_invalid", errorCode: result.code }; if (result.failure === "api_error") return { outcome: result.code === "configuration_missing" ? "provider_unavailable" : "failed", diagnostic: "api_error", errorCode: result.code }; return { outcome: "outcome_unknown", diagnostic: "transport_error", errorCode: result.code }; }

export interface AiExtractionSuggestionServiceOptions {
  defaultModel?: string;
  defaultReasoningEffort?: ExtractionSuggestionInput["reasoningEffort"];
}

export type AiExtractionBatchTransactionSeams = {
  planRequestInTransaction: (tx: DatabaseTransaction, input: BeginAiExtractionSuggestionInput, options?: { locksAlreadyHeld?: boolean; previewOnly?: boolean; batchStrict?: boolean }) => Promise<Record<string, unknown>>;
  claimDispatchInTransaction: (tx: DatabaseTransaction, requestId: string, options?: { batchStrict?: boolean }) => Promise<Record<string, unknown>>;
  runClaimedAiExtractionDispatch: (claim: Record<string, unknown>) => Promise<Record<string, unknown>>;
  executeRequest: (requestId: string, projectId?: string, hooks?: { beforeProvider?: () => boolean }) => Promise<Record<string, unknown>>;
};

export function createAiExtractionSuggestionServices(
  db: Database,
  provider?: ExtractionSuggestionProvider,
  options: AiExtractionSuggestionServiceOptions = {},
): AiExtractionSuggestionServices {
  const defaultModel = options.defaultModel?.trim() || "gpt-5.6-luna";
  const defaultReasoningEffort = options.defaultReasoningEffort ?? "low";
  // A normalized provider result is retained only until its durable result
  // write succeeds. This permits a persistence retry without another provider
  // invocation while keeping ambiguous transport outcomes terminal.
  const pendingPersistence = new Map<string, ProviderSuggestionResult>();
  async function request(requestId: string, executor: Executor = db, lock = false) { const found = rows(await executor.execute(lock ? sql`select * from ai_extraction_requests where id=${requestId}::uuid limit 1 for update` : sql`select * from ai_extraction_requests where id=${requestId}::uuid limit 1`))[0]; if (!found) throw new DomainError("NOT_FOUND", "AI extraction request was not found"); return found; }
  async function result(requestId: string, executor: Executor = db) { return rows(await executor.execute(sql`select * from ai_extraction_results where request_id=${requestId}::uuid limit 1`))[0] ?? null; }
  async function sourcePages(req: Record<string, unknown>, executor: Executor = db) { return rows(await executor.execute(sql`select rp.page_id,rp.page_number,p.text,p.status,p.character_count from ai_extraction_request_pages rp join document_text_extraction_pages p on p.project_id=rp.project_id and p.id=rp.page_id where rp.project_id=${String(req.project_id)}::uuid and rp.request_id=${String(req.id)}::uuid order by rp.page_ordinal`)); }
  async function sourceCoverage(req: Record<string, unknown>, executor: Executor = db) {
    const extraction = rows(await executor.execute(sql`select status from document_text_extractions where project_id=${String(req.project_id)}::uuid and paper_id=${String(req.paper_id)}::uuid and full_text_document_id=${String(req.full_text_document_id)}::uuid and id=${String(req.document_text_extraction_id)}::uuid limit 1`))[0];
    const omitted = rows(await executor.execute(sql`select count(*)::int as count from document_text_extraction_pages where project_id=${String(req.project_id)}::uuid and paper_id=${String(req.paper_id)}::uuid and document_text_extraction_id=${String(req.document_text_extraction_id)}::uuid and (status <> 'succeeded' or character_count <= 0)`))[0];
    return {
      extractionId: String(req.document_text_extraction_id),
      documentId: String(req.full_text_document_id),
      status: String(extraction?.status) === "partial" ? "partial" as const : "succeeded" as const,
      omittedPageCount: Number(omitted?.count ?? 0),
    };
  }
  async function requireRequestSourceEligible(req: Record<string, unknown>, executor: Executor) {
    const document = rows(await executor.execute(sql`select archived_at,storage_state from full_text_documents where project_id=${String(req.project_id)}::uuid and paper_id=${String(req.paper_id)}::uuid and id=${String(req.full_text_document_id)}::uuid limit 1`))[0];
    if (!document) throw new DomainError("CROSS_PROJECT_REFERENCE", "The frozen source document no longer exists");
    if (document.storage_state !== "ready") throw new DomainError("STORAGE_PENDING", "The frozen source document is still being materialized");
    if (document.archived_at) throw new DomainError("DOCUMENT_ARCHIVED", "The frozen source document is archived and cannot be accepted");
    const extraction = rows(await executor.execute(sql`select status from document_text_extractions where project_id=${String(req.project_id)}::uuid and paper_id=${String(req.paper_id)}::uuid and full_text_document_id=${String(req.full_text_document_id)}::uuid and id=${String(req.document_text_extraction_id)}::uuid limit 1`))[0];
    if (!extraction || !["succeeded", "partial"].includes(String(extraction.status))) throw new DomainError("VALIDATION_ERROR", "The frozen text extraction is no longer eligible");
    const invalidPage = rows(await executor.execute(sql`select 1 from ai_extraction_request_pages rp join document_text_extraction_pages p on p.project_id=rp.project_id and p.id=rp.page_id where rp.project_id=${String(req.project_id)}::uuid and rp.request_id=${String(req.id)}::uuid and (p.status <> 'succeeded' or p.character_count <= 0) limit 1`))[0];
    if (invalidPage) throw new DomainError("VALIDATION_ERROR", "A frozen AI source page is no longer eligible");
  }
  async function requireRequestFieldEligible(req: Record<string, unknown>, executor: Executor, lock = false) {
    const fieldQuery = lock
      ? sql`select name, description, field_type, archived_at from extraction_fields where project_id=${String(req.project_id)}::uuid and id=${String(req.extraction_field_id)}::uuid limit 1 for update`
      : sql`select name, description, field_type, archived_at from extraction_fields where project_id=${String(req.project_id)}::uuid and id=${String(req.extraction_field_id)}::uuid limit 1`;
    const field = rows(await executor.execute(fieldQuery))[0];
    if (!field || field.archived_at) throw new DomainError("VALIDATION_ERROR", "The frozen extraction field is no longer active");
    if (String(field.field_type) !== String(req.field_type)) throw new DomainError("VALIDATION_ERROR", "The extraction field type changed after this AI request was created");
    const currentDescription = field.description == null ? null : String(field.description);
    const frozenDescription = req.field_description_snapshot == null ? null : String(req.field_description_snapshot);
    if (String(field.name) !== String(req.field_name_snapshot) || currentDescription !== frozenDescription) throw new DomainError("VALIDATION_ERROR", "The frozen extraction field definition changed after this AI request was created");
  }
  async function requireFinallyIncludedPaperLocked(tx: Executor, projectId: string, paperId: string) {
    const review = rows(await tx.execute(sql`
      with latest_title_abstract as (
        select decision from screening_decisions
        where project_id=${projectId}::uuid and paper_id=${paperId}::uuid and stage='title_abstract'
        order by sequence desc limit 1
      ), latest_full_text as (
        select decision from full_text_screening_decisions
        where project_id=${projectId}::uuid and paper_id=${paperId}::uuid
        order by sequence desc limit 1
      ), latest_retrieval as (
        select outcome from full_text_retrieval_attempts
        where project_id=${projectId}::uuid and paper_id=${paperId}::uuid
        order by sequence desc limit 1
      )
      select
        (select decision from latest_title_abstract) as title_abstract_decision,
        (select decision from latest_full_text) as full_text_decision,
        (select outcome from latest_retrieval) as full_text_retrieval_state,
        exists(select 1 from full_text_retrieval_attempts where project_id=${projectId}::uuid and paper_id=${paperId}::uuid) as has_full_text_retrieval_attempts,
        exists(select 1 from full_text_retrieval_attempts where project_id=${projectId}::uuid and paper_id=${paperId}::uuid and outcome='retrieved') as ever_retrieved,
        exists(select 1 from extraction_value_revisions where project_id=${projectId}::uuid and paper_id=${paperId}::uuid and finalized_at is not null) as has_analytical_history
    `))[0];
    if (!review) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
    const status = derivePaperReviewStatus({
      titleAbstractDecision: review.title_abstract_decision === "include" || review.title_abstract_decision === "exclude" || review.title_abstract_decision === "maybe" ? review.title_abstract_decision : null,
      fullTextDecision: review.full_text_decision === "include" || review.full_text_decision === "exclude" || review.full_text_decision === "maybe" ? review.full_text_decision : null,
      fullTextRetrievalState: review.full_text_retrieval_state === "pending" || review.full_text_retrieval_state === "unavailable" || review.full_text_retrieval_state === "retrieved" ? review.full_text_retrieval_state : "not_sought",
      everRetrieved: Boolean(review.ever_retrieved),
      hasFullTextRetrievalAttempts: Boolean(review.has_full_text_retrieval_attempts),
      hasAnalyticalHistory: Boolean(review.has_analytical_history),
    });
    if (!isFinallyIncluded(status)) throw new DomainError("VALIDATION_ERROR", "AI extraction suggestions are available only for finally included Papers");
  }

  async function lockBeginEntities(tx: Executor, projectId: string, paperId: string, fieldId: string, documentId: string, extractionId: string) {
    if (!rows(await tx.execute(sql`select id from papers where project_id=${projectId}::uuid and id=${paperId}::uuid for update`))[0]) {
      throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
    }
    await tx.execute(sql`select id from extraction_fields where project_id=${projectId}::uuid and id=${fieldId}::uuid for update`);
    const preferred = rows(await tx.execute(sql`
      select full_text_document_id from paper_full_text_preferences
      where project_id=${projectId}::uuid and paper_id=${paperId}::uuid
      limit 1 for update
    `))[0]?.full_text_document_id;
    const documentIds = [...new Set([preferred, documentId].filter(Boolean).map(String))].sort();
    if (documentIds.length) await tx.execute(sql`select id from full_text_documents where project_id=${projectId}::uuid and paper_id=${paperId}::uuid and id in (${sql.join(documentIds.map((value) => sql`${value}::uuid`), sql`, `)}) order by id for update`);
    await tx.execute(sql`select id from document_text_extractions where project_id=${projectId}::uuid and paper_id=${paperId}::uuid and full_text_document_id=${documentId}::uuid and id=${extractionId}::uuid for update`);
  }

  async function currentNonFailedExtraction(tx: Executor, projectId: string, paperId: string, documentId: string) {
    return rows(await tx.execute(sql`
      select id,status from document_text_extractions
      where project_id=${projectId}::uuid and paper_id=${paperId}::uuid
        and full_text_document_id=${documentId}::uuid and status <> 'failed'
      order by sequence desc, id asc limit 1
    `))[0] ?? null;
  }

  async function requirePinnedSourceCurrent(req: Record<string, unknown>, tx: Executor): Promise<"ok" | "stale_text_extraction" | "stale_full_text_document"> {
    const projectId = String(req.project_id);
    const paperId = String(req.paper_id);
    const documentId = String(req.full_text_document_id);
    const extractionId = String(req.document_text_extraction_id);
    const document = rows(await tx.execute(sql`select id,original_filename,archived_at,storage_state from full_text_documents where project_id=${projectId}::uuid and paper_id=${paperId}::uuid and id=${documentId}::uuid limit 1`))[0];
    if (!document || document.archived_at) return "stale_full_text_document";
    if (document.storage_state !== "ready") return "stale_full_text_document";
    const preferred = rows(await tx.execute(sql`select full_text_document_id from paper_full_text_preferences where project_id=${projectId}::uuid and paper_id=${paperId}::uuid limit 1`))[0];
    if (!preferred || String(preferred.full_text_document_id) !== documentId) return "stale_full_text_document";
    const latest = await currentNonFailedExtraction(tx, projectId, paperId, documentId);
    if (!latest || String(latest.id) !== extractionId || !["succeeded", "partial"].includes(String(latest.status))) return "stale_text_extraction";
    const pages = await sourcePages(req, tx);
    const computedPageManifestHash = pageManifestHash(paperId, extractionId, pages.map((page) => ({ id: page.page_id, page_number: page.page_number, text: page.text })));
    if (pages.length === 0 || pages.some((page) => String(page.status) !== "succeeded" || Number(page.character_count) <= 0) || computedPageManifestHash !== String(req.page_manifest_hash)) return "stale_text_extraction";
    return "ok";
  }

  async function planRequestInTransaction(tx: DatabaseTransaction, input: BeginAiExtractionSuggestionInput, options: { locksAlreadyHeld?: boolean; previewOnly?: boolean; batchStrict?: boolean } = {}) {
    const projectId = id(input.projectId, "Project");
    const paperId = id(input.paperId, "Paper");
    const fieldId = id(input.fieldId, "Field");
    const documentId = id(input.fullTextDocumentId, "Document");
    const extractionId = id(input.documentTextExtractionId, "Extraction");
    const key = id(input.idempotencyKey, "Idempotency key");
    if (!input.externalTransmissionAcknowledged) throw new DomainError("VALIDATION_ERROR", "External transmission must be acknowledged");
    if (!options.locksAlreadyHeld) await lockBeginEntities(tx, projectId, paperId, fieldId, documentId, extractionId);
    await requireFinallyIncludedPaperLocked(tx, projectId, paperId);
    const field = rows(await tx.execute(sql`select id,name,description,field_type,required,sort_order,archived_at from extraction_fields where project_id=${projectId}::uuid and id=${fieldId}::uuid limit 1`))[0];
    if (!field) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction field was not found");
    if (field.archived_at) throw new DomainError("VALIDATION_ERROR", "Archived extraction fields cannot receive AI requests");
    const document = rows(await tx.execute(sql`select id,archived_at,storage_state from full_text_documents where project_id=${projectId}::uuid and paper_id=${paperId}::uuid and id=${documentId}::uuid limit 1`))[0];
    if (!document) throw new DomainError("CROSS_PROJECT_REFERENCE", "Document does not belong to this Paper");
    if (document.storage_state !== "ready") throw new DomainError("STORAGE_PENDING", "Document bytes are still being materialized");
    if (document.archived_at) throw new DomainError("DOCUMENT_ARCHIVED", "Archived documents cannot receive AI requests");
    const extraction = rows(await tx.execute(sql`select id,status,sequence from document_text_extractions where project_id=${projectId}::uuid and paper_id=${paperId}::uuid and full_text_document_id=${documentId}::uuid and id=${extractionId}::uuid limit 1`))[0];
    if (!extraction || !["succeeded", "partial"].includes(String(extraction.status))) throw new DomainError("VALIDATION_ERROR", "Text extraction is not eligible");
    if (options.batchStrict) {
      const preferred = rows(await tx.execute(sql`select full_text_document_id from paper_full_text_preferences where project_id=${projectId}::uuid and paper_id=${paperId}::uuid limit 1`))[0];
      if (!preferred || String(preferred.full_text_document_id) !== documentId) throw new DomainError("VALIDATION_ERROR", "The selected document is not the current preferred document");
      const latest = await currentNonFailedExtraction(tx, projectId, paperId, documentId);
      if (!latest || String(latest.id) !== extractionId || !["succeeded", "partial"].includes(String(latest.status))) throw new DomainError("VALIDATION_ERROR", "Text extraction is not the latest non-failed extraction");
    }
    const allPages = rows(await tx.execute(sql`select id,page_number,status,text,character_count from document_text_extraction_pages where project_id=${projectId}::uuid and paper_id=${paperId}::uuid and document_text_extraction_id=${extractionId}::uuid order by page_number`));
    const selected = input.pageNumbers?.length ? allPages.filter((page) => input.pageNumbers!.includes(Number(page.page_number))) : allPages.filter((page) => page.status === "succeeded" && Number(page.character_count) > 0);
    const points = selected.reduce((sum, page) => sum + Array.from(String(page.text)).length, 0);
    const bytes = options.batchStrict
      ? selected.reduce((sum, page) => sum + Buffer.byteLength(String(page.text), "utf8"), 0) + Math.max(selected.length - 1, 0)
      : Buffer.byteLength(selected.map((page) => String(page.text)).join("\n"), "utf8");
    if (!selected.length || selected.length > AI_EXTRACTION_LIMITS.maxPages || selected.some((page) => page.status !== "succeeded" || Number(page.character_count) <= 0) || points > AI_EXTRACTION_LIMITS.maxSourceCodePoints || bytes > AI_EXTRACTION_LIMITS.maxSerializedInputBytes) throw new DomainError("VALIDATION_ERROR", "Selected pages are empty, failed, or exceed the AI input limit");
    const optionsRows = rows(await tx.execute(sql`select id,label,sort_order from extraction_options where project_id=${projectId}::uuid and field_id=${fieldId}::uuid and archived_at is null order by sort_order,id`));
    const baseline = rows(await tx.execute(sql`select r.id from extraction_values v join extraction_value_revisions r on r.project_id=v.project_id and r.extraction_value_id=v.id where v.project_id=${projectId}::uuid and v.paper_id=${paperId}::uuid and v.field_id=${fieldId}::uuid and r.finalized_at is not null order by r.sequence desc limit 1`))[0]?.id ?? null;
    const model = input.model?.trim() || defaultModel;
    const reasoning = input.reasoningEffort ?? defaultReasoningEffort;
    const disclosureVersion = input.disclosureVersion.trim();
    if (!model || model.length > 200) throw new DomainError("VALIDATION_ERROR", "AI model configuration is invalid");
    if (!(new Set(["none", "minimal", "low", "medium", "high", "xhigh"])).has(reasoning)) throw new DomainError("VALIDATION_ERROR", "AI reasoning configuration is invalid");
    if (!disclosureVersion || disclosureVersion.length > 100) throw new DomainError("VALIDATION_ERROR", "AI transmission disclosure version is invalid");
    const optionSnapshot = optionsRows.map((option) => ({ id: options.batchStrict ? canonicalUuid(String(option.id)) : String(option.id), label: String(option.label), sortOrder: Number(option.sort_order) }));
    const source: BatchPinnedSourceInput = {
      paper: { projectId, paperId, title: "", finallyIncluded: true },
      document: { id: documentId, paperId, archivedAt: null },
      extraction: { id: extractionId, paperId, fullTextDocumentId: documentId, sequence: Number(extraction.sequence), status: String(extraction.status) as "succeeded" | "partial" | "failed" | "pending" | "running" },
      pages: selected.map((page) => ({ id: String(page.id), paperId, documentTextExtractionId: extractionId, pageNumber: Number(page.page_number), status: String(page.status) as "succeeded" | "failed", text: String(page.text) })),
    };
    const pageManifest = buildPinnedExtractionPageManifest(source);
    const fieldSnapshot: BatchFieldSnapshot = { projectId, id: fieldId, name: String(field.name), description: field.description == null ? null : String(field.description), fieldType: String(field.field_type) as BatchFieldSnapshot["fieldType"], required: Boolean(field.required), sortOrder: Number(field.sort_order), archivedAt: field.archived_at == null ? null : String(field.archived_at), options: optionSnapshot.map((option) => ({ ...option, archivedAt: null })) };
    const fieldSnapshotHash = hashFieldSnapshot(fieldSnapshot);
    const optionSnapshotHash = hashOptionSnapshot(fieldSnapshot.options);
    const sourceSnapshotHash = hashSourceSnapshot({ document: source.document, extraction: source.extraction, pageManifest });
    const manifest = pageManifest.pages;
    const versions = { promptVersion: "extraction-suggestion-v1", responseSchemaVersion: "extraction-suggestion-response-v1", groundingResolverVersion: "exact-page-quote-v1", contextSelectionVersion: "selected-pages-v1" };
    const legacyManifest = selected.map((page) => ({ id: String(page.id), pageNumber: Number(page.page_number), hash: textHash(String(page.text)) }));
    const requestPageManifestHash = options.batchStrict ? pageManifest.hash : hash(legacyManifest);
    const providerInput: ExtractionSuggestionInput = { field: { id: String(field.id), name: String(field.name), description: field.description == null ? null : String(field.description), fieldType: String(field.field_type) as ExtractionSuggestionInput["field"]["fieldType"], options: optionsRows.map((option) => ({ id: String(option.id), label: String(option.label), active: true })) }, pages: selected.map((page) => ({ id: String(page.id), pageNumber: Number(page.page_number), text: String(page.text) })), model, reasoningEffort: reasoning, ...versions, sourceCoverage: { extractionId, documentId, status: String(extraction.status) === "partial" ? "partial" : "succeeded", omittedPageCount: allPages.filter((page) => page.status !== "succeeded" || Number(page.character_count) <= 0).length } };
    const providerInputCheck = validateSuggestionInput(providerInput);
    if (!providerInputCheck.ok) throw new DomainError("VALIDATION_ERROR", `Selected pages cannot be sent to the AI provider (${providerInputCheck.detail})`);
    const intentHash = options.batchStrict
      ? hashSuggestionIntent({ projectId, paperId, fieldId, fullTextDocumentId: documentId, documentTextExtractionId: extractionId, baselineExtractionRevisionId: baseline == null ? null : String(baseline), fieldSnapshotHash, optionSnapshotHash, sourceSnapshotHash, pageManifestHash: pageManifest.hash, model, reasoningEffort: reasoning, ...versions, disclosureVersion })
      : hash({ projectId, paperId, fieldId, documentId, extractionId, fieldName: String(field.name), fieldDescription: field.description == null ? null : String(field.description), fieldType: String(field.field_type), optionSnapshot, manifest: legacyManifest, model, reasoning, promptVersion: versions.promptVersion, responseSchemaVersion: versions.responseSchemaVersion, groundingResolverVersion: versions.groundingResolverVersion, contextSelectionVersion: versions.contextSelectionVersion, disclosureVersion });
    const prior = rows(await tx.execute(sql`select * from ai_extraction_requests where project_id=${projectId}::uuid and idempotency_key=${key}::uuid limit 1`))[0];
    if (prior) {
      if (String(prior.intent_hash) !== intentHash) throw new DomainError("VALIDATION_ERROR", "The idempotency key was already used for a different AI request intent");
      return { requestId: String(prior.id), created: false, reused: false, request: mapRequest(prior) };
    }
    const unresolved = rows(await tx.execute(sql`select r.id from ai_extraction_requests r where r.project_id=${projectId}::uuid and r.paper_id=${paperId}::uuid and r.extraction_field_id=${fieldId}::uuid and not exists (select 1 from ai_extraction_results x where x.project_id=r.project_id and x.request_id=r.id) limit 1`))[0];
    if (unresolved) throw new DomainError("VALIDATION_ERROR", "An unresolved AI request already exists for this field");
    const reusable = options.batchStrict ? rows(await tx.execute(sql`
      select r.* from ai_extraction_requests r
      join ai_extraction_results x on x.project_id=r.project_id and x.request_id=r.id
      where r.project_id=${projectId}::uuid and r.paper_id=${paperId}::uuid and r.extraction_field_id=${fieldId}::uuid
        and r.intent_hash=${intentHash} and r.full_text_document_id=${documentId}::uuid
        and r.document_text_extraction_id=${extractionId}::uuid and r.field_name_snapshot=${String(field.name)}
        and r.field_description_snapshot is not distinct from ${field.description == null ? null : String(field.description)}
        and r.field_type=${String(field.field_type)} and r.option_snapshot=${JSON.stringify(optionSnapshot)}::jsonb
        and r.baseline_extraction_revision_id is not distinct from ${baseline == null ? null : String(baseline)}::uuid
        and r.provider='openai' and r.external_transmission_acknowledged=true
        and r.configured_model=${model} and r.configured_reasoning_effort=${reasoning}
        and r.prompt_version=${versions.promptVersion} and r.response_schema_version=${versions.responseSchemaVersion}
        and r.grounding_resolver_version=${versions.groundingResolverVersion} and r.context_selection_version=${versions.contextSelectionVersion}
        and r.source_character_count=${points} and r.source_byte_size=${bytes} and r.page_manifest_hash=${requestPageManifestHash}
        and r.disclosure_version=${disclosureVersion} and x.outcome='succeeded' and x.candidate_state is not null
        and not exists (select 1 from ai_extraction_decisions d where d.project_id=r.project_id and d.request_id=r.id)
      order by r.created_at desc, r.id desc limit 1 for update
    `))[0] : null;
    if (reusable) return { requestId: String(reusable.id), created: false, reused: true, request: mapRequest(reusable) };
    const requestId = randomUUID();
    if (options.previewOnly) return { preview: true, paperId, fieldId, documentId, extractionId, baselineExtractionRevisionId: baseline == null ? null : String(baseline), intentHash, pageManifest: manifest, pageManifestHash: requestPageManifestHash, pageCount: pageManifest.pages.length, sourceCharacterCount: pageManifest.characterCount, sourceByteSize: pageManifest.byteSize, fieldDefinitionHash: fieldSnapshotHash, optionSnapshotHash, fieldSnapshot, documentFilename: String(document.original_filename ?? ""), extractionSequence: Number(extraction.sequence), extractionStatus: String(extraction.status), paperTitle: "" };
    const inserted = rows(await tx.execute(sql`insert into ai_extraction_requests (id,project_id,paper_id,extraction_field_id,full_text_document_id,document_text_extraction_id,baseline_extraction_revision_id,idempotency_key,intent_hash,field_name_snapshot,field_description_snapshot,field_type,option_snapshot,provider,configured_model,configured_reasoning_effort,prompt_version,response_schema_version,grounding_resolver_version,context_selection_version,source_character_count,source_byte_size,page_manifest_hash,external_transmission_acknowledged,disclosure_version,finalized_at) values (${requestId}::uuid,${projectId}::uuid,${paperId}::uuid,${fieldId}::uuid,${documentId}::uuid,${extractionId}::uuid,${baseline ? String(baseline) : null}::uuid,${key}::uuid,${intentHash},${String(field.name)},${field.description == null ? null : String(field.description)},${String(field.field_type)},${JSON.stringify(optionSnapshot)}::jsonb,'openai',${model},${reasoning},${versions.promptVersion},${versions.responseSchemaVersion},${versions.groundingResolverVersion},${versions.contextSelectionVersion},${points},${bytes},${requestPageManifestHash},true,${disclosureVersion},now()) returning *`));
    for (const [ordinal, page] of selected.entries()) await tx.execute(sql`insert into ai_extraction_request_pages (project_id,request_id,page_id,paper_id,full_text_document_id,document_text_extraction_id,page_number,page_ordinal,text_sha256,character_count,byte_size) values (${projectId}::uuid,${requestId}::uuid,${String(page.id)}::uuid,${paperId}::uuid,${documentId}::uuid,${extractionId}::uuid,${Number(page.page_number)},${ordinal},${textHash(String(page.text))},${Number(page.character_count)},${Buffer.byteLength(String(page.text), "utf8")})`);
    if (!inserted[0]) throw new DomainError("DATABASE_CONSTRAINT", "AI extraction request could not be recorded");
    return { requestId, created: true, reused: false, request: mapRequest(inserted[0]) };
  }

  async function persist(requestId: string, providerResult: ProviderSuggestionResult, override?: TerminalOverride) {
    return db.transaction(async (tx) => {
      const req = await request(requestId, tx); const existing = await result(requestId, tx); if (existing) return mapResult(existing); let status = override ?? outcomeOf(providerResult);
      let state: string | null = null; let textValue: string | null = null; let numberValue: string | null = null; let booleanValue: boolean | null = null; let optionId: string | null = null; let explanation: string | null = null; const resolved: Array<{ pageId: string; pageNumber: number; startOffset: number; endOffset: number; locatorQuote: string; locatorPrefix: string | null; locatorSuffix: string | null; sourceText: string }> = [];
      const pages = await sourcePages(req, tx);
      const metadata = providerResult.metadata;
      if (providerResult.kind === "success") {
        const options = (Array.isArray(req.option_snapshot) ? req.option_snapshot : []) as Array<{ id: string; label: string; sortOrder?: number }>;
        const input: ExtractionSuggestionInput = { field: { id: String(req.extraction_field_id), name: String(req.field_name_snapshot), description: req.field_description_snapshot == null ? null : String(req.field_description_snapshot), fieldType: String(req.field_type) as ExtractionSuggestionInput["field"]["fieldType"], options: options.map((option) => ({ id: option.id, label: option.label, active: true })) }, pages: pages.map((page) => ({ id: String(page.page_id), pageNumber: Number(page.page_number), text: String(page.text) })), model: String(req.configured_model), reasoningEffort: String(req.configured_reasoning_effort) as ExtractionSuggestionInput["reasoningEffort"], promptVersion: String(req.prompt_version), responseSchemaVersion: String(req.response_schema_version), groundingResolverVersion: "exact-page-quote-v1", contextSelectionVersion: "selected-pages-v1", sourceCoverage: await sourceCoverage(req, tx) };
        const checked = validateProviderSuggestion(providerResult.suggestion, input);
        if (!checked.ok) status = { outcome: "invalid_output", diagnostic: "schema_invalid", errorCode: checked.code };
        else if (checked.suggestion.outcome === "candidate") {
          state = checked.suggestion.state; explanation = checked.suggestion.explanation;
          if (typeof checked.suggestion.value === "boolean") booleanValue = checked.suggestion.value; else if (typeof checked.suggestion.value === "string") { if (input.field.fieldType === "number") numberValue = checked.suggestion.value; else if (input.field.fieldType === "single_select") optionId = checked.suggestion.value; else textValue = checked.suggestion.value; }
          const grounding = resolveSuggestionGroundings(checked.suggestion.groundings, input.pages);
          if (!grounding.ok) {
            status = { outcome: "unresolvable_grounding", diagnostic: "success", errorCode: grounding.code };
            state = null;
            textValue = null;
            numberValue = null;
            booleanValue = null;
            optionId = null;
          } else {
            resolved.push(...grounding.groundings);
          }
        }
      }
      const inserted = rows(await tx.execute(sql`insert into ai_extraction_results (project_id,request_id,outcome,provider_diagnostic,error_code,candidate_state,text_value,number_value,boolean_value,option_id,explanation,provider_request_id,configured_model,returned_model,input_tokens,output_tokens,duration_ms,finalized_at) values (${String(req.project_id)}::uuid,${requestId}::uuid,${status.outcome},${status.diagnostic},${status.errorCode},${state},${textValue},${numberValue},${booleanValue},${optionId}::uuid,${explanation},${metadata.responseId},${String(req.configured_model)},${metadata.returnedModel},${metadata.inputTokens},${metadata.outputTokens},${metadata.durationMs},now()) returning *`));
      if (!inserted[0]) throw new DomainError("DATABASE_CONSTRAINT", "AI result could not be recorded");
      if (status.outcome === "succeeded") for (const item of resolved) await tx.execute(sql`insert into ai_extraction_result_groundings (project_id,request_id,result_id,page_id,page_number,start_offset,end_offset,locator_quote,locator_prefix,locator_suffix,source_text) values (${String(req.project_id)}::uuid,${requestId}::uuid,${String(inserted[0].id)}::uuid,${item.pageId}::uuid,${item.pageNumber},${item.startOffset},${item.endOffset},${item.locatorQuote},${item.locatorPrefix},${item.locatorSuffix},${item.sourceText})`);
      return mapResult(inserted[0]);
    });
  }

  function terminalProviderFailure(req: Record<string, unknown>, errorCode: string): ProviderSuggestionResult {
    return {
      kind: "failure",
      failure: "api_error",
      code: errorCode,
      metadata: {
        provider: "openai",
        configuredModel: String(req.configured_model),
        returnedModel: null,
        responseId: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        durationMs: 0,
      },
    };
  }

  async function claimDispatchInTransaction(tx: DatabaseTransaction, requestId: string, options: { batchStrict?: boolean } = {}) {
    const rid = id(requestId, "Request");
    const req = await request(rid, tx, true);
    const found = await result(rid, tx);
    if (found) return { done: true, value: mapResult(found), req };
    if (options.batchStrict) {
      await requireFinallyIncludedPaperLocked(tx, String(req.project_id), String(req.paper_id));
      await requireRequestFieldEligible(req, tx);
      const sourceState = await requirePinnedSourceCurrent(req, tx);
      if (sourceState !== "ok") {
        const persisted = await persistTerminalInTransaction(tx, req, sourceState);
        return { done: true, value: persisted, req };
      }
    }
    const dispatch = rows(await tx.execute(sql`select id from ai_extraction_dispatches where project_id=${String(req.project_id)}::uuid and request_id=${rid}::uuid limit 1 for update`))[0];
    if (dispatch) return { done: false, pending: true, req, dispatchId: String(dispatch.id) };
    const inserted = rows(await tx.execute(sql`insert into ai_extraction_dispatches (project_id,request_id,started_at,deadline_at) values (${String(req.project_id)}::uuid,${rid}::uuid,now(),now()+interval '90 seconds') on conflict (project_id,request_id) do nothing returning id`))[0];
    if (!inserted) return { done: false, pending: true, req };
    const pages = await sourcePages(req, tx);
    const optionRows = (Array.isArray(req.option_snapshot) ? req.option_snapshot : []) as Array<{ id: string; label: string; sortOrder: number }>;
    const providerInput: ExtractionSuggestionInput = {
      field: { id: String(req.extraction_field_id), name: String(req.field_name_snapshot), description: req.field_description_snapshot == null ? null : String(req.field_description_snapshot), fieldType: String(req.field_type) as ExtractionSuggestionInput["field"]["fieldType"], options: optionRows.map((option) => ({ id: option.id, label: option.label, active: true })) },
      pages: pages.map((page) => ({ id: String(page.page_id), pageNumber: Number(page.page_number), text: String(page.text) })),
      model: String(req.configured_model),
      reasoningEffort: String(req.configured_reasoning_effort) as ExtractionSuggestionInput["reasoningEffort"],
      promptVersion: String(req.prompt_version),
      responseSchemaVersion: String(req.response_schema_version),
      groundingResolverVersion: "exact-page-quote-v1",
      contextSelectionVersion: "selected-pages-v1",
      sourceCoverage: await sourceCoverage(req, tx),
    };
    const checkedInput = validateSuggestionInput(providerInput);
    if (!checkedInput.ok) {
      const persisted = await persistTerminalInTransaction(tx, req, "invalid_output", { outcome: "invalid_output", diagnostic: "schema_invalid", errorCode: checkedInput.detail });
      return { done: true, value: persisted, req };
    }
    return { done: false, pending: false, req, providerInput, dispatchId: String(inserted.id) };
  }

  async function claimRequest(requestId: string, projectId?: string, options: { batchStrict?: boolean } = {}) {
    const rid = id(requestId, "Request");
    const requestedProjectId = projectId ? id(projectId, "Project") : null;
    return withSerializableRetry(db, async (tx) => {
      const initial = await request(rid, tx);
      if (requestedProjectId && String(initial.project_id) !== requestedProjectId) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI request does not belong to this project");
      if (options.batchStrict) await lockBeginEntities(tx, String(initial.project_id), String(initial.paper_id), String(initial.extraction_field_id), String(initial.full_text_document_id), String(initial.document_text_extraction_id));
      return claimDispatchInTransaction(tx, rid, options);
    });
  }

  async function persistTerminalInTransaction(tx: DatabaseTransaction, req: Record<string, unknown>, errorCode: string, override?: TerminalOverride) {
    const status = override ?? { outcome: "failed" as const, diagnostic: "unknown" as const, errorCode };
    const inserted = rows(await tx.execute(sql`insert into ai_extraction_results (project_id,request_id,outcome,provider_diagnostic,error_code,configured_model,finalized_at) values (${String(req.project_id)}::uuid,${String(req.id)}::uuid,${status.outcome},${status.diagnostic},${status.errorCode},${String(req.configured_model)},now()) on conflict (project_id,request_id) do nothing returning *`))[0];
    if (inserted) return mapResult(inserted);
    const existing = await result(String(req.id), tx);
    if (!existing) throw new DomainError("DATABASE_CONSTRAINT", "AI extraction terminal result could not be recorded");
    return mapResult(existing);
  }

  async function runClaimedAiExtractionDispatch(claim: Record<string, unknown>, hooks: { beforeProvider?: () => boolean } = {}) {
    if (claim.done) return claim.value as Record<string, unknown>;
    if (claim.pending) return getAiExtractionSuggestionInternal(String((claim.req as Record<string, unknown>).id), String((claim.req as Record<string, unknown>).project_id));
    const req = claim.req as Record<string, unknown>;
    const rid = String(req.id);
    if (hooks.beforeProvider && !hooks.beforeProvider()) return persist(rid, terminalProviderFailure(req, "cancelled"), { outcome: "failed", diagnostic: "unknown", errorCode: "cancelled" });
    if (!provider) return persist(rid, terminalProviderFailure(req, "configuration_missing"));
    const providerInput = claim.providerInput as ExtractionSuggestionInput;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    let providerResult: ProviderSuggestionResult;
    try {
      providerResult = await provider.suggest(providerInput, { signal: controller.signal, timeoutMs: PROVIDER_TIMEOUT_MS });
    } catch {
      clearTimeout(timer);
      return persist(rid, terminalProviderFailure(req, "outcome_unknown"), { outcome: "outcome_unknown", diagnostic: "transport_error", errorCode: "outcome_unknown" });
    }
    clearTimeout(timer);
    try {
      const persisted = await persist(rid, providerResult);
      pendingPersistence.delete(rid);
      return persisted;
    } catch (error) {
      pendingPersistence.set(rid, providerResult);
      throw error;
    }
  }

  const inFlightExecutions = new Map<string, Promise<Record<string, unknown>>>();
  async function executeRequest(requestId: string, projectId?: string, hooks: { beforeProvider?: () => boolean } = {}) {
    const rid = id(requestId, "Request");
    const existing = inFlightExecutions.get(rid);
    if (existing) return existing;
    const execution = (async () => {
      const claim = await claimRequest(rid, projectId);
      return runClaimedAiExtractionDispatch(claim, hooks);
    })();
    inFlightExecutions.set(rid, execution);
    try { return await execution; } finally { inFlightExecutions.delete(rid); }
  }

  async function getAiExtractionSuggestionInternal(requestId: string, projectId?: string) {
    const rid = id(requestId, "Request");
    const req = await request(rid);
    if (projectId && String(req.project_id) !== id(projectId, "Project")) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI request does not belong to this project");
    const found = await result(rid);
    const groundings = found ? rows(await db.execute(sql`select * from ai_extraction_result_groundings where project_id=${String(req.project_id)}::uuid and result_id=${String(found.id)}::uuid order by created_at`)) : [];
    return { request: mapRequest(req), sourceCoverage: await sourceCoverage(req), result: found ? mapResult(found) : null, dispatch: rows(await db.execute(sql`select * from ai_extraction_dispatches where project_id=${String(req.project_id)}::uuid and request_id=${rid}::uuid limit 1`))[0] ?? null, pages: await sourcePages(req), groundings };
  }

  const services: AiExtractionSuggestionServices = {
    async beginAiExtractionSuggestion(input) {
      return withSerializableRetry(db, (tx) => planRequestInTransaction(tx, input));
    },
    async executeAiExtractionSuggestion(requestId, projectId?) {
      const replay = pendingPersistence.get(id(requestId, "Request"));
      if (replay) {
        const persisted = await persist(id(requestId, "Request"), replay);
        pendingPersistence.delete(id(requestId, "Request"));
        return persisted;
      }
      return executeRequest(requestId, projectId);
    },
    async expireAiExtractionSuggestion(requestId, projectId?) { const rid = id(requestId, "Request"); return db.transaction(async (tx) => { const req = await request(rid, tx); if (projectId && String(req.project_id) !== id(projectId, "Project")) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI request does not belong to this project"); const found = await result(rid, tx); if (found) { pendingPersistence.delete(rid); return mapResult(found); } const dispatch = rows(await tx.execute(sql`select deadline_at from ai_extraction_dispatches where project_id=${String(req.project_id)}::uuid and request_id=${rid}::uuid limit 1`))[0]; const deadline = dispatch ? asDate(dispatch.deadline_at)?.getTime() ?? Date.now() : (asDate(req.created_at)?.getTime() ?? Date.now()) + REQUEST_EXPIRY_MS; if (Date.now() < deadline) throw new DomainError("VALIDATION_ERROR", "AI request has not reached its expiry deadline"); const inserted = rows(await tx.execute(sql`insert into ai_extraction_results (project_id,request_id,outcome,provider_diagnostic,error_code,configured_model,finalized_at) values (${String(req.project_id)}::uuid,${rid}::uuid,${dispatch ? "outcome_unknown" : "failed"},'unknown',${dispatch ? "outcome_unknown" : "request_expired"},${String(req.configured_model)},now()) returning *`)); pendingPersistence.delete(rid); return mapResult(inserted[0]); }); },
    async getAiExtractionSuggestion(requestId, projectId) { return getAiExtractionSuggestionInternal(requestId, projectId); },
    async listAiExtractionSuggestions(projectId, paperId, fieldId) { const p = id(projectId, "Project"), paper = id(paperId, "Paper"); const field = fieldId ? sql`and r.extraction_field_id=${id(fieldId, "Field")}::uuid` : sql``; const found = rows(await db.execute(sql`select r.*,x.id as result_id,x.outcome,x.provider_diagnostic,x.error_code,x.candidate_state,x.text_value,x.number_value,x.boolean_value,x.option_id,x.explanation,x.provider_request_id,x.configured_model as result_configured_model,x.returned_model,x.input_tokens,x.output_tokens,x.duration_ms,x.created_at as result_created_at,x.finalized_at as result_finalized_at from ai_extraction_requests r left join ai_extraction_results x on x.project_id=r.project_id and x.request_id=r.id where r.project_id=${p}::uuid and r.paper_id=${paper}::uuid ${field} order by r.created_at desc`)); return found.map((row) => ({ request: mapRequest(row), result: row.result_id == null ? null : mapResult({ ...row, id: row.result_id, request_id: row.id, configured_model: row.result_configured_model, created_at: row.result_created_at, finalized_at: row.result_finalized_at }) })); },
    async rejectAiExtractionSuggestion(projectId, requestId) { const p = id(projectId, "Project"), rid = id(requestId, "Request"); return db.transaction(async (tx) => { const req = await request(rid, tx); if (String(req.project_id) !== p) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI request does not belong to this project"); const old = rows(await tx.execute(sql`select * from ai_extraction_decisions where project_id=${p}::uuid and request_id=${rid}::uuid limit 1`))[0]; if (old) { if (String(old.decision) !== "rejected") throw new DomainError("VALIDATION_ERROR", "This AI request was already accepted"); return old; } if (!await result(rid, tx)) throw new DomainError("VALIDATION_ERROR", "Suggestion has not completed"); return rows(await tx.execute(sql`insert into ai_extraction_decisions (project_id,request_id,decision) values (${p}::uuid,${rid}::uuid,'rejected') returning *`))[0]; }); },
    async acceptAiExtractionSuggestion(input) {
      const projectId = id(input.projectId, "Project");
      const requestId = id(input.requestId, "Request");
      if (input.mode !== "accept" && input.mode !== "edit_and_accept") throw new DomainError("VALIDATION_ERROR", "Invalid AI acceptance mode");
      const expectedRevisionId = input.expectedCurrentRevisionId == null ? null : id(input.expectedCurrentRevisionId, "Expected revision");
      const selectedIds = input.groundingIds.map((value) => id(value, "Grounding"));
      if (new Set(selectedIds).size !== selectedIds.length) throw new DomainError("VALIDATION_ERROR", "A grounding cannot be selected more than once");

      return db.transaction(async (tx) => {
        const req = await request(requestId, tx);
        if (String(req.project_id) !== projectId) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI request does not belong to this project");
        const paperId = String(req.paper_id);
        await tx.execute(sql`select id from papers where project_id=${projectId}::uuid and id=${paperId}::uuid for update`);
        await requireFinallyIncludedPaperLocked(tx, projectId, paperId);

        const existing = rows(await tx.execute(sql`select * from ai_extraction_decisions where project_id=${projectId}::uuid and request_id=${requestId}::uuid limit 1`))[0];
        if (existing) {
          if (String(existing.decision) !== "accepted") throw new DomainError("VALIDATION_ERROR", "This AI request was already rejected");
          if (String(existing.acceptance_mode) !== input.mode || (existing.expected_current_extraction_revision_id == null ? null : String(existing.expected_current_extraction_revision_id)) !== expectedRevisionId) throw new DomainError("VALIDATION_ERROR", "This AI request was already accepted with different choices");
          const existingMappings = rows(await tx.execute(sql`select grounding_id,evidence_id,evidence_mode from ai_extraction_decision_evidence where project_id=${projectId}::uuid and decision_id=${String(existing.id)}::uuid order by grounding_id`));
          const existingGroundings = existingMappings.map((row) => String(row.grounding_id)).sort();
          if (input.mode === "edit_and_accept") {
            const submittedGroundings = [...selectedIds].sort();
            if (existingGroundings.length !== submittedGroundings.length || existingGroundings.some((value, index) => value !== submittedGroundings[index])) throw new DomainError("VALIDATION_ERROR", "This AI request was already accepted with different grounding choices");
          }
          const submittedReuse = Object.entries(input.reusedEvidenceByGroundingId ?? {})
            .map(([groundingId, evidenceId]) => [groundingId, String(evidenceId)] as const)
            .sort(([left], [right]) => left.localeCompare(right));
          const existingReuse = existingMappings
            .filter((row) => String(row.evidence_mode) === "reused")
            .map((row) => [String(row.grounding_id), String(row.evidence_id)] as const)
            .sort(([left], [right]) => left.localeCompare(right));
          if (submittedReuse.length !== existingReuse.length || submittedReuse.some(([groundingId, evidenceId], index) => existingReuse[index]?.[0] !== groundingId || existingReuse[index]?.[1] !== evidenceId)) {
            throw new DomainError("VALIDATION_ERROR", "This AI request was already accepted with different Evidence choices");
          }
          if (input.state !== undefined && String(existing.value_state) !== input.state) throw new DomainError("VALIDATION_ERROR", "This AI request was already accepted with a different state");
          if (input.researcherNote !== undefined && (existing.researcher_note == null ? null : String(existing.researcher_note)) !== (input.researcherNote ?? null)) throw new DomainError("VALIDATION_ERROR", "This AI request was already accepted with a different note");
          if (input.value !== undefined) {
            const existingValue = existing.text_value ?? existing.number_value ?? existing.boolean_value ?? existing.option_id ?? null;
            const sameValue = String(req.field_type) === "number" ? normalizedDecimal(String(existingValue ?? "")) === normalizedDecimal(String(input.value)) : existingValue === input.value || String(existingValue ?? "") === String(input.value);
            if (!sameValue) throw new DomainError("VALIDATION_ERROR", "This AI request was already accepted with a different value");
          }
          return existing;
        }
        const aiResult = await result(requestId, tx);
        if (!aiResult || String(aiResult.outcome) !== "succeeded" || aiResult.candidate_state == null) {
          throw new DomainError("VALIDATION_ERROR", "Only a successful AI candidate can be accepted");
        }

        const baseline = req.baseline_extraction_revision_id == null ? null : String(req.baseline_extraction_revision_id);
        if (baseline !== expectedRevisionId) throw new DomainError("VALIDATION_ERROR", "The submitted baseline does not match the AI request baseline");
        const current = rows(await tx.execute(sql`
          select r.* from extraction_values v
          join extraction_value_revisions r on r.project_id=v.project_id and r.extraction_value_id=v.id
          where v.project_id=${projectId}::uuid and v.paper_id=${paperId}::uuid and v.field_id=${String(req.extraction_field_id)}::uuid
            and r.finalized_at is not null
          order by r.sequence desc limit 1
        `))[0] ?? null;
        const currentId = current == null ? null : String(current.id);
        if (currentId !== expectedRevisionId) throw new DomainError("VALIDATION_ERROR", "The extraction value changed after this AI request was created");
        await requireRequestSourceEligible(req, tx);
        await requireRequestFieldEligible(req, tx, true);

        const allGroundings = rows(await tx.execute(sql`
          select * from ai_extraction_result_groundings
          where project_id=${projectId}::uuid and request_id=${requestId}::uuid and result_id=${String(aiResult.id)}::uuid
          order by created_at, id
        `));
        const allById = new Map(allGroundings.map((grounding) => [String(grounding.id), grounding]));
        const acceptedIds = input.mode === "accept" ? allGroundings.map((grounding) => String(grounding.id)) : selectedIds;
        if (input.mode === "edit_and_accept" && selectedIds.some((groundingId) => !allById.has(groundingId))) throw new DomainError("CROSS_PROJECT_REFERENCE", "Selected grounding does not belong to this AI result");
        if (input.reusedEvidenceByGroundingId && Object.keys(input.reusedEvidenceByGroundingId).some((groundingId) => !acceptedIds.includes(groundingId))) throw new DomainError("VALIDATION_ERROR", "Reusable Evidence may only be selected for accepted groundings");
        if (String(input.state ?? aiResult.candidate_state) === "cleared" && acceptedIds.length > 0) throw new DomainError("VALIDATION_ERROR", "A cleared extraction cannot retain AI grounding");

        const fieldType = String(req.field_type) as "short_text" | "long_text" | "number" | "boolean" | "single_select";
        const state = (input.state ?? String(aiResult.candidate_state)) as "present" | "not_reported" | "not_applicable" | "cleared";
        if (!["present", "not_reported", "not_applicable", "cleared"].includes(state)) throw new DomainError("VALIDATION_ERROR", "Invalid extraction state");
        if (input.mode === "accept" && input.state !== undefined && input.state !== String(aiResult.candidate_state)) throw new DomainError("VALIDATION_ERROR", "Accept exactly cannot change the proposed state");
        if (input.mode === "accept" && input.researcherNote) throw new DomainError("VALIDATION_ERROR", "Accept exactly cannot add a researcher edit");
        if (state === "cleared" && input.mode !== "edit_and_accept") throw new DomainError("VALIDATION_ERROR", "Cleared values must be an explicit researcher edit");
        if ((state === "not_reported" || state === "not_applicable") && acceptedIds.length === 0) throw new DomainError("VALIDATION_ERROR", `${state.replace("_", " ")} requires positive grounding`);
        if (state === "present" && acceptedIds.length === 0) throw new DomainError("VALIDATION_ERROR", "A present AI value requires grounding");

        const optionSnapshot = (Array.isArray(req.option_snapshot) ? req.option_snapshot : []) as Array<{ id: string; label: string }>;
        const proposedValue = input.mode === "accept" ? (aiResult.text_value ?? aiResult.number_value ?? aiResult.boolean_value ?? aiResult.option_id ?? null) : (input.value ?? null);
        if (input.mode === "accept" && input.value !== undefined) {
          const persistedValue = aiResult.text_value ?? aiResult.number_value ?? aiResult.boolean_value ?? aiResult.option_id ?? null;
          const sameValue = fieldType === "number"
            ? normalizedDecimal(String(persistedValue ?? "")) === normalizedDecimal(String(input.value))
            : persistedValue === input.value || String(persistedValue ?? "") === String(input.value);
          if (!sameValue) throw new DomainError("VALIDATION_ERROR", "Accept exactly cannot change the proposed value");
        }
        let textValue: string | null = null;
        let numberValue: string | null = null;
        let booleanValue: boolean | null = null;
        let optionId: string | null = null;
        if (state === "present") {
          if (fieldType === "short_text" || fieldType === "long_text") {
            if (typeof proposedValue !== "string" || !proposedValue.trim() || Array.from(proposedValue).length > (fieldType === "short_text" ? 500 : 10000)) throw new DomainError("VALIDATION_ERROR", "Text extraction values are invalid");
            textValue = proposedValue;
          } else if (fieldType === "number") {
            if (typeof proposedValue !== "string") throw new DomainError("VALIDATION_ERROR", "Number extraction values must remain decimal text");
            const numeric = proposedValue;
            if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(numeric)) throw new DomainError("VALIDATION_ERROR", "Number extraction values are invalid");
            const [integerPart, fractionPart = ""] = numeric.replace(/^-/, "").split(".");
            if (integerPart.length > 20 || fractionPart.length > 10) throw new DomainError("VALIDATION_ERROR", "Number extraction values exceed numeric(30,10)");
            numberValue = numeric;
          } else if (fieldType === "boolean") {
            if (typeof proposedValue !== "boolean") throw new DomainError("VALIDATION_ERROR", "Boolean extraction values are invalid");
            booleanValue = proposedValue;
          } else {
            if (typeof proposedValue !== "string" || !optionSnapshot.some((option) => option.id === proposedValue)) throw new DomainError("VALIDATION_ERROR", "Selected option is not part of the frozen field definition");
            const frozenOption = optionSnapshot.find((option) => option.id === proposedValue);
            const active = rows(await tx.execute(sql`select id,label,archived_at from extraction_options where project_id=${projectId}::uuid and field_id=${String(req.extraction_field_id)}::uuid and id=${proposedValue}::uuid limit 1 for update`))[0];
            if (!active || active.archived_at) throw new DomainError("VALIDATION_ERROR", "Selected option is no longer active");
            if (!frozenOption || String(active.label) !== String(frozenOption.label)) throw new DomainError("VALIDATION_ERROR", "Selected option definition changed after this AI request was created");
            optionId = proposedValue;
          }
        }

        const reusedEvidenceByGroundingId = new Map<string, string>();
        for (const groundingId of acceptedIds) {
          const reusedEvidenceId = input.reusedEvidenceByGroundingId?.[groundingId];
          if (reusedEvidenceId) reusedEvidenceByGroundingId.set(groundingId, id(reusedEvidenceId, "Evidence"));
        }
        const reusedEvidenceIds = [...new Set(reusedEvidenceByGroundingId.values())].sort();
        const lockedReusedEvidence = await lockExtractionEvidenceRowsForUpdate(tx, projectId, reusedEvidenceIds);
        if (lockedReusedEvidence.length !== reusedEvidenceIds.length || lockedReusedEvidence.some((evidence) => evidence.paperId !== paperId)) {
          throw new DomainError("VALIDATION_ERROR", "Reused Evidence is not the exact persisted grounding");
        }
        for (const evidenceId of reusedEvidenceIds) await requireEvidenceUsableForNewDirectSupport(tx, projectId, evidenceId);
        const reusedEvidenceById = new Map(lockedReusedEvidence.map((evidence) => [evidence.id, evidence]));

        const evidenceIds: string[] = [];
        const evidenceModes = new Map<string, "fresh" | "reused">();
        for (const groundingId of acceptedIds) {
          const grounding = allById.get(groundingId);
          if (!grounding) throw new DomainError("CROSS_PROJECT_REFERENCE", "Selected grounding does not belong to this AI result");
          const reused = input.reusedEvidenceByGroundingId?.[groundingId];
          let evidenceId: string;
          if (reused) {
            evidenceId = reusedEvidenceByGroundingId.get(groundingId)!;
            const evidence = reusedEvidenceById.get(evidenceId);
            if (!evidence || evidence.paperId !== paperId || evidence.fullTextDocumentId !== String(req.full_text_document_id) || evidence.documentTextExtractionId !== String(req.document_text_extraction_id) || Number(evidence.pageNumber) !== Number(grounding.page_number) || Number(evidence.extractionStartOffset) !== Number(grounding.start_offset) || Number(evidence.extractionEndOffset) !== Number(grounding.end_offset) || String(evidence.sourceText) !== String(grounding.source_text)) throw new DomainError("VALIDATION_ERROR", "Reused Evidence is not the exact persisted grounding");
            evidenceModes.set(groundingId, "reused");
          } else {
            const inserted = rows(await tx.execute(sql`insert into evidence (project_id,paper_id,full_text_document_id,document_text_extraction_id,extraction_start_offset,extraction_end_offset,source_text,page_number) values (${projectId}::uuid,${paperId}::uuid,${String(req.full_text_document_id)}::uuid,${String(req.document_text_extraction_id)}::uuid,${Number(grounding.start_offset)},${Number(grounding.end_offset)},${String(grounding.source_text)},${Number(grounding.page_number)}) returning id`))[0];
            if (!inserted) throw new DomainError("DATABASE_CONSTRAINT", "AI Evidence could not be created");
            evidenceId = String(inserted.id);
            evidenceModes.set(groundingId, "fresh");
          }
          evidenceIds.push(evidenceId);
        }

        const revision = await writeExtractedExtractionRevision(tx, {
          projectId,
          paperId,
          fieldId: String(req.extraction_field_id),
          fieldType,
          valueState: state,
          textValue,
          numberValue,
          booleanValue,
          optionId,
          researcherNote: input.researcherNote ?? null,
          evidenceIds,
        });
        const decisionRows = rows(await tx.execute(sql`insert into ai_extraction_decisions (project_id,request_id,decision,acceptance_mode,expected_current_extraction_revision_id,preceding_extraction_revision_id,resulting_extraction_revision_id,value_state,text_value,number_value,boolean_value,option_id,researcher_note) values (${projectId}::uuid,${requestId}::uuid,'accepted',${input.mode},${expectedRevisionId}::uuid,${currentId}::uuid,${String(revision.id)}::uuid,${state},${textValue},${numberValue},${booleanValue},${optionId}::uuid,${input.researcherNote ?? null}) returning *`));
        const decision = decisionRows[0];
        if (!decision) throw new DomainError("DATABASE_CONSTRAINT", "AI acceptance decision could not be recorded");
        for (let index = 0; index < acceptedIds.length; index += 1) {
          const groundingId = acceptedIds[index];
          await tx.execute(sql`insert into ai_extraction_decision_evidence (project_id,decision_id,grounding_id,evidence_id,evidence_mode) values (${projectId}::uuid,${String(decision.id)}::uuid,${groundingId}::uuid,${evidenceIds[index]}::uuid,${evidenceModes.get(groundingId)})`);
        }
        return { decision, revision, evidenceIds };
      });
    },
    _batchTransactionSeams: {
      planRequestInTransaction,
      claimDispatchInTransaction,
      runClaimedAiExtractionDispatch,
      executeRequest,
    },
  };
  return services;
}
