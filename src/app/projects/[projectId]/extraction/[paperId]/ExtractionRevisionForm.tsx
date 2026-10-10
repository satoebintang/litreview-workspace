"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useState } from "react";
import type { ExtractionEvidencePreview } from "@/application/extraction-evidence-selection-read-services";
import { beginAiExtractionSuggestionAction, saveExtractionWorksheetRevisionAction } from "@/app/actions";
import { createInitialExtractionWorksheetActionState, type ExtractionWorksheetActionState } from "@/app/extraction-form-state";
import type { ExtractionWorksheetEvidence } from "@/application/extraction-worksheet-read-services";
import type { ExtractionFieldType, ExtractionValueState } from "@/domain/types";
import { useExtractionWorksheet } from "./ExtractionWorksheetContext";

export type ExtractionRevisionFormField = {
  id: string;
  name: string;
  description: string | null;
  fieldType: ExtractionFieldType;
  required: boolean;
  options: Array<{ id: string; label: string; archivedAt: Date | null }>;
};

export type ExtractionRevisionFormValue = {
  fieldId: string;
  currentRevision: null | {
    valueState: ExtractionValueState;
    textValue: string | null;
    numberValue: string | null;
    booleanValue: boolean | null;
    optionId: string | null;
    optionLabel: string | null;
    researcherNote: string | null;
    evidence: ExtractionWorksheetEvidence[];
  };
  supportStatus: "grounded" | "ungrounded";
  hasHistory: boolean;
  historyHref: string | null;
};

function currentValue(value: ExtractionRevisionFormValue["currentRevision"]): string {
  if (!value) return "";
  if (value.textValue !== null) return value.textValue;
  if (value.numberValue !== null) return value.numberValue;
  if (value.booleanValue !== null) return value.booleanValue ? "true" : "false";
  return value.optionId ?? "";
}

function initialSupports(supports: ExtractionWorksheetEvidence[]): ExtractionEvidencePreview[] {
  return supports.map((support) => Object.fromEntries(
    Object.entries(support).filter(([key]) => key !== "createdAt"),
  ) as ExtractionEvidencePreview);
}

function restoreFailedSelection(
  submittedIds: string[],
  supportMetadata: ExtractionEvidencePreview[],
  existing: ExtractionEvidencePreview[],
  projectId: string,
  paperId: string,
): ExtractionEvidencePreview[] {
  const byId = new Map<string, ExtractionEvidencePreview>();
  for (const item of existing) byId.set(item.id.toLowerCase(), item);
  for (const item of supportMetadata) byId.set(item.id.toLowerCase(), item);
  const restored: ExtractionEvidencePreview[] = [];
  const seen = new Set<string>();
  for (const submittedId of submittedIds) {
    const key = submittedId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    restored.push(byId.get(key) ?? {
      id: submittedId,
      projectId,
      paperId,
      pageNumber: 0,
      sourceTextPreview: "",
      sourceTextTruncated: false,
      notePreview: null,
      noteTruncated: false,
      reviewState: "unreviewed",
      curationWarning: "never_reviewed",
      href: `/projects/${projectId}/evidence/${encodeURIComponent(submittedId)}`,
    });
  }
  return restored;
}

function displayValue(revision: NonNullable<ExtractionRevisionFormValue["currentRevision"]>) {
  if (revision.valueState !== "present") return revision.valueState.replace("_", " ");
  if (revision.optionId) return revision.optionLabel ?? "Archived option";
  if (revision.textValue !== null) return revision.textValue;
  if (revision.numberValue !== null) return revision.numberValue;
  if (revision.booleanValue !== null) return revision.booleanValue ? "Yes" : "No";
  return "—";
}

function reviewLabel(state: ExtractionEvidencePreview["reviewState"]) {
  if (state === "rejected") return "Rejected for new direct support";
  if (state === "needs_review") return "Needs review; direct use is allowed with a warning";
  if (state === "unreviewed") return "Never reviewed; direct use is allowed with a warning";
  return "Accepted for direct use";
}

