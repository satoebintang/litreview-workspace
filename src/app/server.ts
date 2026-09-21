import { createReviewServices } from "@/application/services";
import { boundPdfIntakeDiagnostic, type PdfMetadataInspection, type PdfMetadataProposal } from "@/application/pdf-intake-services";
import { createAiExtractionSuggestionServices } from "@/application/ai-extraction-suggestion-services";
import { createAiExtractionBatchServices } from "@/application/ai-extraction-batch-services";
import { createAiSynthesisSuggestionServices } from "@/application/ai-synthesis-suggestion-services";
import { FakeSynthesisSuggestionProvider, type ProviderSynthesisSuggestionResult, type SynthesisSuggestionInput } from "@/application/ai/synthesis-suggestion-provider";
import { createDb } from "@/db/client";
import { sha256Hex } from "@/domain/full-text-documents";
import { LocalDocumentStorage, LocalPdfIntakeStorage } from "@/infrastructure/document-storage";
import { createPdfMetadataInspector, extractPdfDoiCandidate, type PdfMetadataInspectionResult, type PdfMetadataFieldName } from "@/infrastructure/pdf-metadata-inspector";
import { isPlausibleDoiForComparison, normalizeDoiForComparison } from "@/domain/search-normalization";
import { OpenAIExtractionSuggestionProvider } from "@/infrastructure/openai-extraction-suggestion-provider";
import { FakeExtractionSuggestionProvider, type ProviderSuggestionResult } from "@/application/ai/extraction-suggestion-provider";
import { OpenAISynthesisSuggestionProvider } from "@/infrastructure/openai-synthesis-suggestion-provider";
import {
  createPdfjsTextExtractionParser,
} from "@/infrastructure/pdfjs-text-extractor";
import { bibliographicParser } from "@/infrastructure/bibliographic-parser";
import { createPostgresDoiLookupServices } from "@/application/doi-lookup-services";
import { createCrossrefBibliographicMetadataLookupProvider, buildCrossrefWorkUrl } from "@/infrastructure/crossref-bibliographic-metadata-lookup-provider";
import {
  BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION,
  CROSSREF_WORK_MAPPING_VERSION,
  type BibliographicMetadataLookupAttemptAccounting,
  type BibliographicMetadataLookupResult,
} from "@/application/bibliographic-metadata-lookup-provider";
import { createDoiResolutionServices } from "@/application/doi-resolution-services";

const globalForReview = globalThis as unknown as {
  reviewDatabase?: ReturnType<typeof createDb>;
};

const database = globalForReview.reviewDatabase ?? createDb();
if (process.env.NODE_ENV !== "production") globalForReview.reviewDatabase = database;

const storageRoot = process.env.LITREVIEW_DOCUMENT_STORAGE_ROOT?.trim();
const documentStorage = storageRoot ? new LocalDocumentStorage(storageRoot) : undefined;
const pdfIntakeStorage = storageRoot ? new LocalPdfIntakeStorage(storageRoot) : undefined;
const configuredMaxBytes = Number(process.env.LITREVIEW_DOCUMENT_MAX_BYTES ?? "52428800");
const maxDocumentBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0 ? configuredMaxBytes : undefined;

// The infrastructure factory exposes only the parser-neutral application
// contract; PDF.js types and import details remain server-side.
const documentTextExtractor = createPdfjsTextExtractionParser();

