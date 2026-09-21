import { createHash } from "node:crypto";
import { DomainError } from "@/domain/errors";

export const BATCH_DOMAIN_VERSION = "ai-extraction-batch-domain-v1";
export const MAX_BATCH_ITEMS = 500;
export const MAX_BATCH_PAPERS = 100;
export const MAX_BATCH_FIELDS = 25;
export const MAX_BATCH_PAGES_PER_ITEM = 40;
export const MAX_BATCH_SOURCE_CHARACTERS = 80_000;
export const MAX_BATCH_SOURCE_BYTES = 327_680;
export const MAX_SERIALIZABLE_RETRIES = 3;

export type ExtractionFieldType = "short_text" | "long_text" | "number" | "boolean" | "single_select";
export type BatchSelectionPreset = "all" | "eligible" | "missing" | "missing_or_stale" | "explicit";
export type ExtractionRunStatus = "pending" | "running" | "succeeded" | "partial" | "failed";
export type BatchEligibilityReason =
  | "eligible"
  | "paper_not_finally_included"
  | "field_archived"
  | "full_text_document_missing"
  | "full_text_document_archived"
  | "no_non_failed_text_extraction"
  | "text_extraction_pending"
  | "stale_text_extraction"
  | "text_extraction_not_usable"
  | "no_eligible_pages";

export interface BatchPaperSnapshot {
  projectId: string;
  paperId: string;
  title: string;
  finallyIncluded: boolean;
}

export interface BatchFieldOptionSnapshot {
  id: string;
  label: string;
  sortOrder: number;
  archivedAt?: string | null;
}

export interface BatchFieldSnapshot {
  projectId: string;
  id: string;
  name: string;
  description: string | null;
  fieldType: ExtractionFieldType;
  required: boolean;
  sortOrder: number;
  archivedAt: string | null;
  options: readonly BatchFieldOptionSnapshot[];
}

export interface BatchFullTextDocumentSnapshot {
  id: string;
  paperId: string;
  archivedAt: string | null;
}

export interface BatchTextExtractionSnapshot {
  id: string;
  paperId: string;
  fullTextDocumentId: string;
  sequence: number | bigint;
  status: ExtractionRunStatus;
}

export interface BatchExtractionPageSnapshot {
  id: string;
  paperId: string;
  documentTextExtractionId: string;
  pageNumber: number;
  status: "succeeded" | "failed";
  text: string;
}

export interface BatchPinnedSourceInput {
  paper: BatchPaperSnapshot;
  document: BatchFullTextDocumentSnapshot;
  extraction: BatchTextExtractionSnapshot;
  pages: readonly BatchExtractionPageSnapshot[];
}

export interface BatchPageManifestPage {
  pageId: string;
  pageNumber: number;
  pageOrdinal: number;
  textSha256: string;
  characterCount: number;
  byteSize: number;
}

export interface BatchPinnedPageManifest {
  paperId: string;
  documentTextExtractionId: string;
  pages: readonly BatchPageManifestPage[];
  characterCount: number;
  byteSize: number;
  hash: string;
}

export interface BatchPinnedSourceSnapshot {
  document: BatchFullTextDocumentSnapshot;
  extraction: BatchTextExtractionSnapshot;
  pageManifest: BatchPinnedPageManifest;
}

export interface BatchCandidate {
  paper: BatchPaperSnapshot;
  field: BatchFieldSnapshot;
  source: BatchPinnedSourceInput | null;
  extractions: readonly BatchTextExtractionSnapshot[];
  currentExtractionRevisionId: string | null;
}

export interface BatchEligibilityResult {
  eligible: boolean;
  providerCallAllowed: boolean;
  reason: BatchEligibilityReason;
  latestNonFailedExtractionId: string | null;
  pinnedExtractionId: string | null;
}

export interface BatchSelectionInput {
  candidates: readonly BatchCandidate[];
  preset: BatchSelectionPreset;
  paperIds?: readonly string[];
  fieldIds?: readonly string[];
  maxItems?: number;
}

export interface BatchPreviewItem {
  ordinal: number;
  paper: BatchPaperSnapshot;
  field: BatchFieldSnapshot;
  source: BatchPinnedSourceSnapshot | null;
  currentExtractionRevisionId: string | null;
  eligibility: BatchEligibilityResult;
  fieldSnapshotHash: string;
  optionSnapshotHash: string;
  sourceSnapshotHash: string | null;
  intentHash: string;
}

