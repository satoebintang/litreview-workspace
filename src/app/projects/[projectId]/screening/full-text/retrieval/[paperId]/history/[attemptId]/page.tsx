import Link from "next/link";
import { notFound } from "next/navigation";
import { screeningHistoryReadServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function FullTextRetrievalAttemptEventPage({ params }: { params: Promise<{ projectId: string; paperId: string; attemptId: string }> }) {
  const { projectId, paperId, attemptId } = await params;
  let result;
  try { result = await screeningHistoryReadServices.getFullTextRetrievalAttemptEvent(projectId, paperId, attemptId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const detailPath = `/projects/${projectId}/screening/full-text/retrieval/${paperId}`;
  const historyPath = `${detailPath}/history`;
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Exact full-text retrieval attempt</p><h1>{result.route.title}</h1><p>Sequence {result.event.sequence} · attempted {result.event.attemptedAt.toLocaleString()}</p></div><span className="status supported">{result.event.outcome}</span></div>
    <section className="card section-card"><h2>Historical attempt</h2><dl className="item-list"><div className="item-row"><dt>Event ID</dt><dd>{result.event.id}</dd></div><div className="item-row"><dt>Outcome</dt><dd>{result.event.outcome}</dd></div><div className="item-row"><dt>Method</dt><dd>{result.event.method?.replaceAll("_", " ") ?? "Not specified"}</dd></div><div className="item-row"><dt>Sequence</dt><dd>{result.event.sequence}</dd></div><div className="item-row"><dt>Attempted at</dt><dd>{result.event.attemptedAt.toLocaleString()}</dd></div><div className="item-row"><dt>Recorded</dt><dd>{result.event.createdAt.toLocaleString()}</dd></div>{result.event.sourceReference && <div className="item-row"><dt>Source reference</dt><dd className="abstract-text">{result.event.sourceReference}</dd></div>}{result.event.note && <div className="item-row"><dt>Note</dt><dd className="abstract-text">{result.event.note}</dd></div>}</dl></section>
    <nav className="pagination" aria-label="Retrieval navigation"><Link className="button ghost" href={historyPath}>Retrieval history →</Link><Link className="button ghost" href={detailPath}>Retrieval detail →</Link></nav>
  </div></div>;
}
