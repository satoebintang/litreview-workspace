"use server";

import { extractionReadServices } from "@/app/server";
import type { ExtractionEvidenceCandidatePage } from "@/application/extraction-evidence-selection-read-services";
import { DomainError } from "@/domain/errors";

export type ExtractionEvidenceCandidatePageActionResult =
  | { status: "success"; page: ExtractionEvidenceCandidatePage }
  | {
    status: "error";
    safeErrorMessage: string;
    invalidBrowseState: boolean;
    validationInput: "query" | "pagination" | "request" | null;
  };

function validationInput(error: unknown): "query" | "pagination" | "request" | null {
  if (!(error instanceof DomainError) || error.code !== "VALIDATION_ERROR") return null;
  const input = (error.details as { input?: unknown } | undefined)?.input;
  return input === "query" || input === "pagination" ? input : "request";
}

function safeMessage(error: unknown): string {
  return error instanceof DomainError
    ? error.message
    : "Evidence could not be loaded.";
}

export async function getPaperExtractionEvidenceCandidatePageAction(
  projectId: string,
  paperId: string,
  options: { pageSize?: number; after?: string | null; query?: unknown } = {},
): Promise<ExtractionEvidenceCandidatePageActionResult> {
  try {
    const page = await extractionReadServices.getPaperExtractionEvidenceCandidatePage(projectId, paperId, options);
    return { status: "success", page };
  } catch (error) {
    const input = validationInput(error);
    return {
      status: "error",
      safeErrorMessage: safeMessage(error),
      invalidBrowseState: input === "pagination",
      validationInput: input,
    };
  }
}
