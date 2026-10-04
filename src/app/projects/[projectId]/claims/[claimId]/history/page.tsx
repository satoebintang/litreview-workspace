import Link from "next/link";
import { notFound } from "next/navigation";
import { withReviewReadTransaction } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function ClaimRevisionHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; claimId: string }>;
  searchParams?: Promise<{ pageSize?: string; cursor?: string }>;
}) {
  const { projectId, claimId } = await params;
  const query = searchParams ? await searchParams : {};
  let history;
  try {
    history = await withReviewReadTransaction(({ claimSynthesisHistoryReadServices, executor }) =>
      claimSynthesisHistoryReadServices.getClaimRevisionHistoryPage(projectId, claimId, {
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
    <div className="workspace-header"><div><p className="eyebrow">Claim audit</p><h1>Claim revision history</h1><p>Newest revisions first · {history.items.length} on this page</p></div><span className="count">Page size {history.pageSize}</span></div>
    <p><Link href={`/projects/${projectId}/claims/${claimId}`}>Return to current Claim →</Link></p>
    {current && <section className="card section-card full"><div className="section-heading"><h2>Current revision</h2><span className="count">Revision {current.sequence}</span></div><p>{current.lifecycle === "withdrawn" ? "Claim withdrawn" : "Current Claim content is shown on the Claim page."}</p><Link className="button ghost small" href={`/projects/${projectId}/claims/${claimId}/revisions/${current.id}`}>Open exact current revision →</Link></section>}
    <section className="card section-card full"><div className="section-heading"><h2>Historical revision summaries</h2><span className="count">{history.items.length} revisions</span></div>
      {history.items.length === 0 ? <p className="empty">There are no revisions on this page.</p> : <div className="item-list">{history.items.map((revision) => <article className="item" key={revision.id}>
        <div className="item-row"><div><div className="item-title">Revision {revision.sequence} · {revision.lifecycle === "withdrawn" ? "Withdrawn" : revision.supportStatus === "supported" ? "Supported" : "Unsupported"}{revision.isCurrent ? " · Current" : ""}</div><div className="item-meta">{revision.claimTextPreview ?? "Claim withdrawn"}{revision.claimTextTruncated ? "…" : ""}</div></div><span className="status">{revision.totalSupportCount} supports · {revision.citationCandidateCount} citation candidates · {revision.distinctPaperCount} Papers</span></div>
        {revision.researcherNotePreview && <p className="item-meta">Note: {revision.researcherNotePreview}{revision.researcherNoteTruncated ? "…" : ""}</p>}
        <div className="item-meta">Evidence {revision.directEvidenceCount} · ExtractionRevision {revision.extractionRevisionCount} · SynthesisRevision {revision.synthesisRevisionCount} · finalized {new Date(revision.finalizedAt).toLocaleString()}</div>
        <Link className="button ghost small" href={revision.href}>Open exact Claim revision →</Link>
      </article>)}</div>}
      {history.hasMore && history.nextCursor && <div style={{ marginTop: 14 }}><Link className="button ghost" href={`/projects/${projectId}/claims/${claimId}/history?pageSize=${history.pageSize}&cursor=${encodeURIComponent(history.nextCursor)}`}>Next Claim history page →</Link></div>}
    </section>
  </div></div>;
}
