"use client";

import { useMemo, useState } from "react";
import { createSynthesisStatementAction } from "@/app/actions";
import { getSynthesisComparisonPageAction } from "@/app/actions/synthesis-comparison";
import type { SynthesisComparisonPage } from "@/application/synthesis-read-services";

type ExtractionRevisionId = string;
type SelectedSupportLabel = { paperTitle: string; fieldName: string; sequence: number; displayValue: string };

function displayValue(row: SynthesisComparisonPage["items"][number]) {
  if (row.displayValue !== null && row.displayValue !== "") return row.displayValue;
  return row.valueState === "not_extracted" ? "Not extracted" : row.valueState.replaceAll("_", " ");
}

export function SynthesisComparisonPicker({
  projectId,
  initialPage,
}: {
  projectId: string;
  initialPage: SynthesisComparisonPage;
}) {
  const [result, setResult] = useState(initialPage);
  const [selectedIds, setSelectedIds] = useState<Set<ExtractionRevisionId>>(() => new Set());
  const [selectedLabels, setSelectedLabels] = useState<Map<ExtractionRevisionId, SelectedSupportLabel>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const selectedCount = useMemo(() => selectedIds.size, [selectedIds]);

  async function loadPage(page: number) {
    setLoading(true);
    setError("");
    setAnnouncement(`Loading observation page ${page}. ${selectedIds.size} supports remain selected.`);
    try {
      const response = await getSynthesisComparisonPageAction({ projectId, fieldId: result.field.id, page });
      if (!response.ok) throw new Error(response.error);
      setResult(response.page as SynthesisComparisonPage);
      const pagination = response.page.pagination;
      setAnnouncement(pagination.totalCount === 0
        ? `No finally included Papers have observations for ${result.field.name}. ${selectedIds.size} supports remain selected.`
        : `Showing Papers ${pagination.from} to ${pagination.to} of ${pagination.totalCount}. Page ${pagination.page} of ${pagination.totalPages}. ${selectedIds.size} supports remain selected.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Synthesis observations could not be loaded.";
      setError(message);
      setAnnouncement("Synthesis observations could not be loaded. Existing selections are unchanged.");
    } finally {
      setLoading(false);
    }
  }

  function add(row: SynthesisComparisonPage["items"][number]) {
    const revision = row.extractionRevision;
    if (!revision || !row.isSelectable) return;
    const id = revision.id;
    const label = {
      paperTitle: row.paper.title,
      fieldName: row.field.name,
      sequence: revision.sequence,
      displayValue: displayValue(row),
    };
    setSelectedIds((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      return next;
    });
    setSelectedLabels((previous) => {
      if (previous.has(id)) return previous;
      const next = new Map(previous);
      next.set(id, label);
      return next;
    });
    setAnnouncement(`Added exact ExtractionRevision ${revision.sequence} from ${row.paper.title}.`);
  }

  function remove(id: ExtractionRevisionId) {
    const label = selectedLabels.get(id);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    setSelectedLabels((previous) => {
      const next = new Map(previous);
      next.delete(id);
      return next;
    });
    setAnnouncement(`Removed ${label?.paperTitle ?? "selected observation"} from Synthesis supports.`);
  }

  const { page, pageSize, totalCount, totalPages, from, to } = result.pagination;

  return <form action={createSynthesisStatementAction} aria-label="Create Synthesis">
    <input type="hidden" name="projectId" value={projectId} />
    <div className="item-meta" style={{ margin: "16px 0" }}>
      {result.field.name} · {Object.entries(result.summary.counts).map(([state, count]) => `${count} ${state.replaceAll("_", " ")}`).join(" · ")}
    </div>

    <section className="synthesis-selected-supports" aria-label="Selected Synthesis supports">
      <div className="section-heading"><h3>Selected supports</h3><span className="count">{selectedCount}</span></div>
      {selectedIds.size === 0 ? <p className="hint">No observations selected. Adding an observation keeps its exact ExtractionRevision ID.</p> : <ul className="item-list">
        {[...selectedIds].map((id) => {
          const label = selectedLabels.get(id);
          return <li className="item item-row" key={id}>
            <span><strong>{label?.paperTitle ?? "Selected observation"}</strong> · {label?.fieldName ?? result.field.name} · Revision {label?.sequence ?? "—"} · {label?.displayValue ?? ""}</span>
            <button className="button ghost" type="button" onClick={() => remove(id)} aria-label={`Remove ${label?.paperTitle ?? "selected observation"} revision ${label?.sequence ?? ""}`}>Remove</button>
          </li>;
        })}
      </ul>}
    </section>

    {error && <p className="error-banner" role="alert">{error}</p>}
    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    <fieldset className="synthesis-matrix-results" aria-busy={loading}>
      <legend>Observation results for {result.field.name}</legend>
      {result.items.length === 0 ? <p className="hint">No finally included Papers have observations for this Field.</p> : <div className="matrix-list">
        {result.items.map((row) => {
          const revision = row.extractionRevision;
          const selected = revision !== null && selectedIds.has(revision.id);
          return <label className={`item matrix-row ${revision && !row.isSelectable ? "muted" : ""}`} key={row.paper.id}>
            <div className="item-row" style={{ alignItems: "flex-start" }}>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={!row.isSelectable || loading}
                  aria-label={`Select observation from ${row.paper.title}`}
                  onChange={(event) => {
                    if (!revision) return;
                    if (event.currentTarget.checked) add(row);
                    else remove(revision.id);
                  }}
                />
                <div>
                  <div className="item-title">{row.paper.title}</div>
                  <div className="item-meta">{displayValue(row)} · {row.valueState.replaceAll("_", " ")} · {row.supportStatus === "grounded" ? "Grounded" : "Ungrounded"}</div>
                  {revision && <div className="item-meta">{row.evidenceCount} {row.evidenceCount === 1 ? "Evidence passage" : "Evidence passages"} · Extraction revision {revision.sequence}</div>}
                </div>
              </div>
              <span className={`status ${row.supportStatus === "grounded" ? "supported" : "unsupported"}`}>{row.valueState.replaceAll("_", " ")}</span>
            </div>
          </label>;
        })}
      </div>}
    </fieldset>

    <nav className="pagination synthesis-matrix-pagination" aria-label="Evidence matrix pages">
      <button className="button ghost" type="button" disabled={loading || page <= 1} onClick={() => void loadPage(page - 1)}>Previous</button>
      <span aria-hidden="true">{from}–{to} of {totalCount} · Page {page} of {totalPages || 1} · {pageSize} per page</span>
      <span className="visually-hidden">{totalCount === 0 ? "No matching Papers" : `Papers ${from} through ${to} of ${totalCount}`}. Page {page} of {totalPages || 1}.</span>
      <button className="button ghost" type="button" disabled={loading || page >= totalPages} onClick={() => void loadPage(page + 1)}>Next</button>
    </nav>

    {[...selectedIds].map((id) => <input type="hidden" name="extractionRevisionIds" value={id} key={`selected:${id}`} />)}

    <div className="form-grid" style={{ marginTop: 18 }}>
      <div className="field"><label htmlFor="synthesis-title">Topic or title <span className="hint">optional</span></label><input id="synthesis-title" name="title" placeholder="e.g. Common attack techniques" /></div>
      <div className="field"><label htmlFor="synthesis-text">Synthesis statement</label><textarea id="synthesis-text" name="statementText" required placeholder="Write a cross-paper analytical conclusion from the selected observations" /></div>
      <div className="field"><label htmlFor="synthesis-note">Researcher note <span className="hint">optional</span></label><textarea id="synthesis-note" name="researcherNote" placeholder="Context for your interpretation" /></div>
    </div>
    <button className="button" type="submit">Create synthesis from selected observations</button>
  </form>;
}
