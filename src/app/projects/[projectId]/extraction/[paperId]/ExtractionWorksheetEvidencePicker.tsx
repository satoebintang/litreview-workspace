"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ExtractionEvidenceCandidatePage } from "@/application/extraction-evidence-selection-read-services";
import { useExtractionWorksheet } from "./ExtractionWorksheetContext";

type PickerField = { id: string; name: string };

export function ExtractionWorksheetEvidencePicker({
  projectId,
  paperId,
  fields,
}: {
  projectId: string;
  paperId: string;
  fields: PickerField[];
}) {
  const { browse, setBrowse, selectedByFieldId, addFieldSupport } = useExtractionWorksheet();
  const [page, setPage] = useState<ExtractionEvidenceCandidatePage | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const activeField = fields.find((field) => field.id === browse.fieldId) ?? null;
  const activeSelection = browse.fieldId ? selectedByFieldId[browse.fieldId] ?? [] : [];
  const selectedIds = new Set(activeSelection.map((item) => item.id.toLowerCase()));

  const load = useCallback(async (requestGeneration: number, after: string | null, pageSize: number) => {
    try {
      const query = new URLSearchParams({ pageSize: String(pageSize) });
      if (after) query.set("after", after);
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paperId)}/extraction-evidence?${query}`,
        { cache: "no-store" },
      );
      const result = await response.json() as
        | { status: "success"; page: ExtractionEvidenceCandidatePage }
        | { status: "error"; safeErrorMessage: string; invalidBrowseState: boolean };
      if (generation.current !== requestGeneration) return;
      if (result.status === "success") {
        setPage(result.page);
        setStatus("ready");
        setErrorMessage(null);
        return;
      }
      if (result.invalidBrowseState) {
        setBrowse({ ...browse, after: null, pageSize: 20 }, "replace");
        setPage(null);
        setStatus("loading");
        setErrorMessage(null);
        return;
      }
      setPage(null);
      setStatus("error");
      setErrorMessage(result.safeErrorMessage);
    } catch {
      if (generation.current !== requestGeneration) return;
      setPage(null);
      setStatus("error");
      setErrorMessage("Evidence could not be loaded. Your selected supports were kept unchanged.");
    }
  }, [browse, paperId, projectId, setBrowse]);

  useEffect(() => {
    if (!browse.open || !browse.fieldId) {
      generation.current += 1;
      setPage(null);
      setStatus("idle");
      setErrorMessage(null);
      return;
    }
    const requestGeneration = ++generation.current;
    setPage(null);
    setStatus("loading");
    setErrorMessage(null);
    void load(requestGeneration, browse.after, browse.pageSize);
  }, [browse.open, browse.fieldId, browse.after, browse.pageSize, load]);

  const requestNextPage = () => {
    if (!browse.fieldId || !page?.nextCursor) return;
    setBrowse({ ...browse, after: page.nextCursor });
  };

  const requestFirstPage = () => {
    if (!browse.fieldId || !browse.after) return;
    setBrowse({ ...browse, after: null });
  };

  const selectField = (fieldId: string) => {
    setBrowse({ ...browse, open: true, fieldId, after: null });
  };

  return <section className="card section-card extraction-evidence-browser" aria-label="Shared Evidence browser">
    <div className="section-heading"><div><h2>Evidence browser</h2><p className="hint">One bounded page is shared by all Fields. Adding a candidate changes only the selected Field’s draft.</p></div></div>
    {fields.length === 0 ? <div className="empty">Add an active extraction Field before selecting Evidence.</div> : <>
      <div className="field"><label htmlFor="evidence-browser-field">Field receiving added Evidence</label><select id="evidence-browser-field" value={browse.fieldId ?? ""} onChange={(event) => selectField(event.currentTarget.value)}><option value="" disabled>Select a Field</option>{fields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}</select></div>
      {!browse.open ? <p className="hint" role="status">Open the browser from a Field to load its first bounded Evidence page.</p> : <>
        <div className="item-row" aria-live="polite">
          <span>{activeField ? `Browsing Evidence for ${activeField.name}` : "Browsing Paper Evidence"}</span>
          {status === "loading" && <span role="status">Loading candidates…</span>}
          {status === "ready" && page && <span role="status">Showing {page.items.length} candidates{page.hasNext ? " · more available" : " · last page"}</span>}
        </div>
        {status === "error" && errorMessage && <div className="error-banner" role="alert">{errorMessage} Selected supports were kept unchanged.</div>}
        {status === "ready" && page && (page.items.length === 0 ? <div className="empty">No Evidence has been recorded for this Paper.</div> : <div className="item-list candidate-evidence-list">{page.items.map((candidate) => {
          const isSelected = selectedIds.has(candidate.id.toLowerCase());
          const rejected = candidate.reviewState === "rejected";
          const cannotAdd = rejected || isSelected || !activeField;
          return <article className="item candidate-evidence" key={candidate.id}>
            <div className="item-row"><div><strong>Page {candidate.pageNumber}</strong> · <span className={`status ${rejected ? "stale" : candidate.curationWarning ? "warning" : "supported"}`}>{candidate.reviewState === "unreviewed" ? "Unreviewed" : candidate.reviewState === "needs_review" ? "Needs review" : candidate.reviewState}</span></div>
              {isSelected ? <span className="item-meta">Already selected · remove it from the Field support list to deselect</span> : rejected ? <span className="support-warning">Rejected Evidence cannot be added as new direct support.</span> : <button className="button secondary" type="button" disabled={cannotAdd} onClick={() => browse.fieldId && addFieldSupport(browse.fieldId, candidate)}>Add to this Field</button>}
            </div>
            <p className="quote">“{candidate.sourceTextPreview}”{candidate.sourceTextTruncated && <span className="item-meta"> Preview truncated.</span>}</p>
            {candidate.notePreview && <p className="item-meta">Researcher note: {candidate.notePreview}{candidate.noteTruncated ? " … (preview truncated)" : ""}</p>}
            {candidate.curationWarning && <p className="support-warning">{rejected ? "Rejected items remain visible for inspection but cannot be newly selected." : candidate.reviewState === "needs_review" ? "Needs review; direct use remains allowed with a warning." : candidate.reviewState === "unreviewed" ? "Never reviewed; direct use remains allowed with a warning." : ""}</p>}
            <p><Link href={candidate.href} target="_blank" rel="noopener noreferrer">Open exact Evidence detail →</Link></p>
          </article>;
        })}</div>)}
        <div className="item-row" style={{ marginTop: 16 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {browse.after && <button className="button ghost" type="button" onClick={requestFirstPage}>First page</button>}
            {page?.hasNext && <button className="button secondary" type="button" onClick={requestNextPage}>Next Evidence page</button>}
            <button className="button ghost" type="button" onClick={() => setBrowse({ ...browse, open: false, after: null })}>Close browser</button>
          </div>
          <div className="field"><label htmlFor="evidence-browser-page-size">Candidates per page</label><select id="evidence-browser-page-size" value={browse.pageSize} onChange={(event) => setBrowse({ ...browse, after: null, pageSize: Number(event.currentTarget.value) })}><option value={20}>20</option><option value={50}>50</option></select></div>
        </div>
      </>}
      <noscript><p className="hint">Browsing and adding Evidence candidates requires JavaScript. Current supports remain available in each Field form.</p></noscript>
    </>}
  </section>;
}