function adaptPdfMetadataInspection(result: PdfMetadataInspectionResult): PdfMetadataInspection {
  const fieldNames: PdfMetadataFieldName[] = ["title", "authors", "publicationYear", "venue", "doi", "abstract"];
  const pages = new Map(result.pages.map((page) => [page.pageNumber, page]));
  const fields: PdfMetadataProposal[] = [];
  for (const fieldName of fieldNames) {
    const field = result.fields[fieldName];
    const provenance = field?.provenance ?? [];
    const value = field?.value ?? null;
    const absent = provenance.length === 0 && (value == null || (Array.isArray(value) && value.length === 0));
    if (absent) {
      fields.push({ field: fieldName, value: null, sourceKind: null, sourceLocator: null, classification: "unavailable", diagnostic: boundPdfIntakeDiagnostic(field?.diagnostic ?? "no_supported_source") });
      continue;
    }
    const candidates = fieldName === "doi" ? provenance : [provenance[0] ?? null];
    for (const candidate of candidates) {
      const sourceKind = candidate?.kind === "xmp" ? "xmp" : candidate?.kind === "info" ? "pdf_info" : candidate?.kind === "page_text" ? "page_text_match" : null;
      const page = candidate?.pageNumber == null ? null : pages.get(candidate.pageNumber) ?? null;
      const candidateValue = fieldName === "doi" && candidate
        ? (candidate.normalizedValue ?? (extractPdfDoiCandidate(candidate.rawValue) && isPlausibleDoiForComparison(extractPdfDoiCandidate(candidate.rawValue))
          ? normalizeDoiForComparison(extractPdfDoiCandidate(candidate.rawValue))
          : null))
        : value;
      const doiDiagnostic = field?.diagnostic ?? null;
      const doiAmbiguous = fieldName === "doi" && (doiDiagnostic === "multiple_distinct_doi_candidates" || doiDiagnostic?.split(";").some((item) => item === "doi_occurrence_limit_exhausted" || item === "doi_distinct_candidate_limit_exhausted"));
      fields.push({
        field: fieldName,
        value: candidateValue,
        sourceKind,
        sourceLocator: candidate ? (sourceKind === "page_text_match" ? `page:${candidate.pageNumber}` : candidate.key) : null,
        classification: doiAmbiguous || candidate?.ambiguous ? "ambiguous" : sourceKind === "page_text_match" ? "exact_text_identifier" : "exact_embedded_metadata",
        diagnostic: boundPdfIntakeDiagnostic(doiDiagnostic),
        normalizedValue: fieldName === "doi" ? String(candidateValue ?? "") || null : typeof value === "string" ? value : null,
        pageNumber: candidate?.pageNumber ?? null,
        startOffset: candidate?.startOffset ?? null,
        endOffset: candidate?.endOffset ?? null,
        exactMatch: candidate?.rawValue ?? null,
        pageTextSha256: page ? sha256Hex(new TextEncoder().encode(page.text)) : null,
      });
    }
  }
  const status = result.status === "metadata_failed" ? "failed" : result.status;
  return {
    status,
    pageCount: result.pageCount,
    attemptedPageCount: result.pages.length,
    succeededPageCount: result.pages.filter((page) => !page.error).length,
    scannedCodePoints: result.pages.reduce((total, page) => total + page.characterCount, 0),
    diagnostics: [
      ...(result.error ? [boundPdfIntakeDiagnostic(`${result.error.code}: ${result.error.message}`) ?? ""] : []),
      ...result.pages.flatMap((page) => page.error ? [boundPdfIntakeDiagnostic(`page_${page.pageNumber}_${page.error.code}: ${page.error.message}`) ?? ""] : []),
    ],
    errorCode: status === "failed" ? result.error?.code ?? "metadata_failed" : null,
    errorMessage: boundPdfIntakeDiagnostic(result.error?.message),
    extractorKey: result.inspectorKey,
    extractorVersion: result.inspectorVersion,
    pdfjsVersion: result.inspectorVersion,
    mappingVersion: "paper-metadata-map-v2",
    textScanVersion: "pdf-intake-early-text-v1",
    doiAlgorithmVersion: "pdf-intake-doi-v2",
    fields,
  };
}

const pdfMetadataInspector = createPdfMetadataInspector();
const adaptedPdfMetadataInspector = {
  inspect: async (bytes: Uint8Array, options?: { signal?: AbortSignal }) => adaptPdfMetadataInspection(await pdfMetadataInspector.inspect(bytes, options)),
};

