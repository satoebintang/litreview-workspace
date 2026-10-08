import { describe, expect, it } from "vitest";
import {
  createInitialExtractionWorksheetActionState,
  nextExtractionWorksheetResponseVersion,
  parseExtractionValueFormData,
} from "@/app/extraction-form-state";

describe("Extraction worksheet serializable form state", () => {
  it("preserves the released parser omission for notes on non-present states", () => {
    const form = new FormData();
    form.set("state", "not_reported");
    form.set("researcherNote", "attempted note remains in action state");
    form.append("evidenceIds", "11111111-1111-4111-8111-111111111111");
    const parsed = parseExtractionValueFormData(form);
    expect(parsed).toEqual({ state: "not_reported", evidenceIds: ["11111111-1111-4111-8111-111111111111"] });
    expect(parsed).not.toHaveProperty("researcherNote");
  });

  it("parses current present values, keeps repeated Evidence values, and versions failed responses", () => {
    const form = new FormData();
    form.set("state", "present");
    form.set("valueKind", "number");
    form.set("value", "2.75");
    form.set("researcherNote", "  note  ");
    form.append("evidenceIds", "11111111-1111-4111-8111-111111111111");
    form.append("evidenceIds", "22222222-2222-4222-8222-222222222222");
    expect(parseExtractionValueFormData(form)).toEqual({
      state: "present",
      value: 2.75,
      researcherNote: "note",
      evidenceIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    });
    const initial = createInitialExtractionWorksheetActionState({ fieldId: "field", state: "present", value: "", researcherNote: "", evidenceIds: [] });
    expect(initial.responseVersion).toBe(0);
    expect(nextExtractionWorksheetResponseVersion(initial.responseVersion)).toBe(1);
    expect(nextExtractionWorksheetResponseVersion(Number.MAX_SAFE_INTEGER)).toBe(1);
  });
});
