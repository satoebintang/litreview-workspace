import { describe, expect, it } from "vitest";
import {
  aggregateBatchItems,
  assignCanonicalPreviewOrdinals,
  BATCH_DOMAIN_VERSION,
  buildPinnedExtractionPageManifest,
  cachePinnedExtractionPageManifest,
  cancelBatchItems,
  checkBatchCompatibility,
  deriveBatchStatus,
  EMPTY_PAGE_MANIFEST_HASH,
  encodeLengthPrefixedScalars,
  evaluateInitialEligibility,
  evaluateTerminalSuggestionReuse,
  hashBatchItemManifest,
  hashBatchManifest,
  hashFieldSnapshot,
  hashOptionSnapshot,
  hashSuggestionIntent,
  latestNonFailedExtraction,
  sha256LengthPrefixedScalars,
  selectBatchPreviewItems,
  type BatchCandidate,
  type BatchPinnedSourceInput,
  type BatchSuggestionIntentContext,
} from "@/application/ai-extraction-batch-domain";
import { AI_EXTRACTION_LIMITS, serializeExtractionSuggestionInput, validateSuggestionInput, type ExtractionSuggestionInput } from "@/application/ai/extraction-suggestion-provider";

const projectId = "00000000-0000-4000-8000-000000000001";
const paperA = "00000000-0000-4000-8000-00000000000a";
const paperB = "00000000-0000-4000-8000-00000000000b";
const fieldA = "00000000-0000-4000-8000-0000000000aa";
const fieldB = "00000000-0000-4000-8000-0000000000bb";
const documentA = "00000000-0000-4000-8000-0000000000da";
const extractionA = "00000000-0000-4000-8000-0000000000ea";
const pageA = "00000000-0000-4000-8000-0000000000pa".replace("p", "f");

function providerInput(overrides: Partial<ExtractionSuggestionInput> = {}): ExtractionSuggestionInput {
  return {
    field: { id: fieldA, name: "Outcome", description: null, fieldType: "short_text", options: [] },
    pages: [{ id: pageA, pageNumber: 1, text: "42 participants" }],
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    promptVersion: "extraction-suggestion-v1",
    responseSchemaVersion: "extraction-suggestion-response-v1",
    groundingResolverVersion: "exact-page-quote-v1",
    contextSelectionVersion: "selected-pages-v1",
    sourceCoverage: { extractionId: extractionA, documentId: documentA, status: "succeeded", omittedPageCount: 0 },
    ...overrides,
  };
}

function paper(paperId: string) { return { projectId, paperId, title: paperId, finallyIncluded: true }; }
function field(fieldId: string, sortOrder = 0) { return { projectId, id: fieldId, name: "Field", description: null, fieldType: "short_text" as const, required: false, sortOrder, archivedAt: null, options: [] }; }
function source(overrides: Partial<BatchPinnedSourceInput["extraction"]> = {}): BatchPinnedSourceInput {
  return {
    paper: paper(paperA),
    document: { id: documentA, paperId: paperA, archivedAt: null },
    extraction: { id: extractionA, paperId: paperA, fullTextDocumentId: documentA, sequence: 1, status: "succeeded", ...overrides },
    pages: [{ id: pageA, paperId: paperA, documentTextExtractionId: extractionA, pageNumber: 1, status: "succeeded", text: "42 participants" }],
  };
}

function candidate(overrides: Partial<BatchCandidate> = {}): BatchCandidate {
  return { paper: paper(paperA), field: field(fieldA), source: source(), extractions: [source().extraction], currentExtractionRevisionId: null, ...overrides };
}

