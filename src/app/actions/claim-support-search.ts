"use server";

import { claimSupportReadServices } from "../server";
import type { SearchClaimSupportOptionsInput } from "@/application/claim-support-read-services";
import { DomainError } from "@/domain/errors";

export async function searchClaimSupportOptionsAction(input: unknown) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new DomainError("VALIDATION_ERROR", "Claim support search input is invalid");
    }
    return { ok: true as const, page: await claimSupportReadServices.searchClaimSupportOptions(input as SearchClaimSupportOptionsInput) };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof DomainError ? error.message : "Claim support options could not be loaded.",
    };
  }
}
