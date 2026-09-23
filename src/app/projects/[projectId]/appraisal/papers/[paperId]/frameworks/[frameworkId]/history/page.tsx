import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { CustomFrameworkBadge } from "@/components/CustomFrameworkBadge";
import { DomainError } from "@/domain/errors";

export default async function AppraisalHistoryPage({ params, searchParams }: { params: Promise<{ projectId: string; paperId: string; frameworkId: string }>; searchParams?: Promise<{ page?: string }> }) {
  const { projectId, paperId, frameworkId } = await params;
  const query = searchParams ? await searchParams : {};
  const page = Number(query.page) > 0 ? Number(query.page) : 1;
  let history;
  let appraisal;
  try {
    [history, appraisal] = await Promise.all([
      reviewServices.readAppraisalHistory(projectId, paperId, frameworkId, { page }),
      reviewServices.readPaperAppraisal(projectId, paperId, frameworkId),
    ]);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Critical appraisal · history</p><h1>{appraisal.paper.title}</h1><div className="item-row"><CustomFrameworkBadge /><span>{appraisal.framework.name} · immutable appraisal revisions</span></div></div><span className="status supported">● append-only</span></div>
    <div className="workspace-actions"><Link className="button secondary" href={`/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}`}>Back to worksheet</Link><Link className="button ghost" href={`/projects/${projectId}/appraisal`}>Appraisal queue</Link></div>
    {appraisal.historical && <div className="support-warning"><CustomFrameworkBadge /> The Paper is no longer finally included. These custom framework revisions remain readable as historical researcher work.</div>}
    <section className="card section-card"><div className="section-heading"><h2>Revision history</h2><span className="count">{history.revisions.length} shown</span></div>{history.revisions.length === 0 ? <div className="empty">No finalized appraisal revision exists for this Paper and framework.</div> : <div className="item-list">{history.revisions.map((revision) => <Link className="item" key={revision.id} href={`/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}/history/${revision.id}`}><div className="item-row"><div><div className="item-title">Revision {revision.revisionNumber} · framework version {revision.versionNumber} · {revision.versionLabel}</div><div className="item-meta">Finalized {revision.finalizedAt.toLocaleString()} · {revision.completion}{revision.currentWarningCount ? ` · ${revision.currentWarningCount} current Evidence drift warning${revision.currentWarningCount === 1 ? "" : "s"}` : ""}</div></div><span className="status supported">{revision.overallJudgementLabel ?? "No overall judgement"}</span></div></Link>)}</div>}{history.page > 1 && <Link className="button ghost" href={`/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}/history?page=${history.page - 1}`}>Newer revisions</Link>}{history.revisions.length === history.pageSize && <Link className="button ghost" href={`/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}/history?page=${history.page + 1}`}>Older revisions</Link>}</section>
    <p className="footer-note">Revision history preserves the exact framework version, eligibility decision identities, responses, rationale, and Evidence review snapshots used at each save.</p>
  </div></div>;
}
