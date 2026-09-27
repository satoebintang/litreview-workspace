"use server";

import { paperSelectionReadServices } from "../server";
import type { SearchPaperOptionsInput } from "@/application/paper-selection-read-services";
import { DomainError } from "@/domain/errors";

export async function searchPaperOptionsAction(input: unknown) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new DomainError("VALIDATION_ERROR", "Paper search input is invalid");
    }
    return {
      ok: true as const,
      page: await paperSelectionReadServices.searchPaperOptions(input as SearchPaperOptionsInput),
    };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof DomainError ? error.message : "Paper options could not be loaded.",
    };
  }
}
