import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import {
  decodeExtractionHistoryCursor,
  effectiveExtractionHistoryPageSize,
  encodeExtractionHistoryCursor,
} from "@/application/extraction-history-cursor";
import { EXTRACTION_HISTORY_TYPE, type ExtractionHistoryCursor } from "@/application/extraction-history-read-types";

const projectId = "00000000-0000-4000-8000-000000000001";
const paperId = "00000000-0000-4000-8000-000000000002";
const fieldId = "00000000-0000-4000-8000-000000000003";
const slotId = "00000000-0000-4000-8000-000000000004";
const revisionId = "00000000-0000-4000-8000-000000000005";

function cursor(lastSequence = "9007199254740993"): ExtractionHistoryCursor {
  return {
    v: 1,
    projectId,
    paperId,
    fieldId,
    extractionValueId: slotId,
    historyType: EXTRACTION_HISTORY_TYPE,
    pageSize: 50,
    lastSequence,
    lastRevisionId: revisionId,
  };
}

describe("Slice 53 extraction history cursor", () => {
  it("round trips the compact canonical scope and preserves BIGINT text", () => {
    const token = encodeExtractionHistoryCursor(cursor());
    expect(token.length).toBeLessThanOrEqual(512);
    expect(decodeExtractionHistoryCursor(token, { projectId, paperId, fieldId, pageSize: 50 })).toEqual(cursor());
  });

  it("binds project, Paper, Field, stable slot, stream, and effective page size", () => {
    const token = encodeExtractionHistoryCursor(cursor());
    for (const expected of [
      { projectId: "00000000-0000-4000-8000-000000000099", paperId, fieldId, pageSize: 50 },
      { projectId, paperId: "00000000-0000-4000-8000-000000000099", fieldId, pageSize: 50 },
      { projectId, paperId, fieldId: "00000000-0000-4000-8000-000000000099", pageSize: 50 },
      { projectId, paperId, fieldId, extractionValueId: "00000000-0000-4000-8000-000000000099", pageSize: 50 },
      { projectId, paperId, fieldId, pageSize: 20 },
    ]) {
      expect(() => decodeExtractionHistoryCursor(token, expected)).toThrow(DomainError);
    }
  });

  it("caps page size at 50 and rejects invalid values", () => {
    expect(effectiveExtractionHistoryPageSize(undefined)).toBe(20);
    expect(effectiveExtractionHistoryPageSize(20)).toBe(20);
    expect(effectiveExtractionHistoryPageSize(50)).toBe(50);
    expect(effectiveExtractionHistoryPageSize(51)).toBe(50);
    for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => effectiveExtractionHistoryPageSize(size)).toThrow(DomainError);
    }
  });

  it.each(["+1", "01", "-0", "9223372036854775808", "-9223372036854775809"]) (
    "rejects noncanonical or out-of-range sequence text %s",
    (lastSequence) => {
      const token = encodeExtractionHistoryCursor(cursor(lastSequence));
      expect(() => decodeExtractionHistoryCursor(token, { projectId, paperId, fieldId, pageSize: 50 })).toThrow(DomainError);
    },
  );

  it("rejects malformed, noncanonical, and oversized tokens", () => {
    expect(() => decodeExtractionHistoryCursor("%%%", { projectId, paperId, fieldId, pageSize: 50 })).toThrow(DomainError);
    const token = encodeExtractionHistoryCursor(cursor());
    expect(() => decodeExtractionHistoryCursor(`${token}=`, { projectId, paperId, fieldId, pageSize: 50 })).toThrow(DomainError);
    expect(() => decodeExtractionHistoryCursor("a".repeat(513), { projectId, paperId, fieldId, pageSize: 50 })).toThrow(DomainError);
  });
});
