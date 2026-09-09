import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

type Summary = {
  distinctSearchRuns: number;
  reportedResultsTotal: number;
  retrievedRecords: number;
  distinctSources: number;
  currentlyResolvedRecords: number;
  unresolvedRecords: number;
  unresolvedDuplicatePairs: number;
  sameWorkDecisionPairs: number;
  differentWorkDecisionPairs: number;
  acquisitionDerivedPapers: number;
  duplicateRecordsCollapsed: number;
  papersInScreeningPopulation: number;
  unscreened: number;
  included: number;
  excluded: number;
  maybe: number;
  fullTextEligible: number;
  fullTextAwaiting: number;
  fullTextAssessed: number;
  fullTextIncluded: number;
  fullTextExcluded: number;
  fullTextMaybe: number;
  fullTextConflicts: number;
  finallyIncluded: number;
  legacyAnalysisAwaitingFullText: number;
  historicalAcquisitionOnlyPapers: number;
  manualPapers: number;
  exclusionReasons: Array<{ criterionId: string; text: string; count: number }>;
};

function Metric({ label, value, href, hint }: { label: string; value: number; href?: string; hint?: string }) {
  const content = <><span>{label}</span><strong>{value}</strong>{hint && <small className="hint">{hint}</small>}</>;
  return href ? <Link className="screening-stat" href={href}>{content}</Link> : <div className="screening-stat">{content}</div>;
}

export default async function ReviewFlowPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const summary = await reviewServices.getReviewFlowSummary(projectId) as Summary;
  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}`}>← Back to workspace</Link>
      <div className="workspace-header"><div><p className="eyebrow">Derived project accounting · {project.title}</p><h1>Review flow</h1><p>Live counts derived from search runs, retrieved records, Paper resolution, and screening history.</p></div><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Link className="button secondary" href={`/projects/${projectId}/review-report`}>Open review report →</Link><Link className="button secondary" href={`/projects/${projectId}/deduplication`}>Open deduplication queue →</Link></div></div>
      <section className="card section-card full"><div className="section-heading"><h2>Identification</h2><span className="count">reported results are not unique studies</span></div><div className="screening-stats"><Metric label="Reported results" value={summary.reportedResultsTotal} hint="sum of immutable run reports" /><Metric label="Retrieved records entered" value={summary.retrievedRecords} /><Metric label="Search runs" value={summary.distinctSearchRuns} /><Metric label="Sources used" value={summary.distinctSources} /></div></section>
      <section className="card section-card full"><div className="section-heading"><h2>Deduplication</h2><span className="count">current acquisition state</span></div><div className="screening-stats"><Metric label="Resolved records" value={summary.currentlyResolvedRecords} /><Metric label="Unresolved records" value={summary.unresolvedRecords} /><Metric label="Unresolved candidate pairs" value={summary.unresolvedDuplicatePairs} href={`/projects/${projectId}/deduplication`} /><Metric label="Acquisition Papers" value={summary.acquisitionDerivedPapers} /><Metric label="Collapsed records" value={summary.duplicateRecordsCollapsed} hint="resolved records minus acquisition Papers" /><Metric label="Same-work decisions" value={summary.sameWorkDecisionPairs} /><Metric label="Different-work decisions" value={summary.differentWorkDecisionPairs} /></div></section>
      <section className="card section-card full"><div className="section-heading"><h2>Screening</h2><span className="count">all canonical Papers, including manual Papers</span></div><div className="screening-stats"><Metric label="Screening population" value={summary.papersInScreeningPopulation} href={`/projects/${projectId}/screening`} /><Metric label="Unscreened" value={summary.unscreened} href={`/projects/${projectId}/screening?state=unscreened`} /><Metric label="Included" value={summary.included} href={`/projects/${projectId}/screening?state=included`} /><Metric label="Excluded" value={summary.excluded} href={`/projects/${projectId}/screening?state=excluded`} /><Metric label="Maybe" value={summary.maybe} href={`/projects/${projectId}/screening?state=maybe`} /></div>{summary.exclusionReasons.length > 0 && <div className="nested-support" style={{ marginTop: 18 }}><div className="item-meta">Current exclusion reasons</div><div className="item-list">{summary.exclusionReasons.map((reason) => <div className="item-row" key={reason.criterionId}><span>{reason.text}</span><strong>{reason.count}</strong></div>)}</div></div>}</section>
      <section className="card section-card full"><div className="section-heading"><h2>Full-text eligibility</h2><span className="count">only current title/abstract-included Papers contribute</span></div><div className="screening-stats"><Metric label="Full-text eligible" value={summary.fullTextEligible} href={`/projects/${projectId}/screening/full-text`} /><Metric label="Awaiting full text" value={summary.fullTextAwaiting} href={`/projects/${projectId}/screening/full-text?state=awaiting`} /><Metric label="Assessed" value={summary.fullTextAssessed} /><Metric label="Included" value={summary.fullTextIncluded} href={`/projects/${projectId}/screening/full-text?state=included`} /><Metric label="Excluded" value={summary.fullTextExcluded} href={`/projects/${projectId}/screening/full-text?state=excluded`} /><Metric label="Maybe" value={summary.fullTextMaybe} href={`/projects/${projectId}/screening/full-text?state=maybe`} /><Metric label="Conflicts" value={summary.fullTextConflicts} href={`/projects/${projectId}/screening/full-text?state=conflict`} /><Metric label="Finally included" value={summary.finallyIncluded} href={`/projects/${projectId}/extraction`} /></div><p className="footer-note">Historical analysis awaiting full-text review: {summary.legacyAnalysisAwaitingFullText}.</p></section>
      <section className="card section-card full"><div className="section-heading"><h2>Paper provenance classification</h2><span className="count">derived from current links</span></div><div className="screening-stats"><Metric label="Manual Papers" value={summary.manualPapers} /><Metric label="Historical-only acquisition Papers" value={summary.historicalAcquisitionOnlyPapers} hint="no current record link" /></div><p className="footer-note">This is a review-flow summary, not a PRISMA diagram or persisted snapshot. Clickable metrics identify the relevant existing workspace population.</p></section>
    </div></main>;
}
