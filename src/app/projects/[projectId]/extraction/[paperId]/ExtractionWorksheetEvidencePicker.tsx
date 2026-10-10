"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ExtractionEvidenceCandidatePage } from "@/application/extraction-evidence-selection-read-services";
import { normalizeExtractionEvidenceSearchQuery } from "@/application/extraction-evidence-search-query";
import { useExtractionWorksheet } from "./ExtractionWorksheetContext";

type PickerField = { id: string; name: string };
type BrowseRequest = { open: boolean; fieldId: string | null; after: string | null; pageSize: number; query: string; queryError: string | null };
type PageActionResult =
  | { status: "success"; page: ExtractionEvidenceCandidatePage }
  | { status: "error"; safeErrorMessage: string; invalidBrowseState: boolean; validationInput: "query" | "pagination" | "request" | null };

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
  const [errorKind, setErrorKind] = useState<"query" | "pagination" | "load" | null>(null);
  const [queryText, setQueryText] = useState(browse.query);
  const [retryCount, setRetryCount] = useState(0);
  const generation = useRef(0);
  const activeField = fields.find((field) => field.id === browse.fieldId) ?? null;
  const activeSelection = browse.fieldId ? selectedByFieldId[browse.fieldId] ?? [] : [];
  const selectedIds = new Set(activeSelection.map((item) => item.id.toLowerCase()));

  useLayoutEffect(() => {
    generation.current += 1;
  }, [browse.open, browse.fieldId, browse.after, browse.pageSize, browse.query, browse.queryError, retryCount]);

  useEffect(() => {
    setQueryText(browse.query);
    if (browse.queryError) {
      setPage(null);
      setStatus("error");
      setErrorMessage(browse.queryError);
      setErrorKind("query");
    }
  }, [browse.query, browse.queryError]);

  const load = useCallback(async (requestGeneration: number, request: BrowseRequest) => {
    try {
      const query = new URLSearchParams({ pageSize: String(request.pageSize) });
      if (request.after) query.set("after", request.after);
      if (request.query) query.set("query", request.query);
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(paperId)}/extraction-evidence?${query}`,
        { cache: "no-store" },
      );
      const result = await response.json() as PageActionResult;
      if (generation.current !== requestGeneration) return;
      if (result.status === "success") {
        setPage(result.page);
        setStatus("ready");
        setErrorMessage(null);
        setErrorKind(null);
        return;
      }
      if (result.validationInput === "query") {
        setPage(null);
        setStatus("error");
        setErrorMessage(result.safeErrorMessage);
        setErrorKind("query");
        return;
      }
      if (result.invalidBrowseState) {
        if (request.after === null && request.pageSize === 20) {
          setPage(null);
          setStatus("error");
          setErrorMessage("The first Evidence page could not be loaded because its browse state is invalid. Retry after reviewing the search query.");
          setErrorKind("pagination");
          return;
        }
        setPage(null);
        setBrowse({ ...request, after: null, pageSize: 20, queryError: null }, "replace");
        return;
      }
      setPage(null);
      setStatus("error");
      setErrorMessage(result.safeErrorMessage);
      setErrorKind("load");
    } catch {
      if (generation.current !== requestGeneration) return;
      setPage(null);
      setStatus("error");
      setErrorMessage("Evidence could not be loaded.");
      setErrorKind("load");
    }
  }, [paperId, projectId, setBrowse]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    if (!browse.open || !browse.fieldId) {
      setPage(null);
      setStatus("idle");
      setErrorMessage(null);
      setErrorKind(null);
      return;
    }
    if (browse.queryError) {
      setPage(null);
      setStatus("error");
      setErrorMessage(browse.queryError);
      setErrorKind("query");
      return;
    }
    const request: BrowseRequest = {
      open: browse.open,
      fieldId: browse.fieldId,
      after: browse.after,
      pageSize: browse.pageSize,
      query: browse.query,
      queryError: browse.queryError,
    };
    setPage(null);
    setStatus("loading");
    setErrorMessage(null);
    setErrorKind(null);
    void load(requestGeneration, request);
  }, [browse.open, browse.fieldId, browse.after, browse.pageSize, browse.query, browse.queryError, retryCount, load]);

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let query: string;
    try {
      query = normalizeExtractionEvidenceSearchQuery(queryText);
    } catch (error) {
      generation.current += 1;
      setPage(null);
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Evidence search query is invalid.");
      setErrorKind("query");
      return;
    }
    setQueryText(query);
    setBrowse({ ...browse, open: true, after: null, query, queryError: null });
  };

  const clearSearch = () => {
    setQueryText("");
    setErrorMessage(null);
    setErrorKind(null);
    setBrowse({ ...browse, open: true, after: null, query: "", queryError: null });
  };

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
        <form className="item-row evidence-search-form" onSubmit={submitSearch}>
          <div className="field"><label htmlFor="evidence-browser-query">Search Evidence passages and notes</label><input id="evidence-browser-query" type="search" value={queryText} onChange={(event) => {
            setQueryText(event.currentTarget.value);
            if (errorKind === "query") {
              setErrorMessage(null);
              setErrorKind(null);
            }
          }} /></div>
          <div style={{ display: "flex", gap: 8, alignItems: "end" }}><button className="button secondary" type="submit">Search</button>{(browse.query || queryText || browse.queryError) && <button className="button ghost" type="button" onClick={clearSearch}>Clear search</button>}</div>
        </form>
        <p className="hint">Search checks complete passage and note text. A match may be outside the visible preview; open exact Evidence detail to inspect the full source record.</p>
        <div className="item-row" aria-live="polite">
          <span>{activeField ? `Browsing Evidence for ${activeField.name}` : "Browsing Paper Evidence"}</span>
          {status === "loading" && <span role="status">Loading candidates…</span>}
          {status === "ready" && page && <span role="status">Showing {page.items.length} candidates{page.hasNext ? " · more available" : " · last page"}</span>}
        </div>
        {status === "error" && errorMessage && <div className="error-banner" role="alert">{errorMessage} Selected supports were kept unchanged.{errorKind !== "query" && <button className="button ghost" type="button" onClick={() => setRetryCount((current) => current + 1)}>Retry</button>}</div>}
        {status === "ready" && page && (page.items.length === 0
          ? <div className="empty">{browse.after ? "End of Evidence results." : browse.query ? <>No Evidence matches this search. <button className="button ghost" type="button" onClick={clearSearch}>Clear search</button></> : "No Evidence has been recorded for this Paper."}</div>
          : <div className="item-list candidate-evidence-list">{page.items.map((candidate) => {
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
