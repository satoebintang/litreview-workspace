import { notFound } from "next/navigation";
import {
  createPaperFromRetrievedRecordAction,
  linkRetrievedRecordToPaperAction,
  relinkRetrievedRecordAction,
  unlinkRetrievedRecordFromPaperAction,
} from "@/app/actions";
import { paperSelectionReadServices, reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import { PaperPicker } from "@/app/projects/[projectId]/papers/PaperPicker";
import type { PaperOption } from "@/application/paper-selection-read-services";

type Paper = { id: string; title: string; authors: string[]; publicationYear: number | null; venue: string | null; doi: string | null };
type RecordRow = { id: string; title: string; authors: string[]; publicationYear: number | null; venue: string | null; doi: string | null; url: string | null; abstract: string | null; rawCitation: string | null; sourceRecordId: string | null; retrievedAt: Date };
type Match = { id: string; paperId: string; action: "linked" | "unlinked"; createdAt: Date } | null;
type HistoryEvent = { id: string; paperId: string; action: "linked" | "unlinked"; createdAt: Date };

export default async function SearchRunPage({ params, searchParams }: {
  params: Promise<{ projectId: string; runId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string; paperId?: string }>;
}) {
  const { projectId, runId } = await params;
  const query = searchParams ? await searchParams : {};
  let run;
  try { run = await reviewServices.getSearchRun(projectId, runId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const [project, projectedRecords] = await Promise.all([
    reviewServices.getProject(projectId),
    reviewServices.listRetrievedRecordProjections(projectId, runId),
  ]) as unknown as [{ title: string }, Array<{ record: RecordRow; match: Match; history: HistoryEvent[]; duplicates: Paper[] }>];
  const records = projectedRecords.map(({ record }) => record);
  const referencedPaperIds = [...new Set(projectedRecords.flatMap(({ match, history }) => [
    ...(match ? [match.paperId] : []),
    ...history.map((event) => event.paperId),
  ]))];
  const paperOptionEntries = await paperSelectionReadServices.getPaperOptionsByIds(projectId, referencedPaperIds);
  const paperById = new Map<string, PaperOption>();
  for (const entry of paperOptionEntries) if (entry.option) paperById.set(entry.paperId, entry.option);
  const recordViews = projectedRecords;

  return <div className="project-page">
    <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Historical search run · {project.title}</p><h1>Run {run.sequence} · {run.sourceDisplayNameSnapshot}</h1><p>{run.executedAt.toLocaleString()} · {run.reportedResultCount} reported results</p></div><span className="status supported">Immutable snapshot</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">{query.saved === "paper" ? "Paper created and linked from the retrieved record." : `Record ${query.saved}.`}</div>}
      <div className="workspace-grid">
        <section className="card section-card"><div className="section-heading"><h2>Run provenance</h2><span className="count">source snapshot</span></div>
          <div className="provenance-chain"><div className="item"><div className="item-meta">Source key</div><div className="item-title">{run.sourceKeySnapshot}</div><div className="item-meta">{run.sourceDisplayNameSnapshot}</div></div><div className="chain-arrow">↓</div><div className="item"><div className="item-meta">Exact query</div><div className="quote">{run.queryText}</div>{run.filtersTextSnapshot && <div className="item-meta">Filters: {run.filtersTextSnapshot}</div>}</div><div className="item-row"><span>Reported result count</span><strong>{run.reportedResultCount}</strong></div>{run.notes && <div className="item"><div className="item-meta">Run notes</div><div className="abstract-text">{run.notes}</div></div>}</div>
        </section>
        <section className="card section-card"><div className="section-heading"><h2>Match history</h2><span className="count">{recordViews.reduce((total, view) => total + view.history.length, 0)} events</span></div><p className="hint">Linking, unlinking, and relinking append events. Current links are derived from the latest event for each record.</p><div className="item-list">{recordViews.length === 0 ? <div className="empty">No retrieved records are attached to this run.</div> : recordViews.map(({ record, match, history }) => <article className="item" key={`history-${record.id}`}><div className="item-title">{record.title}</div>{history.length === 0 ? <div className="item-meta">No Paper match yet.</div> : history.map((event) => <div className="item-meta" key={event.id}>{event.action} → {paperById.get(event.paperId)?.title ?? "Paper"} · {event.createdAt.toLocaleString()}</div>)}{match && <div className="status supported" style={{ marginTop: 8 }}>Current: {paperById.get(match.paperId)?.title ?? "Paper"}</div>}</article>)}</div></section>

        <section className="card section-card full"><div className="section-heading"><h2>Retrieved records</h2><span className="count">{records.length} attached</span></div>
          <p className="hint">Records preserve source fields exactly as entered. Review duplicate candidates before creating or linking a project Paper.</p>
          {recordViews.length === 0 ? <div className="empty">Return to Protocol &amp; search to add a manual retrieved record.</div> : <div className="item-list">{recordViews.map(({ record, match, duplicates }) => <article className="item" key={record.id}>
            <div className="item-row"><div><div className="item-title">{record.title}</div><div className="item-meta">{record.authors.length ? record.authors.join(", ") : "Author details not captured"}{record.publicationYear ? ` · ${record.publicationYear}` : ""}{record.venue ? ` · ${record.venue}` : ""}</div></div>{match?.action === "linked" ? <span className="status supported">linked</span> : <span className="status unsupported">unmatched</span>}</div>
            <div className="item-meta" style={{ marginTop: 8 }}>Retrieved {record.retrievedAt.toLocaleString()}{record.sourceRecordId ? ` · Source ID ${record.sourceRecordId}` : ""}</div>{record.doi && <div className="item-meta">DOI: {record.doi}</div>}{record.url && <div className="item-meta"><a className="paper-chip" href={record.url} target="_blank" rel="noreferrer">Open source URL</a></div>}{record.abstract && <p className="abstract-text" style={{ marginTop: 10 }}>{record.abstract}</p>}{record.rawCitation && <div className="item-meta">Raw citation: {record.rawCitation}</div>}
            {duplicates.length > 0 && <div className="nested-support"><strong>Duplicate candidates</strong><div className="item-list" style={{ marginTop: 8 }}>{duplicates.map((paper) => <div className="item" key={paper.id}><div className="item-title">{paper.title}</div><div className="item-meta">{paper.authors.join(", ") || "Author details not added"}{paper.publicationYear ? ` · ${paper.publicationYear}` : ""}{paper.doi ? ` · DOI ${paper.doi}` : ""}</div></div>)}</div></div>}
            {match?.action === "linked" ? <div className="inline-form"><span className="hint">Current Paper: {paperById.get(match.paperId)?.title ?? "Paper"}</span><form action={unlinkRetrievedRecordFromPaperAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="runId" value={runId} /><input type="hidden" name="recordId" value={record.id} /><input type="hidden" name="paperId" value={match.paperId} /><button className="button ghost" type="submit">Unlink</button></form></div> : <div className="item-list" style={{ marginTop: 14 }}><form action={createPaperFromRetrievedRecordAction} className="inline-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="runId" value={runId} /><input type="hidden" name="recordId" value={record.id} /><input name="title" aria-label={`Paper title for ${record.title}`} placeholder="Optional Paper title override" /><button className="button" type="submit">Create Paper from record</button></form><form action={linkRetrievedRecordToPaperAction} className="inline-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="runId" value={runId} /><input type="hidden" name="recordId" value={record.id} /><PaperPicker projectId={projectId} pickerKey={`protocol-link-${record.id}`} fieldName="paperId" label={`link ${record.title} to an existing Paper`} initialSelectedPaper={null} required /><button className="button secondary" type="submit">Link existing Paper</button></form></div>}
            {match?.action === "linked" && <form action={relinkRetrievedRecordAction} className="inline-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="runId" value={runId} /><input type="hidden" name="recordId" value={record.id} /><input type="hidden" name="fromPaperId" value={match.paperId} /><PaperPicker projectId={projectId} pickerKey={`protocol-relink-${record.id}`} fieldName="toPaperId" label={`relink ${record.title} to another Paper`} excludePaperId={match.paperId} initialSelectedPaper={null} required disableSubmitUntilSelection /><button className="button ghost" type="submit" disabled>Relink</button></form>}
          </article>)}</div>}
        </section>
      </div>
      <p className="footer-note">This view uses run and record snapshots for provenance; changing a source or strategy later does not rewrite this historical run.</p>
    </div></div>;
}
