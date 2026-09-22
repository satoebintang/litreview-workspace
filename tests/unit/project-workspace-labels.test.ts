import { describe, expect, it } from "vitest";
import { formatAuditTimestamp, humanizeBatchReason, humanizeBatchState, humanizeWorkspaceToken } from "@/application/project-workspace-labels";

describe("project workspace labels", () => {
  it.each([
    ["suggestion_ready", "Suggestion Ready"],
    ["outcome_unknown", "Outcome Unknown"],
    ["ai_request_id", "AI Request ID"],
  ])("humanizes %s", (value, expected) => {
    expect(humanizeWorkspaceToken(value)).toBe(expected);
  });

  it("uses the same stable wording for batch state and reason codes", () => {
    expect(humanizeBatchState("existing_cleared_revision")).toBe("Existing Cleared Revision");
    expect(humanizeBatchReason("full_text_document_missing")).toBe("Full Text Document Missing");
  });

  it("formats audit timestamps deterministically", () => {
    expect(formatAuditTimestamp("2026-09-22T10:20:30.000Z")).toBe("2026-09-22 10:20:30 UTC");
    expect(formatAuditTimestamp(null)).toBe("—");
  });
});
