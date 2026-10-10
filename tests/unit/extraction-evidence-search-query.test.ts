import { describe, expect, it } from "vitest";
import {
  EXTRACTION_EVIDENCE_SEARCH_QUERY_MAX_CODE_POINTS,
  normalizeExtractionEvidenceSearchQuery,
} from "@/application/extraction-evidence-search-query";

describe("Extraction Evidence search query normalization", () => {
  it("trims surrounding whitespace while preserving internal whitespace, punctuation, and Unicode", () => {
    expect(normalizeExtractionEvidenceSearchQuery("  α%_\\ 'quoted'  phrase  ")).toBe("α%_\\ 'quoted'  phrase");
    expect(normalizeExtractionEvidenceSearchQuery("   ")).toBe("");
  });

  it("limits by Unicode code points after trimming", () => {
    expect(normalizeExtractionEvidenceSearchQuery(` ${"🙂".repeat(EXTRACTION_EVIDENCE_SEARCH_QUERY_MAX_CODE_POINTS)} `))
      .toBe("🙂".repeat(EXTRACTION_EVIDENCE_SEARCH_QUERY_MAX_CODE_POINTS));
    expect(() => normalizeExtractionEvidenceSearchQuery("🙂".repeat(EXTRACTION_EVIDENCE_SEARCH_QUERY_MAX_CODE_POINTS + 1)))
      .toThrow(expect.objectContaining({ code: "VALIDATION_ERROR", details: { input: "query" } }));
  });

  it("accepts the replacement character as valid Unicode", () => {
    expect(normalizeExtractionEvidenceSearchQuery("before\uFFFDafter")).toBe("before\uFFFDafter");
  });

  it("rejects non-string values, NUL, and malformed surrogate sequences as query errors", () => {
    for (const value of [null, 4, {}, ["query"], "nul\0value", "lone\ud800", "lone\udc00", "pair\ud800x\udc00"]) {
      expect(() => normalizeExtractionEvidenceSearchQuery(value))
        .toThrow(expect.objectContaining({ code: "VALIDATION_ERROR", details: { input: "query" } }));
    }
  });

});
