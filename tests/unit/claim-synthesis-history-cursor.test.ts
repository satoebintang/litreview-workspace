import { describe, expect, it } from "vitest";
import { decodeClaimSynthesisHistoryCursor, effectiveClaimSynthesisHistoryPageSize, encodeClaimSynthesisHistoryCursor } from "@/application/claim-synthesis-history-cursor";
import type { ClaimRevisionHistoryCursor } from "@/application/claim-synthesis-history-read-types";

const projectId = "10000000-0000-4000-8000-000000000001";
const claimId = "20000000-0000-4000-8000-000000000002";
const lastEventId = "30000000-0000-4000-8000-000000000003";

function cursor(lastSequence = "9007199254740993"): ClaimRevisionHistoryCursor {
  return { v: 1, projectId, claimId, historyType: "claim-revision", pageSize: 20, lastSequence, lastEventId };
}

describe("Claim/Synthesis history cursor contract", () => {
  it("round-trips canonical signed BIGINT strings without Number conversion", () => {
    for (const sequence of ["0", "-1", "9007199254740993", "9223372036854775807", "-9223372036854775808"]) {
      const encoded = encodeClaimSynthesisHistoryCursor(cursor(sequence));
      expect(decodeClaimSynthesisHistoryCursor(encoded, { projectId, claimId, historyType: "claim-revision", pageSize: 20 })).toEqual(cursor(sequence));
    }
  });

  it("rejects noncanonical, out-of-range, malformed, and differently scoped cursors", () => {
    const encoded = encodeClaimSynthesisHistoryCursor(cursor());
    expect(() => decodeClaimSynthesisHistoryCursor(encoded, { projectId, claimId, historyType: "claim-revision", pageSize: 10 })).toThrow();
    expect(() => decodeClaimSynthesisHistoryCursor(encoded, { projectId, claimId: "20000000-0000-4000-8000-000000000099", historyType: "claim-revision", pageSize: 20 })).toThrow();
    for (const sequence of ["-0", "01", "-01", "9223372036854775808", "-9223372036854775809"]) {
      const invalid = Buffer.from(JSON.stringify(cursor(sequence)), "utf8").toString("base64url");
      expect(() => decodeClaimSynthesisHistoryCursor(invalid, { projectId, claimId, historyType: "claim-revision", pageSize: 20 })).toThrow();
    }
    expect(() => decodeClaimSynthesisHistoryCursor(`${encoded}=`, { projectId, claimId, historyType: "claim-revision", pageSize: 20 })).toThrow();
  });

  it("rejects unsupported versions, non-exact keys, wrong project or stream, and oversized tokens", () => {
    const expected = { projectId, claimId, historyType: "claim-revision" as const, pageSize: 20 };
    const tokenFor = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const valid = cursor();
    const missingKey: Record<string, unknown> = { ...valid };
    delete missingKey.lastEventId;

    expect(() => decodeClaimSynthesisHistoryCursor(tokenFor({ ...valid, v: 2 }), expected)).toThrow();
    expect(() => decodeClaimSynthesisHistoryCursor(tokenFor({ ...valid, unexpected: true }), expected)).toThrow();
    expect(() => decodeClaimSynthesisHistoryCursor(tokenFor(missingKey), expected)).toThrow();
    expect(() => decodeClaimSynthesisHistoryCursor(tokenFor({ ...valid, projectId: "10000000-0000-4000-8000-000000000099" }), expected)).toThrow();
    expect(() => decodeClaimSynthesisHistoryCursor(tokenFor({ ...valid, historyType: "synthesis-revision" }), expected)).toThrow();
    expect(() => decodeClaimSynthesisHistoryCursor(`${encodeClaimSynthesisHistoryCursor(valid)}${"A".repeat(513)}`, expected)).toThrow();
  });

  it("uses the approved page-size limits", () => {
    expect(effectiveClaimSynthesisHistoryPageSize(undefined)).toBe(20);
    expect(effectiveClaimSynthesisHistoryPageSize(7)).toBe(7);
    expect(effectiveClaimSynthesisHistoryPageSize(500)).toBe(50);
    expect(() => effectiveClaimSynthesisHistoryPageSize(0)).toThrow();
  });
});