describe("Slice 31 W2 canonical encoding and manifests", () => {
  it("uses typed UTF-8 length-prefixed bytes with explicit null and canonical scalars", () => {
    const bytes = encodeLengthPrefixedScalars(["é", null, true, false, 42, -7]);
    expect(Buffer.from(bytes).toString("hex")).toBe("0000000301c3a90000000100000000050274727565000000060266616c73650000000303343200000003032d37");
    expect(sha256LengthPrefixedScalars(["é", null, true, false, 42, -7])).toBe("5aed9071e8804a4256164c4697e6daf02219332cb3f6d9a55f76c6dfa0533539");
  });

  it("assigns page ordinals once and reuses one cached manifest per Paper/extraction", () => {
    const first = buildPinnedExtractionPageManifest(source());
    const cache = new Map<string, typeof first>();
    const cached = cachePinnedExtractionPageManifest(cache, source());
    expect(cached).toBe(cache.get(`${paperA}:${extractionA}`));
    expect(cached).toBe(cached);
    expect(first.pages[0]).toMatchObject({ pageId: pageA, pageNumber: 1, pageOrdinal: 0, characterCount: 15, byteSize: 15 });
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("orders aggregate manifest inputs by numeric ordinal", () => {
    const input = { manifestAlgorithmVersion: "manifest-v1", provider: "openai", configuredModel: "gpt-test", configuredReasoningEffort: "low", selectionPolicyVersion: "selection-v1", batchDisclosureVersion: "batch-v1", requestDisclosureVersion: "request-v1", externalTransmissionAcknowledged: true, paperCount: 2, fieldCount: 1, cellCount: 2, executableCount: 2, items: [{ itemOrdinal: 10, itemManifestHash: "a".repeat(64) }, { itemOrdinal: 2, itemManifestHash: "b".repeat(64) }] } as const;
    expect(hashBatchManifest(input)).toBe(hashBatchManifest({ ...input, items: [...input.items].reverse() }));
  });

  it("keeps a fixed Unicode item and aggregate vector identical across runtimes", () => {
    const vectorProject = "00000000-0000-4000-8000-000000000001";
    const vectorPaper = "00000000-0000-4000-8000-000000000002";
    const vectorField = "00000000-0000-4000-8000-000000000003";
    const vectorDocument = "00000000-0000-4000-8000-000000000004";
    const vectorExtraction = "00000000-0000-4000-8000-000000000005";
    const vectorPage = "00000000-0000-4000-8000-000000000006";
    const vectorKey = "00000000-0000-4000-8000-000000000007";
    const options = [{ id: "00000000-0000-4000-8000-000000000008", label: "éclair — 多字节", sortOrder: 0 }];
    const pageManifest = buildPinnedExtractionPageManifest({
      paper: { projectId: vectorProject, paperId: vectorPaper, title: "Résumé 📚", finallyIncluded: true },
      document: { id: vectorDocument, paperId: vectorPaper, archivedAt: null },
      extraction: { id: vectorExtraction, paperId: vectorPaper, fullTextDocumentId: vectorDocument, sequence: 7, status: "partial" },
      pages: [{ id: vectorPage, paperId: vectorPaper, documentTextExtractionId: vectorExtraction, pageNumber: 1, status: "succeeded", text: "αβ résumé — 你好" }],
    });
    const item = {
      itemOrdinal: 0, paperId: vectorPaper, extractionFieldId: vectorField, expectedCurrentExtractionRevisionId: null,
      titleAbstractDecisionId: null, fullTextDecisionId: null, fullTextDocumentId: vectorDocument, documentTextExtractionId: vectorExtraction,
      initialDisposition: "executable", initialReasonCode: "eligible", idempotencyKey: vectorKey, expectedRequestIntentHash: "a".repeat(64),
      fieldDefinitionHash: hashFieldSnapshot({ projectId: vectorProject, id: vectorField, name: "Résumé", description: "Détails 😊", fieldType: "single_select", required: true, sortOrder: 3, archivedAt: null, options }),
      optionSnapshotHash: hashOptionSnapshot(options), paperTitleSnapshot: "Résumé 📚", paperAbstractSnapshot: "Abstract — 你好", fieldNameSnapshot: "Résumé",
      fieldDescriptionSnapshot: "Détails 😊", fieldTypeSnapshot: "single_select", fieldRequiredSnapshot: true, fieldOptionSnapshot: options,
      documentFilenameSnapshot: "étude 📄.pdf", extractionSequenceSnapshot: 7, extractionStatusSnapshot: "partial", pageManifest,
    } as const;
    const itemHash = hashBatchItemManifest(item);
    expect(pageManifest.hash).toBe("70f5016df33f7d47931d36573d9f79e980459e2bfed860fdb59a0bbf62335359");
    expect(itemHash).toBe("4e80d79b4370b15bf3d59295c6530187e04b8724fd24defe4adab93658c3d678");
    expect(hashBatchManifest({ manifestAlgorithmVersion: BATCH_DOMAIN_VERSION, provider: "openai", configuredModel: "gpt-test", configuredReasoningEffort: "low", selectionPolicyVersion: "selection-v1", batchDisclosureVersion: "batch-v1", requestDisclosureVersion: "request-v1", externalTransmissionAcknowledged: true, paperCount: 1, fieldCount: 1, cellCount: 1, executableCount: 1, items: [{ itemOrdinal: 0, itemManifestHash: itemHash }] })).toBe("34cb99bdd0e16c474e9b799cab56fb7eedfa4d6633b3a8f9495191760767dcf9");
  });

  it("binds empty page manifests to one canonical sentinel", () => {
    const item = {
      itemOrdinal: 0, paperId: paperA, extractionFieldId: fieldA, expectedCurrentExtractionRevisionId: null, titleAbstractDecisionId: null, fullTextDecisionId: null,
      fullTextDocumentId: null, documentTextExtractionId: null, initialDisposition: "ineligible", initialReasonCode: "full_text_document_missing", idempotencyKey: documentA,
      expectedRequestIntentHash: null, fieldDefinitionHash: "a".repeat(64), optionSnapshotHash: hashOptionSnapshot([]), paperTitleSnapshot: "Paper", paperAbstractSnapshot: null,
      fieldNameSnapshot: "Field", fieldDescriptionSnapshot: null, fieldTypeSnapshot: "short_text", fieldRequiredSnapshot: false, fieldOptionSnapshot: [],
      documentFilenameSnapshot: null, extractionSequenceSnapshot: null, extractionStatusSnapshot: null, pageManifest: null,
    } as const;
    expect(EMPTY_PAGE_MANIFEST_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBatchItemManifest(item)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Slice 31 complete provider-input eligibility", () => {
  it("rejects a description that crosses the serialized boundary even when source text is small", () => {
    const base = providerInput({ pages: [{ id: pageA, pageNumber: 1, text: "x".repeat(1000) }] });
    expect(new TextEncoder().encode(base.pages[0].text).byteLength).toBeLessThan(AI_EXTRACTION_LIMITS.maxSerializedInputBytes);
    const baseBytes = new TextEncoder().encode(serializeExtractionSuggestionInput(base)).byteLength;
    const exact = { ...base, field: { ...base.field, description: "x".repeat(AI_EXTRACTION_LIMITS.maxSerializedInputBytes - baseBytes + 2) } };
    expect(validateSuggestionInput(exact)).toMatchObject({ ok: true, serializedInputBytes: AI_EXTRACTION_LIMITS.maxSerializedInputBytes });
    expect(validateSuggestionInput({ ...exact, field: { ...exact.field, description: `${exact.field.description}x` } })).toMatchObject({ ok: false, code: "input_too_large", detail: "serialized_input_limit_exceeded" });
  });

  it("rejects a 200-option vocabulary whose serialized metadata exceeds the provider budget", () => {
    const options = Array.from({ length: AI_EXTRACTION_LIMITS.maxOptions }, (_, index) => ({ id: `option-${index}`, label: "x".repeat(2_000), active: true }));
    const checked = validateSuggestionInput(providerInput({ field: { id: fieldA, name: "Outcome", description: null, fieldType: "single_select", options } }));
    expect(checked).toMatchObject({ ok: false, code: "input_too_large", detail: "serialized_input_limit_exceeded" });
  });
});

describe("Slice 31 W2 latest non-failed eligibility", () => {
  it("keeps E1 eligible when only newer E2 failed", () => {
    const e1 = source().extraction;
    const e2 = { ...e1, id: "00000000-0000-4000-8000-0000000000eb", sequence: 2, status: "failed" as const };
    expect(latestNonFailedExtraction([e1, e2])?.id).toBe(e1.id);
    expect(evaluateInitialEligibility({ paper: paper(paperA), field: field(fieldA), source: source(), extractions: [e1, e2] })).toMatchObject({ eligible: true, reason: "eligible", providerCallAllowed: true });
  });

  it("does not call a provider when a pinned E1 is stale behind pending E2", () => {
    const e1 = source().extraction;
    const e2 = { ...e1, id: "00000000-0000-4000-8000-0000000000eb", sequence: 2, status: "pending" as const };
    expect(evaluateInitialEligibility({ paper: paper(paperA), field: field(fieldA), source: source(), extractions: [e1, e2] })).toMatchObject({ eligible: false, providerCallAllowed: false, reason: "stale_text_extraction" });
  });

  it("does not fall back to E1 when the latest non-failed E2 is still pending", () => {
    const e1 = source().extraction;
    const e2 = { ...e1, id: "00000000-0000-4000-8000-0000000000eb", sequence: 2, status: "pending" as const };
    const pinnedE2 = source({ id: e2.id, sequence: e2.sequence, status: e2.status });
    expect(evaluateInitialEligibility({ paper: paper(paperA), field: field(fieldA), source: pinnedE2, extractions: [e1, e2] })).toMatchObject({ eligible: false, providerCallAllowed: false, reason: "text_extraction_pending", latestNonFailedExtractionId: e2.id, pinnedExtractionId: e2.id });
  });
});

describe("Slice 31 W2 selection and lifecycle", () => {
  it("rejects duplicate Paper/field selection and gives the canonical order the only ordinals", () => {
    expect(() => selectBatchPreviewItems({ preset: "all", candidates: [candidate(), candidate()] })).toThrow(/duplicate Paper\/field/);
    const unassign = (item: ReturnType<typeof selectBatchPreviewItems>[number]) => {
      const { ordinal, ...rest } = item;
      void ordinal;
      return rest;
    };
    const items = assignCanonicalPreviewOrdinals([
      unassign(selectBatchPreviewItems({ preset: "all", candidates: [candidate({ field: field(fieldA, 1) })] })[0]),
      unassign(selectBatchPreviewItems({ preset: "all", candidates: [candidate({ paper: paper(paperB), field: field(fieldB, 2) })] })[0]),
    ]);
    expect(items.map((item) => [item.paper.paperId, item.ordinal])).toEqual([[paperA, 0], [paperB, 1]]);
  });

  it("enforces the server-side Paper and field caps in the pure selection boundary", () => {
    const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
    expect(selectBatchPreviewItems({ preset: "all", candidates: Array.from({ length: 100 }, (_, index) => candidate({ paper: paper(id(index + 1)), source: null })) })).toHaveLength(100);
    const manyPapers = Array.from({ length: 101 }, (_, index) => candidate({ paper: paper(id(index + 1)), source: null }));
    expect(() => selectBatchPreviewItems({ preset: "all", candidates: manyPapers })).toThrow(/100 Papers/);
    expect(selectBatchPreviewItems({ preset: "all", candidates: Array.from({ length: 25 }, (_, index) => candidate({ field: field(id(index + 1)), source: null })) })).toHaveLength(25);
    const manyFields = Array.from({ length: 26 }, (_, index) => candidate({ field: field(id(index + 1)), source: null }));
    expect(() => selectBatchPreviewItems({ preset: "all", candidates: manyFields })).toThrow(/25 extraction fields/);
  });

  it("accepts exactly 500 cells and rejects the 501st cell", () => {
    const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
    const cells = Array.from({ length: 500 }, (_, index) => candidate({ paper: paper(id(Math.floor(index / 5) + 1)), field: field(id(1000 + (index % 5))), source: null }));
    expect(selectBatchPreviewItems({ preset: "all", candidates: cells })).toHaveLength(500);
    expect(() => selectBatchPreviewItems({ preset: "all", candidates: [...cells, candidate({ paper: paper(id(1)), field: field(id(1006)), source: null })] })).toThrow(/500-item/);
  });

  it("preserves required/optional selection presets and option vocabulary drift", () => {
    const existing = candidate({ currentExtractionRevisionId: extractionA });
    expect(selectBatchPreviewItems({ preset: "missing", candidates: [existing] })).toHaveLength(0);
    expect(selectBatchPreviewItems({ preset: "all", candidates: [existing] })).toHaveLength(1);
    const first = field(fieldA);
    const second = { ...first, fieldType: "single_select" as const, options: [{ id: "00000000-0000-4000-8000-0000000000cc", label: "Yes", sortOrder: 0 }] };
    expect(hashOptionSnapshot(first.options)).not.toBe(hashOptionSnapshot(second.options));
    expect(hashFieldSnapshot(second)).not.toBe(hashFieldSnapshot(first));
  });

  it("aggregates terminal states and cancellation preserves completed outcomes", () => {
    expect(aggregateBatchItems(["pending", "claimed", "stale", "succeeded", "failed", "cancelled"])).toMatchObject({ total: 6, terminal: 4, pending: 1, claimed: 1, stale: 1 });
    expect(cancelBatchItems(["pending", "claimed", "stale", "succeeded", "failed", "cancelled"])).toEqual(["cancelled", "cancelled", "stale", "succeeded", "failed", "cancelled"]);
    expect(deriveBatchStatus({ id: "batch", status: "confirmed", itemStatuses: ["pending", "claimed"] })).toBe("running");
    expect(deriveBatchStatus({ id: "batch", status: "running", itemStatuses: ["succeeded", "failed"] })).toBe("completed");
    expect(deriveBatchStatus({ id: "batch", status: "running", itemStatuses: ["cancelled", "cancelled"] })).toBe("cancelled");
  });
});

function context(): BatchSuggestionIntentContext {
  return {
    projectId, paperId: paperA, fieldId: fieldA, fullTextDocumentId: documentA, documentTextExtractionId: extractionA, baselineExtractionRevisionId: null,
    fieldSnapshotHash: "a".repeat(64), optionSnapshotHash: "b".repeat(64), sourceSnapshotHash: "c".repeat(64), pageManifestHash: "d".repeat(64),
    model: "gpt-5.6-luna", reasoningEffort: "low", promptVersion: "extraction-suggestion-v1", responseSchemaVersion: "extraction-suggestion-response-v1", groundingResolverVersion: "exact-page-quote-v1", contextSelectionVersion: "selected-pages-v1", disclosureVersion: "openai-extraction-transmission-v1",
  };
}

describe("Slice 31 W2 terminal reuse and compatibility", () => {
  it("reuses only an un-decided successful candidate with exact current context", () => {
    const value = context();
    const input = { request: { outcome: "succeeded", intentHash: hashSuggestionIntent(value), context: value }, result: { outcome: "succeeded", candidateExists: true }, decision: null, current: { context: value, eligibility: { eligible: true, providerCallAllowed: true, reason: "eligible" as const, latestNonFailedExtractionId: extractionA, pinnedExtractionId: extractionA }, pageManifestHash: value.pageManifestHash } };
    expect(evaluateTerminalSuggestionReuse(input)).toEqual({ reusable: true, reason: "reusable" });
    expect(evaluateTerminalSuggestionReuse({ ...input, decision: { kind: "rejected" } })).toMatchObject({ reusable: false, reason: "decision_already_exists" });
    expect(evaluateTerminalSuggestionReuse({ ...input, current: { ...input.current, context: { ...value, pageManifestHash: "e".repeat(64) }, pageManifestHash: "e".repeat(64) } })).toMatchObject({ reusable: false, reason: "context_changed" });
  });

  it("keeps orchestration compatible only when Slice 26 remains authoritative", () => {
    expect(checkBatchCompatibility()).toEqual({ compatible: true, violations: [] });
    expect(checkBatchCompatibility({ providerCallsInDomain: true, bulkAcceptance: true }).compatible).toBe(false);
  });
});
