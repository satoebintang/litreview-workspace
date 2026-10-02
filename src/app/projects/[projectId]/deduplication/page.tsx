import Link from "next/link";
import { notFound } from "next/navigation";
import { confirmSameWorkAction, decideDifferentWorkAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import { idSchema } from "@/domain/validation";
import type { DeduplicationQueuePage } from "@/application/deduplication-read-types";

const reasonLabels: Record<string, string> = {
  normalized_doi: "DOI",
  same_source_record_id: "same source record ID",
  normalized_title_year: "title + year",
};

export default async function DeduplicationQueuePage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string; cursor?: string; pageSize?: string }>;
}) {
  const { projectId } = await params;
  if (!idSchema.safeParse(projectId).success) notFound();
  const query = searchParams ? await searchParams : {};
  let queue: DeduplicationQueuePage;
  let pageError = "";
  try {
    const requestedPageSize = query.pageSize === undefined ? undefined : Number(query.pageSize);
    queue = await reviewServices.listDeduplicationQueuePage(projectId, { pageSize: requestedPageSize, cursor: query.cursor ?? null }) as DeduplicationQueuePage;
  } catch (error) {
    if (error instanceof DomainError && error.code === "PROJECT_NOT_FOUND") notFound();
    if (error instanceof DomainError && error.code === "VALIDATION_ERROR") {
      pageError = error.message;
      queue = await reviewServices.listDeduplicationQueuePage(projectId) as DeduplicationQueuePage;
    } else throw error;
  }

  return <div className="project-page">
    <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Acquisition review · {queue.project.title}</p><h1>Deduplication queue</h1><p>Review candidate record pairs before they enter the canonical Paper population.</p></div><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Link prefetch={false} className="button secondary" href={`/projects/${projectId}/review-flow`}>Review flow →</Link><span className="status unsupported">{queue.items.length} shown</span></div></div>
      {pageError && <div className="error-banner" role="alert">{pageError}</div>}{query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">Deduplication decision recorded.</div>}
      <section className="card section-card full"><div className="section-heading"><h2>Unresolved candidate pairs</h2><span className="count">{queue.items.length} shown</span></div>
        <p className="hint">Candidates are conservative, derived from DOI, source record identity, or normalized title and year. A decision suppresses a pair from this queue while preserving its history.</p>
        {queue.items.length === 0 ? <div className="empty">No unresolved duplicate candidates on this page. New retrieved records will appear here when their fields match an existing record.</div> : <div className="item-list">{queue.items.map((item) => {
          const left = item.leftRetrievedRecord;
          const right = item.rightRetrievedRecord;
          const pairPath = `/projects/${projectId}/deduplication/${encodeURIComponent(left.id)}/${encodeURIComponent(right.id)}`;
          return <article className="item" key={`${left.id}:${right.id}`}>
            <div className="item-row"><div><span className={`status ${item.strength === "strong" ? "supported" : "unsupported"}`}>{item.strength} candidate</span><div className="item-meta" style={{ marginTop: 8 }}>{item.reasons.map((reason) => reasonLabels[reason] ?? reason).join(" · ")}</div></div><Link prefetch={false} className="button ghost" href={pairPath}>Inspect pair →</Link></div>
            <div className="workspace-grid" style={{ marginTop: 14 }}><div className="nested-support"><div className="item-title">Record A</div><div className="item-title">{left.title}</div><div className="item-meta">{left.authors || "Author details not captured"}{left.publicationYear ? ` · ${left.publicationYear}` : ""}</div>{left.doi && <div className="item-meta">DOI: {left.doi}</div>}{left.sourceRecordId && <div className="item-meta">Source ID: {left.sourceRecordId}</div>}<div className="item-meta">{left.currentPaperId ? `Current Paper: ${left.currentPaperId}` : left.mappingStatus === "unlinked" ? "Current mapping: unlinked" : "Unmatched"}</div></div><div className="nested-support"><div className="item-title">Record B</div><div className="item-title">{right.title}</div><div className="item-meta">{right.authors || "Author details not captured"}{right.publicationYear ? ` · ${right.publicationYear}` : ""}</div>{right.doi && <div className="item-meta">DOI: {right.doi}</div>}{right.sourceRecordId && <div className="item-meta">Source ID: {right.sourceRecordId}</div>}<div className="item-meta">{right.currentPaperId ? `Current Paper: ${right.currentPaperId}` : right.mappingStatus === "unlinked" ? "Current mapping: unlinked" : "Unmatched"}</div></div></div>
            <div className="inline-form" style={{ marginTop: 14 }}><form action={confirmSameWorkAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="leftRecordId" value={left.id} /><input type="hidden" name="rightRecordId" value={right.id} /><button className="button" type="submit">Same work</button></form><form action={decideDifferentWorkAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="leftRecordId" value={left.id} /><input type="hidden" name="rightRecordId" value={right.id} /><button className="button secondary" type="submit">Different work</button></form></div>
          </article>;
        })}</div>}
        <div className="item-row" style={{ marginTop: 16 }}><div style={{ display: "flex", gap: 8 }}>{queue.pageSize !== 25 && <Link prefetch={false} className="button ghost" href={`/projects/${projectId}/deduplication?pageSize=25`}>Show 25</Link>}{queue.pageSize !== 50 && <Link prefetch={false} className="button ghost" href={`/projects/${projectId}/deduplication?pageSize=50`}>Show 50</Link>}</div>{queue.hasMore && queue.nextCursor && <Link prefetch={false} className="button" href={`/projects/${projectId}/deduplication?pageSize=${queue.pageSize}&cursor=${encodeURIComponent(queue.nextCursor)}`}>Next page →</Link>}</div>
      </section>
      <p className="footer-note">Candidate reasons are advisory. Decisions and Paper resolution are explicit, append-only actions; no Paper merge or automated bulk adjudication is performed.</p>
    </div></div>;
}
