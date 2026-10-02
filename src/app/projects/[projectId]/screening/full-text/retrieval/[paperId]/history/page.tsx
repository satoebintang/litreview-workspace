import Link from "next/link";
import { notFound } from "next/navigation";
import { screeningHistoryReadServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function FullTextRetrievalHistoryPage({ params, searchParams }: {
  params: Promise<{ projectId: string; paperId: string }>;
  searchParams?: Promise<{ cursor?: string; pageSize?: string }>;
}) {
  const { projectId, paperId } = await params;
  const query = searchParams ? await searchParams : {};
  let result;
  try { result = await screeningHistoryReadServices.getFullTextRetrievalAttemptHistoryPage(projectId, paperId, { cursor: query.cursor, pageSize: query.pageSize === undefined ? undefined : Number(query.pageSize) }); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const historyPath = `/projects/${projectId}/screening/full-text/retrieval/${paperId}/history`;
  const exactPath = (id: string) => `${historyPath}/${id}`;
  const currentRetrieval = result.page.currentEvent && "outcome" in result.page.currentEvent ? result.page.currentEvent : null;
  const currentOutsidePage = result.page.currentEvent != null && !result.page.items.some((item) => item.id === result.page.currentEvent?.id);
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Full-text retrieval history</p><h1>{result.route.title}</h1><p>Current state: {currentRetrieval?.outcome ?? "not sought"} · ever retrieved: {result.route.everRetrieved ? "yes" : "no"}</p></div><Link className="button ghost" href={`/projects/${projectId}/screening/full-text/retrieval/${paperId}`}>Retrieval detail →</Link></div>
    <section className="card section-card"><div className="section-heading"><h2>History</h2><span className="count">{result.page.items.length} shown</span></div>
      <nav className="pagination" aria-label="History page size">{[20, 50].map((size) => <Link key={size} className="button ghost" aria-current={result.page.pageSize === size ? "page" : undefined} href={`${historyPath}?pageSize=${size}`}>{size} per page</Link>)}</nav>
      {result.page.items.length === 0 ? <div className="empty">No retrieval attempt has been recorded.</div> : <div className="item-list">{result.page.items.map((attempt) => <article className="item" key={attempt.id}><div className="item-row"><div className="item-title">{attempt.outcome.toUpperCase()}</div>{attempt.isCurrent && <span className="status supported">current</span>}</div><div className="item-meta">Sequence {attempt.sequence} · {attempt.attemptedAt.toLocaleString()}{attempt.method ? ` · ${attempt.method.replaceAll("_", " ")}` : ""}</div>{attempt.sourceReference && <div className="item-meta">{attempt.sourceReference}{attempt.sourceReferenceTruncated && " (preview shortened)"}</div>}{attempt.note && <div className="item-meta">{attempt.note}{attempt.noteTruncated && " (preview shortened)"}</div>}<Link href={exactPath(attempt.id)}>View full event →</Link></article>)}</div>}
      {currentOutsidePage && currentRetrieval && <p className="item-meta">Current attempt: {currentRetrieval.outcome}. <Link href={exactPath(currentRetrieval.id)}>View exact current attempt →</Link></p>}
      {result.page.hasMore && result.page.nextCursor && <p className="pagination"><Link className="button ghost" href={`${historyPath}?pageSize=${result.page.pageSize}&cursor=${encodeURIComponent(result.page.nextCursor)}`}>More history →</Link></p>}
    </section>
  </div></div>;
}
