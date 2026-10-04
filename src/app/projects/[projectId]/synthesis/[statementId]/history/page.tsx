import Link from "next/link";
import { notFound } from "next/navigation";
import { withReviewReadTransaction } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function SynthesisRevisionHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; statementId: string }>;
  searchParams?: Promise<{ pageSize?: string; cursor?: string }>;
}) {
  const { projectId, statementId } = await params;
  const query = searchParams ? await searchParams : {};
  let history;
  try {
    history = await withReviewReadTransaction(({ claimSynthesisHistoryReadServices, executor }) =>
      claimSynthesisHistoryReadServices.getSynthesisRevisionHistoryPage(projectId, statementId, {
        pageSize: query.pageSize === undefined ? undefined : Number(query.pageSize),
        cursor: query.cursor,
      }, executor),
    );
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }
  const current = history.current;

  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Synthesis audit</p><h1>Paginated synthesis history · oldest first</h1><p>{history.items.length} revisions on this page · history order is ascending</p></div><span className="count">Page size {history.pageSize}</span></div>
    <p><Link href={`/projects/${projectId}/synthesis/${statementId}`}>Return to current synthesis →</Link></p>
    {current && <section className="card section-card full"><div className="section-heading"><h2>Current revision</h2><span className="count">Revision {current.sequence}</span></div><p>{current.lifecycle === "withdrawn" ? "Synthesis withdrawn" : "Current conclusion is shown on the Synthesis page."}</p><Link className="button ghost small" href={`/projects/${projectId}/synthesis/${statementId}/revisions/${current.id}`}>Open exact current revision →</Link></section>}
    <section className="card section-card full"><div className="section-heading"><h2>Historical revision summaries</h2><span className="count">{history.items.length} revisions</span></div>
      {history.items.length === 0 ? <p className="empty">There are no revisions on this page.</p> : <div className="item-list">{history.items.map((revision) => <article className="item" key={revision.id}>
        <div className="item-row"><div><div className="item-title">Revision {revision.sequence} · {revision.lifecycle === "withdrawn" ? "Withdrawn" : revision.supportStatus === "supported" ? "Supported observations" : "Unsupported"}{revision.isCurrent ? " · Current" : ""}</div>{revision.titlePreview && <div className="item-meta">{revision.titlePreview}{revision.titleTruncated ? "…" : ""}</div>}<p>{revision.statementPreview ?? "Conclusion withdrawn"}{revision.statementTruncated ? "…" : ""}</p></div><span className="status">{revision.supportingRevisionCount} observations · {revision.supportingPaperCount} Papers · {revision.supportingFieldCount} Fields</span></div>
        {revision.researcherNotePreview && <p className="item-meta">Note: {revision.researcherNotePreview}{revision.researcherNoteTruncated ? "…" : ""}</p>}
        {revision.preparation && <p className="item-meta">Preparation context: Evidence Set “{revision.preparation.evidenceSetNamePreview}{revision.preparation.evidenceSetNameTruncated ? "…" : ""}” · pinned composition sequence {revision.preparation.pinnedCompositionSequence}{revision.preparation.evidenceSetArchivedAt ? " · Archived Evidence Set" : ""}</p>}
        <div className="item-meta">Finalized {new Date(revision.finalizedAt).toLocaleString()}</div><Link className="button ghost small" href={revision.href}>Open exact Synthesis revision →</Link>
      </article>)}</div>}
      {history.hasMore && history.nextCursor && <div style={{ marginTop: 14 }}><Link className="button ghost" href={`/projects/${projectId}/synthesis/${statementId}/history?pageSize=${history.pageSize}&cursor=${encodeURIComponent(history.nextCursor)}`}>Next oldest-first history page →</Link></div>}
    </section>
  </div></div>;
}
