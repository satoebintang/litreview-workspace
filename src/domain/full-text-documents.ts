import { createHash } from "node:crypto";
import { z } from "zod";
import { fullTextDocumentMetadataSchema } from "./validation";

export const FULL_TEXT_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
export const PDF_MEDIA_TYPE = "application/pdf" as const;

const CONTROL_OR_SEPARATOR = /[\u0000-\u001f\u007f\\/]/;

export function validateDocumentFilename(filename: string) {
  if (!filename.trim() || filename.length > 255 || CONTROL_OR_SEPARATOR.test(filename)) {
    throw new Error("Document filename is invalid");
  }
  return filename;
}

export function validatePdfMetadata(input: unknown) {
  return fullTextDocumentMetadataSchema.parse(input);
}

export function isPdfSignature(prefix: Uint8Array) {
  return prefix.length >= 5 && String.fromCharCode(...prefix.subarray(0, 5)) === "%PDF-";
}

export function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function documentStorageKey(projectId: string, paperId: string, documentId: string) {
  return `projects/${projectId}/papers/${paperId}/documents/${documentId}/source.pdf`;
}

export function isDocumentStorageKey(value: string) {
  return /^projects\/[0-9a-f-]{36}\/papers\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/source\.pdf$/.test(value);
}

export type FullTextDocumentMetadata = z.infer<typeof fullTextDocumentMetadataSchema>;
