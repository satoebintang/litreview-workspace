import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { REVIEW_REPORT_METRIC_KEYS, type ReviewReportMetric } from "@/domain/review-report";
import { reviewServices } from "@/app/server";

const metricKeys = new Set<string>(REVIEW_REPORT_METRIC_KEYS);
const sourceMetricKeys = new Set(["runs", "reportedResults", "retrievedRecords", "resolvedRecords", "acquisitionPapers"]);

function queryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function metricHref(projectId: string, item: ReviewReportMetric): string | undefined {
  return item.support === "unsupported" ? undefined : `/projects/${projectId}/review-report/contributors/metric/${item.key}`;
}

function Metric({ projectId, item }: { projectId: string; item: ReviewReportMetric }) {
  const href = metricHref(projectId, item);
  const content = <><span>{item.label}</span><strong>{item.value}</strong></>;
  return href
    ? <Link prefetch={false} className="item-row" href={href} title={item.explanation}>{content}</Link>
    : <div className="item-row" title={item.explanation}><span>{item.label}</span><strong>Unsupported</strong></div>;
}

function MetricSection({ projectId, title, note, metrics }: { projectId: string; title: string; note: string; metrics: ReviewReportMetric[] }) {
  return <section className="card section-card full">
    <div className="section-heading"><h2>{title}</h2><span className="count">{note}</span></div>
    <div className="item-list">{metrics.map((item) => <div className="item" key={item.key}><Metric projectId={projectId} item={item} /></div>)}</div>
  </section>;
}

function ReasonList({ projectId, title, kind, items, nextCursor }: {
  projectId: string;
  title: string;
  kind: "exclusion-reasons" | "full-text-exclusion-reasons";
  items: Array<{ criterionId: string; text: string; textTruncated: boolean; archived: boolean; count: number }>;
  nextCursor: string | null;
}) {
  const contributorRoot = kind === "exclusion-reasons" ? "exclusion-reason" : "full-text-exclusion-reason";
  return <div className="nested-support">
    <div className="section-heading"><h3>{title}</h3><span className="count">current contributing reasons</span></div>
    {items.length === 0 ? <div className="empty">No current exclusions.</div> : <div className="item-list">
      {items.map((reason) => <Link prefetch={false} className="item-row" key={reason.criterionId} href={`/projects/${projectId}/review-report/contributors/${contributorRoot}/${reason.criterionId}`}>
        <span>{reason.text}{reason.textTruncated ? " · truncated preview" : ""}{reason.archived ? " (criterion archived)" : ""}</span><strong>{reason.count}</strong>
      </Link>)}
    </div>}
    <Link prefetch={false} className="button secondary" style={{ marginTop: 10 }} href={`/projects/${projectId}/review-report/context/${kind}`}>Browse all reasons →</Link>
    {nextCursor && <Link prefetch={false} className="button secondary" style={{ marginTop: 10, marginLeft: 8 }} href={`/projects/${projectId}/review-report/context/${kind}?cursor=${encodeURIComponent(nextCursor)}&pageSize=10`}>Next reason page →</Link>}
  </div>;
}

