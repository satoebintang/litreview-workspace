import Link from "next/link";
import { notFound } from "next/navigation";
import { screeningHistoryReadServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function ScreeningHistoryPage({ params, searchParams }: {
  params: Promise<{ projectId: string; paperId: string }>;
  searchParams?: Promise<{ cursor?: string; pageSize?: string }>;
}) {
  const { projectId, paperId } = await params;
  const query = searchParams ? await searchParams : {};
  let result;
  try { result = await screeningHistoryReadServices.getScreeningDecisionHistoryPage(projectId, paperId, { cursor: query.cursor, pageSize: query.pageSize === undefined ? undefined : Number(query.pageSize) }); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const historyPath = `/projects/${projectId}/screening/${paperId}/history`;
  const exactPath = (id: string) => `${historyPath}/${id}`;
  const currentDecision = result.page.currentEvent && "decision" in result.page.currentEvent ? result.page.currentEvent : null;
  const currentOutsidePage = result.page.currentEvent != null && !result.page.items.some((item) => item.id === result.page.currentEvent?.id);
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Title/abstract decision history</p><h1>{result.route.title}</h1><p>Current state: {currentDecision?.decision ?? "unscreened"}</p></div><Link className="button ghost" href={`/projects/${projectId}/screening/${paperId}`}>Paper detail →</Link></div>
    <section className="card section-card"><div className="section-heading"><h2>History</h2><span className="count">{result.page.items.length} shown</span></div>
      <nav className="pagination" aria-label="History page size">{[20, 50].map((size) => <Link key={size} className="button ghost" aria-current={result.page.pageSize === size ? "page" : undefined} href={`${historyPath}?pageSize=${size}`}>{size} per page</Link>)}</nav>
      {result.page.items.length === 0 ? <div className="empty">This paper has not been screened yet.</div> : <div className="item-list">{result.page.items.map((decision) => <article className="item" key={decision.id}><div className="item-row"><div className="item-title">{decision.decision.toUpperCase()}</div>{decision.isCurrent && <span className="status supported">current</span>}</div><div className="item-meta">Sequence {decision.sequence} · {decision.createdAt.toLocaleString()}</div>{decision.exclusionCriterion && <div className="item-meta">Reason: {decision.exclusionCriterion.text}{decision.criterionTextTruncated && " (preview shortened)"}</div>}{decision.note && <div className="item-meta">{decision.note}{decision.noteTruncated && " (preview shortened)"}</div>}<Link href={exactPath(decision.id)}>View full event →</Link></article>)}</div>}
      {currentOutsidePage && currentDecision && <p className="item-meta">Current state: {currentDecision.decision}. <Link href={exactPath(currentDecision.id)}>View exact current event →</Link></p>}
      {result.page.hasMore && result.page.nextCursor && <p className="pagination"><Link className="button ghost" href={`${historyPath}?pageSize=${result.page.pageSize}&cursor=${encodeURIComponent(result.page.nextCursor)}`}>More history →</Link></p>}
    </section>
  </div></div>;
}
