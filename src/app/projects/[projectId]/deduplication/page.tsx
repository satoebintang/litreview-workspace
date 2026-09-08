import Link from "next/link";
import { notFound } from "next/navigation";
import { confirmSameWorkAction, decideDifferentWorkAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

type RecordSide = {
  id: string;
  title: string;
  authors: string[];
  publicationYear: number | null;
  doi: string | null;
  sourceRecordId: string | null;
};
type QueueItem = {
  leftRetrievedRecord: RecordSide;
  rightRetrievedRecord: RecordSide;
  reasons: string[];
  strength: "strong" | "possible";
  leftPaperId: string | null;
  rightPaperId: string | null;
};

const reasonLabels: Record<string, string> = {
  normalized_doi: "DOI",
  same_source_record_id: "same source record ID",
  normalized_title_year: "title + year",
};

export default async function DeduplicationQueuePage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const [queue, summary] = await Promise.all([
    reviewServices.listDeduplicationQueue(projectId),
    reviewServices.getReviewFlowSummary(projectId),
  ]) as unknown as [QueueItem[], { unresolvedDuplicatePairs: number; unresolvedRecords: number }];

  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}`}>← Back to workspace</Link>
      <div className="workspace-header"><div><p className="eyebrow">Acquisition review · {project.title}</p><h1>Deduplication queue</h1><p>Review candidate record pairs before they enter the canonical Paper population.</p></div><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Link className="button secondary" href={`/projects/${projectId}/review-flow`}>Review flow →</Link><span className="status unsupported">{summary.unresolvedDuplicatePairs} unresolved pairs</span></div></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">Deduplication decision recorded.</div>}
      <section className="card section-card full"><div className="section-heading"><h2>Unresolved candidate pairs</h2><span className="count">{queue.length} shown · {summary.unresolvedRecords} records still unmatched</span></div>
        <p className="hint">Candidates are conservative, derived from DOI, source record identity, or normalized title and year. A decision suppresses a pair from this queue while preserving its history.</p>
        {queue.length === 0 ? <div className="empty">No unresolved duplicate candidates. New retrieved records will appear here when their fields match an existing record.</div> : <div className="item-list">{queue.map((item) => {
          const left = item.leftRetrievedRecord;
          const right = item.rightRetrievedRecord;
          const pairPath = `/projects/${projectId}/deduplication/${left.id}/${right.id}`;
          return <article className="item" key={`${left.id}:${right.id}`}>
            <div className="item-row"><div><span className={`status ${item.strength === "strong" ? "supported" : "unsupported"}`}>{item.strength} candidate</span><div className="item-meta" style={{ marginTop: 8 }}>{item.reasons.map((reason) => reasonLabels[reason] ?? reason).join(" · ")}</div></div><Link className="button ghost" href={pairPath}>Inspect pair →</Link></div>
            <div className="workspace-grid" style={{ marginTop: 14 }}><div className="nested-support"><div className="item-title">Record A</div><div className="item-title">{left.title}</div><div className="item-meta">{left.authors.join(", ") || "Author details not captured"}{left.publicationYear ? ` · ${left.publicationYear}` : ""}</div>{left.doi && <div className="item-meta">DOI: {left.doi}</div>}{left.sourceRecordId && <div className="item-meta">Source ID: {left.sourceRecordId}</div>}<div className="item-meta">{item.leftPaperId ? `Current Paper: ${item.leftPaperId}` : "Unmatched"}</div></div><div className="nested-support"><div className="item-title">Record B</div><div className="item-title">{right.title}</div><div className="item-meta">{right.authors.join(", ") || "Author details not captured"}{right.publicationYear ? ` · ${right.publicationYear}` : ""}</div>{right.doi && <div className="item-meta">DOI: {right.doi}</div>}{right.sourceRecordId && <div className="item-meta">Source ID: {right.sourceRecordId}</div>}<div className="item-meta">{item.rightPaperId ? `Current Paper: ${item.rightPaperId}` : "Unmatched"}</div></div></div>
            <div className="inline-form" style={{ marginTop: 14 }}><form action={confirmSameWorkAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="leftRecordId" value={left.id} /><input type="hidden" name="rightRecordId" value={right.id} /><button className="button" type="submit">Same work</button></form><form action={decideDifferentWorkAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="leftRecordId" value={left.id} /><input type="hidden" name="rightRecordId" value={right.id} /><button className="button secondary" type="submit">Different work</button></form></div>
          </article>;
        })}</div>}
      </section>
      <p className="footer-note">Candidate reasons are advisory. Decisions and Paper resolution are explicit, append-only actions; no Paper merge or automated bulk adjudication is performed.</p>
    </div></main>;
}
