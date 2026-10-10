import { DomainError } from "@/domain/errors";

export const EXTRACTION_EVIDENCE_SEARCH_QUERY_MAX_CODE_POINTS = 200;

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function invalidQuery(message: string): DomainError {
  return new DomainError("VALIDATION_ERROR", message, { input: "query" });
}

/** Validate and trim the submitted literal search query without changing its contents. */
export function normalizeExtractionEvidenceSearchQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidQuery("Evidence search query must be text.");
  }
  if (value.includes("\0")) {
    throw invalidQuery("Evidence search query cannot contain a NUL character.");
  }
  if (!isWellFormedUnicode(value)) {
    throw invalidQuery("Evidence search query must contain well-formed Unicode text.");
  }
  const normalized = value.trim();
  if ([...normalized].length > EXTRACTION_EVIDENCE_SEARCH_QUERY_MAX_CODE_POINTS) {
    throw invalidQuery(`Evidence search query cannot exceed ${EXTRACTION_EVIDENCE_SEARCH_QUERY_MAX_CODE_POINTS} characters.`);
  }
  return normalized;
}
