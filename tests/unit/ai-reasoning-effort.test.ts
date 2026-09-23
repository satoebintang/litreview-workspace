import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import { AI_REASONING_EFFORTS, parseAiReasoningEffort } from "@/application/ai/reasoning-effort";

describe("parseAiReasoningEffort", () => {
  it.each(AI_REASONING_EFFORTS)("accepts %s", (value) => {
    expect(parseAiReasoningEffort(value)).toBe(value);
  });

  it("defaults omitted and empty values to low", () => {
    expect(parseAiReasoningEffort(undefined)).toBe("low");
    expect(parseAiReasoningEffort("")).toBe("low");
  });

  it.each([" ", "invalid", "LOW", 3, false])("rejects invalid value %j through validation", (value) => {
    let thrown: unknown;
    try {
      parseAiReasoningEffort(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});