export const reviewServices = createReviewServices(database.db, {
  documentStorage,
  pdfIntakeStorage,
  pdfMetadataInspector: adaptedPdfMetadataInspector,
  maxDocumentBytes,
  documentTextExtractor,
  bibliographicParser,
});

const openAiKey = process.env.OPENAI_API_KEY?.trim();
const configuredAiModel = process.env.AI_EXTRACTION_MODEL?.trim() || "gpt-5.6-luna";
const useFakeExtractionProvider = process.env.AI_EXTRACTION_TEST_PROVIDER === "fake" && process.env.PLAYWRIGHT_TEST === "1";
const fakeExtractionProvider = useFakeExtractionProvider
  ? new FakeExtractionSuggestionProvider({
      result: (input): ProviderSuggestionResult => {
        const metadata = { provider: "fake" as const, configuredModel: input.model, returnedModel: input.model, responseId: `fake-${input.field.id}`, inputTokens: null, outputTokens: null, totalTokens: null, durationMs: 0 };
        const mode = input.field.name.toLowerCase();
        if (mode.includes("failure")) return { kind: "failure", failure: "api_error", code: "fake_failure", metadata };
        if (mode.includes("no candidate") || input.pages.length === 0) return { kind: "success", suggestion: { outcome: "no_candidate", state: null, value: null, explanation: "The deterministic test provider found no candidate.", groundings: [] }, metadata };
        const page = input.pages[0];
        const quote = page.text.trim().slice(0, 80);
        if (!quote) return { kind: "success", suggestion: { outcome: "no_candidate", state: null, value: null, explanation: "The deterministic test provider found no candidate.", groundings: [] }, metadata };
        const value = input.field.fieldType === "boolean" ? true : input.field.fieldType === "number" ? "42" : input.field.fieldType === "single_select" ? input.field.options[0]?.id ?? null : quote;
        if (value === null) return { kind: "success", suggestion: { outcome: "no_candidate", state: null, value: null, explanation: "The deterministic test provider found no candidate.", groundings: [] }, metadata };
        return { kind: "success", suggestion: { outcome: "candidate", state: "present", value, explanation: "Deterministic test provider output.", groundings: [{ pageId: page.id, quote }] }, metadata };
      },
    })
  : undefined;
const aiProvider = fakeExtractionProvider ?? (openAiKey && (process.env.AI_PROVIDER ?? "openai").trim() === "openai"
  ? new OpenAIExtractionSuggestionProvider({
      apiKey: openAiKey,
      defaultModel: configuredAiModel,
      defaultReasoningEffort: "low",
    })
  : undefined);

export const aiExtractionServices = createAiExtractionSuggestionServices(database.db, aiProvider, {
  defaultModel: configuredAiModel,
  defaultReasoningEffort: "low",
});
export const aiExtractionBatchServices = createAiExtractionBatchServices(database.db, aiExtractionServices, {
  configuredModel: configuredAiModel,
  providerAvailable: Boolean(aiProvider),
});

const configuredSynthesisModel = process.env.AI_SYNTHESIS_MODEL?.trim() || configuredAiModel;
const useFakeSynthesisProvider = process.env.AI_SYNTHESIS_TEST_PROVIDER === "fake" && process.env.PLAYWRIGHT_TEST === "1";
const fakeSynthesisProvider = useFakeSynthesisProvider
  ? new FakeSynthesisSuggestionProvider({
      result: (input: SynthesisSuggestionInput): ProviderSynthesisSuggestionResult => ({
        kind: "success",
        suggestion: {
          outcome: "candidate",
          title: "Deterministic AI synthesis suggestion",
          statementText: "The selected extraction revisions support a deterministic synthesis candidate.",
          explanation: "Test-only provider output grounded in every selected support.",
          groundings: input.supports.map((support) => {
            const evidence = support.connectingEvidence[0];
            return { supportId: support.id, evidenceId: String(evidence.id ?? evidence.evidenceId), quote: String(evidence.text ?? evidence.sourceText) };
          }),
        },
        metadata: {
          provider: "fake",
          configuredModel: input.model,
          returnedModel: input.model,
          responseId: `fake-${input.preparationId}`,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          durationMs: 0,
        },
      }),
    })
  : undefined;