export type BatchItemStatus = "pending" | "claimed" | "succeeded" | "failed" | "stale" | "cancelled";
export type BatchStatus = "preview" | "confirmed" | "running" | "completed" | "cancelled";

export interface BatchAggregate {
  total: number;
  pending: number;
  claimed: number;
  succeeded: number;
  failed: number;
  stale: number;
  cancelled: number;
  terminal: number;
}

export interface BatchLifecycleInput {
  id: string;
  status: BatchStatus;
  itemStatuses: readonly BatchItemStatus[];
}

export interface BatchSuggestionIntentContext {
  projectId: string;
  paperId: string;
  fieldId: string;
  fullTextDocumentId: string;
  documentTextExtractionId: string;
  baselineExtractionRevisionId: string | null;
  fieldSnapshotHash: string;
  optionSnapshotHash: string;
  sourceSnapshotHash: string;
  pageManifestHash: string;
  model: string;
  reasoningEffort: string;
  promptVersion: string;
  responseSchemaVersion: string;
  groundingResolverVersion: string;
  contextSelectionVersion: string;
  disclosureVersion: string;
}

export interface TerminalSuggestionReuseInput {
  request: {
    outcome: "succeeded" | string;
    intentHash: string;
    context: BatchSuggestionIntentContext;
  };
  result: {
    outcome: "succeeded" | string;
    candidateExists: boolean;
  } | null;
  decision: null | { kind: "accepted" | "rejected" | "pending" | string };
  current: {
    context: BatchSuggestionIntentContext;
    eligibility: BatchEligibilityResult;
    pageManifestHash: string;
  };
}

export type TerminalSuggestionReuseReason =
  | "reusable"
  | "request_not_succeeded"
  | "result_not_succeeded"
  | "candidate_missing"
  | "decision_already_exists"
  | "intent_changed"
  | "context_changed"
  | "manifest_changed"
  | "current_source_ineligible";

export interface TerminalSuggestionReuseResult {
  reusable: boolean;
  reason: TerminalSuggestionReuseReason;
}

export interface BatchCompatibilityInput {
  providerCallsInDomain?: boolean;
  queueDispatchInDomain?: boolean;
  openAiBatchApi?: boolean;
  canonicalExtractionRevisionWrites?: boolean;
  bulkAcceptance?: boolean;
}

export interface BatchCompatibilityResult {
  compatible: boolean;
  violations: readonly string[];
}

type CanonicalScalar = string | number | bigint | boolean | null;

function fail(message: string): never {
  throw new DomainError("VALIDATION_ERROR", message);
}

function uuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function integer(value: number | bigint | string, label: string): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || Object.is(value, -0))) {
    if (Object.is(value, -0)) return "0";
    fail(`${label} must be a safe integer`);
  }
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(text)) fail(`${label} must be a canonical integer`);
  return text === "-0" ? "0" : text;
}

function scalarBytes(value: CanonicalScalar): Uint8Array {
  if (value === null) return Uint8Array.of(0);
  if (typeof value === "boolean") return Uint8Array.from([2, ...(value ? [116, 114, 117, 101] : [102, 97, 108, 115, 101])]);
  if (typeof value === "number" || typeof value === "bigint") return Uint8Array.from([3, ...new TextEncoder().encode(integer(value, "integer"))]);
  return Uint8Array.from([1, ...new TextEncoder().encode(value)]);
}

/**
 * Canonical scalar encoding used by every W2 hash. Each value is encoded as
 * uint32-big-endian byte length followed by a typed UTF-8 payload. Null is a
 * one-byte payload, not an empty string; booleans are `true`/`false`; integers
 * are base-10 without a plus sign or leading zeroes. UUID fields are passed
 * through `canonicalUuid` before being supplied here.
 */
export function encodeLengthPrefixedScalars(values: readonly CanonicalScalar[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const value of values) {
    const payload = scalarBytes(value);
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, payload.byteLength, false);
    chunks.push(prefix, payload);
  }
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function canonicalUuid(value: string, label = "UUID"): string {
  return uuid(value, label);
}

export function canonicalInteger(value: number | bigint | string, label = "integer"): string {
  return integer(value, label);
}