export function ExtractionRevisionForm({
  projectId,
  paperId,
  field,
  value,
  included,
  activeDraftField,
  aiSuggestion,
}: {
  projectId: string;
  paperId: string;
  field: ExtractionRevisionFormField;
  value: ExtractionRevisionFormValue;
  included: boolean;
  activeDraftField: boolean;
  aiSuggestion: null | { providerAvailable: boolean; fullTextDocumentId: string; documentTextExtractionId: string };
}) {
  const current = value.currentRevision;
  const supportItems = initialSupports(current?.evidence ?? []);
  const initialState = createInitialExtractionWorksheetActionState({
    fieldId: field.id,
    state: current?.valueState ?? "present",
    value: currentValue(current),
    researcherNote: current?.researcherNote ?? "",
    evidenceIds: supportItems.map((item) => item.id),
    supportMetadata: supportItems,
  });
  const permalink = `/projects/${projectId}/extraction/${paperId}?draftField=${encodeURIComponent(field.id)}#extraction-field-${field.id}`;
  const [actionState, formAction, pending] = useActionState<ExtractionWorksheetActionState, FormData>(
    saveExtractionWorksheetRevisionAction,
    initialState,
    permalink,
  );
  const { selectedByFieldId, setFieldSelection, removeFieldSupport, browse, setBrowse } = useExtractionWorksheet();
  const selectedSupports = selectedByFieldId[field.id] ?? supportItems;
  const [valueState, setValueState] = useState(actionState.rawState);
  const [rawValue, setRawValue] = useState(actionState.rawValue);
  const [rawNote, setRawNote] = useState(actionState.rawResearcherNote);
  const [clientError, setClientError] = useState<string | null>(null);
  const [reconciledVersion, setReconciledVersion] = useState(0);
  const supportById = useMemo(() => new Map(selectedSupports.map((item) => [item.id.toLowerCase(), item])), [selectedSupports]);
  const needsActionReconciliation = actionState.response === "failed"
    && actionState.fieldId === field.id
    && actionState.responseVersion > reconciledVersion;
  const visibleSupports = needsActionReconciliation
    ? restoreFailedSelection(actionState.submittedEvidenceIds, actionState.supportMetadata, selectedSupports, projectId, paperId)
    : selectedSupports;
  const blockedSupports = visibleSupports.filter((item) => item.reviewState === "rejected");
  const feedback = clientError ?? (actionState.response === "failed" && actionState.fieldId === field.id ? actionState.safeErrorMessage : null);

  useEffect(() => {
    if (!needsActionReconciliation) return;
    setValueState(actionState.rawState);
    setRawValue(actionState.rawValue);
    setRawNote(actionState.rawResearcherNote);
    setFieldSelection(field.id, restoreFailedSelection(actionState.submittedEvidenceIds, actionState.supportMetadata, selectedSupports, projectId, paperId));
    setReconciledVersion(actionState.responseVersion);
    setClientError(null);
  }, [
    actionState,
    field.id,
    needsActionReconciliation,
    projectId,
    paperId,
    selectedSupports,
    setFieldSelection,
  ]);

  function updateBrowseForField() {
    setBrowse({ ...browse, open: true, fieldId: field.id, after: null });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (included && blockedSupports.length > 0) {
      event.preventDefault();
      setClientError("Remove each currently rejected Evidence item before saving it as new direct support.");
      return;
    }
    setClientError(null);
  }

  return <article id={`extraction-field-${field.id}`} className="extraction-value" data-extraction-field={field.id} tabIndex={activeDraftField ? -1 : undefined}>
    <div className="extraction-value-header"><div><h3>{field.name} {field.required && <span className="required-mark">Required</span>}</h3>{field.description && <p className="hint">{field.description}</p>}</div>{current && <span className={`status ${value.supportStatus === "grounded" ? "supported" : "unsupported"}`}>{value.supportStatus === "grounded" ? "● Grounded" : "○ Not yet grounded"}</span>}</div>
    {included && aiSuggestion && (aiSuggestion.providerAvailable ? <form action={beginAiExtractionSuggestionAction} className="ai-suggestion-form">
      <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="fieldId" value={field.id} />
      <input type="hidden" name="fullTextDocumentId" value={aiSuggestion.fullTextDocumentId} /><input type="hidden" name="documentTextExtractionId" value={aiSuggestion.documentTextExtractionId} />
      <input type="hidden" name="disclosureVersion" value="openai-extraction-transmission-v1" />
      <details><summary>Suggest with AI</summary><p className="hint">The suggestion is assistive and must be reviewed before it can become a canonical extraction revision.</p>
        <label className="checkbox-row"><input type="checkbox" name="externalTransmissionAcknowledged" required /><span>Selected extracted text will be transmitted to the configured OpenAI API service. Tracework requests that the response not be stored as Responses API application state, but provider retention and organizational data controls may still apply.</span></label>
        <button className="button" type="submit">Begin suggestion</button>
      </details>
    </form> : <p className="hint">AI suggestions are unavailable until an OpenAI provider is configured on the server.</p>)}
    <form action={formAction} className="extraction-form" onSubmit={handleSubmit}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="paperId" value={paperId} />
      <input type="hidden" name="fieldId" value={field.id} />
      <input type="hidden" name="valueKind" value={field.fieldType} />
      <div className="field"><label htmlFor={`state-${field.id}`}>Response state</label><select id={`state-${field.id}`} name="state" value={valueState} onChange={(event) => setValueState(event.currentTarget.value)} disabled={!included}><option value="present">Value reported</option><option value="not_reported">Not reported in paper</option><option value="not_applicable">Not applicable</option><option value="cleared">Clear response</option></select></div>
      {field.fieldType === "short_text" && <div className="field"><label htmlFor={`value-${field.id}`}>Structured value</label><input id={`value-${field.id}`} name="value" value={rawValue} onChange={(event) => setRawValue(event.currentTarget.value)} maxLength={500} disabled={!included} /></div>}
      {field.fieldType === "long_text" && <div className="field"><label htmlFor={`value-${field.id}`}>Structured value</label><textarea id={`value-${field.id}`} name="value" value={rawValue} onChange={(event) => setRawValue(event.currentTarget.value)} maxLength={10000} disabled={!included} /></div>}
      {field.fieldType === "number" && <div className="field"><label htmlFor={`value-${field.id}`}>Structured value</label><input id={`value-${field.id}`} name="value" type="number" step="any" value={rawValue} onChange={(event) => setRawValue(event.currentTarget.value)} disabled={!included} /></div>}
      {field.fieldType === "boolean" && <div className="field"><label htmlFor={`value-${field.id}`}>Structured value</label><select id={`value-${field.id}`} name="value" value={rawValue} onChange={(event) => setRawValue(event.currentTarget.value)} disabled={!included}><option value="">Select yes or no</option><option value="true">Yes</option><option value="false">No</option></select></div>}
      {field.fieldType === "single_select" && <div className="field"><label htmlFor={`value-${field.id}`}>Structured value</label><select id={`value-${field.id}`} name="value" value={rawValue} onChange={(event) => setRawValue(event.currentTarget.value)} disabled={!included}><option value="">Select an option</option>{field.options.map((option) => <option key={option.id} value={option.id} disabled={Boolean(option.archivedAt) && option.id !== current?.optionId}>{option.label}{option.archivedAt ? " (archived)" : ""}</option>)}</select></div>}
      <div className="field"><label htmlFor={`note-${field.id}`}>Researcher note <span className="hint">optional · interpretation/commentary</span></label><textarea id={`note-${field.id}`} name="researcherNote" value={rawNote} onChange={(event) => setRawNote(event.currentTarget.value)} disabled={!included} /></div>
      <fieldset className="evidence-picker"><legend>Supporting Evidence <span className="hint">complete current support set</span></legend>
        {visibleSupports.length === 0 ? <div className="empty">No Evidence is selected for this Field.</div> : <div className="item-list">{visibleSupports.map((support) => {
          const selected = supportById.has(support.id.toLowerCase()) || needsActionReconciliation;
          const rejected = support.reviewState === "rejected";
          return <label className="checkbox-row selected-evidence-support" key={`${field.id}:${support.id}`}>
            <input
              type="checkbox"
              name="evidenceIds"
              value={support.id}
              checked={selected}
              onChange={() => removeFieldSupport(field.id, support.id)}
              disabled={!included || pending}
            />
            <span>
              <strong>{support.pageNumber > 0 ? `Page ${support.pageNumber}` : "Evidence identity"}</strong> — <span className="quote-inline">“{support.sourceTextPreview || support.id}”</span>
              {support.sourceTextTruncated && <small><Link href={support.href} target="_blank" rel="noopener noreferrer">Preview truncated · open exact Evidence detail →</Link></small>}
              {support.notePreview && <small>Researcher note preview: {support.notePreview}{support.noteTruncated ? " … (preview truncated)" : ""}</small>}
              {support.curationWarning && <small className="support-warning">{reviewLabel(support.reviewState)}.</small>}
              {rejected && <small className="support-warning">This current support stays selected until you remove it explicitly. It cannot be carried into a new revision.</small>}
              <small><Link href={support.href} target="_blank" rel="noopener noreferrer">Open exact Evidence detail →</Link></small>
            </span>
          </label>;
        })}</div>}
        <button className="button ghost" type="button" onClick={updateBrowseForField} disabled={!included} aria-expanded={browse.open && browse.fieldId === field.id}>
          {browse.open && browse.fieldId === field.id ? "Browse Evidence for this Field" : `Browse Evidence to add to ${field.name}`}
        </button>
        <noscript><p className="hint">Browsing and adding additional Evidence requires JavaScript. Current supports can still be removed above and submitted as a complete revision.</p></noscript>
      </fieldset>
      {feedback && <div className="error-banner" role="alert">{feedback}</div>}
      {actionState.response === "failed" && actionState.fieldId === field.id && <p className="hint" role="status">Your attempted value, note, and complete submitted Evidence set were kept. Review any refreshed Evidence warnings and make explicit changes before resubmitting.</p>}
      <button className="button" type="submit" disabled={!included || pending}>{pending ? "Saving revision…" : "Save new revision"}</button>
    </form>
    <div className="current-observation"><div className="item-meta">Current structured observation</div><p>{current ? displayValue(current) : "Not yet extracted"}</p>{current?.researcherNote && <p className="item-meta">Researcher note: {current.researcherNote}</p>}{value.hasHistory && value.historyHref && <p><Link href={value.historyHref}>Open Field revision history →</Link></p>}</div>
    {activeDraftField && <span className="sr-only" role="status">The active Field draft is ready for recovery.</span>}
  </article>;
}
