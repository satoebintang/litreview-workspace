import Link from "next/link";
import { notFound } from "next/navigation";
import { withReviewReadTransaction } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function SynthesisInterpretationHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; statementId: string; revisionId: string }>;
  searchParams?: Promise<{ pageSize?: string; cursor?: string }>;
}) {
  const { projectId, statementId, revisionId } = await params;
  const query = searchParams ? await searchParams : {};
  let detail;
  try {
    detail = await withReviewReadTransaction(({ claimSynthesisHistoryReadServices, executor }) =>
      claimSynthesisHistoryReadServices.getSynthesisInterpretationHistoryPage(projectId, statementId, revisionId, {
        pageSize: query.pageSize === undefined ? undefined : Number(query.pageSize),
        cursor: query.cursor,
      }, executor)
    );
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }
  const history = detail;
  const parentHref = `/projects/${projectId}/synthesis/${statementId}/revisions/${revisionId}`;

  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Interpretation audit</p><h1>Interpretation snapshot history</h1><p>Newest snapshots first · {history.items.length} on this page</p></div><span className="count">Page size {history.pageSize}</span></div>
    <p><Link href={parentHref}>Return to exact Synthesis revision →</Link></p>
    {history.current && <section className="card section-card full"><div className="section-heading"><h2>Current interpretation</h2><span className={`badge-convergence ${history.current.convergenceState}`}>{history.current.convergenceState} · {history.current.sequence}</span></div><Link className="button ghost small" href={`/projects/${projectId}/synthesis/${statementId}/revisions/${revisionId}/interpretations/${history.current.id}`}>Open exact current snapshot →</Link></section>}
    <section className="card section-card full"><div className="section-heading"><h2>Historical snapshot summaries</h2><span className="count">{history.items.length} snapshots</span></div>
      {history.items.length === 0 ? <p className="empty">No interpretation snapshots are recorded for this revision.</p> : <div className="item-list">{history.items.map((snapshot) => <article className="item" key={snapshot.id}>
        <div className="item-row"><div><div className="item-title"><span className={`badge-convergence ${snapshot.convergenceState}`}>{snapshot.convergenceState}</span> · Snapshot {snapshot.sequence}{snapshot.isCurrent ? " · Current" : ""}</div><p>{snapshot.summaryPreview}{snapshot.summaryTruncated ? "…" : ""}</p></div><span className="status">{snapshot.limitationCount} limitations · {snapshot.questionCount} questions · {snapshot.contradictionCount} contradiction pairs</span></div>
        {snapshot.researcherNotePreview && <p className="item-meta">Note: {snapshot.researcherNotePreview}{snapshot.researcherNoteTruncated ? "…" : ""}</p>}
        <div className="item-meta">Finalized {new Date(snapshot.finalizedAt).toLocaleString()}</div><Link className="button ghost small" href={snapshot.href}>Open exact interpretation →</Link>
      </article>)}</div>}
      {history.hasMore && history.nextCursor && <div style={{ marginTop: 14 }}><Link className="button ghost" href={`${parentHref}/interpretations/history?pageSize=${history.pageSize}&cursor=${encodeURIComponent(history.nextCursor)}`}>Next interpretation history page →</Link></div>}
    </section>
  </div></div>;
}
