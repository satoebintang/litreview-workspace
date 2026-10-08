import { describe, expect, it } from "vitest";
import {
  decodeExtractionEvidenceCandidateCursor,
  effectiveExtractionEvidencePageSize,
  encodeExtractionEvidenceCandidateCursor,
  EXTRACTION_EVIDENCE_CURSOR_MAX_LENGTH,
} from "@/application/extraction-evidence-selection-cursor";

const projectId = "11111111-1111-4111-8111-111111111111";
const paperId = "22222222-2222-4222-8222-222222222222";
const evidenceId = "33333333-3333-4333-8333-333333333333";
const cursor = {
  kind: "paper-extraction-evidence-candidate" as const,
  version: 1 as const,
  projectId,
  paperId,
  pageSize: 20,
  createdAt: "2026-10-07T12:34:56.123456Z",
  id: evidenceId,
};

describe("Extraction Evidence candidate cursor", () => {
  it("round trips a canonical, scope-bound cursor without losing timestamp microseconds", () => {
    const encoded = encodeExtractionEvidenceCandidateCursor(cursor);
    expect(decodeExtractionEvidenceCandidateCursor(encoded, { projectId, paperId, pageSize: 20 })).toEqual(cursor);
    expect(cursor.createdAt).toContain(".123456Z");
  });

  it("rejects malformed, noncanonical, unsupported, mismatched, and overlong cursors", () => {
    const encoded = encodeExtractionEvidenceCandidateCursor(cursor);
    const padded = `${encoded}=`;
    const noncanonicalJson = Buffer.from(JSON.stringify({ ...cursor, extra: true }), "utf8").toString("base64url");
    const unsupported = Buffer.from(JSON.stringify({ ...cursor, version: 2 }), "utf8").toString("base64url");
    expect(() => decodeExtractionEvidenceCandidateCursor("not/a-cursor", { projectId, paperId, pageSize: 20 })).toThrow();
    expect(() => decodeExtractionEvidenceCandidateCursor(padded, { projectId, paperId, pageSize: 20 })).toThrow();
    expect(() => decodeExtractionEvidenceCandidateCursor(noncanonicalJson, { projectId, paperId, pageSize: 20 })).toThrow();
    expect(() => decodeExtractionEvidenceCandidateCursor(unsupported, { projectId, paperId, pageSize: 20 })).toThrow();
    expect(() => decodeExtractionEvidenceCandidateCursor(encoded, { projectId: evidenceId, paperId, pageSize: 20 })).toThrow();
    expect(() => decodeExtractionEvidenceCandidateCursor(encoded, { projectId, paperId: evidenceId, pageSize: 20 })).toThrow();
    expect(() => decodeExtractionEvidenceCandidateCursor(encoded, { projectId, paperId, pageSize: 50 })).toThrow();
    expect(() => decodeExtractionEvidenceCandidateCursor("a".repeat(EXTRACTION_EVIDENCE_CURSOR_MAX_LENGTH + 1), { projectId, paperId, pageSize: 20 })).toThrow();
  });

  it("uses a 20 default and caps larger requested pages at 50", () => {
    expect(effectiveExtractionEvidencePageSize()).toBe(20);
    expect(effectiveExtractionEvidencePageSize(20)).toBe(20);
    expect(effectiveExtractionEvidencePageSize(100)).toBe(50);
    expect(() => effectiveExtractionEvidencePageSize(0)).toThrow();
    expect(() => effectiveExtractionEvidencePageSize(1.5)).toThrow();
  });
});
