import { describe, expect, it } from "vitest";
import { appendResearchQuestionAnswerSchema } from "@/domain/validation";

const id = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

describe("Slice 21 Research Question Answer validation", () => {
  it("trims answer text and normalizes a blank researcher note to null", () => {
    expect(appendResearchQuestionAnswerSchema.parse({
      answerText: "  The answer  ",
      researcherNote: "  ",
      claimRevisionIds: [id("01")],
      synthesisRevisionIds: [],
    })).toEqual({
      answerText: "The answer",
      researcherNote: null,
      claimRevisionIds: [id("01")],
      synthesisRevisionIds: [],
    });
  });

  it("requires at least one context and rejects duplicate exact revisions", () => {
    expect(appendResearchQuestionAnswerSchema.safeParse({
      answerText: "An answer",
      claimRevisionIds: [],
      synthesisRevisionIds: [],
    }).success).toBe(false);

    expect(appendResearchQuestionAnswerSchema.safeParse({
      answerText: "An answer",
      claimRevisionIds: [id("01"), id("01")],
      synthesisRevisionIds: [],
    }).success).toBe(false);
    expect(appendResearchQuestionAnswerSchema.safeParse({
      answerText: "An answer",
      claimRevisionIds: [],
      synthesisRevisionIds: [id("02"), id("02")],
    }).success).toBe(false);
  });

  it("enforces the 20,000-character text limits and 100-item per-type bounds", () => {
    const ids = Array.from({ length: 101 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(2, "0");
      return `00000000-0000-4000-8000-0000000000${suffix}`;
    });
    expect(appendResearchQuestionAnswerSchema.safeParse({
      answerText: "a".repeat(20001),
      claimRevisionIds: [id("01")],
      synthesisRevisionIds: [],
    }).success).toBe(false);
    expect(appendResearchQuestionAnswerSchema.safeParse({
      answerText: "An answer",
      claimRevisionIds: ids,
      synthesisRevisionIds: [],
    }).success).toBe(false);
    expect(appendResearchQuestionAnswerSchema.safeParse({
      answerText: "An answer",
      researcherNote: "n".repeat(20001),
      claimRevisionIds: [id("01")],
      synthesisRevisionIds: [],
    }).success).toBe(false);
  });
});
