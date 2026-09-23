import Link from "next/link";
import { notFound } from "next/navigation";
import {
  archiveAppraisalFrameworkAction,
  createAppraisalFrameworkVersionAction,
} from "@/app/actions";
import { reviewServices } from "@/app/server";
import { CustomFrameworkBadge } from "@/components/CustomFrameworkBadge";
import { ConfirmAction } from "@/components/ConfirmAction";
import { FocusedErrorSummary } from "@/components/FocusedErrorSummary";
import { DomainError } from "@/domain/errors";

export default async function AppraisalFrameworkPage({ params, searchParams }: {
  params: Promise<{ projectId: string; frameworkId: string }>;
  searchParams?: Promise<{ error?: string }>;
}) {
  const { projectId, frameworkId } = await params;
  const query = searchParams ? await searchParams : {};
  let framework;
  try {
    framework = (await reviewServices.listAppraisalFrameworks(projectId)).find((item) => item.id === frameworkId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR", "CROSS_PROJECT_REFERENCE"].includes(error.code)) notFound();
    throw error;
  }
  if (!framework) notFound();

  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Critical appraisal · framework</p><div className="framework-title-line"><h1>{framework.name}</h1><CustomFrameworkBadge /></div><p>Researcher-authored, project-local definition with immutable finalized versions.</p></div><span className={`status ${framework.archivedAt ? "unsupported" : "supported"}`}>{framework.archivedAt ? "archived" : "active"}</span></div>
    {query.error && <FocusedErrorSummary message={query.error} />}
    <div className="workspace-actions"><Link className="button secondary" href={`/projects/${projectId}/appraisal/frameworks`}>Back to frameworks</Link><Link className="button ghost" href={`/projects/${projectId}/appraisal`}>Appraisal queue</Link>{!framework.archivedAt && <ConfirmAction action={archiveAppraisalFrameworkAction} label="Archive framework" title="Archive this appraisal framework?" consequence="Existing appraisal history remains readable. The framework and any draft version become unusable for new edits or finalization." hiddenFields={{ projectId, frameworkId }} confirmLabel="Archive framework" />}</div>
    {framework.archivedAt && <div className="support-warning">This framework is archived. Existing revisions remain immutable and readable, but no new framework edits, finalization, or appraisal saves are allowed.</div>}
    <div className="workspace-grid">
      <section className="card section-card"><div className="section-heading"><h2>Draft version</h2><span className="count">{framework.draftVersion ? `v${framework.draftVersion.versionNumber}` : "none"}</span></div>
        {framework.draftVersion ? <><p className="hint">Edit the draft, then finalize it to create the immutable definition used by appraisal worksheets.</p><div className="item"><div className="item-row"><div><div className="item-title">Version {framework.draftVersion.versionNumber} · {framework.draftVersion.versionLabel}</div><div className="item-meta">Draft revision {framework.draftVersion.draftRevision} · created {framework.draftVersion.createdAt.toLocaleString()}</div></div><Link className="button" href={`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${framework.draftVersion.id}`}>Open draft editor</Link></div></div></> : <div className="empty">No mutable draft is open.</div>}
      </section>
      <section className="card section-card"><div className="section-heading"><h2>Latest finalized version</h2><span className="count">{framework.latestFinalizedVersion ? `v${framework.latestFinalizedVersion.versionNumber}` : "none"}</span></div>
        {framework.latestFinalizedVersion ? <div className="item"><div className="item-row"><div><div className="item-title">Version {framework.latestFinalizedVersion.versionNumber} · {framework.latestFinalizedVersion.versionLabel}</div><div className="item-meta">Finalized {framework.latestFinalizedVersion.finalizedAt?.toLocaleString() ?? ""}</div></div><Link className="button ghost" href={`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${framework.latestFinalizedVersion.id}`}>View definition</Link></div></div> : <div className="empty">Finalize the first draft before this framework can be used.</div>}
      </section>
    </div>
    {!framework.archivedAt && framework.latestFinalizedVersion && !framework.draftVersion && <section className="card narrow-card"><div className="item-row"><h2>Begin explicit reassessment</h2><CustomFrameworkBadge /></div><p className="hint">This creates the next monotonic version by copying the current finalized definition. Existing v{framework.latestFinalizedVersion.versionNumber} appraisals stay on their version until a researcher saves a reassessment.</p><form action={createAppraisalFrameworkVersionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="frameworkId" value={frameworkId} /><div className="field"><label htmlFor="new-version-label">Version label <span className="hint">optional</span></label><input id="new-version-label" name="versionLabel" defaultValue={String(framework.latestFinalizedVersion.versionNumber + 1)} /></div><button className="button" type="submit">Create next draft version</button></form></section>}
    <p className="footer-note">Framework version movement is monotonic. A later version never rewrites earlier appraisal responses, Evidence snapshots, eligibility identities, or downstream research state.</p>
  </div></div>;
}
