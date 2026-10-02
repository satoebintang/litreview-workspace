import { describe, expect, it } from "vitest";
import { REVIEW_REPORT_METRIC_KEYS } from "@/domain/review-report";
import { DomainError } from "@/domain/errors";
import { mapReviewFlowSummaryRow, safeDatabaseInteger } from "@/application/review-flow-summary";

describe("exact Review Flow numeric mapping", () => {
  it("maps the canonical 37-key row without converting unsafe integers through Number", () => {
    const row = Object.fromEntries(REVIEW_REPORT_METRIC_KEYS.map((key) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      "9007199254740991",
    ]));
    const mapped = mapReviewFlowSummaryRow(row);
    expect(Object.keys(mapped)).toHaveLength(37);
    for (const key of REVIEW_REPORT_METRIC_KEYS) expect(mapped[key]).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("accepts exact database integer values up to the safe boundary and rejects overflow or malformed values", () => {
    expect(safeDatabaseInteger("0", "test")).toBe(0);
    expect(safeDatabaseInteger(BigInt(Number.MAX_SAFE_INTEGER), "test")).toBe(Number.MAX_SAFE_INTEGER);
    expect(safeDatabaseInteger(String(Number.MAX_SAFE_INTEGER), "test")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => safeDatabaseInteger("9007199254740992", "test")).toThrow(DomainError);
    expect(() => safeDatabaseInteger("-1", "test")).toThrow(DomainError);
    expect(() => safeDatabaseInteger(9007199254740992, "test")).toThrow(DomainError);
    expect(() => safeDatabaseInteger("1.0", "test")).toThrow(DomainError);
  });
});