export function sha256LengthPrefixedScalars(values: readonly CanonicalScalar[]): string {
  return createHash("sha256").update(encodeLengthPrefixedScalars(values)).digest("hex");
}

/** Canonical page-manifest hash for blocked/ineligible items with no source. */
export const EMPTY_PAGE_MANIFEST_HASH = sha256LengthPrefixedScalars([
  BATCH_DOMAIN_VERSION,
  null,
  null,
  0,
  0,
  0,
]);

function textSha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function assertUnique(values: readonly string[], label: string): void {
  const normalized = values.map((value) => uuid(value, label));
  if (new Set(normalized).size !== normalized.length) fail(`${label} cannot contain duplicates`);
}

function activeOptions(field: BatchFieldSnapshot): BatchFieldOptionSnapshot[] {
  if (field.fieldType !== "single_select" && field.options.length > 0) fail("Only single-select fields may have options");
  const options = [...field.options]
    .filter((option) => option.archivedAt == null)
    .map((option) => ({ ...option, id: uuid(option.id, "Option"), sortOrder: Number(integer(option.sortOrder, "Option sort order")) }))
    .sort((left, right) => left.sortOrder - right.sortOrder || compareCanonicalText(left.id, right.id));
  assertUnique(options.map((option) => option.id), "Option");
  return options;
}

export function hashFieldSnapshot(field: BatchFieldSnapshot): string {
  const options = activeOptions(field);
  return sha256LengthPrefixedScalars([
    BATCH_DOMAIN_VERSION,
    uuid(field.projectId, "Project"),
    uuid(field.id, "Field"),
    field.name,
    field.description,
    field.fieldType,
    field.required,
    field.archivedAt,
    hashOptionSnapshot(options),
  ]);
}

export function hashOptionSnapshot(options: readonly BatchFieldOptionSnapshot[]): string {
  const normalized = [...options]
    .filter((option) => option.archivedAt == null)
    .map((option) => ({ id: uuid(option.id, "Option"), label: option.label, sortOrder: option.sortOrder }))
    .sort((left, right) => left.sortOrder - right.sortOrder || compareCanonicalText(left.id, right.id));
  assertUnique(normalized.map((option) => option.id), "Option");
  integer(normalized.length, "Option count");
  const values: CanonicalScalar[] = [BATCH_DOMAIN_VERSION, normalized.length];
  for (const option of normalized) values.push(option.id, option.label, option.sortOrder);
  return sha256LengthPrefixedScalars(values);
}

function validatePage(page: BatchExtractionPageSnapshot, source: BatchPinnedSourceInput): BatchPageManifestPage | null {
  if (uuid(page.paperId, "Page paper") !== uuid(source.paper.paperId, "Paper")) fail("Page does not belong to the selected Paper");
  if (uuid(page.documentTextExtractionId, "Page extraction") !== uuid(source.extraction.id, "Extraction")) fail("Page does not belong to the pinned extraction");
  if (!Number.isSafeInteger(page.pageNumber) || page.pageNumber <= 0) fail("Page number must be a positive integer");
  if (page.status !== "succeeded" || page.text.length === 0) return null;
  const characterCount = Array.from(page.text).length;
  const byteSize = Buffer.byteLength(page.text, "utf8");
  return { pageId: uuid(page.id, "Page"), pageNumber: page.pageNumber, pageOrdinal: -1, textSha256: textSha256(page.text), characterCount, byteSize };
}

export function buildPinnedExtractionPageManifest(source: BatchPinnedSourceInput): BatchPinnedPageManifest {
  const pages = source.pages.map((page) => validatePage(page, source)).filter((page): page is BatchPageManifestPage => page !== null);
  assertUnique(pages.map((page) => page.pageId), "Page");
  if (new Set(pages.map((page) => page.pageNumber)).size !== pages.length) fail("Extraction pages cannot repeat a page number");
  pages.sort((left, right) => left.pageNumber - right.pageNumber || compareCanonicalText(left.pageId, right.pageId));
  if (pages.length > MAX_BATCH_PAGES_PER_ITEM) fail(`A batch item cannot contain more than ${MAX_BATCH_PAGES_PER_ITEM} eligible pages`);
  pages.forEach((page, index) => { page.pageOrdinal = index; });
  const characterCount = pages.reduce((total, page) => total + page.characterCount, 0);
  const byteSize = pages.reduce((total, page) => total + page.byteSize, 0);
  if (characterCount > MAX_BATCH_SOURCE_CHARACTERS || byteSize > MAX_BATCH_SOURCE_BYTES) fail("Pinned source exceeds the AI extraction input budget");
  const values: CanonicalScalar[] = [
    BATCH_DOMAIN_VERSION,
    uuid(source.paper.paperId, "Paper"),
    uuid(source.extraction.id, "Extraction"),
    pages.length,
    characterCount,
    byteSize,
  ];
  for (const page of pages) values.push(page.pageId, page.pageNumber, page.pageOrdinal, page.textSha256, page.characterCount, page.byteSize);
  return {
    paperId: uuid(source.paper.paperId, "Paper"),
    documentTextExtractionId: uuid(source.extraction.id, "Extraction"),
    pages,
    characterCount,
    byteSize,
    hash: sha256LengthPrefixedScalars(values),
  };
}

