import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { derivePaperReviewStatus, isFinallyIncluded } from "@/domain/paper-review";
import { idSchema } from "@/domain/validation";
import {
  BATCH_DOMAIN_VERSION,
  EMPTY_PAGE_MANIFEST_HASH,
  MAX_BATCH_FIELDS,
  MAX_BATCH_ITEMS,
  MAX_BATCH_PAPERS,
  buildPinnedExtractionPageManifest,
  hashBatchItemIntent,
  hashBatchItemManifest,
  hashBatchManifest,
  hashFieldSnapshot,
  hashOptionSnapshot,
  latestNonFailedExtraction,
  type BatchFieldOptionSnapshot,
  type BatchFieldSnapshot,
  type BatchPinnedPageManifest,
  type BatchPinnedSourceInput,
  type BatchTextExtractionSnapshot,
} from "@/application/ai-extraction-batch-domain";
import { validateSuggestionInput, type ExtractionSuggestionInput } from "@/application/ai/extraction-suggestion-provider";
import { withSerializableRetry, type DatabaseTransaction } from "@/application/serializable-retry";
import type { AiExtractionSuggestionServices, BeginAiExtractionSuggestionInput } from "@/application/ai-extraction-suggestion-services";

export const BATCH_DISCLOSURE_VERSION = "openai-batch-extraction-transmission-v1";
export const REQUEST_DISCLOSURE_VERSION = "openai-extraction-transmission-v1";
export const BATCH_SELECTION_POLICY_VERSION = "missing-current-revision-v1";
export const BATCH_MAX_ITEMS_PER_ACTION = 2;
export const BATCH_PROVIDER_CONCURRENCY = 2;

type RawItemInput = { paperId: string; fieldId: string; fullTextDocumentId?: string; documentTextExtractionId?: string; idempotencyKey?: string };
export type AiExtractionBatchItemInput = RawItemInput;
export type AiExtractionBatchPreviewInput = { projectId: string; items: readonly RawItemInput[]; model?: string; reasoningEffort?: "low"; externalTransmissionAcknowledged: boolean; disclosureVersion?: string };

type PreviewItem = {
  paperId: string; fieldId: string; ordinal: number; idempotencyKey: string; paperTitle: string; paperAbstract: string | null;
  titleAbstractDecisionId: string | null; fullTextDecisionId: string | null; currentExtractionRevisionId: string | null;
  fullTextDocumentId: string | null; documentTextExtractionId: string | null;
  initialDisposition: "executable" | "reusable" | "blocked" | "ineligible"; initialReasonCode: string;
  expectedRequestIntentHash: string | null; fieldDefinitionHash: string; optionSnapshotHash: string;
  fieldName: string; fieldDescription: string | null; fieldType: string; fieldRequired: boolean; fieldOptions: BatchFieldOptionSnapshot[];
  documentFilename: string | null; extractionSequence: number | null; extractionStatus: string | null;
  pageManifest: BatchPinnedPageManifest["pages"]; pageManifestHash: string; pageCount: number; sourceCharacterCount: number; sourceByteSize: number;
  itemManifestHash: string; currentRevisionState: string | null;
};

export type AiExtractionBatchPreview = {
  batchId: string; projectId: string; configuredModel: string; configuredReasoningEffort: "low"; confirmationHash: string; createdAt: Date;
  items: PreviewItem[]; counts: { papers: number; fields: number; cells: number; executable: number; reusable: number; blocked: number; ineligible: number };
};

export type BatchItemState = "pending" | "request_ready" | "running" | "suggestion_ready" | "accepted" | "rejected" | "no_candidate" | "failed" | "outcome_unknown" | "stale" | "blocked" | "ineligible" | "cancelled";
export type AiExtractionBatchReadOptions = { page?: number; pageSize?: number; paperId?: string; fieldId?: string; state?: BatchItemState };
export type AiExtractionBatch = {
  batchId: string; projectId: string; configuredModel: string; configuredReasoningEffort: "low"; batchDisclosureVersion: string; requestDisclosureVersion: string;
  cancelledAt: Date | null; state: "active" | "completed" | "cancelled"; counts: Record<string, number>; totalItems: number; matchingItems: number;
  page: number; pageSize: number; hasNextPage: boolean;
  usage: { resultCount: number; successCount: number; failureCount: number; inputTokens: number; outputTokens: number; durationMs: number };
  items: Array<PreviewItem & { itemId: string; requestId: string | null; requestRelationship: string | null; state: BatchItemState; result: Record<string, unknown> | null; decision: string | null; dispatchId: string | null; terminalCode: string | null }>;
};

export type AiExtractionBatchServices = {
  previewAiExtractionBatch(input: AiExtractionBatchPreviewInput): Promise<AiExtractionBatchPreview>;
  createAiExtractionBatch(preview: AiExtractionBatchPreview, confirmationHash?: string): Promise<AiExtractionBatch>;
  confirmAiExtractionBatch(preview: AiExtractionBatchPreview, confirmationHash?: string): Promise<AiExtractionBatch>;
  listAiExtractionBatches(projectId: string, limit?: number): Promise<AiExtractionBatch[]>;
  getAiExtractionBatch(batchId: string, projectId?: string, options?: AiExtractionBatchReadOptions): Promise<AiExtractionBatch | null>;
  processNextAiExtractionBatchItems(projectId: string, batchId: string, options?: { concurrency?: number }): Promise<AiExtractionBatch>;
  executeAiExtractionBatch(projectId: string, batchId: string): Promise<AiExtractionBatch>;
  cancelAiExtractionBatch(batchId: string, projectId?: string): Promise<AiExtractionBatch>;
};
export interface AiExtractionBatchServiceOptions { configuredModel: string; providerAvailable?: boolean; }

type Row = Record<string, unknown>;
type ReviewSnapshot = { titleAbstractDecisionId: string | null; fullTextDecisionId: string | null; finallyIncluded: boolean };
type PageRow = { id: string; paperId: string; extractionId: string; pageNumber: number; status: "succeeded" | "failed"; text: string; characterCount: number };
type RequestObservation = Row & { resultOutcome: string | null; candidateState: string | null; decision: string | null };
type PreviewContext = {
  reviews: Map<string, ReviewSnapshot>; options: Map<string, BatchFieldOptionSnapshot[]>; current: Map<string, Row>; preferences: Map<string, string>;
  documents: Map<string, Row>; extractions: Map<string, Row[]>; pages: Map<string, PageRow[]>; requests: Map<string, RequestObservation[]>;
};

