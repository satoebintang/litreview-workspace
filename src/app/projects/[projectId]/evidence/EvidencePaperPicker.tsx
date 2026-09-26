"use client";

import { useEffect, useState } from "react";
import {
  EVIDENCE_PAPER_OPTIONS_DEFAULT_PAGE_SIZE,
  type EvidencePaperOption,
} from "@/application/evidence-workspace-read-services";
import { searchEvidencePaperOptionsAction } from "@/app/actions/evidence-paper-search";

type PaperPage = {
  items: EvidencePaperOption[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

function paperDetail(paper: EvidencePaperOption) {
  return [paper.authors.slice(0, 2).join(", "), paper.publicationYear, paper.doi].filter(Boolean).join(" · ");
}

export function EvidencePaperPicker({
  projectId,
  fieldName,
  label,
  initialPaperId,
  initialSelectedPaper,
  initialPage,
  onSelectionChange,
}: {
  projectId: string;
  fieldName: "paperId" | "capturePaperId";
  label: string;
  initialPaperId?: string;
  initialSelectedPaper: EvidencePaperOption | null;
  initialPage: PaperPage;
  onSelectionChange?: (paper: EvidencePaperOption | null, paperId: string) => void;
}) {
  const [draftQuery, setDraftQuery] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [page, setPage] = useState(initialPage);
  const [selectedPaper, setSelectedPaper] = useState(initialSelectedPaper);
  const [selectedPaperId, setSelectedPaperId] = useState(initialPaperId ?? initialSelectedPaper?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState(`${label} options loaded. ${initialPage.totalCount} Papers available.`);

  useEffect(() => {
    setPage(initialPage);
  }, [initialPage]);

  useEffect(() => {
    const paperId = initialPaperId ?? initialSelectedPaper?.id ?? "";
    setSelectedPaper(initialSelectedPaper);
    setSelectedPaperId(paperId);
  }, [initialPaperId, initialSelectedPaper]);

  async function search(query: string, requestedPage: number) {
    setPending(true);
    setError("");
    setAnnouncement(`Searching Papers, page ${requestedPage}.`);
    try {
      const response = await searchEvidencePaperOptionsAction({
        projectId,
        query,
        page: requestedPage,
        pageSize: EVIDENCE_PAPER_OPTIONS_DEFAULT_PAGE_SIZE,
      });
      if (!response.ok) throw new Error(response.error);
      const result = response.page as PaperPage;
      setPage(result);
      setSearchedQuery(query.trim());
      const from = result.totalCount === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
      const to = result.totalCount === 0 ? 0 : Math.min(result.page * result.pageSize, result.totalCount);
      setAnnouncement(`${label}: showing ${from}–${to} of ${result.totalCount} Papers.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Paper options could not be loaded.";
      setError(message);
      setAnnouncement(`${label} search could not be loaded.`);
    } finally {
      setPending(false);
    }
  }

  function select(paper: EvidencePaperOption) {
    setSelectedPaper(paper);
    setSelectedPaperId(paper.id);
    onSelectionChange?.(paper, paper.id);
    setAnnouncement(`Selected ${paper.title} for ${label.toLowerCase()}.`);
  }

  function clearSelection() {
    setSelectedPaper(null);
    setSelectedPaperId("");
    onSelectionChange?.(null, "");
    setAnnouncement(`Removed the selected Paper from ${label.toLowerCase()}.`);
  }

  return <div className="evidence-paper-picker">
    <input type="hidden" name={fieldName} value={selectedPaperId} />
    <div className="field">
      <label htmlFor={`${fieldName}-search`}>Search Papers for {label.toLowerCase()}</label>
      <div className="claim-support-search-row">
        <input
          id={`${fieldName}-search`}
          type="search"
          value={draftQuery}
          aria-describedby={`${fieldName}-search-hint`}
          onChange={(event) => setDraftQuery(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(draftQuery, 1); } }}
        />
        <button className="button secondary" type="button" disabled={pending} onClick={() => void search(draftQuery, 1)}>
          {pending ? "Searching…" : "Search Papers"}
        </button>
      </div>
      <p className="hint" id={`${fieldName}-search-hint`}>Search by Paper title. Queries may contain up to 200 Unicode code points.</p>
    </div>

    {error && <p className="error-banner" role="alert">{error}</p>}
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
  </div>;
}
