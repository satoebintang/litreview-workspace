import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { CustomFrameworkBadge } from "@/components/CustomFrameworkBadge";
import { FocusedErrorSummary } from "@/components/FocusedErrorSummary";
import { DomainError } from "@/domain/errors";

export default async function AppraisalFrameworksPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<{ error?: string }> }) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const frameworks = await reviewServices.listAppraisalFrameworks(projectId);
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Critical appraisal</p><h1>Custom frameworks</h1><p>{project.title} · define the exact researcher-authored vocabulary and prompts</p></div><CustomFrameworkBadge /></div>
    {query.error && <FocusedErrorSummary message={query.error} />}
    <div className="workspace-actions"><Link className="button" href={`/projects/${projectId}/appraisal/frameworks/new`}>Create custom framework</Link><Link className="button secondary" href={`/projects/${projectId}/appraisal`}>Back to appraisal queue</Link></div>
    <section className="card section-card"><div className="section-heading"><h2>Framework definitions</h2><span className="count">{frameworks.length}</span></div>
      {frameworks.length === 0 ? <div className="empty">No custom framework exists yet.</div> : <div className="item-list">{frameworks.map((framework) => <Link className="item" href={`/projects/${projectId}/appraisal/frameworks/${framework.id}`} key={framework.id}><div className="item-row"><div><div className="item-title">{framework.name}</div><div className="item-row"><CustomFrameworkBadge /><span className="item-meta">Created {framework.createdAt.toLocaleString()}</span></div></div><span className={`status ${framework.archivedAt ? "unsupported" : "supported"}`}>{framework.archivedAt ? "archived" : "active"}</span></div><div className="item-meta">{framework.latestFinalizedVersion ? `Latest finalized: version ${framework.latestFinalizedVersion.versionNumber} · ${framework.latestFinalizedVersion.versionLabel}` : "No finalized version"}{framework.draftVersion ? ` · Draft version ${framework.draftVersion.versionNumber}` : ""}</div></Link>)}</div>}
    </section>
    <p className="footer-note">Tracework does not verify licensing or official compatibility. Enter only content you are authorized to use, and keep source and rights notes attached to the exact framework version.</p>
  </div></div>;
}