function rows(value: unknown): Row[] { return value as Row[]; }
function uuid(value: string, label: string): string { const parsed = idSchema.safeParse(value); if (!parsed.success) throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`); return parsed.data.toLowerCase(); }
function asDate(value: unknown): Date | null { if (value == null) return null; const result = value instanceof Date ? value : new Date(String(value)); return Number.isNaN(result.getTime()) ? null : result; }
function stringOrNull(value: unknown): string | null { return value == null ? null : String(value); }
function pairKey(paperId: string, fieldId: string): string { return `${paperId}:${fieldId}`; }
function documentKey(paperId: string, documentId: string): string { return `${paperId}:${documentId}`; }
function json(value: unknown): string { return JSON.stringify(value); }
function uuidList(values: readonly string[]) { return sql.join(values.map((value) => sql`${uuid(value, "UUID")}::uuid`), sql`, `); }
function reviewSnapshot(row: Row): ReviewSnapshot {
  const status = derivePaperReviewStatus({
    titleAbstractDecision: row.title_abstract_decision === "include" || row.title_abstract_decision === "exclude" || row.title_abstract_decision === "maybe" ? row.title_abstract_decision : null,
    fullTextDecision: row.full_text_decision === "include" || row.full_text_decision === "exclude" || row.full_text_decision === "maybe" ? row.full_text_decision : null,
    fullTextRetrievalState: row.retrieval_outcome === "pending" || row.retrieval_outcome === "unavailable" || row.retrieval_outcome === "retrieved" ? row.retrieval_outcome : "not_sought",
    everRetrieved: Boolean(row.ever_retrieved), hasFullTextRetrievalAttempts: Boolean(row.has_retrieval_attempts), hasAnalyticalHistory: Boolean(row.has_analytical_history),
  });
  return { titleAbstractDecisionId: stringOrNull(row.title_abstract_decision_id), fullTextDecisionId: stringOrNull(row.full_text_decision_id), finallyIncluded: isFinallyIncluded(status) };
}

async function lockBatchEntities(tx: DatabaseTransaction, projectId: string, inputs: readonly RawItemInput[]): Promise<void> {
  const paperIds = [...new Set(inputs.map((item) => uuid(item.paperId, "Paper")))].sort();
  const fieldIds = [...new Set(inputs.map((item) => uuid(item.fieldId, "Field")))].sort();
  const paperRows = rows(await tx.execute(sql`select id from papers where project_id=${projectId}::uuid and id in (${uuidList(paperIds)}) order by id for update`));
  if (paperRows.length !== paperIds.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Every selected Paper must belong to this project");
  const fieldRows = rows(await tx.execute(sql`select id from extraction_fields where project_id=${projectId}::uuid and id in (${uuidList(fieldIds)}) order by id for update`));
  if (fieldRows.length !== fieldIds.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Every selected extraction field must belong to this project");
  const preferenceRows = paperIds.length === 0 ? [] : rows(await tx.execute(sql`select paper_id,full_text_document_id from paper_full_text_preferences where project_id=${projectId}::uuid and paper_id in (${uuidList(paperIds)}) order by paper_id for update`));
  const requestedDocumentIds = inputs.map((item) => item.fullTextDocumentId).filter((value): value is string => Boolean(value)).map((value) => uuid(value, "Document"));
  const documentIds = [...new Set([...requestedDocumentIds, ...preferenceRows.map((row) => String(row.full_text_document_id))])].sort();
  const documents = documentIds.length === 0 ? [] : rows(await tx.execute(sql`select id,paper_id,storage_state from full_text_documents where project_id=${projectId}::uuid and id in (${uuidList(documentIds)}) order by id for update`));
  for (const item of inputs) {
    if (!item.fullTextDocumentId) continue;
    const document = documents.find((candidate) => String(candidate.id) === uuid(item.fullTextDocumentId!, "Document"));
    if (!document || String(document.paper_id) !== uuid(item.paperId, "Paper")) throw new DomainError("CROSS_PROJECT_REFERENCE", "The selected document does not belong to the selected Paper");
    if (document.storage_state !== "ready") throw new DomainError("STORAGE_PENDING", "The selected document bytes are still being materialized");
  }
  const explicitExtractionIds = inputs.map((item) => item.documentTextExtractionId).filter((value): value is string => Boolean(value)).map((value) => uuid(value, "Extraction"));
  const extractionRows = rows(await tx.execute(sql`select id,paper_id,full_text_document_id from document_text_extractions where project_id=${projectId}::uuid and paper_id in (${uuidList(paperIds)}) order by id for update`));
  for (const item of inputs) {
    if (!item.documentTextExtractionId) continue;
    const extraction = extractionRows.find((candidate) => String(candidate.id) === uuid(item.documentTextExtractionId!, "Extraction"));
    if (!extraction || String(extraction.paper_id) !== uuid(item.paperId, "Paper") || (item.fullTextDocumentId && String(extraction.full_text_document_id) !== uuid(item.fullTextDocumentId, "Document"))) throw new DomainError("CROSS_PROJECT_REFERENCE", "The selected text extraction does not belong to the selected source");
  }
  const allExtractionIds = [...new Set([...explicitExtractionIds, ...extractionRows.map((row) => String(row.id))])].sort();
  if (allExtractionIds.length) await tx.execute(sql`select id from document_text_extractions where project_id=${projectId}::uuid and id in (${uuidList(allExtractionIds)}) order by id for update`);
}

async function canonicalRows(tx: DatabaseTransaction, projectId: string, items: readonly RawItemInput[]): Promise<Row[]> {
  const pairs = items.map((item) => sql`(p.id=${uuid(item.paperId, "Paper")}::uuid and f.id=${uuid(item.fieldId, "Field")}::uuid)`);
  if (!pairs.length) return [];
  return rows(await tx.execute(sql`select p.id as paper_id,p.title,p.abstract,f.id as field_id,f.name as field_name,f.description as field_description,f.field_type,f.required,f.sort_order,f.archived_at from papers p join extraction_fields f on f.project_id=p.project_id where p.project_id=${projectId}::uuid and (${sql.join(pairs, sql` or `)}) order by convert_to(p.title,'UTF8'),p.id, f.sort_order,f.id`));
}

async function loadPreviewContext(tx: DatabaseTransaction, projectId: string, items: readonly RawItemInput[], canonical: readonly Row[]): Promise<PreviewContext> {
  const paperIds = [...new Set(canonical.map((row) => String(row.paper_id)))].sort();
  const fieldIds = [...new Set(canonical.map((row) => String(row.field_id)))].sort();
  const pairClauses = canonical.map((row) => sql`(r.paper_id=${String(row.paper_id)}::uuid and r.extraction_field_id=${String(row.field_id)}::uuid)`);
  const reviewRows = paperIds.length === 0 ? [] : rows(await tx.execute(sql`select p.id as paper_id,td.id as title_abstract_decision_id,td.decision as title_abstract_decision,fd.id as full_text_decision_id,fd.decision as full_text_decision,rt.outcome as retrieval_outcome,exists(select 1 from full_text_retrieval_attempts h where h.project_id=p.project_id and h.paper_id=p.id) as has_retrieval_attempts,exists(select 1 from full_text_retrieval_attempts h where h.project_id=p.project_id and h.paper_id=p.id and h.outcome='retrieved') as ever_retrieved,exists(select 1 from extraction_value_revisions h where h.project_id=p.project_id and h.paper_id=p.id and h.finalized_at is not null) as has_analytical_history from papers p left join lateral (select id,decision from screening_decisions where project_id=p.project_id and paper_id=p.id and stage='title_abstract' order by sequence desc,id desc limit 1) td on true left join lateral (select id,decision from full_text_screening_decisions where project_id=p.project_id and paper_id=p.id order by sequence desc,id desc limit 1) fd on true left join lateral (select outcome from full_text_retrieval_attempts where project_id=p.project_id and paper_id=p.id order by sequence desc,id desc limit 1) rt on true where p.project_id=${projectId}::uuid and p.id in (${uuidList(paperIds)})`));
  const optionRows = fieldIds.length === 0 ? [] : rows(await tx.execute(sql`select field_id,id,label,sort_order from extraction_options where project_id=${projectId}::uuid and field_id in (${uuidList(fieldIds)}) and archived_at is null order by field_id,sort_order,id`));
  const currentRows = canonical.length === 0 ? [] : rows(await tx.execute(sql`select v.paper_id,v.field_id,r.id,r.sequence,r.value_state from extraction_values v join extraction_value_revisions r on r.project_id=v.project_id and r.extraction_value_id=v.id where v.project_id=${projectId}::uuid and v.paper_id in (${uuidList(paperIds)}) and v.field_id in (${uuidList(fieldIds)}) and r.finalized_at is not null order by v.paper_id,v.field_id,r.sequence desc,r.id desc`));
  const preferenceRows = paperIds.length === 0 ? [] : rows(await tx.execute(sql`select paper_id,full_text_document_id from paper_full_text_preferences where project_id=${projectId}::uuid and paper_id in (${uuidList(paperIds)})`));
  const documentRows = paperIds.length === 0 ? [] : rows(await tx.execute(sql`select id,paper_id,original_filename,archived_at from full_text_documents where project_id=${projectId}::uuid and paper_id in (${uuidList(paperIds)}) and storage_state='ready' order by paper_id,id`));
  const documentIds = documentRows.map((row) => String(row.id));
  const extractionRows = documentIds.length === 0 ? [] : rows(await tx.execute(sql`select id,paper_id,full_text_document_id,sequence,status from document_text_extractions where project_id=${projectId}::uuid and full_text_document_id in (${uuidList(documentIds)}) order by paper_id,full_text_document_id,sequence,id`));
  const extractionIds = extractionRows.map((row) => String(row.id));
  const pageRows = extractionIds.length === 0 ? [] : rows(await tx.execute(sql`select id,paper_id,document_text_extraction_id,page_number,status,text,character_count from document_text_extraction_pages where project_id=${projectId}::uuid and document_text_extraction_id in (${uuidList(extractionIds)}) order by document_text_extraction_id,page_number,id`));
  const requestRows = pairClauses.length === 0 ? [] : rows(await tx.execute(sql`select r.*,x.outcome as result_outcome,x.candidate_state as candidate_state,d.decision as decision from ai_extraction_requests r left join ai_extraction_results x on x.project_id=r.project_id and x.request_id=r.id left join ai_extraction_decisions d on d.project_id=r.project_id and d.request_id=r.id where r.project_id=${projectId}::uuid and (${sql.join(pairClauses, sql` or `)}) order by r.created_at desc,r.id desc`));
  const reviews = new Map(reviewRows.map((row) => [String(row.paper_id), reviewSnapshot(row)]));
  const options = new Map<string, BatchFieldOptionSnapshot[]>();
  for (const row of optionRows) { const list = options.get(String(row.field_id)) ?? []; list.push({ id: uuid(String(row.id), "Option"), label: String(row.label), sortOrder: Number(row.sort_order) }); options.set(String(row.field_id), list); }
  const current = new Map<string, Row>();
  for (const row of currentRows) { const key = pairKey(String(row.paper_id), String(row.field_id)); if (!current.has(key)) current.set(key, row); }
  const preferences = new Map(preferenceRows.map((row) => [String(row.paper_id), String(row.full_text_document_id)]));
  const documents = new Map(documentRows.map((row) => [documentKey(String(row.paper_id), String(row.id)), row]));
  const extractions = new Map<string, Row[]>();
  for (const row of extractionRows) { const key = documentKey(String(row.paper_id), String(row.full_text_document_id)); extractions.set(key, [...(extractions.get(key) ?? []), row]); }
  const pages = new Map<string, PageRow[]>();
  for (const row of pageRows) { const extractionId = String(row.document_text_extraction_id); const list = pages.get(extractionId) ?? []; list.push({ id: String(row.id), paperId: String(row.paper_id), extractionId, pageNumber: Number(row.page_number), status: String(row.status) === "succeeded" ? "succeeded" : "failed", text: String(row.text), characterCount: Number(row.character_count) }); pages.set(extractionId, list); }
  const requests = new Map<string, RequestObservation[]>();
  for (const row of requestRows) {
    const observation = { ...row, resultOutcome: stringOrNull(row.result_outcome), candidateState: stringOrNull(row.candidate_state), decision: stringOrNull(row.decision) } as RequestObservation;
    const key = pairKey(String(row.paper_id), String(row.extraction_field_id));
    requests.set(key, [...(requests.get(key) ?? []), observation]);
  }
  return { reviews, options, current, preferences, documents, extractions, pages, requests };
}

function buildProviderInput(field: BatchFieldSnapshot, source: BatchPinnedSourceInput, configuredModel: string, omittedPageCount: number): ExtractionSuggestionInput {
  const pageMap = new Map(source.pages.map((page) => [page.id, page]));
  const manifest = buildPinnedExtractionPageManifest(source);
  return { field: { id: field.id, name: field.name, description: field.description, fieldType: field.fieldType, options: field.options.map((option) => ({ id: option.id, label: option.label, active: true })) }, pages: manifest.pages.map((page) => ({ id: page.pageId, pageNumber: page.pageNumber, text: pageMap.get(page.pageId)?.text ?? "" })), model: configuredModel, reasoningEffort: "low", promptVersion: "extraction-suggestion-v1", responseSchemaVersion: "extraction-suggestion-response-v1", groundingResolverVersion: "exact-page-quote-v1", contextSelectionVersion: "selected-pages-v1", sourceCoverage: { extractionId: source.extraction.id, documentId: source.document.id, status: source.extraction.status === "partial" ? "partial" : "succeeded", omittedPageCount } };
}

function exactReusableRequest(request: RequestObservation, expectedIntentHash: string, field: BatchFieldSnapshot, source: BatchPinnedSourceInput, configuredModel: string): boolean {
  const manifest = buildPinnedExtractionPageManifest(source);
  const optionSnapshot = field.options.map((option) => ({ id: option.id, label: option.label, sortOrder: option.sortOrder }));
  return String(request.intent_hash) === expectedIntentHash && String(request.full_text_document_id) === source.document.id && String(request.document_text_extraction_id) === source.extraction.id && request.baseline_extraction_revision_id == null && String(request.field_name_snapshot) === field.name && stringOrNull(request.field_description_snapshot) === field.description && String(request.field_type) === field.fieldType && json(request.option_snapshot ?? []) === json(optionSnapshot) && String(request.provider) === "openai" && Boolean(request.external_transmission_acknowledged) && String(request.configured_model) === configuredModel && String(request.configured_reasoning_effort) === "low" && String(request.prompt_version) === "extraction-suggestion-v1" && String(request.response_schema_version) === "extraction-suggestion-response-v1" && String(request.grounding_resolver_version) === "exact-page-quote-v1" && String(request.context_selection_version) === "selected-pages-v1" && Number(request.source_character_count) === manifest.characterCount && Number(request.source_byte_size) === manifest.byteSize + Math.max(manifest.pages.length - 1, 0) && String(request.page_manifest_hash) === manifest.hash && String(request.disclosure_version) === REQUEST_DISCLOSURE_VERSION && request.resultOutcome === "succeeded" && request.candidateState != null && request.decision == null;
}

function manifestFromPreviewItem(item: PreviewItem): BatchPinnedPageManifest | null {
  if (item.pageCount === 0 || item.documentTextExtractionId == null) return null;
  return { paperId: item.paperId, documentTextExtractionId: item.documentTextExtractionId, pages: item.pageManifest, characterCount: item.sourceCharacterCount, byteSize: item.sourceByteSize, hash: item.pageManifestHash };
}
function itemManifest(item: Omit<PreviewItem, "ordinal" | "itemManifestHash"> & { ordinal: number }): string {
  return hashBatchItemManifest({ itemOrdinal: item.ordinal, paperId: item.paperId, extractionFieldId: item.fieldId, expectedCurrentExtractionRevisionId: item.currentExtractionRevisionId, titleAbstractDecisionId: item.titleAbstractDecisionId, fullTextDecisionId: item.fullTextDecisionId, fullTextDocumentId: item.fullTextDocumentId, documentTextExtractionId: item.documentTextExtractionId, initialDisposition: item.initialDisposition, initialReasonCode: item.initialReasonCode, idempotencyKey: item.idempotencyKey, expectedRequestIntentHash: item.expectedRequestIntentHash, fieldDefinitionHash: item.fieldDefinitionHash, optionSnapshotHash: item.optionSnapshotHash, paperTitleSnapshot: item.paperTitle, paperAbstractSnapshot: item.paperAbstract, fieldNameSnapshot: item.fieldName, fieldDescriptionSnapshot: item.fieldDescription, fieldTypeSnapshot: item.fieldType, fieldRequiredSnapshot: item.fieldRequired, fieldOptionSnapshot: item.fieldOptions, documentFilenameSnapshot: item.documentFilename, extractionSequenceSnapshot: item.extractionSequence, extractionStatusSnapshot: item.extractionStatus, pageManifest: manifestFromPreviewItem(item as PreviewItem) });
}
function withOrdinal(item: PreviewItem, ordinal: number): PreviewItem { const next = { ...item, ordinal }; return { ...next, itemManifestHash: itemManifest(next) }; }

function buildPreviewItem(projectId: string, input: RawItemInput, row: Row, context: PreviewContext, configuredModel: string): PreviewItem {
  const paperId = uuid(String(row.paper_id), "Paper");
  const fieldId = uuid(String(row.field_id), "Field");
  const review = context.reviews.get(paperId) ?? { titleAbstractDecisionId: null, fullTextDecisionId: null, finallyIncluded: false };
  const options = context.options.get(fieldId) ?? [];
  const field: BatchFieldSnapshot = { projectId, id: fieldId, name: String(row.field_name), description: stringOrNull(row.field_description), fieldType: String(row.field_type) as BatchFieldSnapshot["fieldType"], required: Boolean(row.required), sortOrder: Number(row.sort_order), archivedAt: stringOrNull(row.archived_at), options };
  const fieldDefinitionHash = hashFieldSnapshot(field);
  const optionSnapshotHash = hashOptionSnapshot(options);
  const current = context.current.get(pairKey(paperId, fieldId)) ?? null;
  const currentRevisionId = stringOrNull(current?.id);
  const preferredDocumentId = context.preferences.get(paperId) ?? null;
  const requestedDocumentId = input.fullTextDocumentId == null ? preferredDocumentId : uuid(input.fullTextDocumentId, "Document");
  const document = requestedDocumentId == null ? null : context.documents.get(`${paperId}:${requestedDocumentId}`) ?? null;
  const documentId = document == null ? requestedDocumentId : String(document.id);
  const extractionList = documentId == null ? [] : context.extractions.get(documentKey(paperId, documentId)) ?? [];
  const extractionSnapshots: BatchTextExtractionSnapshot[] = extractionList.map((candidate) => ({ id: String(candidate.id), paperId, fullTextDocumentId: documentId!, sequence: Number(candidate.sequence), status: String(candidate.status) as BatchTextExtractionSnapshot["status"] }));
  const latest = latestNonFailedExtraction(extractionSnapshots);
  const requestedExtractionId = input.documentTextExtractionId == null ? latest?.id ?? null : uuid(input.documentTextExtractionId, "Extraction");
  const extraction = requestedExtractionId == null ? null : extractionList.find((candidate) => String(candidate.id) === requestedExtractionId) ?? null;
  const rawPages = extraction == null ? [] : context.pages.get(String(extraction.id)) ?? [];
  const sourceInput: BatchPinnedSourceInput | null = document && extraction ? { paper: { projectId, paperId, title: String(row.title), finallyIncluded: review.finallyIncluded }, document: { id: documentId!, paperId, archivedAt: stringOrNull(document.archived_at) }, extraction: { id: String(extraction.id), paperId, fullTextDocumentId: documentId!, sequence: Number(extraction.sequence), status: String(extraction.status) as BatchTextExtractionSnapshot["status"] }, pages: rawPages.map((page) => ({ id: page.id, paperId, documentTextExtractionId: String(extraction.id), pageNumber: page.pageNumber, status: page.status, text: page.text })) } : null;
  let pageManifest: BatchPinnedPageManifest | null = null;
  let sourceError = false;
  if (sourceInput) { try { pageManifest = buildPinnedExtractionPageManifest(sourceInput); } catch { sourceError = true; } }
  let eligibility = { eligible: false, reason: "full_text_document_missing" };
  if (!review.finallyIncluded) eligibility = { eligible: false, reason: "paper_not_finally_included" };
  else if (field.archivedAt != null) eligibility = { eligible: false, reason: "field_archived" };
  else if (!preferredDocumentId) eligibility = { eligible: false, reason: "full_text_document_missing" };
  else if (preferredDocumentId !== documentId) eligibility = { eligible: false, reason: "stale_full_text_document" };
  else if (!document) eligibility = { eligible: false, reason: "full_text_document_missing" };
  else if (document.archived_at != null) eligibility = { eligible: false, reason: "full_text_document_archived" };
  else if (!latest) eligibility = { eligible: false, reason: "no_non_failed_text_extraction" };
  else if (requestedExtractionId !== latest.id) eligibility = { eligible: false, reason: "stale_text_extraction" };
  else if (!extraction || !["succeeded", "partial"].includes(String(extraction.status))) eligibility = { eligible: false, reason: "text_extraction_pending" };
  else if (sourceError) eligibility = { eligible: false, reason: "stale_source_limits" };
  else if (!pageManifest || pageManifest.pages.length === 0) eligibility = { eligible: false, reason: "no_eligible_pages" };
  else {
    const providerCheck = validateSuggestionInput(buildProviderInput(field, sourceInput!, configuredModel, rawPages.filter((page) => page.status !== "succeeded" || page.characterCount <= 0).length));
    eligibility = providerCheck.ok ? { eligible: true, reason: "eligible" } : { eligible: false, reason: "stale_source_limits" };
  }
  let disposition: PreviewItem["initialDisposition"] = "ineligible";
  let reasonCode = eligibility.reason;
  if (currentRevisionId != null) reasonCode = String(current?.value_state) === "cleared" ? "existing_cleared_revision" : "current_revision_exists";
  else if (eligibility.eligible && pageManifest && sourceInput) disposition = "executable";
  const sourceSnapshot = disposition === "executable" && pageManifest && sourceInput ? { document: sourceInput.document, extraction: sourceInput.extraction, pageManifest } : null;
  let expectedRequestIntentHash: string | null = null;
  if (sourceSnapshot && disposition === "executable") {
    expectedRequestIntentHash = hashBatchItemIntent({ paper: { projectId, paperId, title: String(row.title), finallyIncluded: review.finallyIncluded }, field, source: sourceSnapshot, currentExtractionRevisionId: currentRevisionId }, { model: configuredModel, reasoningEffort: "low", promptVersion: "extraction-suggestion-v1", responseSchemaVersion: "extraction-suggestion-response-v1", groundingResolverVersion: "exact-page-quote-v1", contextSelectionVersion: "selected-pages-v1", disclosureVersion: REQUEST_DISCLOSURE_VERSION });
    const observations = context.requests.get(pairKey(paperId, fieldId)) ?? [];
    const unresolved = observations.find((request) => request.resultOutcome == null);
    if (unresolved) { disposition = "blocked"; reasonCode = "blocked_existing_request"; }
    else if (observations.some((request) => exactReusableRequest(request, expectedRequestIntentHash!, field, sourceInput!, configuredModel))) { disposition = "reusable"; reasonCode = "existing_successful_undecided"; }
  }
  const itemSource = disposition === "executable" || disposition === "reusable" ? sourceSnapshot : null;
  const item = { paperId, fieldId, ordinal: 0, idempotencyKey: uuid(input.idempotencyKey ?? "", "Idempotency key"), paperTitle: String(row.title), paperAbstract: stringOrNull(row.abstract), titleAbstractDecisionId: review.titleAbstractDecisionId, fullTextDecisionId: review.fullTextDecisionId, currentExtractionRevisionId: currentRevisionId, fullTextDocumentId: documentId, documentTextExtractionId: extraction == null ? null : String(extraction.id), initialDisposition: disposition, initialReasonCode: reasonCode, expectedRequestIntentHash, fieldDefinitionHash, optionSnapshotHash, fieldName: field.name, fieldDescription: field.description, fieldType: field.fieldType, fieldRequired: field.required, fieldOptions: options, documentFilename: document == null ? null : String(document.original_filename), extractionSequence: extraction == null ? null : Number(extraction.sequence), extractionStatus: extraction == null ? null : String(extraction.status), pageManifest: itemSource?.pageManifest.pages ?? [], pageManifestHash: itemSource?.pageManifest.hash ?? EMPTY_PAGE_MANIFEST_HASH, pageCount: itemSource?.pageManifest.pages.length ?? 0, sourceCharacterCount: itemSource?.pageManifest.characterCount ?? 0, sourceByteSize: itemSource?.pageManifest.byteSize ?? 0, currentRevisionState: stringOrNull(current?.value_state) } satisfies Omit<PreviewItem, "itemManifestHash">;
  return withOrdinal({ ...item, itemManifestHash: "" }, 0);
}

async function buildPreview(tx: DatabaseTransaction, input: AiExtractionBatchPreviewInput, configuredModel: string): Promise<{ projectId: string; configuredModel: string; items: PreviewItem[]; confirmationHash: string; counts: AiExtractionBatchPreview["counts"] }> {
  const projectId = uuid(input.projectId, "Project");
  if (!input.externalTransmissionAcknowledged) throw new DomainError("VALIDATION_ERROR", "Batch transmission must be acknowledged");
  if (!input.items.length) throw new DomainError("VALIDATION_ERROR", "A batch must contain at least one selected cell");
  if (input.items.length > MAX_BATCH_ITEMS) throw new DomainError("VALIDATION_ERROR", `A batch is limited to ${MAX_BATCH_ITEMS} cells`);
  const normalized = input.items.map((item) => ({ ...item, paperId: uuid(item.paperId, "Paper"), fieldId: uuid(item.fieldId, "Field"), idempotencyKey: uuid(item.idempotencyKey ?? "", "Idempotency key") }));
  const seen = new Set<string>();
  for (const item of normalized) { const key = pairKey(item.paperId, item.fieldId); if (seen.has(key)) throw new DomainError("VALIDATION_ERROR", "A batch cannot contain the same Paper and extraction field twice"); seen.add(key); }
  const paperCount = new Set(normalized.map((item) => item.paperId)).size;
  const fieldCount = new Set(normalized.map((item) => item.fieldId)).size;
  if (paperCount > MAX_BATCH_PAPERS) throw new DomainError("VALIDATION_ERROR", `A batch is limited to ${MAX_BATCH_PAPERS} Papers`);
  if (fieldCount > MAX_BATCH_FIELDS) throw new DomainError("VALIDATION_ERROR", `A batch is limited to ${MAX_BATCH_FIELDS} extraction fields`);
  await lockBatchEntities(tx, projectId, normalized);
  const canonical = await canonicalRows(tx, projectId, normalized);
  if (canonical.length !== normalized.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Every selected Paper and field must belong to this project");
  const context = await loadPreviewContext(tx, projectId, normalized, canonical);
  const inputs = new Map(normalized.map((item) => [pairKey(item.paperId, item.fieldId), item]));
  const items = canonical.map((row, ordinal) => withOrdinal(buildPreviewItem(projectId, inputs.get(pairKey(String(row.paper_id), String(row.field_id)))!, row, context, configuredModel), ordinal));
  const executable = items.filter((item) => item.initialDisposition === "executable").length;
  const reusable = items.filter((item) => item.initialDisposition === "reusable").length;
  const blocked = items.filter((item) => item.initialDisposition === "blocked").length;
  const ineligible = items.filter((item) => item.initialDisposition === "ineligible").length;
  const confirmationHash = hashBatchManifest({ manifestAlgorithmVersion: BATCH_DOMAIN_VERSION, provider: "openai", configuredModel, configuredReasoningEffort: "low", selectionPolicyVersion: BATCH_SELECTION_POLICY_VERSION, batchDisclosureVersion: BATCH_DISCLOSURE_VERSION, requestDisclosureVersion: REQUEST_DISCLOSURE_VERSION, externalTransmissionAcknowledged: true, paperCount, fieldCount, cellCount: items.length, executableCount: executable, items: items.map((item) => ({ itemOrdinal: item.ordinal, itemManifestHash: item.itemManifestHash })) });
  return { projectId, configuredModel, items, confirmationHash, counts: { papers: paperCount, fields: fieldCount, cells: items.length, executable, reusable, blocked, ineligible } };
}

function requestInput(projectId: string, batch: Row, item: Row): BeginAiExtractionSuggestionInput { return { projectId, paperId: String(item.paper_id), fieldId: String(item.extraction_field_id), fullTextDocumentId: String(item.full_text_document_id), documentTextExtractionId: String(item.document_text_extraction_id), idempotencyKey: String(item.idempotency_key), model: String(batch.configured_model), reasoningEffort: "low", externalTransmissionAcknowledged: true, disclosureVersion: String(batch.request_disclosure_version) }; }
function inputFromPreviewItem(item: PreviewItem): RawItemInput { return { paperId: item.paperId, fieldId: item.fieldId, fullTextDocumentId: item.fullTextDocumentId ?? undefined, documentTextExtractionId: item.documentTextExtractionId ?? undefined, idempotencyKey: item.idempotencyKey }; }
function deriveItemState(batchCancelledAt: Date | null, item: Row): BatchItemState { const terminal = stringOrNull(item.orchestration_terminal_code); if (terminal) { if (terminal === "blocked_existing_request") return "blocked"; if (terminal.startsWith("ineligible") || terminal === "existing_cleared_revision") return "ineligible"; if (terminal === "cancelled") return "cancelled"; return "stale"; } if (String(item.request_relationship) === "blocking") return "blocked"; if (batchCancelledAt && item.ai_extraction_request_id == null) return "cancelled"; if (item.ai_extraction_request_id == null) { if (String(item.initial_disposition) === "blocked") return "blocked"; if (String(item.initial_disposition) === "ineligible") return "ineligible"; return "pending"; } if (String(item.decision) === "accepted") return "accepted"; if (String(item.decision) === "rejected") return "rejected"; if (item.result_id == null) return item.dispatch_id == null ? "request_ready" : "running"; if (String(item.outcome) === "succeeded" && item.candidate_state != null) return "suggestion_ready"; if (String(item.outcome) === "no_candidate") return "no_candidate"; if (String(item.outcome) === "outcome_unknown") return "outcome_unknown"; return "failed"; }
function previewItemFromRow(row: Row): PreviewItem { return { paperId: String(row.paper_id), fieldId: String(row.extraction_field_id), fullTextDocumentId: stringOrNull(row.full_text_document_id), documentTextExtractionId: stringOrNull(row.document_text_extraction_id), idempotencyKey: String(row.idempotency_key), ordinal: Number(row.item_ordinal), paperTitle: String(row.paper_title_snapshot), paperAbstract: stringOrNull(row.paper_abstract_snapshot), titleAbstractDecisionId: stringOrNull(row.title_abstract_decision_id), fullTextDecisionId: stringOrNull(row.full_text_decision_id), currentExtractionRevisionId: stringOrNull(row.expected_current_extraction_revision_id), initialDisposition: String(row.initial_disposition) as PreviewItem["initialDisposition"], initialReasonCode: String(row.initial_reason_code), expectedRequestIntentHash: stringOrNull(row.expected_request_intent_hash), fieldDefinitionHash: String(row.field_definition_hash), optionSnapshotHash: String(row.option_snapshot_hash), fieldName: String(row.field_name_snapshot), fieldDescription: stringOrNull(row.field_description_snapshot), fieldType: String(row.field_type_snapshot), fieldRequired: Boolean(row.field_required_snapshot), fieldOptions: Array.isArray(row.field_option_snapshot) ? row.field_option_snapshot as BatchFieldOptionSnapshot[] : [], documentFilename: stringOrNull(row.document_filename_snapshot), extractionSequence: row.extraction_sequence_snapshot == null ? null : Number(row.extraction_sequence_snapshot), extractionStatus: stringOrNull(row.extraction_status_snapshot), pageManifest: Array.isArray(row.page_manifest) ? row.page_manifest as BatchPinnedPageManifest["pages"] : [], pageManifestHash: String(row.page_manifest_hash), pageCount: Number(row.page_count), sourceCharacterCount: Number(row.source_character_count), sourceByteSize: Number(row.source_byte_size), itemManifestHash: String(row.item_manifest_hash), currentRevisionState: null }; }
  function driftCode(item: Row, current: PreviewItem): string | null { if (String(item.paper_title_snapshot) !== current.paperTitle || stringOrNull(item.paper_abstract_snapshot) !== current.paperAbstract) return "stale_paper_metadata"; if (stringOrNull(item.title_abstract_decision_id) !== current.titleAbstractDecisionId || stringOrNull(item.full_text_decision_id) !== current.fullTextDecisionId) return "stale_screening"; if (String(item.field_definition_hash) !== current.fieldDefinitionHash || String(item.option_snapshot_hash) !== current.optionSnapshotHash || json(item.field_option_snapshot ?? []) !== json(current.fieldOptions)) return "stale_field"; if (stringOrNull(item.expected_current_extraction_revision_id) !== current.currentExtractionRevisionId) return "stale_current_revision"; if (String(item.initial_disposition) === "executable" && ["full_text_document_missing", "full_text_document_archived", "stale_full_text_document"].includes(current.initialReasonCode)) return "stale_full_text_document"; if (stringOrNull(item.full_text_document_id) !== current.fullTextDocumentId || stringOrNull(item.document_filename_snapshot) !== current.documentFilename) return "stale_full_text_document"; if (stringOrNull(item.document_text_extraction_id) !== current.documentTextExtractionId || (item.extraction_sequence_snapshot == null ? null : Number(item.extraction_sequence_snapshot)) !== current.extractionSequence || stringOrNull(item.extraction_status_snapshot) !== current.extractionStatus || String(item.page_manifest_hash) !== current.pageManifestHash || Number(item.page_count) !== current.pageCount || Number(item.source_character_count) !== current.sourceCharacterCount || Number(item.source_byte_size) !== current.sourceByteSize) return "stale_text_extraction"; if (String(item.expected_request_intent_hash ?? "") !== String(current.expectedRequestIntentHash ?? "")) return "stale_request_intent"; if (String(item.item_manifest_hash) !== current.itemManifestHash) return "stale_manifest"; return null; }

export function createAiExtractionBatchServices(db: Database, suggestions: AiExtractionSuggestionServices, options: AiExtractionBatchServiceOptions): AiExtractionBatchServices {
  const configuredModel = options.configuredModel.trim();
  if (!configuredModel || configuredModel.length > 200) throw new Error("A configured AI extraction model is required");
  const providerAvailable = options.providerAvailable ?? true;
  function requireProviderAvailable() { if (!providerAvailable) throw new DomainError("VALIDATION_ERROR", "The AI extraction provider is not configured; batch creation or processing is unavailable"); }
  async function load(projectId: string, batchId: string, readOptions: AiExtractionBatchReadOptions = {}): Promise<AiExtractionBatch> {
    const pid = uuid(projectId, "Project"); const bid = uuid(batchId, "Batch");
    const batch = rows(await db.execute(sql`select * from ai_extraction_batches where project_id=${pid}::uuid and id=${bid}::uuid limit 1`))[0];
    if (!batch) { const byId = rows(await db.execute(sql`select project_id from ai_extraction_batches where id=${bid}::uuid limit 1`))[0]; if (byId && String(byId.project_id) !== pid) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI extraction batch does not belong to this project"); throw new DomainError("NOT_FOUND", "AI extraction batch was not found"); }
    const itemRows = rows(await db.execute(sql`select i.*,d.id as dispatch_id,x.id as result_id,x.outcome,x.candidate_state,x.text_value,x.number_value,x.boolean_value,x.option_id,x.explanation,x.input_tokens,x.output_tokens,x.duration_ms,dec.decision from ai_extraction_batch_items i left join ai_extraction_dispatches d on d.project_id=i.project_id and d.request_id=i.ai_extraction_request_id left join ai_extraction_results x on x.project_id=i.project_id and x.request_id=i.ai_extraction_request_id left join ai_extraction_decisions dec on dec.project_id=i.project_id and dec.request_id=i.ai_extraction_request_id where i.project_id=${pid}::uuid and i.batch_id=${bid}::uuid order by i.item_ordinal`));
    const cancelledAt = asDate(batch.cancelled_at);
    const mapped = itemRows.map((row) => ({ ...previewItemFromRow(row), itemId: String(row.id), requestId: stringOrNull(row.ai_extraction_request_id), requestRelationship: stringOrNull(row.request_relationship), state: deriveItemState(cancelledAt, row), result: row.result_id == null ? null : { id: String(row.result_id), outcome: String(row.outcome), candidateState: stringOrNull(row.candidate_state), value: row.text_value ?? row.number_value ?? row.boolean_value ?? row.option_id ?? null, explanation: stringOrNull(row.explanation) }, decision: stringOrNull(row.decision), dispatchId: stringOrNull(row.dispatch_id), terminalCode: stringOrNull(row.orchestration_terminal_code) }));
    const counts = mapped.reduce<Record<string, number>>((all, item) => { all[item.state] = (all[item.state] ?? 0) + 1; return all; }, {});
    const paperFilter = readOptions.paperId == null ? null : uuid(readOptions.paperId, "Paper"); const fieldFilter = readOptions.fieldId == null ? null : uuid(readOptions.fieldId, "Field");
    const filtered = mapped.filter((item) => (paperFilter == null || item.paperId === paperFilter) && (fieldFilter == null || item.fieldId === fieldFilter) && (readOptions.state == null || item.state === readOptions.state));
    const pageSize = Math.min(Math.max(Number.isSafeInteger(readOptions.pageSize) ? Number(readOptions.pageSize) : MAX_BATCH_ITEMS, 1), MAX_BATCH_ITEMS); const page = Math.max(Number.isSafeInteger(readOptions.page) ? Number(readOptions.page) : 1, 1); const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);
    const usage = itemRows.reduce<{ resultCount: number; successCount: number; failureCount: number; inputTokens: number; outputTokens: number; durationMs: number }>((total, row) => { if (row.result_id == null) return total; total.resultCount += 1; if (String(row.outcome) === "succeeded") total.successCount += 1; else total.failureCount += 1; total.inputTokens += Number(row.input_tokens ?? 0); total.outputTokens += Number(row.output_tokens ?? 0); total.durationMs += Number(row.duration_ms ?? 0); return total; }, { resultCount: 0, successCount: 0, failureCount: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 });
    const active = mapped.some((item) => ["pending", "request_ready", "running"].includes(item.state));
    return { batchId: bid, projectId: pid, configuredModel: String(batch.configured_model), configuredReasoningEffort: "low", batchDisclosureVersion: String(batch.batch_disclosure_version), requestDisclosureVersion: String(batch.request_disclosure_version), cancelledAt, state: cancelledAt ? "cancelled" : active ? "active" : "completed", counts, totalItems: mapped.length, matchingItems: filtered.length, page, pageSize, hasNextPage: page * pageSize < filtered.length, usage, items: pageItems };
  }
  async function processOne(projectId: string, batchId: string, itemId: string): Promise<void> {
    const action = await withSerializableRetry(db, async (tx) => {
      const pid = uuid(projectId, "Project"); const bid = uuid(batchId, "Batch"); const iid = uuid(itemId, "Batch item");
      const batch = rows(await tx.execute(sql`select * from ai_extraction_batches where project_id=${pid}::uuid and id=${bid}::uuid for update`))[0];
      if (!batch) { const byId = rows(await tx.execute(sql`select project_id from ai_extraction_batches where id=${bid}::uuid limit 1`))[0]; if (byId && String(byId.project_id) !== pid) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI extraction batch does not belong to this project"); throw new DomainError("NOT_FOUND", "AI extraction batch was not found"); }
      const item = rows(await tx.execute(sql`select * from ai_extraction_batch_items where project_id=${pid}::uuid and batch_id=${bid}::uuid and id=${iid}::uuid for update`))[0];
      if (!item || item.ai_extraction_request_id != null || item.orchestration_terminal_code != null || batch.cancelled_at) return { claim: null };
      const input = { paperId: String(item.paper_id), fieldId: String(item.extraction_field_id), fullTextDocumentId: stringOrNull(item.full_text_document_id) ?? undefined, documentTextExtractionId: stringOrNull(item.document_text_extraction_id) ?? undefined, idempotencyKey: String(item.idempotency_key) };
      await lockBatchEntities(tx, pid, [input]);
      const currentPreview = await buildPreview(tx, { projectId: pid, items: [input], model: String(batch.configured_model), reasoningEffort: "low", externalTransmissionAcknowledged: true, disclosureVersion: String(batch.batch_disclosure_version) }, String(batch.configured_model));
      const current = withOrdinal(currentPreview.items[0], Number(item.item_ordinal));
      if (current.initialDisposition === "blocked" && current.initialReasonCode === "blocked_existing_request") {
        const late = rows(await tx.execute(sql`select r.id from ai_extraction_requests r where r.project_id=${pid}::uuid and r.paper_id=${String(item.paper_id)}::uuid and r.extraction_field_id=${String(item.extraction_field_id)}::uuid and not exists (select 1 from ai_extraction_results x where x.project_id=r.project_id and x.request_id=r.id) order by r.created_at,r.id limit 1`))[0];
        if (late) await tx.execute(sql`update ai_extraction_batch_items set ai_extraction_request_id=${String(late.id)}::uuid,request_relationship='blocking',orchestration_terminal_code='blocked_existing_request',orchestration_terminal_detail='An unresolved Slice 26 AI request already owns this Paper and field',orchestration_finalized_at=now() where project_id=${pid}::uuid and id=${iid}::uuid`);
        else await tx.execute(sql`update ai_extraction_batch_items set orchestration_terminal_code='blocked_existing_request',orchestration_terminal_detail='An unresolved Slice 26 AI request already owns this Paper and field',orchestration_finalized_at=now() where project_id=${pid}::uuid and id=${iid}::uuid`);
        return { claim: null };
      }
      const stale = driftCode(item, current);
      if (stale) { await tx.execute(sql`update ai_extraction_batch_items set orchestration_terminal_code=${stale},orchestration_terminal_detail=${`Batch item manifest is stale: ${stale}`},orchestration_finalized_at=now() where project_id=${pid}::uuid and id=${iid}::uuid`); return { claim: null }; }
      if (current.initialDisposition === "ineligible") { await tx.execute(sql`update ai_extraction_batch_items set orchestration_terminal_code=${current.initialReasonCode},orchestration_terminal_detail=${`Batch item is no longer eligible: ${current.initialReasonCode}`},orchestration_finalized_at=now() where project_id=${pid}::uuid and id=${iid}::uuid`); return { claim: null }; }
      if (String(item.initial_disposition) === "reusable" && current.initialDisposition !== "reusable") { await tx.execute(sql`update ai_extraction_batch_items set orchestration_terminal_code='stale_terminal_suggestion',orchestration_terminal_detail='The previously reusable suggestion is no longer an undecided exact match',orchestration_finalized_at=now() where project_id=${pid}::uuid and id=${iid}::uuid`); return { claim: null }; }
      if (current.initialDisposition === "blocked") {
        const late = rows(await tx.execute(sql`select r.id from ai_extraction_requests r where r.project_id=${pid}::uuid and r.paper_id=${String(item.paper_id)}::uuid and r.extraction_field_id=${String(item.extraction_field_id)}::uuid and not exists (select 1 from ai_extraction_results x where x.project_id=r.project_id and x.request_id=r.id) order by r.created_at,r.id limit 1`))[0];
        if (late) await tx.execute(sql`update ai_extraction_batch_items set ai_extraction_request_id=${String(late.id)}::uuid,request_relationship='blocking',orchestration_terminal_code='blocked_existing_request',orchestration_terminal_detail='An unresolved Slice 26 AI request already owns this Paper and field',orchestration_finalized_at=now() where project_id=${pid}::uuid and id=${iid}::uuid`); else await tx.execute(sql`update ai_extraction_batch_items set orchestration_terminal_code='blocked_existing_request',orchestration_terminal_detail='An unresolved Slice 26 AI request already owns this Paper and field',orchestration_finalized_at=now() where project_id=${pid}::uuid and id=${iid}::uuid`);
        return { claim: null };
      }
      let plan: Row;
      try { plan = await suggestions._batchTransactionSeams.planRequestInTransaction(tx, requestInput(pid, batch, item), { locksAlreadyHeld: true, batchStrict: true }); }
      catch (error) {
        if (error instanceof DomainError && /unresolved AI request/i.test(error.message)) {
          const late = rows(await tx.execute(sql`select r.id from ai_extraction_requests r where r.project_id=${pid}::uuid and r.paper_id=${String(item.paper_id)}::uuid and r.extraction_field_id=${String(item.extraction_field_id)}::uuid and not exists (select 1 from ai_extraction_results x where x.project_id=r.project_id and x.request_id=r.id) order by r.created_at,r.id limit 1`))[0];
          if (late) await tx.execute(sql`update ai_extraction_batch_items set ai_extraction_request_id=${String(late.id)}::uuid,request_relationship='blocking',orchestration_terminal_code='blocked_existing_request',orchestration_terminal_detail='An unresolved Slice 26 AI request won the race before dispatch',orchestration_finalized_at=now() where project_id=${pid}::uuid and id=${iid}::uuid`); else await tx.execute(sql`update ai_extraction_batch_items set orchestration_terminal_code='blocked_existing_request',orchestration_terminal_detail='An unresolved Slice 26 AI request won the race before dispatch',orchestration_finalized_at=now() where project_id=${pid}::uuid and id=${iid}::uuid`);
          return { claim: null };
        }
        throw error;
      }
      const requestId = String(plan.requestId);
      await tx.execute(sql`update ai_extraction_batch_items set ai_extraction_request_id=${requestId}::uuid,request_relationship='authoritative' where project_id=${pid}::uuid and id=${iid}::uuid`);
      if (plan.reused) return { claim: null };
      const claim = await suggestions._batchTransactionSeams.claimDispatchInTransaction(tx, requestId, { batchStrict: true });
      return { claim };
    });
    if (action.claim) await suggestions._batchTransactionSeams.runClaimedAiExtractionDispatch(action.claim);
  }
  const services: AiExtractionBatchServices = {
    async previewAiExtractionBatch(input) { requireProviderAvailable(); const result = await withSerializableRetry(db, (tx) => buildPreview(tx, input, configuredModel)); return { batchId: randomUUID(), projectId: result.projectId, configuredModel: result.configuredModel, configuredReasoningEffort: "low", confirmationHash: result.confirmationHash, createdAt: new Date(), items: result.items, counts: result.counts }; },
    async createAiExtractionBatch(preview, confirmationHash) {
      requireProviderAvailable();
      const batchId = await withSerializableRetry(db, async (tx) => {
        const raw: AiExtractionBatchPreviewInput = { projectId: preview.projectId, items: preview.items.map(inputFromPreviewItem), model: preview.configuredModel, reasoningEffort: "low", externalTransmissionAcknowledged: true, disclosureVersion: BATCH_DISCLOSURE_VERSION };
        const recomputed = await buildPreview(tx, raw, configuredModel); const suppliedHash = confirmationHash ?? preview.confirmationHash;
        if (suppliedHash !== preview.confirmationHash || recomputed.confirmationHash !== suppliedHash) throw new DomainError("CONCURRENT_MODIFICATION", "Preview changed; review again");
        const id = uuid(preview.batchId, "Batch"); if (recomputed.counts.executable + recomputed.counts.reusable < 1) throw new DomainError("VALIDATION_ERROR", "Batch creation requires at least one executable or reusable cell");
        await tx.execute(sql`insert into ai_extraction_batches (id,project_id,provider,configured_model,configured_reasoning_effort,selection_policy_version,batch_disclosure_version,request_disclosure_version,external_transmission_acknowledged,paper_count,field_count,cell_count,executable_count,manifest_algorithm_version,manifest_sha256) values (${id}::uuid,${preview.projectId}::uuid,'openai',${preview.configuredModel},'low',${BATCH_SELECTION_POLICY_VERSION},${BATCH_DISCLOSURE_VERSION},${REQUEST_DISCLOSURE_VERSION},true,${recomputed.counts.papers},${recomputed.counts.fields},${recomputed.counts.cells},${recomputed.counts.executable},${BATCH_DOMAIN_VERSION},${recomputed.confirmationHash})`);
        for (const item of recomputed.items) await tx.execute(sql`insert into ai_extraction_batch_items (project_id,batch_id,item_ordinal,paper_id,extraction_field_id,expected_current_extraction_revision_id,title_abstract_decision_id,full_text_decision_id,full_text_document_id,document_text_extraction_id,initial_disposition,initial_reason_code,idempotency_key,expected_request_intent_hash,field_definition_hash,option_snapshot_hash,paper_title_snapshot,paper_abstract_snapshot,field_name_snapshot,field_description_snapshot,field_type_snapshot,field_required_snapshot,field_option_snapshot,document_filename_snapshot,extraction_sequence_snapshot,extraction_status_snapshot,page_manifest,page_manifest_hash,page_count,source_character_count,source_byte_size,item_manifest_hash) values (${preview.projectId}::uuid,${id}::uuid,${item.ordinal},${item.paperId}::uuid,${item.fieldId}::uuid,${item.currentExtractionRevisionId}::uuid,${item.titleAbstractDecisionId}::uuid,${item.fullTextDecisionId}::uuid,${item.fullTextDocumentId}::uuid,${item.documentTextExtractionId}::uuid,${item.initialDisposition},${item.initialReasonCode},${item.idempotencyKey}::uuid,${item.expectedRequestIntentHash},${item.fieldDefinitionHash},${item.optionSnapshotHash},${item.paperTitle},${item.paperAbstract},${item.fieldName},${item.fieldDescription},${item.fieldType},${item.fieldRequired},${json(item.fieldOptions)}::jsonb,${item.documentFilename},${item.extractionSequence},${item.extractionStatus},${json(item.pageManifest)}::jsonb,${item.pageManifestHash},${item.pageCount},${item.sourceCharacterCount},${item.sourceByteSize},${item.itemManifestHash})`);
        for (const item of recomputed.items.filter((candidate) => candidate.initialDisposition === "blocked" && candidate.initialReasonCode === "blocked_existing_request")) {
          const unresolved = rows(await tx.execute(sql`select r.id from ai_extraction_requests r where r.project_id=${preview.projectId}::uuid and r.paper_id=${item.paperId}::uuid and r.extraction_field_id=${item.fieldId}::uuid and not exists (select 1 from ai_extraction_results x where x.project_id=r.project_id and x.request_id=r.id) order by r.created_at,r.id limit 1`))[0];
          if (unresolved) await tx.execute(sql`update ai_extraction_batch_items set ai_extraction_request_id=${String(unresolved.id)}::uuid,request_relationship='blocking',orchestration_terminal_code='blocked_existing_request',orchestration_terminal_detail='An unresolved Slice 26 AI request already owns this Paper and field',orchestration_finalized_at=now() where project_id=${preview.projectId}::uuid and batch_id=${id}::uuid and item_ordinal=${item.ordinal}`);
        }
        return id;
      });
      return load(preview.projectId, batchId);
    },
    async confirmAiExtractionBatch(preview, confirmationHash) { return this.createAiExtractionBatch(preview, confirmationHash); },
    async listAiExtractionBatches(projectId, limit = 20) { const pid = uuid(projectId, "Project"); const bounded = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 20, 1), 100); const batchRows = rows(await db.execute(sql`select id from ai_extraction_batches where project_id=${pid}::uuid order by created_at desc,id desc limit ${bounded}`)); return Promise.all(batchRows.map((row) => load(pid, String(row.id)))); },
    async getAiExtractionBatch(batchId, projectId, readOptions) { const pid = projectId ? uuid(projectId, "Project") : null; try { if (!pid) { const found = rows(await db.execute(sql`select project_id from ai_extraction_batches where id=${uuid(batchId, "Batch")}::uuid limit 1`))[0]; if (!found) return null; return await load(String(found.project_id), batchId, readOptions); } return await load(pid, batchId, readOptions); } catch (error) { if (error instanceof DomainError && error.code === "NOT_FOUND") return null; throw error; } },
    async processNextAiExtractionBatchItems(projectId, batchId, processOptions = {}) { requireProviderAvailable(); const pid = uuid(projectId, "Project"); const batch = await load(pid, batchId); if (batch.state === "cancelled" || batch.state === "completed") return batch; const concurrency = Math.min(Math.max(Number.isSafeInteger(processOptions.concurrency) ? Number(processOptions.concurrency) : BATCH_PROVIDER_CONCURRENCY, 1), BATCH_PROVIDER_CONCURRENCY); const candidates = batch.items.filter((item) => ["executable", "reusable"].includes(item.initialDisposition) && item.requestId == null && item.terminalCode == null).sort((left, right) => left.ordinal - right.ordinal).slice(0, BATCH_MAX_ITEMS_PER_ACTION).map((item) => item.itemId); let cursor = 0; const worker = async () => { while (true) { const next = candidates[cursor++]; if (!next) return; await processOne(pid, batch.batchId, next); } }; const outcomes = await Promise.allSettled(Array.from({ length: concurrency }, () => worker())); const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"); if (rejected) throw rejected.reason; return load(pid, batch.batchId); },
    async executeAiExtractionBatch(projectId, batchId) { return this.processNextAiExtractionBatchItems(projectId, batchId); },
    async cancelAiExtractionBatch(batchId, projectId) { const bid = uuid(batchId, "Batch"); const pid = projectId == null ? null : uuid(projectId, "Project"); if (pid == null) { const found = rows(await db.execute(sql`select project_id from ai_extraction_batches where id=${bid}::uuid limit 1`))[0]; if (!found) throw new DomainError("NOT_FOUND", "AI extraction batch was not found"); return this.cancelAiExtractionBatch(bid, String(found.project_id)); } await withSerializableRetry(db, async (tx) => { const batch = rows(await tx.execute(sql`select id from ai_extraction_batches where project_id=${pid}::uuid and id=${bid}::uuid for update`))[0]; if (!batch) { const byId = rows(await tx.execute(sql`select project_id from ai_extraction_batches where id=${bid}::uuid limit 1`))[0]; if (byId && String(byId.project_id) !== pid) throw new DomainError("CROSS_PROJECT_REFERENCE", "AI extraction batch does not belong to this project"); throw new DomainError("NOT_FOUND", "AI extraction batch was not found"); } await tx.execute(sql`update ai_extraction_batches set cancelled_at=now() where project_id=${pid}::uuid and id=${bid}::uuid and cancelled_at is null`); }); return load(pid, bid); },
  };
  return services;
}
