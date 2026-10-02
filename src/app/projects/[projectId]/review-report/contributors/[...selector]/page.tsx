import Link from "next/link";
import { notFound } from "next/navigation";
import { DomainError } from "@/domain/errors";
import {
  REVIEW_REPORT_METRIC_KEYS,
  type ReviewReportContributorSelector,
  type ReviewReportMetricKey,
} from "@/domain/review-report";
import { reviewServices } from "@/app/server";

const METRICS = new Set<string>(REVIEW_REPORT_METRIC_KEYS);
const SOURCE_METRICS = new Set(["runs", "reportedResults", "retrievedRecords", "resolvedRecords", "acquisitionPapers"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseSelector(parts: string[]): ReviewReportContributorSelector | null {
  if (parts.length === 2 && parts[0] === "metric" && METRICS.has(parts[1])) return { scope: "metric", metric: parts[1] as ReviewReportMetricKey };
  if (parts.length === 3 && parts[0] === "source" && UUID.test(parts[1]) && SOURCE_METRICS.has(parts[2])) return { scope: "source", sourceId: parts[1], metric: parts[2] as "runs" | "reportedResults" | "retrievedRecords" | "resolvedRecords" | "acquisitionPapers" };
  if (parts.length === 2 && parts[0] === "exclusion-reason" && UUID.test(parts[1])) return { scope: "exclusionReason", criterionId: parts[1] };
  if (parts.length === 2 && parts[0] === "full-text-exclusion-reason" && UUID.test(parts[1])) return { scope: "fullTextExclusionReason", criterionId: parts[1] };
  if (parts.length === 1 && parts[0] === "overlap") return { scope: "overlap" };
  return null;
}

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

function selectorPath(projectId: string, selector: ReviewReportContributorSelector): string {
  if (selector.scope === "metric") return `/projects/${projectId}/review-report/contributors/metric/${selector.metric}`;
  if (selector.scope === "source") return `/projects/${projectId}/review-report/contributors/source/${selector.sourceId}/${selector.metric}`;
  if (selector.scope === "exclusionReason") return `/projects/${projectId}/review-report/contributors/exclusion-reason/${selector.criterionId}`;
  if (selector.scope === "fullTextExclusionReason") return `/projects/${projectId}/review-report/contributors/full-text-exclusion-reason/${selector.criterionId}`;
  return `/projects/${projectId}/review-report/contributors/overlap`;
}

function selectorTitle(selector: ReviewReportContributorSelector): string {
  if (selector.scope === "metric") return `Metric: ${selector.metric}`;
  if (selector.scope === "source") return `SearchSource ${selector.metric}`;
  if (selector.scope === "exclusionReason") return "Title/abstract exclusion reason";
  if (selector.scope === "fullTextExclusionReason") return "Full-text exclusion reason";
  return "Cross-source overlap";
}

function itemHref(projectId: string, selector: ReviewReportContributorSelector, item: {
  kind: string;
  id: string;
  paperId?: string;
  searchRunId?: string;
  leftRecordId?: string;
  rightRecordId?: string;
}): string | null {
  if (item.kind === "searchRun") return `/projects/${projectId}/protocol/runs/${item.id}`;
  if (item.kind === "retrievedRecord" && item.searchRunId) return `/projects/${projectId}/protocol/runs/${item.searchRunId}/records/${item.id}`;
  if (item.kind === "deduplicationPair" && item.leftRecordId && item.rightRecordId) return `/projects/${projectId}/deduplication/${item.leftRecordId}/${item.rightRecordId}`;
  if (item.kind === "searchSource") return `/projects/${projectId}/protocol#sources`;
  if (item.kind === "screeningDecision" && item.paperId) return `/projects/${projectId}/screening/${item.paperId}`;
  if (item.kind === "fullTextScreeningDecision" && item.paperId) {
    if (selector.scope === "metric" && ["fullTextRetrieved", "fullTextUnavailable"].includes(selector.metric)) return `/projects/${projectId}/screening/full-text/retrieval/${item.paperId}`;
    return `/projects/${projectId}/screening/full-text/${item.paperId}`;
  }
  if (item.kind === "paper") {
    const paperId = item.paperId ?? item.id;
    if (selector.scope === "metric" && (selector.metric.startsWith("fullTextRetrieval") || ["fullTextNotSought", "fullTextRetrieved", "fullTextUnavailable", "fullTextSought", "fullTextEverSought", "fullTextEverRetrieved"].includes(selector.metric))) return `/projects/${projectId}/screening/full-text/retrieval/${paperId}`;
    if (selector.scope === "metric" && selector.metric === "legacyAnalysisAwaitingFullText") return `/projects/${projectId}/screening/full-text/${paperId}`;
    return `/projects/${projectId}/screening/${paperId}`;
  }
  return null;
}

export default async function ReviewReportContributorPage({ params, searchParams }: {
  params: Promise<{ projectId: string; selector: string[] }>;
  searchParams?: Promise<{ cursor?: string | string[]; pageSize?: string | string[] }>;
}) {
  const { projectId, selector: pathParts } = await params;
  const selector = parseSelector(pathParts);
  if (!selector) notFound();
  const query = searchParams ? await searchParams : {};
  const pageSize = parsePageSize(query.pageSize);
  const cursor = query.cursor === undefined ? undefined : scalar(query.cursor) ?? "";
  let page;
  try {
    page = await reviewServices.listReviewReportContributorPage(projectId, selector, { pageSize, cursor });
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const base = selectorPath(projectId, selector);
  const next = page.nextCursor ? `${base}?cursor=${encodeURIComponent(page.nextCursor)}&pageSize=${page.pageSize}` : null;
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Review Flow Report contributors</p><h1>{selectorTitle(selector)}</h1><p><strong>Contribution total:</strong> {page.contributionTotal}</p></div><Link prefetch={false} className="button secondary" href={`/projects/${projectId}/review-report`}>Back to Review Flow Report</Link></div>
    <section className="card section-card full"><div className="section-heading"><h2>Contributing items</h2><span className="count">page size {page.pageSize}</span></div>
      {page.items.length === 0 ? <div className="empty">No contributing items.</div> : <div className="item-list">{page.items.map((item) => {
        const href = itemHref(projectId, selector, item);
        const identity = item.kind === "fullTextScreeningDecision" && item.id === "" ? item.paperId : item.id;
        const key = `${item.kind}-${identity}`;
        const content = <><span>{item.label}{item.labelTruncated ? " · truncated preview" : ""}</span><strong>{item.contribution}</strong></>;
        return <article className="item" key={key}><div className="item-row">{href ? <Link prefetch={false} className="item-row" href={href}>{content}</Link> : content}</div><div className="item-meta">{item.kind}{"strength" in item && item.strength ? ` · ${item.strength}` : ""}</div></article>;
      })}</div>}
      <div className="section-heading" style={{ marginTop: 18 }}>
        <Link prefetch={false} className="button secondary" href={base}>Restart from first page</Link>
        {next && <Link prefetch={false} className="button secondary" href={next}>Next page →</Link>}
      </div>
      {page.hasMore && <p className="footer-note">More contributors are available. This page uses live keyset pagination.</p>}
    </section>
  </div></div>;
}
