import Link from "next/link";
import { notFound } from "next/navigation";
import { saveAppraisalRevisionAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { AppraisalWorksheetForm } from "@/components/AppraisalWorksheetForm";
import { AuditDetails } from "@/components";
import { CustomFrameworkBadge } from "@/components/CustomFrameworkBadge";
import { FocusedErrorSummary } from "@/components/FocusedErrorSummary";
import { DomainError } from "@/domain/errors";

export default async function AppraisalWorksheetPage({ params, searchParams }: {
  params: Promise<{ projectId: string; paperId: string; frameworkId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string; versionId?: string; evidence?: string; evidenceSearch?: string; evidencePage?: string }>;
}) {
  const { projectId, paperId, frameworkId } = await params;
  const query = searchParams ? await searchParams : {};
  let appraisal;
  let evidence;
  try {
    appraisal = await reviewServices.readPaperAppraisal(projectId, paperId, frameworkId);
    evidence = query.evidence === "1"
      ? await reviewServices.listPaperEvidence(projectId, paperId, { search: query.evidenceSearch, page: Number(query.evidencePage) || 1, pageSize: 50 })
      : { evidence: [], page: 1, pageSize: 50, totalCount: 0 };
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  if (!appraisal.latestAvailableVersion) {
    return <div className="project-page"><div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Critical appraisal</p><h1>{appraisal.paper.title}</h1><p>{appraisal.framework.name}</p></div><CustomFrameworkBadge /></div><div className="empty">This framework has no finalized version yet. <Link href={`/projects/${projectId}/appraisal/frameworks/${frameworkId}`}>Open the framework definition →</Link></div></div></div>;
  }

  const selectedVersionId = query.versionId ?? appraisal.currentRevision?.frameworkVersionId ?? appraisal.latestAvailableVersion.id;
  let version;
  try { version = await reviewServices.readFrameworkVersion(projectId, selectedVersionId); }
  catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  if (version.framework.id !== frameworkId) notFound();
  const currentRevision = appraisal.currentRevision;
  const sameRevisionVersion = currentRevision?.frameworkVersionId === version.version.id;
  const currentVersionNumber = currentRevision?.frameworkVersionNumber ?? null;
  const canSave = !appraisal.historical && !appraisal.frameworkArchived && version.version.finalizedAt != null && (currentVersionNumber == null || version.version.versionNumber >= currentVersionNumber);
  const responseByItem = new Map((sameRevisionVersion ? currentRevision?.responses ?? [] : []).map((response) => [response.frameworkItemId, response]));
  const evidenceLabel = (item: typeof evidence.evidence[number]) => `p. ${item.pageNumber} · ${item.sourceText.slice(0, 100)}${item.sourceText.length > 100 ? "…" : ""}`;
  const evidenceLoaded = query.evidence === "1";
  const pickerHref = `/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}?versionId=${version.version.id}&evidence=1`;

  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Critical appraisal · worksheet</p><h1>{appraisal.paper.title}</h1><div className="item-row"><CustomFrameworkBadge /><span>{appraisal.framework.name} · version {version.version.versionNumber} · {version.version.versionLabel}</span></div></div><span className={`status ${canSave ? "supported" : "unsupported"}`}>{canSave ? "editable" : "read-only"}</span></div>
    {query.error && <FocusedErrorSummary message={query.error} />}{query.saved && <div className="success-note" role="status">Appraisal revision saved.</div>}
    <div className="workspace-actions"><Link className="button secondary" href={`/projects/${projectId}/appraisal`}>Back to appraisal queue</Link><Link className="button ghost" href={`/projects/${projectId}/appraisal/frameworks/${frameworkId}/versions/${version.version.id}`}>View exact framework version</Link>{currentRevision && <Link className="button ghost" href={`/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}/history`}>Revision history</Link>}</div>
    {appraisal.historical && <div className="support-warning"><CustomFrameworkBadge /> This Paper is no longer finally included. The worksheet is permanently read-only; the saved custom framework appraisal remains historical context.</div>}
    {appraisal.frameworkArchived && <div className="support-warning"><CustomFrameworkBadge /> This framework is archived. Existing appraisal history remains readable, but new appraisal revisions are disabled.</div>}
    {appraisal.newerVersionAvailable && currentRevision && version.version.id === currentRevision.frameworkVersionId && <div className="support-warning"><CustomFrameworkBadge /> A newer finalized version of this researcher-authored framework is available. You may continue editing this version, or <Link href={`/projects/${projectId}/appraisal/papers/${paperId}/frameworks/${frameworkId}?versionId=${appraisal.latestAvailableVersion.id}`}>begin the explicit reassessment on version {appraisal.latestAvailableVersion.versionNumber}</Link>. Saving that newer version creates a new immutable appraisal revision; it does not migrate responses automatically.</div>}
    {currentRevision && currentVersionNumber != null && version.version.versionNumber < currentVersionNumber && <div className="support-warning"><CustomFrameworkBadge /> This version is older than the current appraisal revision and cannot become current again. It is shown for historical inspection only.</div>}
    <section className="card section-card"><div className="section-heading"><div><h2>Eligibility and provenance boundary</h2><p className="hint">The saved revision pins the exact latest title/abstract and full-text inclusion decisions at save time.</p></div><span className="count">{currentRevision ? `revision ${currentRevision.revisionNumber}` : "new revision"}</span></div><div className="item-meta">Paper: {appraisal.paper.title}</div>{currentRevision && <AuditDetails items={[{ label: "Title/abstract decision", value: currentRevision.titleAbstractDecisionId }, { label: "Full-text decision", value: currentRevision.fullTextDecisionId }]} />}<div className="item-meta">Evidence options below are limited to this Paper and snapshot their current review state at save time.</div></section>
    <AppraisalWorksheetForm action={saveAppraisalRevisionAction}>
      <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="frameworkId" value={frameworkId} /><input type="hidden" name="frameworkVersionId" value={version.version.id} /><input type="hidden" name="expectedCurrentRevisionId" value={currentRevision?.id ?? ""} />
      {version.sections.map((section) => <section className="card section-card" key={section.id}><div className="section-heading"><div><h2>{section.label}</h2>{section.description && <p className="hint">{section.description}</p>}</div><span className="count">{version.items.filter((item) => item.sectionId === section.id).length} items</span></div><div className="item-list">{version.items.filter((item) => item.sectionId === section.id).map((item) => {
        const response = responseByItem.get(item.id);
        const selectedEvidence = new Set(response?.evidence.map((entry) => entry.evidenceId) ?? []);
        const guidanceId = item.guidance ? `response-guidance-${item.id}` : undefined;
        return <article className="item appraisal-item" key={item.id}>
          <input type="hidden" name="itemIds" value={item.id} />
          <fieldset id={`response-group-${item.id}`} tabIndex={-1} className="appraisal-response-group" aria-describedby={guidanceId}>
            <legend>{item.prompt} {item.required && <span className="required-mark">Required</span>}</legend>
            {item.guidance && <p className="hint" id={guidanceId}>{item.guidance}</p>}
            <div className="response-options" role="radiogroup" aria-label={item.prompt}>
              <label className="response-option"><input type="radio" name={`selectedOption_${item.id}`} value="" defaultChecked={!response?.selectedOptionId} disabled={!canSave} /><span>Not selected</span></label>
              {item.options.map((option) => <label className="response-option" key={option.id}><input type="radio" name={`selectedOption_${item.id}`} value={option.id} defaultChecked={response?.selectedOptionId === option.id} required={item.required} disabled={!canSave} /><span>{option.label}</span></label>)}
            </div>
          </fieldset>
          <div className="field"><label htmlFor={`rationale-${item.id}`}>Researcher rationale <span className="hint">optional</span></label><textarea id={`rationale-${item.id}`} name={`rationale_${item.id}`} defaultValue={response?.rationale ?? ""} disabled={!canSave} /></div>
          <div className="field"><label htmlFor={`evidence-${item.id}`}>Same-Paper Evidence grounding <span className="hint">optional · multi-select</span></label>{evidenceLoaded ? <select id={`evidence-${item.id}`} name={`evidenceIds_${item.id}`} multiple size={Math.min(6, Math.max(3, evidence.evidence.length))} defaultValue={[...selectedEvidence]} disabled={!canSave}>{evidence.evidence.length === 0 ? <option value="" disabled>No Evidence recorded for this Paper</option> : evidence.evidence.map((source) => <option key={source.id} value={source.id}>{evidenceLabel(source)} · {source.reviewState}</option>)}</select> : <Link className="button ghost" href={pickerHref}>Load Evidence picker</Link>}{response?.evidence.map((entry) => <div className="support-warning" key={entry.id}>Evidence grounding saved as {entry.evidenceReviewStateAtSave}{entry.currentReviewWarning ? ` · ${entry.currentReviewWarning}` : ""}. The snapshot remains immutable.<AuditDetails items={[{ label: "Evidence identity", value: entry.evidenceId }]} /></div>)}</div>
        </article>;
      })}</div></section>)}
      <section className="card section-card"><div className="section-heading"><h2>Overall researcher judgement</h2><span className="count">{version.version.overallJudgementRequired ? "required" : "optional"}</span></div><div className="field"><label htmlFor="overall-judgement">Judgement</label><select id="overall-judgement" name="overallJudgementOptionId" defaultValue={sameRevisionVersion ? currentRevision?.overallJudgementOptionId ?? "" : ""} disabled={!canSave}><option value="">Not selected</option>{version.overallOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div><div className="field"><label htmlFor="overall-rationale">Overall rationale <span className="hint">optional</span></label><textarea id="overall-rationale" name="overallRationale" defaultValue={sameRevisionVersion ? currentRevision?.overallRationale ?? "" : ""} disabled={!canSave} /></div>{canSave && <button className="button" type="submit">Save immutable appraisal revision</button>}</section>
    </AppraisalWorksheetForm>
    <p className="footer-note">Critical appraisal is researcher-authored descriptive appraisal. It assigns no score, never auto-writes canonical Evidence or extraction, and never gates synthesis, Claims, Research Question Answers, manuscripts, or PRISMA accounting.</p>
  </div></div>;
}
