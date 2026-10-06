import { describe, expect, it } from "vitest";
import {
  canonicalSelectionUuid,
  decodePlacementSelectionCursor,
  decodeReplacementSelectionCursor,
  effectiveManuscriptClaimSelectionPageSize,
  encodePlacementSelectionCursor,
  encodeReplacementSelectionCursor,
  type PlacementSelectionCursor,
  type ReplacementSelectionCursor,
} from "@/application/manuscript-claim-selection-cursor";
import { DomainError } from "@/domain/errors";

const projectId = "10000000-0000-4000-8000-000000000001";
const manuscriptId = "20000000-0000-4000-8000-000000000002";
const sectionId = "30000000-0000-4000-8000-000000000003";
const placementId = "40000000-0000-4000-8000-000000000004";
const claimId = "50000000-0000-4000-8000-000000000005";
const placedRevisionId = "60000000-0000-4000-8000-000000000006";
const lastRevisionId = "70000000-0000-4000-8000-000000000007";

function placementCursor(lastSequence = "9007199254740993"): PlacementSelectionCursor {
  return { v: 1, selectorType: "placement", projectId, manuscriptId, sectionId, pageSize: 20, lastSequence, lastRevisionId };
}

function replacementCursor(placedSequence = "9007199254740991", lastSequence = "9007199254740993"): ReplacementSelectionCursor {
  return { v: 1, selectorType: "replacement", projectId, manuscriptId, placementId, claimId, placedRevisionId, placedSequence, pageSize: 50, lastSequence, lastRevisionId };
}

describe("manuscript ClaimRevision selection cursor contract", () => {
  it("maps malformed route UUID scope to a route-safe validation error", () => {
    for (const value of [null, 123, "not-a-uuid", "10000000-0000-4000-8000-00000000000Z"]) {
      expect(() => canonicalSelectionUuid(value)).toThrow(DomainError);
      try {
        canonicalSelectionUuid(value);
      } catch (error) {
        expect(error).toMatchObject({ code: "VALIDATION_ERROR" });
      }
    }
  });

  it("round-trips exact signed BIGINT strings and keeps selector streams distinct", () => {
    for (const sequence of ["0", "-1", "9007199254740993", "9223372036854775807", "-9223372036854775808"]) {
      const token = encodePlacementSelectionCursor(placementCursor(sequence));
      expect(decodePlacementSelectionCursor(token, { projectId, manuscriptId, sectionId, pageSize: 20 })).toEqual(placementCursor(sequence));
    }
    const replacementToken = encodeReplacementSelectionCursor(replacementCursor());
    expect(replacementToken.length).toBeLessThanOrEqual(512);
    expect(decodeReplacementSelectionCursor(replacementToken, { projectId, manuscriptId, placementId, claimId, placedRevisionId, placedSequence: "9007199254740991", pageSize: 50 })).toEqual(replacementCursor());
    expect(() => decodePlacementSelectionCursor(replacementToken, { projectId, manuscriptId, sectionId, pageSize: 20 })).toThrow();
    expect(() => decodeReplacementSelectionCursor(encodePlacementSelectionCursor(placementCursor()), { projectId, manuscriptId, placementId, claimId, placedRevisionId, placedSequence: "9007199254740991", pageSize: 20 })).toThrow();
  });

  it("rejects changed scope/page size, malformed tokens, and noncanonical or out-of-range sequences", () => {
    const token = encodePlacementSelectionCursor(placementCursor());
    expect(() => decodePlacementSelectionCursor(token, { projectId, manuscriptId, sectionId, pageSize: 10 })).toThrow();
    expect(() => decodePlacementSelectionCursor(token, { projectId, manuscriptId, sectionId: placementId, pageSize: 20 })).toThrow();
    expect(() => decodePlacementSelectionCursor(`${token}=`, { projectId, manuscriptId, sectionId, pageSize: 20 })).toThrow();
    const raw = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    for (const sequence of ["-0", "01", "-01", "9223372036854775808", "-9223372036854775809"]) {
      expect(() => decodePlacementSelectionCursor(raw({ v: 1, t: "placement", p: projectId, m: manuscriptId, d: sectionId, n: 20, s: sequence, i: lastRevisionId }), { projectId, manuscriptId, sectionId, pageSize: 20 })).toThrow();
    }
    expect(() => decodePlacementSelectionCursor("*", { projectId, manuscriptId, sectionId, pageSize: 20 })).toThrow();
  });

  it("rejects noncanonical JSON, duplicate keys, unknown keys, and oversize tokens", () => {
    const expected = { projectId, manuscriptId, sectionId, pageSize: 20 };
    const json = JSON.stringify({ v: 1, t: "placement", p: projectId, m: manuscriptId, d: sectionId, n: 20, s: "1", i: lastRevisionId });
    const encoded = Buffer.from(json, "utf8").toString("base64url");
    expect(() => decodePlacementSelectionCursor(Buffer.from(` ${json}`, "utf8").toString("base64url"), expected)).toThrow();
    expect(() => decodePlacementSelectionCursor(Buffer.from(json.replace("\"v\":1", "\"v\":1,\"v\":1"), "utf8").toString("base64url"), expected)).toThrow();
    expect(() => decodePlacementSelectionCursor(Buffer.from(`${json.slice(0, -1)},\"extra\":true}`, "utf8").toString("base64url"), expected)).toThrow();
    expect(() => decodePlacementSelectionCursor(`${encoded}${"A".repeat(513)}`, expected)).toThrow();
  });

  it("defaults to 20 rows, caps at 50, and rejects nonpositive page sizes", () => {
    expect(effectiveManuscriptClaimSelectionPageSize(undefined)).toBe(20);
    expect(effectiveManuscriptClaimSelectionPageSize(7)).toBe(7);
    expect(effectiveManuscriptClaimSelectionPageSize(500)).toBe(50);
    expect(() => effectiveManuscriptClaimSelectionPageSize(0)).toThrow();
  });
});