const aiSynthesisProvider = fakeSynthesisProvider ?? (openAiKey && (process.env.AI_PROVIDER ?? "openai").trim() === "openai"
  ? new OpenAISynthesisSuggestionProvider({ apiKey: openAiKey, defaultModel: configuredSynthesisModel, defaultReasoningEffort: "low" })
  : undefined);

export const aiSynthesisServices = createAiSynthesisSuggestionServices(database.db, aiSynthesisProvider, {
  defaultModel: configuredSynthesisModel,
  defaultReasoningEffort: "low",
  finalizePreparationInTransaction: reviewServices.finalizeSynthesisPreparationInTransaction,
});

export const aiSynthesisProviderAvailable = Boolean(aiSynthesisProvider);

export const aiExtractionProviderAvailable = Boolean(aiProvider);

function fakeDoiProvider(attemptAccounting: BibliographicMetadataLookupAttemptAccounting) {
  return {
    provider: "crossref",
    contractVersion: BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION,
    mappingVersion: CROSSREF_WORK_MAPPING_VERSION,
    lookup: async (input: { doi: string }): Promise<BibliographicMetadataLookupResult> => {
      const startedAt = new Date();
      const endpoint = buildCrossrefWorkUrl(input.doi) ?? "https://api.crossref.org/v1/works/";
      const lease = await attemptAccounting.begin({ provider: "crossref", doi: input.doi, url: endpoint, attempt: 1, redirect: 0, startedAt });
      await lease.release({ status: "succeeded", httpStatus: 200, outcomeCode: "fake_response" });
      const finalizedAt = new Date();
      return {
        kind: "success",
        proposal: {
          requestedDoi: input.doi,
          returnedDoi: input.doi,
          title: "Deterministic Crossref DOI fixture",
          authors: ["Tracework Fixture"],
          authorDetails: [{ given: "Tracework", family: "Fixture", literal: null, suffix: null, orcid: null, displayName: "Tracework Fixture", providerSequence: null }],
          publicationYear: 2026,
          venue: "Tracework Test Journal",
          providerType: "journal-article",
          publisher: "Tracework Test Publisher",
          url: `https://doi.org/${input.doi}`,
          sourceSnapshot: {
            DOI: input.doi,
            title: ["Deterministic Crossref DOI fixture"],
            author: [{ given: "Tracework", family: "Fixture" }],
            authorCount: 1,
            published: { "date-parts": [[2026]] },
            "published-print": null,
            "published-online": null,
            issued: null,
            "container-title": ["Tracework Test Journal"],
            type: "journal-article",
            publisher: "Tracework Test Publisher",
            URL: `https://doi.org/${input.doi}`,
          },
          warnings: [],
        },
        evidence: {
          provider: "crossref",
          endpoint,
          httpStatus: 200,
          contentType: "application/json",
          responseByteSize: null,
          responseSha256: null,
          observedRateLimitPerSecond: null,
          observedConcurrencyLimit: null,
          attemptCount: 1,
          startedAt,
          finalizedAt,
        },
      };
    },
  };
}

const configuredCrossrefMailto = process.env.CROSSREF_MAILTO?.trim() || (process.env.PLAYWRIGHT_TEST === "1" ? "test@example.com" : "");
export const doiLookupServices = configuredCrossrefMailto
  ? createPostgresDoiLookupServices(database.db, (attemptAccounting) => process.env.PLAYWRIGHT_TEST === "1"
    ? fakeDoiProvider(attemptAccounting)
    : createCrossrefBibliographicMetadataLookupProvider({
        mailto: configuredCrossrefMailto,
        userAgent: process.env.CROSSREF_USER_AGENT?.trim() || undefined,
        attemptAccounting,
      }))
  : undefined;
export const doiLookupProviderAvailable = Boolean(doiLookupServices);
export const doiResolutionServices = createDoiResolutionServices(database.db);
