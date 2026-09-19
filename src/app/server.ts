import { createReviewServices } from "@/application/services";
import { boundPdfIntakeDiagnostic, type PdfMetadataInspection, type PdfMetadataProposal } from "@/application/pdf-intake-services";
import { createAiExtractionSuggestionServices } from "@/application/ai-extraction-suggestion-services";
import { createAiSynthesisSuggestionServices } from "@/application/ai-synthesis-suggestion-services";
import { FakeSynthesisSuggestionProvider, type ProviderSynthesisSuggestionResult, type SynthesisSuggestionInput } from "@/application/ai/synthesis-suggestion-provider";
import { createDb } from "@/db/client";
import { sha256Hex } from "@/domain/full-text-documents";
import { LocalDocumentStorage, LocalPdfIntakeStorage } from "@/infrastructure/document-storage";
import { createPdfMetadataInspector, extractPdfDoiCandidate, type PdfMetadataInspectionResult, type PdfMetadataFieldName } from "@/infrastructure/pdf-metadata-inspector";
import { isPlausibleDoiForComparison, normalizeDoiForComparison } from "@/domain/search-normalization";
import { OpenAIExtractionSuggestionProvider } from "@/infrastructure/openai-extraction-suggestion-provider";
import { OpenAISynthesisSuggestionProvider } from "@/infrastructure/openai-synthesis-suggestion-provider";
import {
  createPdfjsTextExtractionParser,
} from "@/infrastructure/pdfjs-text-extractor";
import { bibliographicParser } from "@/infrastructure/bibliographic-parser";

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
const aiProvider = openAiKey && (process.env.AI_PROVIDER ?? "openai").trim() === "openai"
  ? new OpenAIExtractionSuggestionProvider({
      apiKey: openAiKey,
      defaultModel: configuredAiModel,
      defaultReasoningEffort: "low",
    })
  : undefined;

export const aiExtractionServices = createAiExtractionSuggestionServices(database.db, aiProvider, {
  defaultModel: configuredAiModel,
  defaultReasoningEffort: "low",
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
