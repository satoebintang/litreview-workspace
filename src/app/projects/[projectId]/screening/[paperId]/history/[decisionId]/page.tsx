import Link from "next/link";
import { notFound } from "next/navigation";
import { screeningHistoryReadServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function ScreeningDecisionEventPage({ params }: { params: Promise<{ projectId: string; paperId: string; decisionId: string }> }) {
  const { projectId, paperId, decisionId } = await params;
  let result;
  try { result = await screeningHistoryReadServices.getScreeningDecisionEvent(projectId, paperId, decisionId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const detailPath = `/projects/${projectId}/screening/${paperId}`;
  const historyPath = `${detailPath}/history`;
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Exact title/abstract decision</p><h1>{result.route.title}</h1><p>Sequence {result.event.sequence} · {result.event.createdAt.toLocaleString()}</p></div><span className={`status screening-${result.event.decision}`}>{result.event.decision}</span></div>
    <section className="card section-card"><h2>Historical event</h2><dl className="item-list"><div className="item-row"><dt>Event ID</dt><dd>{result.event.id}</dd></div><div className="item-row"><dt>Decision</dt><dd>{result.event.decision}</dd></div><div className="item-row"><dt>Sequence</dt><dd>{result.event.sequence}</dd></div><div className="item-row"><dt>Created</dt><dd>{result.event.createdAt.toLocaleString()}</dd></div>{result.event.exclusionCriterion && <><div className="item-row"><dt>Criterion ID</dt><dd>{result.event.exclusionCriterion.id}</dd></div><div className="item-row"><dt>Criterion type</dt><dd>{result.event.exclusionCriterion.type ?? "unspecified"}</dd></div><div className="item-row"><dt>Criterion text</dt><dd>{result.event.exclusionCriterion.text}</dd></div>{result.event.exclusionCriterion.archivedAt && <div className="item-row"><dt>Criterion archived</dt><dd>{result.event.exclusionCriterion.archivedAt.toLocaleString()}</dd></div>}</>}{result.event.note && <div className="item-row"><dt>Note</dt><dd className="abstract-text">{result.event.note}</dd></div>}</dl></section>
    <nav className="pagination" aria-label="Decision navigation"><Link className="button ghost" href={historyPath}>Decision history →</Link><Link className="button ghost" href={detailPath}>Paper detail →</Link></nav>
  </div></div>;
}
