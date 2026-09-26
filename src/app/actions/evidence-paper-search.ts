"use server";

import { evidenceWorkspaceReadServices } from "../server";
import type { SearchEvidencePaperOptionsInput } from "@/application/evidence-workspace-read-services";
import { DomainError } from "@/domain/errors";

export async function searchEvidencePaperOptionsAction(input: unknown) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new DomainError("VALIDATION_ERROR", "Paper search input is invalid");
    }
    return {
      ok: true as const,
      page: await evidenceWorkspaceReadServices.searchEvidencePaperOptions(input as SearchEvidencePaperOptionsInput),
    };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof DomainError ? error.message : "Paper options could not be loaded.",
    };
  }
}
