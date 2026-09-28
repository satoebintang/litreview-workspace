import Link from "next/link";
import { notFound } from "next/navigation";
import {
  createPaperFromRetrievedRecordAction,
  linkRetrievedRecordToPaperAction,
  relinkRetrievedRecordAction,
  unlinkRetrievedRecordFromPaperAction,
} from "@/app/actions";
import { acquisitionReadServices, reviewServices } from "@/app/server";
import { PaperPicker } from "@/app/projects/[projectId]/papers/PaperPicker";
import { DomainError } from "@/domain/errors";

const cursorMessage = "Page link expired or invalid. Start from the first page.";

export default async function RetrievedRecordPage({ params, searchParams }: {
  params: Promise<{ projectId: string; runId: string; recordId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string; paperId?: string; historyCursor?: string; candidateCursor?: string }>;
}) {
  const { projectId, runId, recordId } = await params;
  const query = searchParams ? await searchParams : {};
  let detail;
  try { detail = await acquisitionReadServices.getRetrievedRecordDetail(projectId, runId, recordId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  if (!detail) notFound();
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }

  let historyPage;
  let candidatesPage;
  let historyError: string | null = null;
  let candidatesError: string | null = null;
  const reads = await Promise.allSettled([
    acquisitionReadServices.getRetrievedRecordMatchHistoryPage(projectId, runId, recordId, { cursor: query.historyCursor }),
    acquisitionReadServices.getRetrievedRecordDuplicateCandidatePage(projectId, runId, recordId, { cursor: query.candidateCursor }),
  ]);
  if (reads[0]?.status === "fulfilled") historyPage = reads[0].value;
  else if (reads[0]?.status === "rejected" && reads[0].reason instanceof DomainError && reads[0].reason.message === cursorMessage) historyError = cursorMessage;
  else if (reads[0]?.status === "rejected") throw reads[0].reason;
  if (reads[1]?.status === "fulfilled") candidatesPage = reads[1].value;
  else if (reads[1]?.status === "rejected" && reads[1].reason instanceof DomainError && reads[1].reason.message === cursorMessage) candidatesError = cursorMessage;
  else if (reads[1]?.status === "rejected") throw reads[1].reason;

  const base = `/projects/${projectId}/protocol/runs/${runId}/records/${recordId}`;
  const nextHistoryHref = historyPage?.nextCursor ? `${base}?historyCursor=${encodeURIComponent(historyPage.nextCursor)}` : null;
  const nextCandidatesHref = candidatesPage?.nextCursor ? `${base}?candidateCursor=${encodeURIComponent(candidatesPage.nextCursor)}` : null;
  const record = detail.record;

  return <div className="project-page">
    <div className="container workspace">
      <div className="workspace-header"><div><p className="eyebrow">RetrievedRecord · {project.title}</p><h1>{record.title}</h1><p><Link href={`/projects/${projectId}/protocol/runs/${runId}`}>Run {detail.run.sequence} · {detail.run.sourceDisplayNameSnapshot}</Link> · Retrieved {record.retrievedAt.toLocaleString()}</p></div><Link className="button secondary" href={`/projects/${projectId}/protocol/runs/${runId}`}>Back to SearchRun</Link></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">{query.saved === "paper" ? "Paper created and linked." : query.saved === "linked" ? "Paper linked." : query.saved === "unlinked" ? "Paper unlinked." : query.saved === "relinked" ? "Paper relinked." : "RetrievedRecord added."}</div>}
      {historyError && <div className="error-banner" role="alert">{historyError}</div>}{candidatesError && <div className="error-banner" role="alert">{candidatesError}</div>}
      <div className="workspace-grid">
        <section className="card section-card full"><div className="section-heading"><h2>Source metadata</h2><span className="count">Exact RetrievedRecord</span></div>
          <div className="item-list"><div className="item"><div className="item-meta">Title</div><div className="item-title">{record.title}</div></div><div className="item"><div className="item-meta">Authors</div><div className="item-title">{record.authors.length ? record.authors.join(", ") : "No authors recorded"}</div></div><div className="item-row"><span>Publication year</span><strong>{record.publicationYear ?? "Not recorded"}</strong></div><div className="item"><div className="item-meta">Venue</div><div className="item-title">{record.venue ?? "Not recorded"}</div></div><div className="item"><div className="item-meta">DOI</div><div className="item-title">{record.doi ?? "Not recorded"}</div></div><div className="item"><div className="item-meta">Source record ID</div><div className="item-title">{record.sourceRecordId ?? "Not recorded"}</div></div><div className="item"><div className="item-meta">URL</div>{record.url ? <a href={record.url} target="_blank" rel="noreferrer">{record.url}</a> : <div className="item-title">Not recorded</div>}</div><div className="item"><div className="item-meta">Abstract</div><div className="abstract-text">{record.abstract ?? "Not recorded"}</div></div><div className="item"><div className="item-meta">Raw citation</div><div className="abstract-text">{record.rawCitation ?? "Not recorded"}</div></div></div>
        </section>
        <section className="card section-card"><div className="section-heading"><h2>Run and source provenance</h2><span className="count">Immutable snapshots</span></div><div className="item-list"><div className="item-row"><span>SearchRun</span><Link href={`/projects/${projectId}/protocol/runs/${runId}`}>Run {detail.run.sequence}</Link></div><div className="item"><div className="item-meta">Source identity</div><div className="item-title">{detail.run.sourceDisplayNameSnapshot} [{detail.run.sourceKeySnapshot}]</div></div><div className="item"><div className="item-meta">Exact query</div><div className="quote">{detail.run.queryText}</div></div><div className="item"><div className="item-meta">Filters snapshot</div><div className="abstract-text">{detail.run.filtersTextSnapshot ?? "No filters recorded"}</div></div><div className="item-row"><span>Strategy ID</span><strong>{detail.run.strategyId}</strong></div><div className="item-row"><span>Reported results</span><strong>{detail.run.reportedResultCount}</strong></div><div className="item-row"><span>Run executed</span><strong>{detail.run.executedAt.toLocaleString()}</strong></div>{detail.run.notes && <div className="item"><div className="item-meta">Run notes</div><div className="abstract-text">{detail.run.notes}</div></div>}</div></section>
        <section className="card section-card"><div className="section-heading"><h2>Current Paper match</h2><span className={`status ${detail.currentMatch ? "supported" : "unsupported"}`}>{detail.currentMatch ? "linked" : "unmatched"}</span></div>
          {detail.currentMatch ? <><div className="item"><div className="item-title">{detail.currentMatch.paperTitle}</div><div className="item-meta">Paper ID {detail.currentMatch.paperId} · match event {detail.currentMatch.sequence}</div></div><div className="inline-form"><form action={unlinkRetrievedRecordFromPaperAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="runId" value={runId} /><input type="hidden" name="recordId" value={recordId} /><input type="hidden" name="paperId" value={detail.currentMatch.paperId} /><button className="button ghost" type="submit">Unlink current Paper</button></form><form action={relinkRetrievedRecordAction} className="inline-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="runId" value={runId} /><input type="hidden" name="recordId" value={recordId} /><input type="hidden" name="fromPaperId" value={detail.currentMatch.paperId} /><PaperPicker projectId={projectId} pickerKey={`record-relink-${recordId}`} fieldName="toPaperId" label="relink to another Paper" excludePaperId={detail.currentMatch.paperId} initialSelectedPaper={null} required disableSubmitUntilSelection /><button className="button ghost" type="submit" disabled>Relink</button></form></div></> : <div className="item-list"><form action={createPaperFromRetrievedRecordAction} className="inline-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="runId" value={runId} /><input type="hidden" name="recordId" value={recordId} /><input name="title" aria-label="Optional Paper title override" placeholder="Optional Paper title override" /><button className="button" type="submit">Create Paper from record</button></form><form action={linkRetrievedRecordToPaperAction} className="inline-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="runId" value={runId} /><input type="hidden" name="recordId" value={recordId} /><PaperPicker projectId={projectId} pickerKey={`record-link-${recordId}`} fieldName="paperId" label="link to an existing Paper" initialSelectedPaper={null} required /><button className="button secondary" type="submit">Link Paper</button></form></div>}
        </section>
        <section className="card section-card"><div className="section-heading"><h2>Match history</h2><span className="count">{historyPage?.items.length ?? 0} events on this page</span></div><p className="hint">Every row is an immutable event and keeps the Paper identity recorded at that time.</p>{historyPage?.items.length === 0 ? <div className="empty">No match events recorded.</div> : <div className="item-list">{historyPage?.items.map((event) => <article className="item" key={event.id}><div className="item-row"><strong>{event.action}</strong><span className="count">Sequence {event.sequence}</span></div><div className="item-title">{event.paperTitle}</div><div className="item-meta">Paper ID {event.paperId} · {event.createdAt.toLocaleString()}</div></article>)}</div>}{nextHistoryHref && <Link className="button secondary" style={{ marginTop: 12 }} href={nextHistoryHref}>More match history →</Link>}</section>
        <section className="card section-card full"><div className="section-heading"><h2>Duplicate candidates</h2><span className="count">{candidatesPage?.items.length ?? 0} candidates on this page</span></div><p className="hint">Candidates use the released normalized DOI, normalized title and year, or stable source-record signals. Review each Paper before linking.</p>{candidatesPage?.items.length === 0 ? <div className="empty">No duplicate candidates currently match this record.</div> : <div className="item-list">{candidatesPage?.items.map((paper) => <article className="item" key={paper.id}><div className="item-title">{paper.title}</div><div className="item-meta">Paper ID {paper.id} · created {paper.createdAt.toLocaleString()}</div></article>)}</div>}{nextCandidatesHref && <Link className="button secondary" style={{ marginTop: 12 }} href={nextCandidatesHref}>More duplicate candidates →</Link>}</section>
      </div>
      <p className="footer-note">A later match event changes only the current link. Historical match events and source metadata remain preserved.</p>
    </div>
  </div>;
}
