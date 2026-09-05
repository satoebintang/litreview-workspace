import { describe, expect, it } from "vitest";
import { createClaimSchema, createPaperSchema, recordEvidenceSchema } from "@/domain/validation";

describe("Slice 1 input validation", () => {
  it("preserves the ordered author array", () => {
    const result = createPaperSchema.parse({ title: "Study", authors: ["Zed", "Ada"] });
    expect(result.authors).toEqual(["Zed", "Ada"]);
  });

  it("rejects blank source text and non-positive pages", () => {
    expect(recordEvidenceSchema.safeParse({ paperId: "not-a-uuid", sourceText: "", pageNumber: 0 }).success).toBe(false);
    expect(recordEvidenceSchema.safeParse({ paperId: "00000000-0000-4000-8000-000000000000", sourceText: " \n\t ", pageNumber: 1 }).success).toBe(false);
  });

  it("preserves substantive whitespace in source quotations", () => {
    const result = recordEvidenceSchema.parse({ paperId: "00000000-0000-4000-8000-000000000000", sourceText: "  Exact passage  ", pageNumber: 2 });
    expect(result.sourceText).toBe("  Exact passage  ");
  });

  it("rejects blank claim text", () => {
    expect(createClaimSchema.safeParse({ claimText: "  " }).success).toBe(false);
  });
});
