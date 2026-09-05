import Link from "next/link";
import { notFound } from "next/navigation";
import {
  archiveExtractionFieldAction,
  archiveExtractionOptionAction,
  createExtractionFieldAction,
  createExtractionOptionAction,
} from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

const fieldTypes = [
  ["short_text", "Short text"],
  ["long_text", "Long text"],
  ["number", "Number"],
  ["boolean", "Boolean"],
  ["single_select", "Single select"],
] as const;

export default async function ExtractionDashboardPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try {
    project = await reviewServices.getProject(projectId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const [fields, progress] = await Promise.all([
    reviewServices.listExtractionFields(projectId, true),
    reviewServices.getProjectExtractionProgress(projectId),
  ]);
  const optionsByField = new Map(await Promise.all(fields.map(async (field) => [field.id, await reviewServices.listExtractionOptions(projectId, field.id, true)] as const)));
  const activeFields = fields.filter((field) => !field.archivedAt);
  const activeRequired = activeFields.filter((field) => field.required).length;
  const savedMessage = query.saved === "field" ? "Extraction field saved." : query.saved === "option" ? "Extraction option saved." : undefined;

  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}`}>← Back to workspace</Link>
      <div className="workspace-header"><div><p className="eyebrow">Structured extraction</p><h1>Extraction protocol</h1><p>{project.title} · {activeFields.length} active {activeFields.length === 1 ? "field" : "fields"}</p></div><span className="status supported">● Researcher-entered</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      <div className="workspace-grid">
        <section className="card section-card"><div className="section-heading"><h2>Configure fields</h2><span className="count">{activeRequired} required</span></div>
          <p className="hint">Fields are project-specific and appear in this order on every included paper. Used fields are archived to preserve the research record.</p>
          <form action={createExtractionFieldAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="extraction-field-name">Field name</label><input id="extraction-field-name" name="name" required placeholder="e.g. Attack technique" /></div><div className="field"><label htmlFor="extraction-field-description">Instructions <span className="hint">optional</span></label><textarea id="extraction-field-description" name="description" placeholder="What should the researcher record?" /></div><div className="field"><label htmlFor="extraction-field-type">Field type</label><select id="extraction-field-type" name="fieldType" defaultValue="short_text">{fieldTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><label className="checkbox-row"><input type="checkbox" name="required" /> <span><strong>Required field</strong><br /><span className="hint">Counts toward paper completion.</span></span></label><button className="button" type="submit">Add extraction field</button></form>
          <div className="item-list extraction-field-list">{fields.length === 0 ? <div className="empty">No extraction fields yet. Add the first field to define your worksheet.</div> : fields.map((field) => { const options = optionsByField.get(field.id) ?? []; return <article className={`item extraction-field-item ${field.archivedAt ? "archived" : ""}`} key={field.id}><div className="item-row"><div><div className="item-title">{field.name} {field.required && <span className="required-mark">Required</span>}</div><div className="item-meta">{fieldTypes.find(([value]) => value === field.fieldType)?.[1] ?? field.fieldType}{field.description ? ` · ${field.description}` : ""}</div></div>{field.archivedAt ? <span className="status unsupported">archived</span> : <form action={archiveExtractionFieldAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="fieldId" value={field.id} /><button className="button ghost" type="submit">Archive</button></form>}</div>{field.fieldType === "single_select" && <div className="extraction-options"><div className="item-meta">Options</div>{options.filter((option) => !option.archivedAt).map((option) => <div className="option-row" key={option.id}><span>{option.label}</span>{field.archivedAt || option.archivedAt ? <span className="hint">archived</span> : <form action={archiveExtractionOptionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="optionId" value={option.id} /><button className="button ghost" type="submit">Archive</button></form>}</div>)}<form className="inline-form" action={createExtractionOptionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="fieldId" value={field.id} /><label className="sr-only" htmlFor={`option-${field.id}`}>New option for {field.name}</label><input id={`option-${field.id}`} name="label" required placeholder="Add an option" /><button className="button ghost" type="submit">Add option</button></form></div>}</article>; })}</div>
        </section>
        <section className="card section-card"><div className="section-heading"><h2>Included papers</h2><span className="count">{progress.includedPaperCount} included</span></div>
          <p className="hint">Extraction is available for papers whose current screening state is included. Progress is derived from active required fields.</p>
          {progress.papers.length === 0 ? <div className="empty">No included papers yet. Finish screening a paper to open its extraction worksheet.</div> : <div className="item-list extraction-progress-list">{progress.papers.map((item) => <Link className="item extraction-progress-item" key={item.paper.id} href={`/projects/${projectId}/extraction/${item.paper.id}`}><div className="item-row"><div><div className="item-title">{item.paper.title}</div><div className="item-meta">{item.completedRequired} / {item.requiredCount} required fields complete</div></div><div className="progress-summary"><span className={`status ${item.status === "complete" ? "supported" : "unsupported"}`}>{item.status.replace("_", " ")}</span>{item.percentage !== null && <strong>{item.percentage}%</strong>}</div></div><div className="progress-track" aria-label={`${item.percentage ?? 0}% complete`}><span style={{ width: `${item.percentage ?? 0}%` }} /></div></Link>)}</div>}
        </section>
      </div>
      <p className="footer-note">Structured observations remain distinct from verbatim Evidence. Each revision records the Evidence that supported it at that time.</p>
    </div></main>;
}
