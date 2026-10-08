"use server";

import { extractionReadServices } from "@/app/server";
import type { ExtractionEvidenceCandidatePage } from "@/application/extraction-evidence-selection-read-services";
import { DomainError } from "@/domain/errors";

export type ExtractionEvidenceCandidatePageActionResult =
  | { status: "success"; page: ExtractionEvidenceCandidatePage }
  | { status: "error"; safeErrorMessage: string; invalidBrowseState: boolean };

function safeMessage(error: unknown): string {
  return error instanceof DomainError
    ? error.message
    : "Evidence could not be loaded. Your selected supports were kept unchanged.";
}

export async function getPaperExtractionEvidenceCandidatePageAction(
  projectId: string,
  paperId: string,
  options: { pageSize?: number; after?: string | null } = {},
): Promise<ExtractionEvidenceCandidatePageActionResult> {
  try {
    const page = await extractionReadServices.getPaperExtractionEvidenceCandidatePage(projectId, paperId, options);
    return { status: "success", page };
  } catch (error) {
    return {
      status: "error",
      safeErrorMessage: safeMessage(error),
      invalidBrowseState: error instanceof DomainError && error.code === "VALIDATION_ERROR",
    };
  }
}
