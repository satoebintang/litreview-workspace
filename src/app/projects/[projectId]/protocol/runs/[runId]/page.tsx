import Link from "next/link";
import { notFound } from "next/navigation";
import { createRetrievedRecordForRunAction } from "@/app/actions";
import { acquisitionReadServices, reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

function dateInput(value: Date) { return value.toISOString().slice(0, 16); }

export default async function SearchRunPage({ params, searchParams }: {
  params: Promise<{ projectId: string; runId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string; cursor?: string; searchField?: string; query?: string }>;
}) {
  const { projectId, runId } = await params;
  const query = searchParams ? await searchParams : {};
  let run;
  try { run = await reviewServices.getSearchRun(projectId, runId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const project = await reviewServices.getProject(projectId);
  let recordPage;
  let pageError: string | null = null;
  try {
    recordPage = await acquisitionReadServices.getRetrievedRecordPage(projectId, runId, {
      cursor: query.cursor,
      searchField: query.searchField === "title" || query.searchField === "doi" || query.searchField === "sourceRecordId" ? query.searchField : query.searchField ? query.searchField as never : "",
      query: query.query,
    });
  } catch (error) {
    if (error instanceof DomainError && error.code === "VALIDATION_ERROR") pageError = error.message;
    else throw error;
  }
  const recordUrl = (recordId: string) => `/projects/${projectId}/protocol/runs/${runId}/records/${recordId}`;
  const nextHref = recordPage?.nextCursor
    ? `/projects/${projectId}/protocol/runs/${runId}?${new URLSearchParams({ cursor: recordPage.nextCursor, ...(query.searchField ? { searchField: query.searchField } : {}), ...(query.query ? { query: query.query } : {}) }).toString()}`
    : null;

  return <div className="project-page">
    <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Historical search run · {project.title}</p><h1>Run {run.sequence} · {run.sourceDisplayNameSnapshot}</h1><p>{run.executedAt.toLocaleString()} · {run.reportedResultCount} reported results</p></div><span className="status supported">Immutable snapshot</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">Retrieved record added. Review its source details and match history below.</div>}{pageError && <div className="error-banner" role="alert">{pageError}</div>}
      <div className="workspace-grid">
        <section className="card section-card"><div className="section-heading"><h2>Run provenance</h2><span className="count">source snapshot</span></div>
          <div className="provenance-chain"><div className="item"><div className="item-meta">Source key</div><div className="item-title">{run.sourceKeySnapshot}</div><div className="item-meta">{run.sourceDisplayNameSnapshot}</div></div><div className="chain-arrow">↓</div><div className="item"><div className="item-meta">Exact query</div><div className="quote">{run.queryText}</div>{run.filtersTextSnapshot && <div className="item-meta">Filters: {run.filtersTextSnapshot}</div>}</div><div className="item-meta">Strategy identity: {run.strategyId}</div><div className="item-row"><span>Reported result count</span><strong>{run.reportedResultCount}</strong></div>{run.notes && <div className="item"><div className="item-meta">Run notes</div><div className="abstract-text">{run.notes}</div></div>}</div>
        </section>
        <section className="card section-card"><div className="section-heading"><h2>Add a RetrievedRecord</h2><span className="count">Source comes from this run</span></div>
          <form action={createRetrievedRecordForRunAction} className="extraction-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="runId" value={runId} /><div className="field"><label htmlFor="record-source-id">Source record ID <span className="hint">optional</span></label><input id="record-source-id" name="sourceRecordId" /></div><div className="field"><label htmlFor="record-title">Title</label><input id="record-title" name="title" required /></div><div className="field"><label htmlFor="record-authors">Authors</label><input id="record-authors" name="authors" placeholder="First Author, Second Author" /></div><div className="field"><label htmlFor="record-year">Publication year</label><input id="record-year" name="publicationYear" type="number" min="1000" max="3000" /></div><div className="field"><label htmlFor="record-venue">Venue</label><input id="record-venue" name="venue" /></div><div className="field"><label htmlFor="record-doi">DOI</label><input id="record-doi" name="doi" /></div><div className="field"><label htmlFor="record-url">URL</label><input id="record-url" name="url" type="url" /></div><div className="field"><label htmlFor="record-abstract">Abstract</label><textarea id="record-abstract" name="abstract" /></div><div className="field"><label htmlFor="record-raw-citation">Raw citation</label><textarea id="record-raw-citation" name="rawCitation" /></div><div className="field"><label htmlFor="record-retrieved-at">Retrieved at</label><input id="record-retrieved-at" name="retrievedAt" required type="datetime-local" defaultValue={dateInput(new Date())} /></div><button className="button" type="submit">Add retrieved record</button></form>
        </section>

        <section className="card section-card full"><div className="section-heading"><h2>RetrievedRecords</h2><span className="count">{recordPage?.items.length ?? 0} on this page{recordPage?.hasMore ? " · more available" : ""}</span></div>
          <p className="hint">Compact rows preserve source previews. Open one record for complete metadata, history, duplicate candidates, and Paper actions.</p>
          <form method="get" className="inline-form" action={`/projects/${projectId}/protocol/runs/${runId}`}><div className="field"><label htmlFor="record-search-field">Search field</label><select id="record-search-field" name="searchField" defaultValue={recordPage?.searchField ?? ""}><option value="">No search</option><option value="title">Title</option><option value="doi">DOI</option><option value="sourceRecordId">Source record ID</option></select></div><div className="field"><label htmlFor="record-search-query">Exact search</label><input id="record-search-query" name="query" defaultValue={recordPage?.normalizedSearch ?? query.query ?? ""} /></div><button className="button secondary" type="submit">Search records</button></form>
          {recordPage?.items.length === 0 && <div className="empty">{query.cursor ? "No more RetrievedRecords on this page." : "No RetrievedRecords match this search."}</div>}
          {recordPage && recordPage.items.length > 0 && <div className="item-list">{recordPage.items.map((record) => <Link className="item" key={record.id} href={recordUrl(record.id)}><div className="item-row"><div className="item-title">{record.title}</div><span className={`status ${record.currentMatch ? "supported" : "unsupported"}`}>{record.currentMatch ? "linked" : "unmatched"}</span></div><div className="item-meta">{record.authorsPreview.join(", ") || "Author details not captured"}{record.additionalAuthorsCount > 0 ? ` · +${record.additionalAuthorsCount} more` : ""}{record.publicationYear ? ` · ${record.publicationYear}` : ""}{record.venuePreview ? ` · ${record.venuePreview}` : ""}</div><div className="item-meta">Retrieved {record.retrievedAt.toLocaleString()}{record.sourceRecordIdPreview ? ` · Source ID ${record.sourceRecordIdPreview}` : ""}{record.doiPreview ? ` · DOI ${record.doiPreview}` : ""}</div>{record.abstractPreview && <p className="abstract-text">{record.abstractPreview}</p>}{record.currentMatch && <div className="status supported">Current Paper: {record.currentMatch.paperTitle}</div>}{record.rawCitationPreview && <div className="item-meta">Citation: {record.rawCitationPreview}</div>}</Link>)}</div>}
          <div className="inline-form" style={{ marginTop: 14 }}>{query.cursor && <Link className="button ghost" href={`/projects/${projectId}/protocol/runs/${runId}${query.searchField && query.query ? `?searchField=${encodeURIComponent(query.searchField)}&query=${encodeURIComponent(query.query)}` : ""}`}>Return to first page</Link>}{nextHref && <Link className="button secondary" href={nextHref}>Next RetrievedRecords page →</Link>}</div>
        </section>
      </div>
      <p className="footer-note">Run source, query, filters, notes, and result count remain the exact values recorded when this SearchRun was created.</p>
    </div></div>;
}
