import { createReviewServices } from "@/application/services";
import { createAiExtractionSuggestionServices } from "@/application/ai-extraction-suggestion-services";
import { createDb } from "@/db/client";
import { LocalDocumentStorage } from "@/infrastructure/document-storage";
import { OpenAIExtractionSuggestionProvider } from "@/infrastructure/openai-extraction-suggestion-provider";
import {
  createPdfjsTextExtractionParser,
} from "@/infrastructure/pdfjs-text-extractor";

const globalForReview = globalThis as unknown as {
  reviewDatabase?: ReturnType<typeof createDb>;
};

const database = globalForReview.reviewDatabase ?? createDb();
if (process.env.NODE_ENV !== "production") globalForReview.reviewDatabase = database;

const storageRoot = process.env.LITREVIEW_DOCUMENT_STORAGE_ROOT?.trim();
const documentStorage = storageRoot ? new LocalDocumentStorage(storageRoot) : undefined;
const configuredMaxBytes = Number(process.env.LITREVIEW_DOCUMENT_MAX_BYTES ?? "52428800");
const maxDocumentBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0 ? configuredMaxBytes : undefined;

// The infrastructure factory exposes only the parser-neutral application
// contract; PDF.js types and import details remain server-side.
const documentTextExtractor = createPdfjsTextExtractionParser();

export const reviewServices = createReviewServices(database.db, { documentStorage, maxDocumentBytes, documentTextExtractor });

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

export const aiExtractionProviderAvailable = Boolean(aiProvider);
