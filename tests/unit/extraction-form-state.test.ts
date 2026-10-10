import { describe, expect, it } from "vitest";
import {
  createInitialExtractionWorksheetActionState,
  nextExtractionWorksheetResponseVersion,
  parseExtractionValueFormData,
} from "@/app/extraction-form-state";

describe("Extraction worksheet serializable form state", () => {
  it("preserves researcher notes and evidence for not_reported and not_applicable states", () => {
    const notReportedForm = new FormData();
    notReportedForm.set("state", "not_reported");
    notReportedForm.set("researcherNote", "  absent from main text  ");
    notReportedForm.append("evidenceIds", "11111111-1111-4111-8111-111111111111");
    notReportedForm.append("evidenceIds", "22222222-2222-4222-8222-222222222222");
    expect(parseExtractionValueFormData(notReportedForm)).toEqual({
      state: "not_reported",
      researcherNote: "absent from main text",
      evidenceIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    });

    const notReportedEmptyNote = new FormData();
    notReportedEmptyNote.set("state", "not_reported");
    expect(parseExtractionValueFormData(notReportedEmptyNote)).toEqual({
      state: "not_reported",
      researcherNote: undefined,
      evidenceIds: [],
    });

    const notReportedWhitespaceNote = new FormData();
    notReportedWhitespaceNote.set("state", "not_reported");
    notReportedWhitespaceNote.set("researcherNote", "   \t  \n  ");
    expect(parseExtractionValueFormData(notReportedWhitespaceNote)).toEqual({
      state: "not_reported",
      researcherNote: undefined,
      evidenceIds: [],
    });

    const notApplicableForm = new FormData();
    notApplicableForm.set("state", "not_applicable");
    notApplicableForm.set("researcherNote", "  study design does not include control group  ");
    notApplicableForm.append("evidenceIds", "33333333-3333-4333-8333-333333333333");
    expect(parseExtractionValueFormData(notApplicableForm)).toEqual({
      state: "not_applicable",
      researcherNote: "study design does not include control group",
      evidenceIds: ["33333333-3333-4333-8333-333333333333"],
    });

    const notApplicableEmptyNote = new FormData();
    notApplicableEmptyNote.set("state", "not_applicable");
    expect(parseExtractionValueFormData(notApplicableEmptyNote)).toEqual({
      state: "not_applicable",
      researcherNote: undefined,
      evidenceIds: [],
    });

    const notApplicableWhitespaceNote = new FormData();
    notApplicableWhitespaceNote.set("state", "not_applicable");
    notApplicableWhitespaceNote.set("researcherNote", "   ");
    expect(parseExtractionValueFormData(notApplicableWhitespaceNote)).toEqual({
      state: "not_applicable",
      researcherNote: undefined,
      evidenceIds: [],
    });
  });

  it("omits researcher notes while preserving evidence for cleared responses", () => {
    const clearedForm = new FormData();
    clearedForm.set("state", "cleared");
    clearedForm.set("researcherNote", "should be omitted");
    clearedForm.append("evidenceIds", "11111111-1111-4111-8111-111111111111");
    const parsed = parseExtractionValueFormData(clearedForm);
    expect(parsed).toEqual({
      state: "cleared",
      evidenceIds: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(parsed).not.toHaveProperty("researcherNote");

    const clearedEmpty = new FormData();
    clearedEmpty.set("state", "cleared");
    const parsedEmpty = parseExtractionValueFormData(clearedEmpty);
    expect(parsedEmpty).toEqual({
      state: "cleared",
      evidenceIds: [],
    });
    expect(parsedEmpty).not.toHaveProperty("researcherNote");
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
