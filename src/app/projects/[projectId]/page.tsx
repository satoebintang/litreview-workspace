import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, EmptyState, PageHeader, StatusBadge } from "@/components";
import { deriveProjectGuidance } from "@/application/project-workspace-read-services";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";
import { projectPrimaryHref } from "../route-contract";

type OverviewSearchParams = { error?: string };

function MetricCard({ title, href, children }: { title: string; href: string; children: React.ReactNode }) {
  return (
    <section className="card overview-card">
      <div className="section-heading"><h2>{title}</h2><Link className="text-link" href={href}>Open <span aria-hidden="true">→</span></Link></div>
      <dl className="overview-metrics">{children}</dl>
    </section>
  );
}

function Metric({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return <div className="overview-metric"><dt>{label}</dt><dd>{value}{note && <span className="hint">{note}</span>}</dd></div>;
}

export default async function ProjectOverviewPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<OverviewSearchParams> }) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let facts;
  try {
    facts = await reviewServices.getProjectOverview(projectId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }

  const guidance = deriveProjectGuidance({
    projectId,
    researchQuestionCount: facts.plan.researchQuestionCount,
    canonicalPaperCount: facts.papers.canonicalPaperCount,
    unresolvedDuplicatePairCount: facts.screening.unresolvedDuplicatePairCount,
    unscreenedPaperCount: facts.papers.unscreenedPaperCount,
    maybePaperCount: facts.papers.maybePaperCount,
    retrievalNotSoughtCount: facts.screening.retrievalNotSoughtCount,
    retrievalPendingCount: facts.screening.retrievalPendingCount,
    retrievalUnavailableCount: facts.screening.retrievalUnavailableCount,
    awaitingFullTextAssessmentCount: facts.screening.awaitingFullTextAssessmentCount,
    fullTextMaybeCount: facts.screening.fullTextMaybeCount,
    fullTextConflictCount: facts.screening.fullTextConflictCount,
    finallyIncludedPaperCount: facts.screening.finallyIncludedPaperCount,
    requiredFieldCount: facts.extraction.requiredFieldCount,
    aiExtractionSuggestionCount: facts.extraction.aiSuggestionAwaitingReviewCount,
    missingRequiredExtractionPaperCount: facts.extraction.missingRequiredExtractionPaperCount,
    evidenceCount: facts.evidence.evidenceCount,
    evidenceSetCount: facts.evidence.evidenceSetCount,
    aiSynthesisSuggestionCount: facts.synthesis.aiSuggestionAwaitingReviewCount,
    activePreparationCount: facts.synthesis.activePreparationCount,
    activeUnsupportedClaimCount: facts.writing.activeUnsupportedClaimCount,
    openEditorialThreadCount: facts.writing.openEditorialThreadCount,
    manuscriptWorkExists: facts.writing.manuscriptCount > 0 || facts.writing.snapshotCount > 0,
    nextAiExtractionHref: facts.extraction.nextAiSuggestionHref,
    nextAiSynthesisHref: facts.synthesis.nextAiSuggestionHref,
    nextPreparationHref: facts.synthesis.nextPreparationHref,
  });

  return (
    <div className="overview-page">
      <PageHeader
        eyebrow="Project overview"
        title={facts.project.title}
        description={facts.project.description ?? "A read-only view of the current research record and the next available work."}
        status={<StatusBadge tone="info">Operational guidance</StatusBadge>}
      />
      {query.error && <Alert tone="danger" title="Could not complete that action">{query.error}</Alert>}

      <section className="overview-guidance card" aria-labelledby="guidance-heading">
        <div className="section-heading"><div><p className="eyebrow">Attention</p><h2 id="guidance-heading">What to do next</h2></div><StatusBadge tone={guidance.length ? "warning" : "neutral"}>{guidance.length ? `${guidance.length} available` : "No pending recommendation"}</StatusBadge></div>
        {guidance.length > 0 ? (
          <div className="guidance-list">
            <div className="guidance-item guidance-item--recommended"><div><span className="eyebrow">Recommended next</span><strong>{guidance[0].label}</strong></div><Link className="button" href={guidance[0].href}>Open workspace <span aria-hidden="true">→</span></Link></div>
            {guidance.slice(1, 4).map((action) => <div className="guidance-item" key={action.key}><span>{action.label}</span><Link className="button ghost" href={action.href}>Open <span aria-hidden="true">→</span></Link></div>)}
          </div>
        ) : (
          <EmptyState title="Your workspace is ready for review" description="No immediate recommendation is pending. Use the workspace links below to inspect the current research record." />
        )}
      </section>

      <div className="overview-card-grid">
        <MetricCard title="Plan" href={projectPrimaryHref(projectId, "plan")}>
          <Metric label="Research Questions" value={facts.plan.researchQuestionCount} />
          <Metric label="Search strategies" value={facts.plan.searchStrategyCount} />
          <Metric label="SearchRuns" value={facts.plan.searchRunCount} />
        </MetricCard>
        <MetricCard title="Papers" href={projectPrimaryHref(projectId, "papers")}>
          <Metric label="Canonical Papers" value={facts.papers.canonicalPaperCount} />
        </MetricCard>
        <MetricCard title="Screening" href={projectPrimaryHref(projectId, "screen")}>
          <Metric label="Possible duplicate pairs" value={facts.screening.unresolvedDuplicatePairCount} />
          <Metric label="Unscreened" value={facts.papers.unscreenedPaperCount} />
          <Metric label="Awaiting full-text assessment" value={facts.screening.awaitingFullTextAssessmentCount} />
          <Metric label="Finally included" value={facts.screening.finallyIncludedPaperCount} />
        </MetricCard>
        <MetricCard title="Extraction" href={projectPrimaryHref(projectId, "extract")}>
          <Metric label="Required fields" value={facts.extraction.requiredFieldCount} />
          <Metric label="Papers missing a required value" value={facts.extraction.missingRequiredExtractionPaperCount} />
          <Metric label="AI suggestions awaiting review" value={facts.extraction.aiSuggestionAwaitingReviewCount} />
        </MetricCard>
        <MetricCard title="Synthesis" href={projectPrimaryHref(projectId, "synthesize")}>
          <Metric label="Active preparations" value={facts.synthesis.activePreparationCount} />
          <Metric label="Active synthesis statements" value={facts.synthesis.activeSynthesisStatementCount} />
          <Metric label="Finalized RQ Answers" value={facts.synthesis.finalizedAnswerCount} />
          <Metric label="AI suggestions awaiting review" value={facts.synthesis.aiSuggestionAwaitingReviewCount} />
        </MetricCard>
        <MetricCard title="Writing" href={projectPrimaryHref(projectId, "write")}>
          <Metric label="Active unsupported Claims" value={facts.writing.activeUnsupportedClaimCount} />
          <Metric label="Open editorial threads" value={facts.writing.openEditorialThreadCount} />
          <Metric label="Snapshots" value={facts.writing.snapshotCount} />
        </MetricCard>
      </div>

      <section className="workspace-shortcuts" aria-labelledby="workspace-shortcuts-heading">
        <div className="section-heading"><div><p className="eyebrow">Workspace</p><h2 id="workspace-shortcuts-heading">Open a workspace</h2></div></div>
        <div className="shortcut-grid">
          {[
            ["Plan", "Define Research Questions, protocol, and search runs.", "plan"],
            ["Papers", "Collect canonical Papers and choose an intake boundary.", "papers"],
            ["Screen", "Review duplicate, title/abstract, and full-text decisions.", "screen"],
            ["Extract", "Record structured values and review AI suggestions.", "extract"],
            ["Synthesize", "Curate Evidence Sets and write supported synthesis.", "synthesize"],
            ["Write", "Build the manuscript and continue editorial review.", "write"],
            ["Reports", "Inspect review-flow accounting and reporting views.", "reports"],
          ].map(([label, description, key]) => (
            <Link className="shortcut-card" href={projectPrimaryHref(projectId, key as "plan" | "papers" | "screen" | "extract" | "synthesize" | "write" | "reports")} key={key}>
              <strong>{label}</strong><span>{description}</span><span aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      </section>
      <p className="footer-note">Navigation, recommendations, and these metrics are presentation derived; they are not workflow state or provenance.</p>
    </div>
  );
}