export function cachePinnedExtractionPageManifest(
  cache: Map<string, BatchPinnedPageManifest>,
  source: BatchPinnedSourceInput,
): BatchPinnedPageManifest {
  const key = `${uuid(source.paper.paperId, "Paper")}:${uuid(source.extraction.id, "Extraction")}`;
  const manifest = buildPinnedExtractionPageManifest(source);
  const existing = cache.get(key);
  if (existing) {
    if (existing.hash !== manifest.hash) fail("A Paper/extraction page manifest was already pinned with different content");
    return existing;
  }
  cache.set(key, manifest);
  return manifest;
}

export function latestNonFailedExtraction(extractions: readonly BatchTextExtractionSnapshot[]): BatchTextExtractionSnapshot | null {
  return [...extractions]
    .filter((extraction) => extraction.status !== "failed")
    .sort((left, right) => {
      const leftSequence = BigInt(integer(left.sequence, "Extraction sequence"));
      const rightSequence = BigInt(integer(right.sequence, "Extraction sequence"));
      return rightSequence < leftSequence ? -1 : rightSequence > leftSequence ? 1 : compareCanonicalText(uuid(left.id, "Extraction"), uuid(right.id, "Extraction"));
    })[0] ?? null;
}

export function evaluateInitialEligibility(input: {
  paper: BatchPaperSnapshot;
  field: BatchFieldSnapshot;
  source: BatchPinnedSourceInput | null;
  extractions: readonly BatchTextExtractionSnapshot[];
}): BatchEligibilityResult {
  const pinnedExtractionId = input.source?.extraction.id == null ? null : uuid(input.source.extraction.id, "Extraction");
  if (!input.paper.finallyIncluded) return { eligible: false, providerCallAllowed: false, reason: "paper_not_finally_included", latestNonFailedExtractionId: null, pinnedExtractionId };
  if (input.field.archivedAt != null) return { eligible: false, providerCallAllowed: false, reason: "field_archived", latestNonFailedExtractionId: null, pinnedExtractionId };
  if (!input.source) return { eligible: false, providerCallAllowed: false, reason: "full_text_document_missing", latestNonFailedExtractionId: null, pinnedExtractionId: null };
  if (input.source.document.archivedAt != null) return { eligible: false, providerCallAllowed: false, reason: "full_text_document_archived", latestNonFailedExtractionId: null, pinnedExtractionId };
  const latest = latestNonFailedExtraction(input.extractions.filter((extraction) =>
    uuid(extraction.paperId, "Extraction paper") === uuid(input.paper.paperId, "Paper")
    && uuid(extraction.fullTextDocumentId, "Extraction document") === uuid(input.source!.document.id, "Document")));
  if (!latest) return { eligible: false, providerCallAllowed: false, reason: "no_non_failed_text_extraction", latestNonFailedExtractionId: null, pinnedExtractionId };
  const latestId = uuid(latest.id, "Extraction");
  if (pinnedExtractionId !== latestId) return { eligible: false, providerCallAllowed: false, reason: "stale_text_extraction", latestNonFailedExtractionId: latestId, pinnedExtractionId };
  if (latest.status === "pending" || latest.status === "running") return { eligible: false, providerCallAllowed: false, reason: "text_extraction_pending", latestNonFailedExtractionId: latestId, pinnedExtractionId };
  if (latest.status !== "succeeded" && latest.status !== "partial") return { eligible: false, providerCallAllowed: false, reason: "text_extraction_not_usable", latestNonFailedExtractionId: latestId, pinnedExtractionId };
  const manifest = buildPinnedExtractionPageManifest(input.source);
  if (manifest.pages.length === 0) return { eligible: false, providerCallAllowed: false, reason: "no_eligible_pages", latestNonFailedExtractionId: latestId, pinnedExtractionId };
  return { eligible: true, providerCallAllowed: true, reason: "eligible", latestNonFailedExtractionId: latestId, pinnedExtractionId };
}

