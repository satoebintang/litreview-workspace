"use client";

import { useState } from "react";
import { getResearchQuestionExtractionCoveragePageAction } from "@/app/actions/research-question-bounded";
import type { ResearchQuestionExtractionCoveragePage } from "@/application/research-question-bounded-read-types";

export default function ResearchQuestionExtractionCoverage({
  projectId,
  questionId,
  fieldId,
}: {
  projectId: string;
  questionId: string;
  fieldId: string;
}) {
  const [page, setPage] = useState<ResearchQuestionExtractionCoveragePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(cursor?: string | null) {
    setBusy(true);
    setError(null);
    const result = await getResearchQuestionExtractionCoveragePageAction(projectId, questionId, fieldId, { pageSize: 25, cursor });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPage(result.value);
  }

  return <section className="card section-card full" style={{ marginTop: 18 }}>
    <div className="section-heading"><h2>Finally included Paper coverage</h2>{page && <span className="count">{page.items.length} Papers on this page</span>}</div>
    <p className="hint">Coverage is live: a later screening decision or finalized Extraction revision can change the rows shown on a later page. Excluded and maybe Papers are omitted.</p>
    {!page && <button className="button secondary" type="button" disabled={busy} onClick={() => void load(null)}>Load included Paper coverage</button>}
    {error && <div className="curation-warning-box" role="alert">{error} <button className="button ghost" type="button" onClick={() => void load(null)}>Refresh coverage</button></div>}
    {page && page.items.length === 0 && <div className="empty">No finally included Papers currently have a coverage row for this Field.</div>}
    {page && page.items.length > 0 && <div className="item-list">
      {page.items.map((paper) => <article className="item" key={paper.paperId}>
        <div className="item-title">{paper.paperTitle}</div>
        <div className="item-meta">Paper <code>{paper.paperId}</code> · {paper.status} · revision {paper.revisionId ?? "none"}</div>
        {paper.displayValue != null && <div className="quote-inline" style={{ marginTop: 6 }}>{paper.displayValue}</div>}
      </article>)}
    </div>}
    {page && <div className="inline-form" style={{ justifyContent: "space-between", marginTop: 12 }}>
      <span className="hint">A page may include up to 100 Papers.</span>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="button ghost" type="button" disabled={busy} onClick={() => void load(null)}>Refresh</button>
        <button className="button secondary" type="button" disabled={busy || !page.hasMore} onClick={() => void load(page.nextCursor)}>Next Papers</button>
      </div>
    </div>}
  </section>;
}
