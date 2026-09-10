import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";
import { LocalDocumentStorage } from "@/infrastructure/document-storage";

const globalForReview = globalThis as unknown as {
  reviewDatabase?: ReturnType<typeof createDb>;
};

const database = globalForReview.reviewDatabase ?? createDb();
if (process.env.NODE_ENV !== "production") globalForReview.reviewDatabase = database;

const storageRoot = process.env.LITREVIEW_DOCUMENT_STORAGE_ROOT?.trim();
const documentStorage = storageRoot ? new LocalDocumentStorage(storageRoot) : undefined;
const configuredMaxBytes = Number(process.env.LITREVIEW_DOCUMENT_MAX_BYTES ?? "52428800");
const maxDocumentBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0 ? configuredMaxBytes : undefined;

export const reviewServices = createReviewServices(database.db, { documentStorage, maxDocumentBytes });