export function hashSourceSnapshot(source: BatchPinnedSourceSnapshot): string {
  return sha256LengthPrefixedScalars([
    BATCH_DOMAIN_VERSION,
    uuid(source.document.id, "Document"),
    uuid(source.document.paperId, "Document paper"),
    source.document.archivedAt,
    uuid(source.extraction.id, "Extraction"),
    uuid(source.extraction.paperId, "Extraction paper"),
    uuid(source.extraction.fullTextDocumentId, "Extraction document"),
    source.extraction.sequence,
    source.extraction.status,
    source.pageManifest.hash,
    source.pageManifest.characterCount,
    source.pageManifest.byteSize,
  ]);
}

export function hashSuggestionIntent(context: BatchSuggestionIntentContext): string {
  const values: CanonicalScalar[] = [
    BATCH_DOMAIN_VERSION,
    uuid(context.projectId, "Project"),
    uuid(context.paperId, "Paper"),
    uuid(context.fieldId, "Field"),
    uuid(context.fullTextDocumentId, "Document"),
    uuid(context.documentTextExtractionId, "Extraction"),
    context.baselineExtractionRevisionId == null ? null : uuid(context.baselineExtractionRevisionId, "Baseline revision"),
    context.fieldSnapshotHash,
    context.optionSnapshotHash,
    context.sourceSnapshotHash,
    context.pageManifestHash,
    context.model,
    context.reasoningEffort,
    context.promptVersion,
    context.responseSchemaVersion,
    context.groundingResolverVersion,
    context.contextSelectionVersion,
    context.disclosureVersion,
  ];
  return sha256LengthPrefixedScalars(values);
}

export interface BatchItemManifestHashInput {
  itemOrdinal: number;
  paperId: string;
  extractionFieldId: string;
  expectedCurrentExtractionRevisionId: string | null;
  titleAbstractDecisionId: string | null;
  fullTextDecisionId: string | null;
  fullTextDocumentId: string | null;
  documentTextExtractionId: string | null;
  initialDisposition: string;
  initialReasonCode: string;
  idempotencyKey: string;
  expectedRequestIntentHash: string | null;
  fieldDefinitionHash: string;
  optionSnapshotHash: string;
  paperTitleSnapshot: string;
  paperAbstractSnapshot: string | null;
  fieldNameSnapshot: string;
  fieldDescriptionSnapshot: string | null;
  fieldTypeSnapshot: string;
  fieldRequiredSnapshot: boolean;
  fieldOptionSnapshot: readonly BatchFieldOptionSnapshot[];
  documentFilenameSnapshot: string | null;
  extractionSequenceSnapshot: number | bigint | null;
  extractionStatusSnapshot: string | null;
  pageManifest: BatchPinnedPageManifest | null;
}

