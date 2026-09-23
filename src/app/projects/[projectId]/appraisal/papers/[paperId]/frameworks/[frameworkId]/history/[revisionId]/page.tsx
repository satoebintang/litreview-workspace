import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { AuditDetails } from "@/components";
import { CustomFrameworkBadge } from "@/components/CustomFrameworkBadge";
import { DomainError } from "@/domain/errors";

export default async function AppraisalRevisionDetailPage({ params }: { params: Promise<{ projectId: string; paperId: string; frameworkId: string; revisionId: string }> }) {
  const { projectId, paperId, frameworkId, revisionId } = await params;
  let revision;
  let version;
  try {
    revision = await reviewServices.readAppraisalRevision(projectId, revisionId);
    version = await reviewServices.readFrameworkVersion(projectId, revision.frameworkVersionId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  if (revision.paperId !== paperId || revision.frameworkId !== frameworkId || version.framework.id !== frameworkId) notFound();
  const responseByItem = new Map(revision.responses.map((response) => [response.frameworkItemId, response]));
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Critical appraisal · immutable revision</p><h1>Revision {revision.revisionNumber}</h1><div className="item-row"><CustomFrameworkBadge /><span>{version.framework.name} · version {version.version.versionNumber} · finalized {revision.finalizedAt.toLocaleString()}</span></div></div><span className={`status ${revision.historicalEligibility ? "unsupported" : "supported"}`}>{revision.historicalEligibility ? "historical eligibility" : "finally included at save"}</span></div>
    <div className="workspace-actions"><Link className="button secondary" href={`/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}/history`}>Back to history</Link><Link className="button ghost" href={`/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}`}>Open worksheet</Link><Link className="button ghost" href={`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${version.version.id}`}>View framework version</Link></div>
    <section className="card section-card"><div className="section-heading"><h2>Frozen provenance</h2><span className="count">Revision {revision.revisionNumber}</span></div><div className="item-meta">Framework version {version.version.versionNumber} · {version.version.versionLabel}</div>{revision.overallJudgementLabel && <div className="item-meta">Overall judgement: {revision.overallJudgementLabel}</div>}{revision.overallRationale && <p>{revision.overallRationale}</p>}<AuditDetails items={[{ label: "Revision identity", value: revision.id }, { label: "Framework version identity", value: revision.frameworkVersionId }, { label: "Title/abstract decision identity", value: revision.titleAbstractDecisionId }, { label: "Full-text decision identity", value: revision.fullTextDecisionId }]} /></section>
    {version.sections.map((section) => <section className="card section-card" key={section.id}><div className="section-heading"><h2>{section.label}</h2><span className="count">Exact framework prompts</span></div><div className="item-list">{version.items.filter((item) => item.sectionId === section.id).map((item) => { const response = responseByItem.get(item.id); return <article className="item" key={item.id}><div className="item-title">{item.prompt}</div>{item.guidance && <div className="hint">{item.guidance}</div>}<div className="item-meta">Response: {response?.selectedOptionLabel ?? "Not selected"}</div>{response?.rationale && <p>{response.rationale}</p>}{response?.evidence.map((entry) => <div className="support-warning" key={entry.id}><strong>Evidence p. {entry.pageNumber}</strong> · saved review state {entry.evidenceReviewStateAtSave}{entry.currentReviewWarning ? ` · ${entry.currentReviewWarning}` : ""}<p className="quote">“{entry.sourceText}”</p>{entry.note && <div className="item-meta">{entry.note}</div>}<AuditDetails items={[{ label: "Evidence identity", value: entry.evidenceId }]} /></div>)}</article>; })}</div></section>)}
    <p className="footer-note">This page is a read-only snapshot. Current Evidence curation warnings are displayed as context and never rewrite the saved revision.</p>
  </div></div>;
}
