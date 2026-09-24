"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { linkEvidenceAction, unlinkEvidenceAction } from "@/app/actions";
import { searchClaimSupportOptionsAction } from "@/app/actions/claim-support-search";
import type { ClaimSupportSearchKind } from "@/application/claim-support-read-services";

type Kind = ClaimSupportSearchKind;
type PickerPage = {
  items: unknown[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
};
type SearchState = { query: string; result: PickerPage };
type Selection = { id: string; label: string };
type SelectionGroups = Record<Kind, Selection[]>;
type HistoricalSupport = { kind: string; id: string; label: string; reason: string };
type SearchItem = Record<string, unknown> & { id: string };

const kinds: Kind[] = ["evidence", "extractionRevision", "synthesisRevision"];
const kindLabels: Record<Kind, string> = {
  evidence: "Evidence",
  extractionRevision: "Extraction revisions",
  synthesisRevision: "Synthesis revisions",
};
const hiddenNames: Record<Kind, string> = {
  evidence: "evidenceIds",
  extractionRevision: "extractionRevisionIds",
  synthesisRevision: "synthesisRevisionIds",
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function optionLabel(kind: Kind, item: SearchItem) {
  if (kind === "evidence") {
    const paper = object(item.paper);
    const title = `${text(paper.title, "Source paper")} · page ${Number(item.pageNumber) || 0}`;
    const createdAt = text(item.createdAt);
    const detail = [text(item.sourceText).slice(0, 160), createdAt ? `Recorded ${createdAt.slice(0, 10)}` : ""]
      .filter(Boolean).join(" · ");
    const review = text(item.reviewState);
    return { title, detail: review && review !== "accepted" ? `${detail} · ${review === "needs_review" ? "Needs review" : "Never reviewed"}` : detail };
  }
  if (kind === "extractionRevision") {
    const paper = object(item.paper);
    const field = object(item.field);
    const current = item.isCurrentExtractionRevision === true;
    const title = `${text(field.name, "Observation")} · ${text(paper.title, "Source paper")}`;
    const detail = `Revision ${Number(item.sequence) || "—"} · ${current ? "Current revision" : "Superseded revision"} · ${Number(item.evidenceCount) || 0} Evidence paths`;
    return { title, detail };
  }
  const title = text(item.title) || text(item.statementText).slice(0, 120) || "Synthesis conclusion";
  const detail = `Revision ${Number(item.sequence) || "—"} · ${Number(item.observationCount) || 0} observations · ${Number(item.evidencePathCount) || 0} Evidence paths`;
  return { title, detail };
}

function itemRecord(value: unknown): SearchItem | null {
  const row = object(value);
  return typeof row.id === "string" ? row as SearchItem : null;
}

function selectedLabel(item: Selection) {
  return item.label || `${item.id.slice(0, 8)}…`;
}

export function ClaimSupportPicker({
  projectId,
  initialSelected,
  historicalIneligible,
  initialSynthesisRevisionId,
}: {
  projectId: string;
  initialSelected: SelectionGroups;
  historicalIneligible: HistoricalSupport[];
  initialSynthesisRevisionId?: string;
}) {
  const [activeKind, setActiveKind] = useState<Kind>("evidence");
  const [searches, setSearches] = useState<Partial<Record<Kind, SearchState>>>({});
  const [draftQueries, setDraftQueries] = useState<Record<Kind, string>>({ evidence: "", extractionRevision: "", synthesisRevision: "" });
  const [selected, setSelected] = useState<SelectionGroups>(initialSelected);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("Loading Claim support options.");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusKind = useRef<Kind | null>(null);
  const selectedCount = useMemo(() => kinds.reduce((sum, kind) => sum + selected[kind].length, 0), [selected]);

  async function load(kind: Kind, query: string, page: number, focus = false) {
    setError("");
    setAnnouncement(`Loading ${kindLabels[kind].toLowerCase()} page ${page}.`);
    if (focus) focusKind.current = kind;
    try {
      const response = await searchClaimSupportOptionsAction({ projectId, kind, query, page, pageSize: 20 });
      if (!response.ok) throw new Error(response.error);
      setSearches((previous) => ({ ...previous, [kind]: { query, result: response.page as PickerPage } }));
      const { result } = { result: response.page as PickerPage };
      const from = result.totalCount === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
      const through = Math.min(result.page * result.pageSize, result.totalCount);
      setAnnouncement(`${kindLabels[kind]}: showing ${from} to ${through} of ${result.totalCount}. ${selectedCount} support${selectedCount === 1 ? "" : "s"} selected.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Claim support options could not be loaded.";
      setError(message);
      setAnnouncement(`${kindLabels[kind]} could not be loaded.`);
      focusKind.current = null;
    }
  }

  useEffect(() => {
    let active = true;
    void Promise.all(kinds.map(async (kind) => {
      const response = await searchClaimSupportOptionsAction({ projectId, kind, page: 1, pageSize: 20 });
      if (!response.ok) throw new Error(response.error);
      return [kind, { query: "", result: response.page as PickerPage }] as const;
    })).then((entries) => {
      if (!active) return;
      const loaded = Object.fromEntries(entries) as Record<Kind, SearchState>;
      setSearches(loaded);
      const total = kinds.reduce((sum, kind) => sum + loaded[kind].result.totalCount, 0);
      setAnnouncement(`Claim support options loaded. ${total} available across all support types.`);
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Claim support options could not be loaded.");
      setAnnouncement("Claim support options could not be loaded.");
    });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (focusKind.current === activeKind && searches[activeKind]) {
      headingRef.current?.focus();
      focusKind.current = null;
    }
  }, [activeKind, searches]);

  function toggle(kind: Kind, id: string, label: string, checked: boolean, summaryLabel = label) {
    setSelected((previous) => {
      const next = { ...previous, [kind]: [...previous[kind]] };
      if (checked) {
        if (!next[kind].some((item) => item.id === id)) next[kind].push({ id, label: summaryLabel });
      } else {
        next[kind] = next[kind].filter((item) => item.id !== id);
      }
      return next;
    });
    setAnnouncement(`${checked ? "Added" : "Removed"} ${label} from ${kindLabels[kind]}.`);
  }

  const search = searches[activeKind];
  const rows = search?.result.items.map(itemRecord).filter((item): item is SearchItem => item !== null) ?? [];

  return <div className="support-picker" aria-label="Claim support selection">
    <div className="support-picker-toolbar">
      <div className="support-kind-tabs" role="group" aria-label="Support type">
        {kinds.map((kind) => <button
          className={`button ghost ${activeKind === kind ? "active" : ""}`}
          type="button"
          aria-pressed={activeKind === kind}
          key={kind}
          onClick={() => setActiveKind(kind)}
        >{kindLabels[kind]} <span className="count">{selected[kind].length} selected</span></button>)}
      </div>
      <details className="claim-support-selected">
        <summary>Selected supports: {selectedCount}</summary>
        {selectedCount === 0 ? <p className="hint">No supports selected.</p> : <div className="claim-support-selected-list">
          {kinds.map((kind) => selected[kind].map((item) => <div className="claim-support-selected-item" key={`${kind}:${item.id}`}>
            <span><strong>{kindLabels[kind]}:</strong> {selectedLabel(item)}</span>
            <button className="button ghost" type="button" onClick={() => toggle(kind, item.id, selectedLabel(item), false)} aria-label={`Remove ${selectedLabel(item)} from ${kindLabels[kind]}`}>Remove</button>
          </div>))}
        </div>}
      </details>
    </div>

    {initialSynthesisRevisionId && selected.synthesisRevision.some((item) => item.id === initialSynthesisRevisionId) && <p className="support-selection-note" role="status">Exact Synthesis Revision {initialSynthesisRevisionId.slice(0, 8)} is selected from the requested context.</p>}

    {historicalIneligible.length > 0 && <details className="historical-support-context">
      <summary>Historical supports kept in the snapshot and not carried forward: {historicalIneligible.length}</summary>
      <ul>{historicalIneligible.map((item) => <li key={`${item.kind}:${item.id}`}><strong>{item.kind}:</strong> {item.label} — {item.reason}</li>)}</ul>
    </details>}

    <div className="claim-support-search">
      <label htmlFor="claim-support-query">Search {kindLabels[activeKind].toLowerCase()}</label>
      <div className="claim-support-search-row">
        <input
          id="claim-support-query"
          type="search"
          maxLength={400}
          value={draftQueries[activeKind]}
          onChange={(event) => {
            const query = event.currentTarget.value;
            setDraftQueries((previous) => ({ ...previous, [activeKind]: query }));
          }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void load(activeKind, draftQueries[activeKind], 1, true); } }}
        />
        <button className="button secondary" type="button" onClick={() => void load(activeKind, draftQueries[activeKind], 1, true)}>Search</button>
      </div>
    </div>

    {error && <p className="error-banner" role="alert">{error}</p>}
    <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
    <fieldset id="claim-support-results">
      <legend><span ref={headingRef} tabIndex={-1}>{kindLabels[activeKind]}</span> <span className="hint">optional</span></legend>
      {!search ? <p className="hint">Loading options…</p> : rows.length === 0 ? <p className="hint">{activeKind === "evidence" && search.query === "" && search.result.totalCount === 0 ? "No Evidence records are available." : `No eligible ${kindLabels[activeKind].toLowerCase()} match this search.`}</p> : rows.map((item) => {
        const label = optionLabel(activeKind, item);
        const isSelected = selected[activeKind].some((selection) => selection.id === item.id);
        return <div className="claim-support-result-row" key={item.id}>
          <span>{label.title}<small>{label.detail}</small></span>
          <button
            className={`button ${isSelected ? "ghost" : "secondary"}`}
            type="button"
            aria-pressed={isSelected}
            aria-label={`${isSelected ? "Remove" : "Add"} ${label.title} ${isSelected ? "from" : "to"} ${kindLabels[activeKind]}`}
            onClick={() => toggle(activeKind, item.id, label.title, !isSelected, [label.title, label.detail].filter(Boolean).join(" — "))}
          >{isSelected ? "Remove" : "Add"}</button>
        </div>;
      })}
    </fieldset>

    {search && <nav className="pagination claim-support-pagination" aria-label={`${kindLabels[activeKind]} pages`}>
      <button className="button ghost" type="button" disabled={!search.result.hasPrevious} onClick={() => void load(activeKind, search.query, search.result.page - 1, true)}>Previous</button>
      <span>Page {search.result.page} of {search.result.totalPages || 1} · {search.result.totalCount} matches</span>
      <button className="button ghost" type="button" disabled={!search.result.hasNext} onClick={() => void load(activeKind, search.query, search.result.page + 1, true)}>Next</button>
    </nav>}

    {kinds.map((kind) => selected[kind].map((item) => <input type="hidden" name={hiddenNames[kind]} value={item.id} key={`hidden:${kind}:${item.id}`} />))}
  </div>;
}

export function DirectEvidenceSelector({ projectId, claimId, existingEvidenceIds }: { projectId: string; claimId: string; existingEvidenceIds: string[] }) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<PickerPage | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("Loading direct Evidence options.");
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const shouldFocusHeading = useRef(false);

  async function load(nextQuery: string, page: number, focus = false) {
    setError("");
    setAnnouncement(`Loading direct Evidence page ${page}.`);
    setSelectedId("");
    if (focus) shouldFocusHeading.current = true;
    try {
      const response = await searchClaimSupportOptionsAction({ projectId, kind: "evidence", query: nextQuery, page, pageSize: 20 });
      if (!response.ok) throw new Error(response.error);
      const pageResult = response.page as PickerPage;
      setQuery(nextQuery);
      setResult(pageResult);
      setAnnouncement(`Evidence: ${pageResult.totalCount} matches. Showing page ${pageResult.page} of ${pageResult.totalPages || 1}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Evidence options could not be loaded.");
      setAnnouncement("Direct Evidence options could not be loaded.");
      shouldFocusHeading.current = false;
    }
  }

  useEffect(() => {
    let active = true;
    void searchClaimSupportOptionsAction({ projectId, kind: "evidence", query: "", page: 1, pageSize: 20 }).then((response) => {
      if (!active) return;
      if (!response.ok) throw new Error(response.error);
      const pageResult = response.page as PickerPage;
      setQuery("");
      setResult(pageResult);
      setAnnouncement(`Evidence: ${pageResult.totalCount} matches. Showing page ${pageResult.page} of ${pageResult.totalPages || 1}.`);
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Evidence options could not be loaded.");
      setAnnouncement("Direct Evidence options could not be loaded.");
    });
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    if (shouldFocusHeading.current && result) {
      resultHeading.current?.focus();
      shouldFocusHeading.current = false;
    }
  }, [result]);

  const evidenceRows = result?.items.map(itemRecord).filter((item): item is SearchItem => item !== null) ?? [];

  return <section className="card section-card full">
    <div className="section-heading"><h2 ref={resultHeading} tabIndex={-1}>Direct Evidence link</h2><span className="count">Compatibility shortcut</span></div>
    <form action={linkEvidenceAction}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="claimId" value={claimId} />
      <div className="claim-support-search">
        <label htmlFor="direct-evidence-query">Search Evidence for direct link</label>
        <div className="claim-support-search-row">
          <input id="direct-evidence-query" type="search" maxLength={400} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void load(draft, 1, true); } }} />
          <button className="button secondary" type="button" onClick={() => void load(draft, 1, true)}>Search</button>
        </div>
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
      <div className="field">
        <label htmlFor="link-evidence">Evidence passage · {result?.totalCount ?? 0} eligible matches</label>
        <select id="link-evidence" name="evidenceId" required value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}>
          <option value="" disabled>Select Evidence from this page</option>
          {evidenceRows.map((item) => {
            const label = optionLabel("evidence", item);
            return <option key={item.id} value={item.id}>{label.title} · {text(item.sourceText).slice(0, 100)}</option>;
          })}
        </select>
      </div>
      {result && <nav className="pagination claim-support-pagination" aria-label="Direct Evidence pages">
        <button className="button ghost" type="button" disabled={!result.hasPrevious} onClick={() => void load(query, result.page - 1, true)}>Previous</button>
        <span>Page {result.page} of {result.totalPages || 1} · {result.totalCount} matches</span>
        <button className="button ghost" type="button" disabled={!result.hasNext} onClick={() => void load(query, result.page + 1, true)}>Next</button>
      </nav>}
      <button className="button secondary" type="submit">Link evidence</button>
    </form>
    {existingEvidenceIds.map((evidenceId) => <form key={evidenceId} action={unlinkEvidenceAction} style={{ marginTop: 10 }}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="claimId" value={claimId} />
      <input type="hidden" name="evidenceId" value={evidenceId} />
      <button className="button ghost" type="submit">Unlink</button>
    </form>)}
  </section>;
}