export function hashBatchItemManifest(input: BatchItemManifestHashInput): string {
  const pageManifest = input.pageManifest;
  const pageManifestHash = pageManifest?.hash ?? EMPTY_PAGE_MANIFEST_HASH;
  const fieldOptions = [...input.fieldOptionSnapshot]
    .filter((option) => option.archivedAt == null)
    .map((option) => ({ id: uuid(option.id, "Option"), label: option.label, sortOrder: Number(integer(option.sortOrder, "Option sort order")) }))
    .sort((left, right) => left.sortOrder - right.sortOrder || compareCanonicalText(left.id, right.id));
  assertUnique(fieldOptions.map((option) => option.id), "Option");
  const values: CanonicalScalar[] = [
    BATCH_DOMAIN_VERSION,
    (integer(input.itemOrdinal, "Item ordinal"), input.itemOrdinal),
    uuid(input.paperId, "Paper"),
    uuid(input.extractionFieldId, "Field"),
    input.expectedCurrentExtractionRevisionId == null ? null : uuid(input.expectedCurrentExtractionRevisionId, "Baseline revision"),
    input.titleAbstractDecisionId == null ? null : uuid(input.titleAbstractDecisionId, "Title/abstract decision"),
    input.fullTextDecisionId == null ? null : uuid(input.fullTextDecisionId, "Full-text decision"),
    input.fullTextDocumentId == null ? null : uuid(input.fullTextDocumentId, "Document"),
    input.documentTextExtractionId == null ? null : uuid(input.documentTextExtractionId, "Extraction"),
    input.initialDisposition,
    input.initialReasonCode,
    uuid(input.idempotencyKey, "Idempotency key"),
    input.expectedRequestIntentHash,
    input.fieldDefinitionHash,
    input.optionSnapshotHash,
    input.paperTitleSnapshot,
    input.paperAbstractSnapshot,
    input.fieldNameSnapshot,
    input.fieldDescriptionSnapshot,
    input.fieldTypeSnapshot,
    input.fieldRequiredSnapshot,
    fieldOptions.length,
  ];
  for (const option of fieldOptions) {
    values.push(option.id, option.label, option.sortOrder);
  }
  values.push(
    input.documentFilenameSnapshot,
    input.extractionSequenceSnapshot == null ? null : BigInt(integer(input.extractionSequenceSnapshot, "Extraction sequence")),
    input.extractionStatusSnapshot,
    pageManifestHash,
    pageManifest?.pages.length ?? 0,
    pageManifest?.characterCount ?? 0,
    pageManifest?.byteSize ?? 0,
  );
  return sha256LengthPrefixedScalars(values);
}

export interface BatchManifestHashInput {
  manifestAlgorithmVersion: string;
  provider: string;
  configuredModel: string;
  configuredReasoningEffort: string;
  selectionPolicyVersion: string;
  batchDisclosureVersion: string;
  requestDisclosureVersion: string;
  externalTransmissionAcknowledged: boolean;
  paperCount: number;
  fieldCount: number;
  cellCount: number;
  executableCount: number;
  items: readonly { itemOrdinal: number; itemManifestHash: string }[];
}

export function hashBatchManifest(input: BatchManifestHashInput): string {
  const values: CanonicalScalar[] = [
    BATCH_DOMAIN_VERSION,
    input.manifestAlgorithmVersion,
    input.provider,
    input.configuredModel,
    input.configuredReasoningEffort,
    input.selectionPolicyVersion,
    input.batchDisclosureVersion,
    input.requestDisclosureVersion,
    input.externalTransmissionAcknowledged,
    (integer(input.paperCount, "Paper count"), input.paperCount),
    (integer(input.fieldCount, "Field count"), input.fieldCount),
    (integer(input.cellCount, "Cell count"), input.cellCount),
    (integer(input.executableCount, "Executable count"), input.executableCount),
  ];
  for (const item of [...input.items].sort((left, right) => Number(integer(left.itemOrdinal, "Item ordinal")) - Number(integer(right.itemOrdinal, "Item ordinal")))) {
    values.push((integer(item.itemOrdinal, "Item ordinal"), item.itemOrdinal), item.itemManifestHash);
  }
  return sha256LengthPrefixedScalars(values);
}

export function hashBatchItemIntent(item: Pick<BatchPreviewItem, "paper" | "field" | "source" | "currentExtractionRevisionId">, context: Omit<BatchSuggestionIntentContext, "projectId" | "paperId" | "fieldId" | "fullTextDocumentId" | "documentTextExtractionId" | "baselineExtractionRevisionId" | "fieldSnapshotHash" | "optionSnapshotHash" | "sourceSnapshotHash" | "pageManifestHash">): string {
  if (!item.source) fail("An eligible batch item requires a pinned source");
  const fieldSnapshotHash = hashFieldSnapshot(item.field);
  const optionSnapshotHash = hashOptionSnapshot(activeOptions(item.field));
  const pageManifestHash = item.source.pageManifest.hash;
  const sourceSnapshotHash = hashSourceSnapshot(item.source);
  return hashSuggestionIntent({
    ...context,
    projectId: item.paper.projectId,
    paperId: item.paper.paperId,
    fieldId: item.field.id,
    fullTextDocumentId: item.source.document.id,
    documentTextExtractionId: item.source.extraction.id,
    baselineExtractionRevisionId: item.currentExtractionRevisionId,
    fieldSnapshotHash,
    optionSnapshotHash,
    sourceSnapshotHash,
    pageManifestHash,
  });
}

