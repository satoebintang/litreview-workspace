import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addAppraisalFrameworkItemAction,
  addAppraisalFrameworkResponseOptionAction,
  addAppraisalFrameworkSectionAction,
  finalizeAppraisalFrameworkVersionAction,
  reorderAppraisalFrameworkItemsAction,
  reorderAppraisalFrameworkOverallOptionsAction,
  reorderAppraisalFrameworkResponseOptionsAction,
  reorderAppraisalFrameworkSectionsAction,
  removeAppraisalFrameworkItemAction,
  removeAppraisalFrameworkResponseOptionAction,
  removeAppraisalFrameworkSectionAction,
  setAppraisalFrameworkOverallOptionsAction,
  updateAppraisalFrameworkItemAction,
  updateAppraisalFrameworkResponseOptionAction,
  updateAppraisalFrameworkSectionAction,
  updateFrameworkDraftMetadataAction,
} from "@/app/actions";
import { reviewServices } from "@/app/server";
import { AccessibleValidation } from "@/components/AccessibleValidation";
import { ConfirmAction } from "@/components/ConfirmAction";
import { CustomFrameworkBadge } from "@/components/CustomFrameworkBadge";
import { DraftReorderControls } from "@/components/DraftReorderControls";
import { FocusAfterNavigation } from "@/components/FocusAfterNavigation";
import { FocusedErrorSummary } from "@/components/FocusedErrorSummary";
import { DomainError } from "@/domain/errors";