export default async function ReviewReportPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};

  // Preserve the released selector precedence and redirect before any summary query.
  const metric = queryValue(query.metric);
  const sourceId = queryValue(query.sourceId);
  const sourceMetric = queryValue(query.sourceMetric);
  const criterionId = queryValue(query.criterionId);
  const fullTextCriterionId = queryValue(query.fullTextCriterionId);
  const overlap = queryValue(query.overlap);
  if (metric && metricKeys.has(metric)) redirect(`/projects/${projectId}/review-report/contributors/metric/${metric}`);
  if (sourceId && sourceMetric && sourceMetricKeys.has(sourceMetric)) redirect(`/projects/${projectId}/review-report/contributors/source/${sourceId}/${sourceMetric}`);
  if (criterionId) redirect(`/projects/${projectId}/review-report/contributors/exclusion-reason/${criterionId}`);
  if (fullTextCriterionId) redirect(`/projects/${projectId}/review-report/contributors/full-text-exclusion-reason/${fullTextCriterionId}`);
  if (overlap === "1") redirect(`/projects/${projectId}/review-report/contributors/overlap`);

  let report;
  try {
    report = await reviewServices.getInteractiveReviewReportSummary(projectId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }

  return <div className="project-page">
    <div className="container workspace">
      <div className="workspace-header"><div><p className="eyebrow">Derived reporting projection · {report.project.title}</p><h1>Review Flow Report</h1><p>PRISMA-oriented reporting over recorded acquisition, resolution, and screening facts. This report does not claim formal PRISMA 2020 compliance.</p></div><Link prefetch={false} className="button secondary" href={`/projects/${projectId}/review-report/export`}>Download complete Markdown</Link></div>

      <section className="card section-card full"><div className="section-heading"><h2>Research Questions</h2><span className="count">{report.contextCounts.activeResearchQuestions} active</span></div><p className="hint">Questions are loaded only when you open the context page.</p><Link prefetch={false} className="button secondary" href={`/projects/${projectId}/review-report/context/questions`}>Browse active questions →</Link></section>
      <section className="card section-card full"><div className="section-heading"><h2>Current Screening Criteria</h2><span className="count">{report.contextCounts.activeScreeningCriteria} active</span></div><p className="hint">Criteria are loaded only when you open the context page.</p><Link prefetch={false} className="button secondary" href={`/projects/${projectId}/review-report/context/screening-criteria`}>Browse screening criteria →</Link></section>
      <section className="card section-card full"><div className="section-heading"><h2>Current Full-text Criteria</h2><span className="count">{report.contextCounts.activeFullTextCriteria} active</span></div><p className="hint">Criteria are loaded only when you open the context page.</p><Link prefetch={false} className="button secondary" href={`/projects/${projectId}/review-report/context/full-text-criteria`}>Browse full-text criteria →</Link></section>

      <MetricSection projectId={projectId} title="Search Identification" note="reported results are not unique records" metrics={report.identification.metrics} />
      <section className="card section-card full"><div className="section-heading"><h2>Cross-source overlap</h2><span className="count">current linked state</span></div><Link prefetch={false} className="item-row" href={`/projects/${projectId}/review-report/contributors/overlap`}><span>Papers linked through more than one SearchSource</span><strong>{report.identification.overlappingPaperCount}</strong></Link><p className="footer-note">Historical-only acquisition links do not contribute to this count.</p></section>
      <section className="card section-card full"><div className="section-heading"><h2>By SearchSource</h2><span className="count">{report.contextCounts.representedSearchSources} represented</span></div><p className="hint">Source identities and contributor pages load on demand. Archived sources represented by recorded SearchRuns remain visible.</p><Link prefetch={false} className="button secondary" href={`/projects/${projectId}/review-report/context/sources`}>Browse represented SearchSources →</Link></section>

      <MetricSection projectId={projectId} title="Deduplication and Paper Resolution" note="current derived state" metrics={report.deduplication.metrics} />
      <section className="card section-card full"><div className="section-heading"><h2>Title/Abstract Screening</h2><span className="count">current state of canonical Papers</span></div><div className="item-list">{report.screening.metrics.map((item) => <div className="item" key={item.key}><Metric projectId={projectId} item={item} /></div>)}</div><ReasonList projectId={projectId} title="Current title/abstract exclusion reasons" kind="exclusion-reasons" items={report.screening.exclusionReasons.items} nextCursor={report.screening.exclusionReasons.nextCursor} /></section>
      <section className="card section-card full"><div className="section-heading"><h2>Full-text Eligibility</h2><span className="count">stage-specific current projection</span></div><div className="item-list">{report.fullTextEligibility.metrics.map((item) => <div className="item" key={item.key}><Metric projectId={projectId} item={item} /></div>)}</div><ReasonList projectId={projectId} title="Current full-text exclusion reasons" kind="full-text-exclusion-reasons" items={report.fullTextEligibility.exclusionReasons.items} nextCursor={report.fullTextEligibility.exclusionReasons.nextCursor} /></section>
      <MetricSection projectId={projectId} title="Full-text Retrieval" note="current state plus separate historical facts" metrics={report.fullTextRetrieval.metrics} />
      <p className="footer-note">Ever retrieved remains true when a later attempt is unavailable. Current unavailable is not a claim that a Paper was never retrieved.</p>
      <MetricSection projectId={projectId} title="Final Eligibility" note="analytical write boundary" metrics={report.finalEligibility.metrics} />

      <section className="card section-card full"><div className="section-heading"><h2>Reporting Support and Limitations</h2><span className="count">model-derived</span></div><div className="item-list">{report.supportMatrix.map((mapping) => <div className="item" key={mapping.key}><div className="item-row"><span>{mapping.label}</span><strong className={`status ${mapping.support === "unsupported" ? "unsupported" : mapping.support === "partially_supported" ? "maybe" : "supported"}`}>{mapping.support}</strong></div><div className="item-meta">{mapping.explanation}</div></div>)}{report.limitations.map((item) => <div className="item" key={item.code}><div className="item-meta">{item.message}</div></div>)}</div></section>
      <section className="card section-card full"><div className="section-heading"><h2>Acquisition browsing</h2><span className="count">bounded summary above</span></div><p className="hint">Open Protocol to page through exact SearchRun snapshots and RetrievedRecords. The complete Markdown export retains the full SearchRun appendix and historical source labels.</p><Link prefetch={false} className="button secondary" href={`/projects/${projectId}/protocol`}>Open Protocol ledger →</Link></section>
      <p className="footer-note">This report is derived on demand. It does not create report state, alter workflow history, or claim formal PRISMA compliance.</p>
    </div>
  </div>;
}