function selectionMatches(candidate: BatchCandidate, input: BatchSelectionInput): boolean {
  const paperId = uuid(candidate.paper.paperId, "Paper");
  const fieldId = uuid(candidate.field.id, "Field");
  if (input.paperIds && !input.paperIds.map((id) => uuid(id, "Paper")).includes(paperId)) return false;
  if (input.fieldIds && !input.fieldIds.map((id) => uuid(id, "Field")).includes(fieldId)) return false;
  return true;
}

export function assignCanonicalPreviewOrdinals(items: readonly Omit<BatchPreviewItem, "ordinal">[]): BatchPreviewItem[] {
  // The database preview query owns cross-runtime ordering. This helper only
  // persists the already-canonical row order supplied by that query.
  return items.map((item, ordinal) => ({ ...item, ordinal }));
}

export function selectBatchPreviewItems(input: BatchSelectionInput): BatchPreviewItem[] {
  const paperIds = input.paperIds ?? [];
  const fieldIds = input.fieldIds ?? [];
  assertUnique(paperIds, "Paper selection");
  assertUnique(fieldIds, "Field selection");
  const seen = new Set<string>();
  const cache = new Map<string, BatchPinnedPageManifest>();
  const selected: Omit<BatchPreviewItem, "ordinal">[] = [];
  for (const candidate of input.candidates) {
    const key = `${uuid(candidate.paper.paperId, "Paper")}:${uuid(candidate.field.id, "Field")}`;
    if (seen.has(key)) fail("Batch selection contains duplicate Paper/field items");
    seen.add(key);
    if (!selectionMatches(candidate, input)) continue;
    const eligibility = evaluateInitialEligibility(candidate);
    const matchesPreset = input.preset === "all"
      || (input.preset === "eligible" && eligibility.eligible)
      || (input.preset === "missing" && candidate.currentExtractionRevisionId == null)
      || (input.preset === "missing_or_stale" && (candidate.currentExtractionRevisionId == null || eligibility.reason === "stale_text_extraction"))
      || (input.preset === "explicit" && paperIds.length > 0 && fieldIds.length > 0);
    if (!matchesPreset) continue;
    const source = candidate.source == null ? null : {
      document: candidate.source.document,
      extraction: candidate.source.extraction,
      pageManifest: cachePinnedExtractionPageManifest(cache, candidate.source),
    } satisfies BatchPinnedSourceSnapshot;
    selected.push({
      paper: candidate.paper,
      field: candidate.field,
      source,
      currentExtractionRevisionId: candidate.currentExtractionRevisionId,
      eligibility,
      fieldSnapshotHash: hashFieldSnapshot(candidate.field),
      optionSnapshotHash: hashOptionSnapshot(activeOptions(candidate.field)),
      sourceSnapshotHash: source == null ? null : hashSourceSnapshot(source),
      intentHash: source == null ? "" : hashBatchItemIntent({ paper: candidate.paper, field: candidate.field, source, currentExtractionRevisionId: candidate.currentExtractionRevisionId }, { model: "", reasoningEffort: "", promptVersion: "", responseSchemaVersion: "", groundingResolverVersion: "", contextSelectionVersion: "", disclosureVersion: "" }),
    });
  }
  const maxItems = input.maxItems ?? MAX_BATCH_ITEMS;
  if (!Number.isSafeInteger(maxItems) || maxItems <= 0 || maxItems > MAX_BATCH_ITEMS) fail(`Batch selection is limited to ${MAX_BATCH_ITEMS} items`);
  if (selected.length > maxItems) fail(`Batch selection exceeds the ${maxItems}-item limit`);
  const selectedPapers = new Set(selected.map((item) => uuid(item.paper.paperId, "Paper")));
  const selectedFields = new Set(selected.map((item) => uuid(item.field.id, "Field")));
  if (selectedPapers.size > MAX_BATCH_PAPERS) fail(`Batch selection is limited to ${MAX_BATCH_PAPERS} Papers`);
  if (selectedFields.size > MAX_BATCH_FIELDS) fail(`Batch selection is limited to ${MAX_BATCH_FIELDS} extraction fields`);
  return assignCanonicalPreviewOrdinals(selected);
}

