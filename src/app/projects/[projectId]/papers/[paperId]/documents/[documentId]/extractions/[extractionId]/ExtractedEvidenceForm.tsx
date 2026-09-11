"use client";

import { useState } from "react";
import { codePointLength, utf16SelectionToCodePointOffsets } from "@/domain/unicode-offsets";

type Action = (formData: FormData) => void | Promise<void>;

export function ExtractedEvidenceForm({
  action,
  projectId,
  paperId,
  documentId,
  extractionId,
  pageNumber,
  text,
}: {
  action: Action;
  projectId: string;
  paperId: string;
  documentId: string;
  extractionId: string;
  pageNumber: number;
  text: string;
}) {
  const [range, setRange] = useState({ start: 0, end: 0 });
  const length = codePointLength(text);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  function updateSelection(event: React.SyntheticEvent<HTMLTextAreaElement>) {
    const target = event.currentTarget;
    try {
      setRange(utf16SelectionToCodePointOffsets(text, target.selectionStart, target.selectionEnd));
      setSelectionError(null);
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "Selection could not be converted to code-point offsets");
    }
  }

  return <form action={action} style={{ marginTop: 16 }}>
    <input type="hidden" name="projectId" value={projectId} />
    <input type="hidden" name="paperId" value={paperId} />
    <input type="hidden" name="documentId" value={documentId} />
    <input type="hidden" name="extractionId" value={extractionId} />
    <input type="hidden" name="pageNumber" value={pageNumber} />
    <div className="section-heading"><h3>Create Evidence from exact page span</h3><span className="count">Offsets are code points</span></div>
    <p className="hint">Select a contiguous span in the read-only text below. The selection is converted from browser UTF-16 indexes to zero-based half-open Unicode code-point offsets. The server derives the stored source text from the page.</p>
    <div className="field"><label htmlFor={`selection-${pageNumber}`}>Page text</label><textarea id={`selection-${pageNumber}`} value={text} readOnly onSelect={updateSelection} onMouseUp={updateSelection} onKeyUp={updateSelection} style={{ minHeight: 180, fontFamily: "monospace" }} /></div>
    {selectionError && <div className="error-banner" role="alert">{selectionError}</div>}
    <div className="field"><label htmlFor={`start-${pageNumber}`}>Start offset</label><input id={`start-${pageNumber}`} name="startOffset" type="number" min="0" max={length} value={range.start} onChange={(event) => setRange((current) => ({ ...current, start: Number(event.target.value) }))} required /></div>
    <div className="field"><label htmlFor={`end-${pageNumber}`}>End offset (exclusive)</label><input id={`end-${pageNumber}`} name="endOffset" type="number" min="1" max={length} value={range.end} onChange={(event) => setRange((current) => ({ ...current, end: Number(event.target.value) }))} required /></div>
    <div className="field"><label htmlFor={`note-${pageNumber}`}>Researcher note <span className="hint">optional</span></label><textarea id={`note-${pageNumber}`} name="note" /></div>
    <button className="button" type="submit">Record exact Evidence</button>
  </form>;
}