export default async function AppraisalFrameworkVersionPage({ params, searchParams }: {
  params: Promise<{ projectId: string; frameworkId: string; versionId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string; focus?: string }>;
}) {
  const { projectId, frameworkId, versionId } = await params;
  const query = searchParams ? await searchParams : {};
  let detail;
  try {
    detail = await reviewServices.readFrameworkVersion(projectId, versionId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  if (detail.framework.id !== frameworkId) notFound();
  const draft = detail.version.finalizedAt == null;
  const expectedDraftRevision = detail.version.draftRevision;
  const itemsBySection = new Map(detail.sections.map((section) => [section.id, detail.items.filter((item) => item.sectionId === section.id)]));

  return <AccessibleValidation><FocusAfterNavigation targetId={query.focus} /><div className="project-page"><div className="container workspace">
    <div className="workspace-header">
      <div><p className="eyebrow">Critical appraisal · framework version</p><div className="framework-title-line"><h1>{detail.framework.name} · version {detail.version.versionNumber}</h1><CustomFrameworkBadge /></div><p>{detail.version.versionLabel} · {draft ? `mutable draft revision ${expectedDraftRevision}` : `finalized ${detail.version.finalizedAt?.toLocaleString() ?? ""}`}</p></div>
      <span className={`status ${draft ? "stale" : "supported"}`}>{draft ? "draft" : "immutable"}</span>
    </div>
    {query.error && <FocusedErrorSummary message={query.error} />}
    {query.saved && <div className="success-note" role="status">Framework version updated.</div>}
    <div className="workspace-actions"><Link className="button secondary" href={`/projects/${projectId}/appraisal/frameworks/${frameworkId}`}>Back to framework</Link><Link className="button ghost" href={`/projects/${projectId}/appraisal`}>Appraisal queue</Link></div>
    {!draft && <div className="support-warning">This is the exact immutable definition captured by finalized appraisal revisions. It is read-only; create a new framework version for future changes.</div>}

    <section className="card section-card">
      <div className="section-heading"><h2>Version metadata</h2><span className="count">{detail.version.overallJudgementRequired ? "Overall judgement required" : "Overall judgement optional"}</span></div>
      {draft ? <form id="appraisal-metadata-form" action={updateFrameworkDraftMetadataAction}>
        <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="frameworkId" value={frameworkId} /><input type="hidden" name="versionId" value={versionId} /><input type="hidden" name="expectedDraftRevision" value={expectedDraftRevision} />
        <div className="field"><label htmlFor="version-label">Version label</label><input id="version-label" name="versionLabel" required defaultValue={detail.version.versionLabel} /></div>
        <div className="field"><label htmlFor="version-description">Description</label><textarea id="version-description" name="description" defaultValue={detail.version.description ?? ""} /></div>
        <div className="field"><label htmlFor="version-citation">Citation or source note</label><textarea id="version-citation" name="citation" defaultValue={detail.version.citation ?? ""} /></div>
        <div className="field"><label htmlFor="version-url">External reference URL</label><input id="version-url" name="externalReferenceUrl" type="url" defaultValue={detail.version.externalReferenceUrl ?? ""} /></div>
        <div className="field"><label htmlFor="version-rights">Rights note</label><textarea id="version-rights" name="rightsNote" defaultValue={detail.version.rightsNote ?? ""} /></div>
        <div className="field"><label htmlFor="version-instructions">Instructions</label><textarea id="version-instructions" name="instructions" defaultValue={detail.version.instructions ?? ""} /></div>
        <div className="field"><label htmlFor="version-design">Intended study design</label><input id="version-design" name="intendedStudyDesign" defaultValue={detail.version.intendedStudyDesign ?? ""} /></div>
        <div className="field"><label htmlFor="version-applicability">Applicability note</label><textarea id="version-applicability" name="applicabilityNote" defaultValue={detail.version.applicabilityNote ?? ""} /></div>
        <label className="checkbox-row"><input type="checkbox" name="overallJudgementRequired" defaultChecked={detail.version.overallJudgementRequired} /> <span>Require an overall researcher judgement</span></label>
        <button className="button" type="submit">Save metadata</button>
      </form> : <div className="item-list"><div className="item-meta">Description</div><p>{detail.version.description || "Not recorded."}</p><div className="item-meta">Citation or source note</div><p>{detail.version.citation || "Not recorded."}</p><div className="item-meta">Rights note</div><p>{detail.version.rightsNote || "Not recorded."}</p><div className="item-meta">Instructions</div><p>{detail.version.instructions || "Not recorded."}</p><div className="item-meta">Applicability</div><p>{detail.version.applicabilityNote || "Not recorded."}</p></div>}
    </section>

    <div className="workspace-grid">
      <section className="card section-card">
        <div className="section-heading"><h2>Sections and items</h2><span className="count">{detail.items.length} items</span></div>
        {detail.sections.length === 0 && <div className="empty">No sections yet. Add one to begin defining the framework.</div>}
        {detail.sections.map((section, sectionIndex) => {
          const sectionItems = itemsBySection.get(section.id) ?? [];
          const sectionItemIds = sectionItems.map((item) => item.id);
          return <article className="item" id={`draft-section-${section.id}`} tabIndex={-1} key={section.id}>
            <div className="item-row"><div><div className="item-title">{section.label}</div>{section.description && <div className="item-meta">{section.description}</div>}</div><div className="item-row">
              {draft && <DraftReorderControls action={reorderAppraisalFrameworkSectionsAction} projectId={projectId} frameworkId={frameworkId} versionId={versionId} expectedDraftRevision={expectedDraftRevision} ids={detail.sections.map((entry) => entry.id)} index={sectionIndex} kind="section" label={section.label} targetId={`draft-section-${section.id}`} />}
              {draft && <ConfirmAction action={removeAppraisalFrameworkSectionAction} label="Remove" title="Remove this section?" consequence="The section must be empty. Finalized definitions cannot be changed." hiddenFields={{ projectId, frameworkId, versionId, sectionId: section.id, expectedDraftRevision }} confirmLabel="Remove section" />}
            </div></div>
            {draft && <form id={`edit-section-${section.id}`} className="inline-form" action={updateAppraisalFrameworkSectionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="frameworkId" value={frameworkId} /><input type="hidden" name="versionId" value={versionId} /><input type="hidden" name="expectedDraftRevision" value={expectedDraftRevision} /><input type="hidden" name="sectionId" value={section.id} /><label className="sr-only" htmlFor={`section-label-${section.id}`}>Section label</label><input id={`section-label-${section.id}`} name="label" aria-label={`Section label for ${section.label}`} defaultValue={section.label} required /><label className="sr-only" htmlFor={`section-description-${section.id}`}>Section description</label><input id={`section-description-${section.id}`} name="description" aria-label={`Section description for ${section.label}`} defaultValue={section.description ?? ""} placeholder="Description" /><button className="button ghost" type="submit">Save section</button></form>}
            {sectionItems.map((item, itemIndex) => <div className="item nested-item" id={`draft-item-${item.id}`} tabIndex={-1} key={item.id}>
              <div className="item-row"><div><div className="item-title">{item.prompt} {item.required && <span className="required-mark">Required</span>}</div>{item.guidance && <div className="item-meta">{item.guidance}</div>}</div><div className="item-row">
                {draft && <DraftReorderControls action={reorderAppraisalFrameworkItemsAction} projectId={projectId} frameworkId={frameworkId} versionId={versionId} expectedDraftRevision={expectedDraftRevision} ids={sectionItemIds} index={itemIndex} kind="item" label={item.prompt} targetId={`draft-item-${item.id}`} scope={{ name: "sectionId", value: section.id }} />}
                {draft && <ConfirmAction action={removeAppraisalFrameworkItemAction} label="Remove item" title="Remove this appraisal item?" consequence="Its response options will also be removed from this draft. Finalized versions remain immutable." hiddenFields={{ projectId, frameworkId, versionId, itemId: item.id, expectedDraftRevision }} confirmLabel="Remove item" />}
              </div></div>
              {draft && <form id={`edit-item-${item.id}`} className="inline-form" action={updateAppraisalFrameworkItemAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="frameworkId" value={frameworkId} /><input type="hidden" name="versionId" value={versionId} /><input type="hidden" name="expectedDraftRevision" value={expectedDraftRevision} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="sectionId" value={item.sectionId} /><label className="sr-only" htmlFor={`prompt-${item.id}`}>Prompt</label><input id={`prompt-${item.id}`} name="prompt" aria-label={`Prompt for ${item.prompt}`} defaultValue={item.prompt} required /><label className="sr-only" htmlFor={`guidance-${item.id}`}>Guidance</label><input id={`guidance-${item.id}`} name="guidance" aria-label={`Guidance for ${item.prompt}`} defaultValue={item.guidance ?? ""} placeholder="Guidance" /><label className="checkbox-row"><input type="checkbox" name="required" defaultChecked={item.required} /> required</label><button className="button ghost" type="submit">Save item</button></form>}
              <div className="item-list"><div className="item-meta">Response options</div>
                {item.options.map((option, optionIndex) => <div className="option-row" id={`draft-response-option-${option.id}`} tabIndex={-1} key={option.id}>
                  <span><code>{option.optionKey}</code> · {option.label}</span>
                  {draft && <div className="item-row"><DraftReorderControls action={reorderAppraisalFrameworkResponseOptionsAction} projectId={projectId} frameworkId={frameworkId} versionId={versionId} expectedDraftRevision={expectedDraftRevision} ids={item.options.map((entry) => entry.id)} index={optionIndex} kind="response-option" label={option.label} targetId={`draft-response-option-${option.id}`} scope={{ name: "itemId", value: item.id }} />
                    <form id={`edit-response-option-${option.id}`} className="inline-form" action={updateAppraisalFrameworkResponseOptionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="frameworkId" value={frameworkId} /><input type="hidden" name="versionId" value={versionId} /><input type="hidden" name="expectedDraftRevision" value={expectedDraftRevision} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="optionId" value={option.id} /><label className="sr-only" htmlFor={`option-key-${option.id}`}>Response key</label><input id={`option-key-${option.id}`} name="optionKey" aria-label={`Response key for ${item.prompt}: ${option.label}`} defaultValue={option.optionKey} required /><label className="sr-only" htmlFor={`option-label-${option.id}`}>Response label</label><input id={`option-label-${option.id}`} name="label" aria-label={`Response label for ${item.prompt}: ${option.label}`} defaultValue={option.label} required /><button className="button ghost" type="submit">Save</button></form>
                    <ConfirmAction action={removeAppraisalFrameworkResponseOptionAction} label="Remove" title="Remove this response option?" consequence="Existing appraisal revisions remain readable; this draft option will not be available after finalization." hiddenFields={{ projectId, frameworkId, versionId, itemId: item.id, optionId: option.id, expectedDraftRevision }} confirmLabel="Remove option" />
                  </div>}
                </div>)}
                {draft && <form id={`add-response-option-${item.id}`} className="inline-form" action={addAppraisalFrameworkResponseOptionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="frameworkId" value={frameworkId} /><input type="hidden" name="versionId" value={versionId} /><input type="hidden" name="expectedDraftRevision" value={expectedDraftRevision} /><input type="hidden" name="itemId" value={item.id} /><label className="sr-only" htmlFor={`new-option-key-${item.id}`}>New response key</label><input id={`new-option-key-${item.id}`} name="optionKey" aria-label={`New response key for ${item.prompt}`} placeholder="key" required /><label className="sr-only" htmlFor={`new-option-label-${item.id}`}>New response label</label><input id={`new-option-label-${item.id}`} name="label" aria-label={`New response label for ${item.prompt}`} placeholder="label" required /><button className="button ghost" type="submit">Add option</button></form>}
              </div>
            </div>)}
            {draft && <form id={`add-item-${section.id}`} className="inline-form" action={addAppraisalFrameworkItemAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="frameworkId" value={frameworkId} /><input type="hidden" name="versionId" value={versionId} /><input type="hidden" name="expectedDraftRevision" value={expectedDraftRevision} /><input type="hidden" name="sectionId" value={section.id} /><label className="sr-only" htmlFor={`new-item-prompt-${section.id}`}>New appraisal item prompt</label><input id={`new-item-prompt-${section.id}`} name="prompt" aria-label={`New item in ${section.label}`} placeholder="New appraisal prompt" required /><label className="sr-only" htmlFor={`new-item-guidance-${section.id}`}>New item guidance</label><input id={`new-item-guidance-${section.id}`} name="guidance" aria-label={`Guidance for new item in ${section.label}`} placeholder="Guidance (optional)" /><label className="checkbox-row"><input type="checkbox" name="required" /> required</label><button className="button ghost" type="submit">Add item</button></form>}
          </article>;
        })}
        {draft && <form id="add-section-form" className="inline-form" action={addAppraisalFrameworkSectionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="frameworkId" value={frameworkId} /><input type="hidden" name="versionId" value={versionId} /><input type="hidden" name="expectedDraftRevision" value={expectedDraftRevision} /><label className="sr-only" htmlFor="new-section-label">New section label</label><input id="new-section-label" name="label" placeholder="New section" aria-label="New section label" required /><label className="sr-only" htmlFor="new-section-description">New section description</label><input id="new-section-description" name="description" placeholder="Description (optional)" aria-label="New section description" /><button className="button" type="submit">Add section</button></form>}
      </section>

      <section className="card section-card">
        <div className="section-heading"><h2>Overall judgement</h2><span className="count">{detail.overallOptions.length} options</span></div>
        <p className="hint">This is an optional researcher judgement, never a numeric score and never a synthesis gate.</p>
        {detail.overallOptions.map((option, index) => <div className="option-row" id={`draft-overall-option-${option.id}`} tabIndex={-1} key={option.id}>
          <span><code>{option.optionKey}</code> · {option.label}</span>
          {draft && <DraftReorderControls action={reorderAppraisalFrameworkOverallOptionsAction} projectId={projectId} frameworkId={frameworkId} versionId={versionId} expectedDraftRevision={expectedDraftRevision} ids={detail.overallOptions.map((entry) => entry.id)} index={index} kind="overall-option" label={option.label} targetId={`draft-overall-option-${option.id}`} />}
        </div>)}
        {draft && <form id="overall-options-form" action={setAppraisalFrameworkOverallOptionsAction}>
          <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="frameworkId" value={frameworkId} /><input type="hidden" name="versionId" value={versionId} /><input type="hidden" name="expectedDraftRevision" value={expectedDraftRevision} />
          <div className="item-list">{detail.overallOptions.map((option, index) => <div className="item-row overall-option-edit" key={option.id}>
            <div className="field"><label htmlFor={`overall-key-${option.id}`}>Judgement key {index + 1}</label><input id={`overall-key-${option.id}`} name="optionKey" defaultValue={option.optionKey} /></div>
            <div className="field"><label htmlFor={`overall-label-${option.id}`}>Judgement label {index + 1}</label><input id={`overall-label-${option.id}`} name="optionLabel" defaultValue={option.label} /></div>
          </div>)}
            <div className="item-row overall-option-edit"><div className="field"><label htmlFor="overall-key-new">Add judgement key</label><input id="overall-key-new" name="optionKey" /></div><div className="field"><label htmlFor="overall-label-new">Add judgement label</label><input id="overall-label-new" name="optionLabel" /></div></div>
          </div>
          <p className="hint">Clear both fields for a row to remove it. Saving applies all option changes together.</p>
          <label className="checkbox-row"><input type="checkbox" name="required" defaultChecked={detail.version.overallJudgementRequired} /> require overall judgement</label>
          <button className="button secondary" type="submit">Save overall options</button>
        </form>}
      </section>
    </div>
    {draft && <section className="card section-card"><h2>Finalize version</h2><p className="hint">Finalization validates complete contiguous ordering, exact item/option ownership, and freezes this version permanently.</p><ConfirmAction action={finalizeAppraisalFrameworkVersionAction} label="Finalize immutable version" title="Finalize this framework version?" consequence="Finalization is permanent. The exact definition, options, and version identity will become immutable and future changes require a new version." hiddenFields={{ projectId, frameworkId, versionId, expectedDraftRevision }} confirmLabel="Finalize version" /></section>}
    <p className="footer-note">Only finalized framework versions can be pinned by an AppraisalRevision. Editing this custom framework never mutates screening, Evidence, extraction, synthesis, Claims, Research Question Answers, manuscript, or PRISMA accounting.</p>
  </div></div></AccessibleValidation>;
}
