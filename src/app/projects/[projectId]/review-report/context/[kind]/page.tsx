import Link from "next/link";
import { notFound } from "next/navigation";
import { DomainError } from "@/domain/errors";
import type { ReviewReportContextKind, ReviewReportContextPageItem } from "@/domain/review-report";
import { reviewServices } from "@/app/server";

const TITLES: Record<ReviewReportContextKind, string> = {
  questions: "Active Research Questions",
  "screening-criteria": "Active Screening Criteria",
  "full-text-criteria": "Active Full-text Criteria",
  sources: "Represented SearchSources",
  "exclusion-reasons": "Title/Abstract Exclusion Reasons",
  "full-text-exclusion-reasons": "Full-text Exclusion Reasons",
};
const VALID_KINDS = new Set<string>(Object.keys(TITLES));

function scalar(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePageSize(value: string | string[] | undefined): number | undefined {
  if (value === undefined) return undefined;
  const raw = scalar(value);
  if (raw === undefined) return Number.NaN;
  if (!/^[0-9]+$/.test(raw)) return Number.NaN;
  return Number(raw);
}

function truncated(flag: boolean): string { return flag ? " · truncated preview" : ""; }

function ContextItem({ projectId, item }: { projectId: string; item: ReviewReportContextPageItem }) {
  if (item.kind === "question") return <article className="item"><div className="item-title">{item.identifier}: {item.label}</div><div className="item-meta">Research Question{truncated(item.identifierTruncated || item.labelTruncated)}</div></article>;
  if (item.kind === "screeningCriterion") return <article className="item"><div className="item-meta">{item.criterionType}</div><div className="item-title">{item.text}{truncated(item.textTruncated)}</div></article>;
  if (item.kind === "fullTextCriterion") return <article className="item"><div className="item-title">{item.text}{truncated(item.textTruncated)}</div></article>;
  if (item.kind === "searchSource") return <article className="item">
    <div className="item-row"><div><div className="item-title">{item.displayName}{truncated(item.displayNameTruncated)}</div><div className="item-meta">{item.sourceKey}{truncated(item.sourceKeyTruncated)}{item.archived ? " · archived configuration" : ""}</div></div><strong>SearchSource</strong></div>
    <div className="item-list" style={{ marginTop: 8 }}>
      {(["runs", "reportedResults", "retrievedRecords", "resolvedRecords", "acquisitionPapers"] as const).map((metric) => <Link prefetch={false} className="item-row" key={metric} href={`/projects/${projectId}/review-report/contributors/source/${item.id}/${metric}`}><span>{metric}</span><strong>Open contributors</strong></Link>)}
    </div>
  </article>;
  const path = item.kind === "exclusionReason"
    ? `/projects/${projectId}/review-report/contributors/exclusion-reason/${item.criterionId}`
    : `/projects/${projectId}/review-report/contributors/full-text-exclusion-reason/${item.criterionId}`;
  return <Link prefetch={false} className="item-row" href={path}>
    <span>{item.text}{item.archived ? " (criterion archived)" : ""}{truncated(item.textTruncated)}</span><strong>{item.count}</strong>
  </Link>;
}

export default async function ReviewReportContextPage({ params, searchParams }: {
  params: Promise<{ projectId: string; kind: string }>;
  searchParams?: Promise<{ cursor?: string | string[]; pageSize?: string | string[] }>;
}) {
  const { projectId, kind: rawKind } = await params;
  if (!VALID_KINDS.has(rawKind)) notFound();
  const kind = rawKind as ReviewReportContextKind;
  const query = searchParams ? await searchParams : {};
  const pageSize = parsePageSize(query.pageSize);
  const cursor = query.cursor === undefined ? undefined : scalar(query.cursor) ?? "";
  let page;
  try {
    page = await reviewServices.listReviewReportContextPage(projectId, kind, { pageSize, cursor });
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const base = `/projects/${projectId}/review-report/context/${kind}`;
  const next = page.nextCursor ? `${base}?cursor=${encodeURIComponent(page.nextCursor)}&pageSize=${page.pageSize}` : null;
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Review Flow Report context</p><h1>{TITLES[kind]}</h1><p>Showing up to {page.pageSize} entries in the released order.</p></div><Link prefetch={false} className="button secondary" href={`/projects/${projectId}/review-report`}>Back to Review Flow Report</Link></div>
    <section className="card section-card full"><div className="item-list">
      {page.items.length === 0 ? <div className="empty">No entries in this context collection.</div> : page.items.map((item) => <ContextItem key={item.kind === "exclusionReason" || item.kind === "fullTextExclusionReason" ? item.criterionId : item.id} projectId={projectId} item={item} />)}
    </div>
      <div className="section-heading" style={{ marginTop: 18 }}>
        <Link prefetch={false} className="button secondary" href={base}>Restart from first page</Link>
        {next && <Link prefetch={false} className="button secondary" href={next}>Next page →</Link>}
      </div>
      {page.hasMore && <p className="footer-note">More entries are available. Pagination uses a live keyset over the released order.</p>}
    </section>
  </div></div>;
}
