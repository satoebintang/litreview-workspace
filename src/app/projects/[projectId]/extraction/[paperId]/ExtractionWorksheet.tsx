"use client";

import type { ExtractionEvidencePreview } from "@/application/extraction-evidence-selection-read-services";
import type { ExtractionWorksheetEvidence } from "@/application/extraction-worksheet-read-services";
import { ExtractionRevisionForm, type ExtractionRevisionFormField, type ExtractionRevisionFormValue } from "./ExtractionRevisionForm";
import { ExtractionWorksheetEvidencePicker } from "./ExtractionWorksheetEvidencePicker";
import { ExtractionWorksheetProvider } from "./ExtractionWorksheetContext";

type BrowseState = { open: boolean; fieldId: string | null; after: string | null; pageSize: number; query: string; queryError: string | null };

export type ExtractionWorksheetItem = {
  field: ExtractionRevisionFormField;
  fieldId: string;
  currentRevision: ExtractionRevisionFormValue["currentRevision"];
  supportStatus: "grounded" | "ungrounded";
  hasHistory: boolean;
  historyHref: string | null;
};

function selectionMap(values: ExtractionWorksheetItem[]): Record<string, ExtractionEvidencePreview[]> {
  return Object.fromEntries(values.map((value) => [
    value.fieldId,
    (value.currentRevision?.evidence ?? []).map((item: ExtractionWorksheetEvidence) => Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== "createdAt"),
    ) as ExtractionEvidencePreview),
  ]));
}

export function ExtractionWorksheet({
  projectId,
  paperId,
  values,
  included,
  initialBrowse,
  activeDraftFieldId,
  aiSuggestion,
}: {
  projectId: string;
  paperId: string;
  values: ExtractionWorksheetItem[];
  included: boolean;
  initialBrowse: BrowseState;
  activeDraftFieldId: string | null;
  aiSuggestion: null | {
    providerAvailable: boolean;
    fullTextDocumentId: string;
    documentTextExtractionId: string;
  };
}) {
  const fieldIds = values.map((value) => value.field.id);
  return <ExtractionWorksheetProvider
    fieldIds={fieldIds}
    initialSelectedByFieldId={selectionMap(values)}
    initialBrowse={initialBrowse}
  >
    <div className="extraction-values">{values.map((item) => <ExtractionRevisionForm
      key={item.field.id}
      projectId={projectId}
      paperId={paperId}
      field={item.field}
      value={item}
      included={included}
      activeDraftField={activeDraftFieldId === item.field.id}
      aiSuggestion={aiSuggestion}
    />)}</div>
    <ExtractionWorksheetEvidencePicker
      projectId={projectId}
      paperId={paperId}
      fields={values.map((value) => ({ id: value.field.id, name: value.field.name }))}
    />
  </ExtractionWorksheetProvider>;
}
