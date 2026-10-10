import type { ExtractionEvidencePreview } from "@/application/extraction-evidence-selection-read-services";

export type ExtractionWorksheetActionState = {
  response: "idle" | "failed";
  fieldId: string;
  responseVersion: number;
  rawState: string;
  rawValue: string;
  rawResearcherNote: string;
  /** The exact submitted values are kept for failed-action reconstruction. */
  submittedEvidenceIds: string[];
  supportMetadata: ExtractionEvidencePreview[];
  safeErrorMessage: string | null;
};

export function createInitialExtractionWorksheetActionState(input: {
  fieldId: string;
  state: string;
  value: string;
  researcherNote: string;
  evidenceIds: string[];
  supportMetadata?: ExtractionEvidencePreview[];
}): ExtractionWorksheetActionState {
  return {
    response: "idle",
    fieldId: input.fieldId,
    responseVersion: 0,
    rawState: input.state,
    rawValue: input.value,
    rawResearcherNote: input.researcherNote,
    submittedEvidenceIds: [...input.evidenceIds],
    supportMetadata: input.supportMetadata ?? [],
    safeErrorMessage: null,
  };
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** Preserve researcher notes for present, not_reported, and not_applicable states, while preserving released note omission for cleared. */
export function parseExtractionValueFormData(form: FormData) {
  const state = formText(form, "state") || "present";
  const evidenceIds = form.getAll("evidenceIds").filter((id): id is string => typeof id === "string");
  if (state === "cleared") {
    return {
      state: "cleared" as const,
      evidenceIds,
    };
  }
  const researcherNote = formText(form, "researcherNote") || undefined;
  if (state !== "present") {
    return {
      state: state as "not_reported" | "not_applicable",
      researcherNote,
      evidenceIds,
    };
  }
  const kind = formText(form, "valueKind");
  const raw = form.get("value");
  let value: unknown = typeof raw === "string" ? raw : undefined;
  if (kind === "number") value = typeof raw === "string" && raw !== "" ? Number(raw) : undefined;
  if (kind === "boolean") value = raw === "true";
  return {
    state: "present" as const,
    value,
    researcherNote,
    evidenceIds,
  };
}

export function nextExtractionWorksheetResponseVersion(current: number): number {
  return Number.isSafeInteger(current) && current >= 0 && current < Number.MAX_SAFE_INTEGER ? current + 1 : 1;
}
