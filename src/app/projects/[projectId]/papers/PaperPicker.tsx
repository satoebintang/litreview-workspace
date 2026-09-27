"use client";

import { useEffect, useRef, useState } from "react";
import { searchPaperOptionsAction } from "@/app/actions/paper-selection-search";
import { PAPER_OPTIONS_DEFAULT_PAGE_SIZE, type PaperOption, type PaperOptionPage } from "@/application/paper-selection-read-services";

function emptyPage(): PaperOptionPage {
  return {
    items: [],
    page: 1,
    pageSize: PAPER_OPTIONS_DEFAULT_PAGE_SIZE,
    totalCount: 0,
    totalPages: 0,
    from: 0,
    to: 0,
    hasPrevious: false,
    hasNext: false,
  };
}

function paperDetail(paper: PaperOption) {
  return [paper.authors.join(", "), paper.publicationYear, paper.doi ? `DOI ${paper.doi}` : null]
    .filter(Boolean)
    .join(" · ");
}

export function PaperPicker({
  projectId,
  pickerKey,
  fieldName,
  label,
  excludePaperId,
  initialPaperId,
  initialSelectedPaper,
  required = false,
  disableSubmitUntilSelection = false,
  className = "",
  onSelectionChange,
}: {
  projectId: string;
  pickerKey: string;
  fieldName: string;
  label: string;
  excludePaperId?: string;
  initialPaperId?: string;
  initialSelectedPaper: PaperOption | null;
  required?: boolean;
  disableSubmitUntilSelection?: boolean;
  className?: string;
  onSelectionChange?: (paper: PaperOption | null, paperId: string) => void;
}) {
  const [draftQuery, setDraftQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [page, setPage] = useState<PaperOptionPage>(emptyPage);
  const [loaded, setLoaded] = useState(false);
  const [selectedPaper, setSelectedPaper] = useState(initialSelectedPaper);
  const [selectedPaperId, setSelectedPaperId] = useState(initialPaperId ?? initialSelectedPaper?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState(`${label}. Browse or search to load Paper options.`);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const latestRequest = useRef(0);
  const inputId = `${pickerKey}-paper-search`;
  const hintId = `${pickerKey}-paper-search-hint`;
  const errorId = `${pickerKey}-paper-search-error`;
  const isExcluded = Boolean(excludePaperId && selectedPaperId.toLowerCase() === excludePaperId.toLowerCase());
  const validSelection = Boolean(selectedPaperId && selectedPaper?.id === selectedPaperId && !isExcluded);

  useEffect(() => {
    const paperId = initialPaperId ?? initialSelectedPaper?.id ?? "";
    setSelectedPaper(initialSelectedPaper);
    setSelectedPaperId(paperId);
  }, [initialPaperId, initialSelectedPaper]);

  useEffect(() => {
    const form = hiddenInputRef.current?.form;
    if (!form || !required) return;
    const handleSubmit = (event: SubmitEvent) => {
      if (validSelection) return;
      event.preventDefault();
      const message = isExcluded
        ? `Choose a different Paper for ${label.toLowerCase()} before submitting.`
        : `Select a Paper for ${label.toLowerCase()} before submitting.`;
      setError(message);
      setAnnouncement(message);
      searchInputRef.current?.focus();
    };
    form.addEventListener("submit", handleSubmit);
    return () => form.removeEventListener("submit", handleSubmit);
  }, [isExcluded, label, required, validSelection]);

  useEffect(() => {
    if (!disableSubmitUntilSelection) return;
    const form = hiddenInputRef.current?.form;
    if (!form) return;
    const submitControls = form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button[type='submit'], input[type='submit']");
    submitControls.forEach((control) => { control.disabled = !validSelection; });
  }, [disableSubmitUntilSelection, validSelection]);

  async function search(query: string, requestedPage: number) {
    const requestId = ++latestRequest.current;
    setPending(true);
    setError("");
    setAnnouncement(`Searching Papers, page ${requestedPage}.`);
    try {
      const response = await searchPaperOptionsAction({
        projectId,
        query,
        page: requestedPage,
        pageSize: PAPER_OPTIONS_DEFAULT_PAGE_SIZE,
        excludePaperId,
      });
      if (requestId !== latestRequest.current) return;
      if (!response.ok) throw new Error(response.error);
      const result = response.page as PaperOptionPage;
      setPage(result);
      setLoaded(true);
      setSearchedQuery(query.trim());
      setAnnouncement(`${label}: showing ${result.from}–${result.to} of ${result.totalCount} Papers.`);
    } catch (cause) {
      if (requestId !== latestRequest.current) return;
      const message = cause instanceof Error ? cause.message : "Paper options could not be loaded.";
      setError(message);
      setAnnouncement(`${label} search could not be loaded.`);
    } finally {
      if (requestId === latestRequest.current) setPending(false);
    }
  }

  function select(paper: PaperOption) {
    setSelectedPaper(paper);
    setSelectedPaperId(paper.id);
    setError("");
    onSelectionChange?.(paper, paper.id);
    setAnnouncement(`Selected ${paper.title} for ${label.toLowerCase()}.`);
  }

  function clearSelection() {
    setSelectedPaper(null);
    setSelectedPaperId("");
    setError("");
    onSelectionChange?.(null, "");
    setAnnouncement(`Removed the selected Paper from ${label.toLowerCase()}.`);
  }

  function submitSearch() {
    void search(draftQuery, 1);
  }

  return <div className={`paper-picker ${className}`.trim()} data-picker-key={pickerKey}>
    <input ref={hiddenInputRef} type="hidden" name={fieldName} value={selectedPaperId} />
    <div className="field">
      <label htmlFor={inputId}>Search Papers for {label.toLowerCase()}</label>
      <div className="claim-support-search-row">
        <input
          ref={searchInputRef}
          id={inputId}
          type="search"
          value={draftQuery}
          aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
          onChange={(event) => setDraftQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (draftQuery.trim()) submitSearch();
            }
          }}
        />
        <button className="button secondary" type="button" disabled={pending} onClick={submitSearch}>
          {pending ? "Searching…" : loaded ? "Search Papers" : "Browse Papers"}
        </button>
      </div>
      <p className="hint" id={hintId}>Search by Paper title. Queries may contain up to 200 Unicode code points.</p>
    </div>

    {error && <p id={errorId} className="error-banner" role="alert">{error}</p>}
    <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>

    <div className="evidence-paper-selection" aria-live="polite">
      {selectedPaper ? <>
        <p><strong>Selected Paper:</strong> {selectedPaper.title}{paperDetail(selectedPaper) ? ` · ${paperDetail(selectedPaper)}` : ""}</p>
        <button className="button ghost" type="button" onClick={clearSelection}>Remove selected Paper</button>
      </> : selectedPaperId ? <>
        <p className="error-banner" role="alert">This selected Paper is unavailable in this Project.</p>
        <button className="button ghost" type="button" onClick={clearSelection}>Remove unavailable Paper</button>
      </> : <p className="hint">No Paper selected.</p>}
    </div>

    {!loaded
      ? <p className="hint">Browse Papers or enter a title search to choose a Paper.</p>
      : <>
        <fieldset className="evidence-paper-results">
          <legend>Paper search results</legend>
          {page.items.length === 0
            ? <p className="hint">{searchedQuery ? "No Papers match this title search." : "No Papers are available in this Project."}</p>
            : page.items.map((paper) => <div className="claim-support-result-row" key={paper.id}>
              <span>{paper.title}<small>{paperDetail(paper) || "Bibliographic details not recorded"}</small></span>
              <button
                className={`button ${selectedPaperId === paper.id ? "ghost" : "secondary"}`}
                type="button"
                aria-pressed={selectedPaperId === paper.id}
                onClick={() => select(paper)}
              >{selectedPaperId === paper.id ? "Selected" : "Select"}</button>
            </div>)}
        </fieldset>

        <nav className="pagination claim-support-pagination" aria-label={`${label} Paper search pages`}>
          <button className="button ghost" type="button" disabled={pending || !page.hasPrevious} onClick={() => void search(searchedQuery, page.page - 1)}>Previous</button>
          <span>Page {page.page} of {page.totalPages || 1} · {page.totalCount} Papers</span>
          <button className="button ghost" type="button" disabled={pending || !page.hasNext} onClick={() => void search(searchedQuery, page.page + 1)}>Next</button>
        </nav>
      </>}
  </div>;
}
