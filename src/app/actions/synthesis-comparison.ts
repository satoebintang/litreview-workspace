"use server";

import { synthesisReadServices } from "../server";
import { DomainError } from "@/domain/errors";

export async function getSynthesisComparisonPageAction(input: unknown) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new DomainError("VALIDATION_ERROR", "Synthesis comparison request is invalid");
    }
    const value = input as { projectId?: unknown; fieldId?: unknown; page?: unknown };
    if (typeof value.projectId !== "string" || typeof value.fieldId !== "string") {
      throw new DomainError("VALIDATION_ERROR", "Synthesis comparison request is invalid");
    }
    return {
      ok: true as const,
      page: await synthesisReadServices.getSynthesisComparisonPage(value.projectId, value.fieldId, {
        page: typeof value.page === "number" || typeof value.page === "string" ? value.page : 1,
        pageSize: 50,
      }),
    };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof DomainError ? error.message : "Synthesis observations could not be loaded.",
    };
  }
}