export function aggregateBatchItems(statuses: readonly BatchItemStatus[]): BatchAggregate {
  const aggregate: BatchAggregate = { total: statuses.length, pending: 0, claimed: 0, succeeded: 0, failed: 0, stale: 0, cancelled: 0, terminal: 0 };
  for (const status of statuses) aggregate[status] += 1;
  aggregate.terminal = aggregate.succeeded + aggregate.failed + aggregate.stale + aggregate.cancelled;
  return aggregate;
}

export function deriveBatchStatus(input: BatchLifecycleInput): BatchStatus {
  const aggregate = aggregateBatchItems(input.itemStatuses);
  if (aggregate.total > 0 && aggregate.cancelled === aggregate.total) return "cancelled";
  if (aggregate.total > 0 && aggregate.terminal === aggregate.total) return "completed";
  if (input.status === "running" || aggregate.claimed > 0 || aggregate.succeeded > 0 || aggregate.failed > 0 || aggregate.stale > 0) return "running";
  return input.status;
}

export function canCancelBatch(status: BatchStatus): boolean {
  return status === "preview" || status === "confirmed" || status === "running";
}

export function cancelBatchItems(statuses: readonly BatchItemStatus[]): BatchItemStatus[] {
  return statuses.map((status) => status === "succeeded" || status === "failed" || status === "stale" || status === "cancelled" ? status : "cancelled");
}

export function isRetryableSerializableConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  return [value.code, value.cause?.code].some((code) => code === "40001" || code === "40P01");
}

function sameContext(left: BatchSuggestionIntentContext, right: BatchSuggestionIntentContext): boolean {
  const keys: (keyof BatchSuggestionIntentContext)[] = ["projectId", "paperId", "fieldId", "fullTextDocumentId", "documentTextExtractionId", "baselineExtractionRevisionId", "fieldSnapshotHash", "optionSnapshotHash", "sourceSnapshotHash", "pageManifestHash", "model", "reasoningEffort", "promptVersion", "responseSchemaVersion", "groundingResolverVersion", "contextSelectionVersion", "disclosureVersion"];
  return keys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (["projectId", "paperId", "fieldId", "fullTextDocumentId", "documentTextExtractionId", "baselineExtractionRevisionId"].includes(key)) {
      if (leftValue == null || rightValue == null) return leftValue === rightValue;
      return uuid(String(leftValue), String(key)) === uuid(String(rightValue), String(key));
    }
    return leftValue === rightValue;
  });
}

export function evaluateTerminalSuggestionReuse(input: TerminalSuggestionReuseInput): TerminalSuggestionReuseResult {
  if (input.request.outcome !== "succeeded") return { reusable: false, reason: "request_not_succeeded" };
  if (!input.result || input.result.outcome !== "succeeded") return { reusable: false, reason: "result_not_succeeded" };
  if (!input.result.candidateExists) return { reusable: false, reason: "candidate_missing" };
  if (input.decision !== null) return { reusable: false, reason: "decision_already_exists" };
  if (input.request.intentHash !== hashSuggestionIntent(input.request.context)) return { reusable: false, reason: "intent_changed" };
  if (!sameContext(input.request.context, input.current.context)) return { reusable: false, reason: "context_changed" };
  if (!input.current.eligibility.eligible || !input.current.eligibility.providerCallAllowed) return { reusable: false, reason: "current_source_ineligible" };
  if (input.current.pageManifestHash !== input.current.context.pageManifestHash || input.current.pageManifestHash !== input.request.context.pageManifestHash) return { reusable: false, reason: "manifest_changed" };
  return { reusable: true, reason: "reusable" };
}

export function checkBatchCompatibility(input: BatchCompatibilityInput = {}): BatchCompatibilityResult {
  const violations: string[] = [];
  if (input.providerCallsInDomain) violations.push("Provider calls belong to Slice 26 execution, not the batch domain");
  if (input.queueDispatchInDomain) violations.push("Queues/workers are outside the approved batch boundary");
  if (input.openAiBatchApi) violations.push("OpenAI Batch API is outside the approved batch boundary");
  if (input.canonicalExtractionRevisionWrites) violations.push("Only researcher acceptance may write canonical ExtractionRevision state");
  if (input.bulkAcceptance) violations.push("Batch orchestration does not provide bulk acceptance");
  return { compatible: violations.length === 0, violations };
}
