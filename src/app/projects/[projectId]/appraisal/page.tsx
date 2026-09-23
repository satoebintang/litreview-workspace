import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { CustomFrameworkBadge } from "@/components/CustomFrameworkBadge";
import { FocusedErrorSummary } from "@/components/FocusedErrorSummary";
import { DomainError } from "@/domain/errors";

export default async function AppraisalDashboardPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; frameworkId?: string; baseState?: string; paperTitle?: string; attention?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const [frameworks, status] = await Promise.all([
    reviewServices.listAppraisalFrameworks(projectId),
    reviewServices.listPaperAppraisalStatus(projectId, { frameworkId: query.frameworkId, baseState: query.baseState, paperTitle: query.paperTitle, attention: query.attention }),
  ]);

  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Extract · appraisal</p><h1>Critical appraisal</h1><p>{project.title} · researcher-authored judgements for finally included Papers</p></div><div className="item-row"><CustomFrameworkBadge /><span className="status supported">appraisal only</span></div></div>
    {query.error && <FocusedErrorSummary message={query.error} />}
    <div className="workspace-actions"><Link className="button" href={`/projects/${projectId}/appraisal/frameworks/new`}>Create custom framework</Link><Link className="button secondary" href={`/projects/${projectId}/appraisal/frameworks`}>Manage frameworks</Link></div>
    <section className="card section-card"><div className="section-heading"><div><h2>Paper × Framework work queue</h2><p className="hint">Completion is derived from the exact saved revision. Historical, archived, and newer-version flags are independent context.</p></div><span className="count">{status.totalCount} rows</span></div>
      {status.rows.length === 0 ? <div className="empty">No appraisal rows yet. Finalize a custom framework and include a Paper to begin.</div> : <div className="item-list">
        {status.rows.map((row) => <article className="item" key={`${row.paperId}-${row.frameworkId}`}>
          <div className="item-row"><div><div className="item-title">{row.paperTitle}</div><div className="item-row"><CustomFrameworkBadge /><span className="item-meta">{row.frameworkName} · {row.versionNumber == null ? "No assessment version" : `version ${row.versionNumber}${row.versionLabel ? ` · ${row.versionLabel}` : ""}`}</span></div></div><span className={`status ${row.baseState === "complete" ? "supported" : "unsupported"}`}>{row.baseState.replace("_", " ")}</span></div>
          <div className="item-meta">{row.overallJudgement ? `Overall judgement: ${row.overallJudgement}` : "No overall judgement"}{row.lastSavedAt ? ` · saved ${row.lastSavedAt.toLocaleString()}` : ""}</div>
          <div className="tag-row">{row.historical && <span className="status unsupported">Historical — Paper no longer included</span>}{row.frameworkArchived && <span className="status unsupported">Framework archived</span>}{row.newerVersionAvailable && <span className="status unsupported">Newer framework version available</span>}</div>
          <div className="item-actions"><Link className="button ghost" href={`/projects/${projectId}/appraisal/papers/${row.paperId}/frameworks/${row.frameworkId}`}>{row.revisionId ? "Open worksheet" : "Start appraisal"}</Link>{row.revisionId && <Link className="button ghost" href={`/projects/${projectId}/appraisal/papers/${row.paperId}/frameworks/${row.frameworkId}/history`}>History</Link>}</div>
        </article>)}
      </div>}
    </section>
    <section className="card section-card"><div className="section-heading"><h2>Frameworks</h2><span className="count">{frameworks.length}</span></div>
      {frameworks.length === 0 ? <p className="hint">There are no custom frameworks yet. Tracework does not ship official RoB, JBI, CASP, or GRADE content.</p> : <div className="item-list">{frameworks.map((framework) => <Link className="item" key={framework.id} href={`/projects/${projectId}/appraisal/frameworks/${framework.id}`}><div className="item-row"><div><div className="item-title">{framework.name}</div><div className="item-row"><CustomFrameworkBadge /><span className="item-meta">{framework.latestFinalizedVersion ? `latest finalized version ${framework.latestFinalizedVersion.versionNumber}` : "no finalized version"}</span></div></div><span className={`status ${framework.archivedAt ? "unsupported" : "supported"}`}>{framework.archivedAt ? "archived" : "active"}</span></div>{framework.draftVersion && <div className="item-meta">Draft version {framework.draftVersion.versionNumber} · revision {framework.draftVersion.draftRevision}</div>}</Link>)}</div>}
    </section>
    <p className="footer-note">Critical appraisal is separate from screening, Evidence, extraction, synthesis, Claims, Research Question Answers, manuscripts, and PRISMA accounting. It never assigns a score or gates synthesis.</p>
  </div></div>;
}
