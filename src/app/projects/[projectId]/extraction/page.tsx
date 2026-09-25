import Link from "next/link";
import { notFound } from "next/navigation";
import {
  archiveExtractionFieldAction,
  archiveExtractionOptionAction,
  createExtractionFieldAction,
  createExtractionOptionAction,
} from "@/app/actions";
import { extractionReadServices, reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import { ConfirmAction } from "@/components/ConfirmAction";

const fieldTypes = [
  ["short_text", "Short text"],
  ["long_text", "Long text"],
  ["number", "Number"],
  ["boolean", "Boolean"],
  ["single_select", "Single select"],
] as const;

export default async function ExtractionDashboardPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string; page?: string }>;
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
  const [protocol, progress] = await Promise.all([
    extractionReadServices.getExtractionProtocol(projectId),
    extractionReadServices.getExtractionProgressPage(projectId, { page: query.page }),
  ]);
  const fields = protocol.fields;
  const activeFields = fields.filter((field) => !field.archivedAt);
  const activeRequired = activeFields.filter((field) => field.required).length;
  const savedMessage = query.saved === "field" ? "Extraction field saved." : query.saved === "option" ? "Extraction option saved." : undefined;

  return <div className="project-page">
    <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Structured extraction</p><h1>Extraction protocol</h1><p>{project.title} · {activeFields.length} active {activeFields.length === 1 ? "field" : "fields"}</p></div><span className="status supported">● Researcher-entered</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}><Link className="button secondary" href={`/projects/${projectId}/extraction/batches`}>Open AI extraction batches →</Link><Link className="button ghost" href={`/projects/${projectId}/extraction/batches/new`}>Prepare a batch</Link><Link className="button ghost" href={`/projects/${projectId}/appraisal`}>Critical appraisal</Link></div>
      <div className="workspace-grid">
        <section className="card section-card"><div className="section-heading"><h2>Configure fields</h2><span className="count">{activeRequired} required</span></div>
          <p className="hint">Fields are project-specific and appear in this order on every included paper. Used fields are archived to preserve the research record.</p>
          <form action={createExtractionFieldAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="extraction-field-name">Field name</label><input id="extraction-field-name" name="name" required placeholder="e.g. Attack technique" /></div><div className="field"><label htmlFor="extraction-field-description">Instructions <span className="hint">optional</span></label><textarea id="extraction-field-description" name="description" placeholder="What should the researcher record?" /></div><div className="field"><label htmlFor="extraction-field-type">Field type</label><select id="extraction-field-type" name="fieldType" defaultValue="short_text">{fieldTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><label className="checkbox-row"><input type="checkbox" name="required" /> <span><strong>Required field</strong><br /><span className="hint">Counts toward paper completion.</span></span></label><button className="button" type="submit">Add extraction field</button></form>
          <div className="item-list extraction-field-list">{fields.length === 0 ? <div className="empty">No extraction fields yet. Add the first field to define your worksheet.</div> : fields.map((field) => { const options = field.options; return <article className={`item extraction-field-item ${field.archivedAt ? "archived" : ""}`} key={field.id}><div className="item-row"><div><div className="item-title">{field.name} {field.required && <span className="required-mark">Required</span>}</div><div className="item-meta">{fieldTypes.find(([value]) => value === field.fieldType)?.[1] ?? field.fieldType}{field.description ? ` · ${field.description}` : ""}</div></div>{field.archivedAt ? <span className="status unsupported">archived</span> : <ConfirmAction action={archiveExtractionFieldAction} label="Archive" title="Archive this extraction field?" consequence={`Future extraction worksheets will no longer accept “${field.name}”. Historical values remain preserved.`} hiddenFields={{ projectId, fieldId: field.id }} confirmLabel="Archive field" />}</div>{field.fieldType === "single_select" && <div className="extraction-options"><div className="item-meta">Options</div>{options.filter((option) => !option.archivedAt).map((option) => <div className="option-row" key={option.id}><span>{option.label}</span>{field.archivedAt || option.archivedAt ? <span className="hint">archived</span> : <ConfirmAction action={archiveExtractionOptionAction} label="Archive" title="Archive this extraction option?" consequence={`The option “${option.label}” will no longer be available for new extraction values. Historical values remain preserved.`} hiddenFields={{ projectId, optionId: option.id }} confirmLabel="Archive option" />}</div>)}<form className="inline-form" action={createExtractionOptionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="fieldId" value={field.id} /><label className="sr-only" htmlFor={`option-${field.id}`}>New option for {field.name}</label><input id={`option-${field.id}`} name="label" required placeholder="Add an option" /><button className="button ghost" type="submit">Add option</button></form></div>}</article>; })}</div>
        </section>
        <section className="card section-card"><div className="section-heading"><h2>Finally included papers</h2><span className="count">{progress.counts.includedPaperCount} included</span></div>
          <p className="hint">New extraction revisions are available only after current title/abstract inclusion and full-text inclusion. Historical extraction-only Papers remain readable below.</p>
          {progress.items.length === 0 ? <div className="empty">No extraction history is available yet.</div> : <div className="item-list extraction-progress-list">{progress.items.map((item) => <Link className="item extraction-progress-item" key={item.paper.id} href={`/projects/${projectId}/extraction/${item.paper.id}`}><div className="item-row"><div><div className="item-title">{item.paper.title}</div><div className="item-meta">{item.completedRequired} / {item.requiredCount} required fields complete{!item.writeEligible ? " · read-only historical state" : ""}</div></div><div className="progress-summary"><span className={`status ${item.status === "complete" ? "supported" : "unsupported"}`}>{item.status.replace("_", " ")}</span>{item.percentage !== null && <strong>{item.percentage}%</strong>}</div></div><div className="progress-track" aria-label={`${item.percentage ?? 0}% complete`}><span style={{ width: `${item.percentage ?? 0}%` }} /></div></Link>)}</div>}
          <nav className="extraction-progress-pagination" aria-label="Extraction progress pagination">
            <p className="hint" aria-live="polite">{progress.pagination.from}–{progress.pagination.to} of {progress.pagination.totalCount}</p>
            <div className="action-group" aria-label="Extraction progress page controls">
              {progress.pagination.page > 1
                ? <Link className="button secondary" href={`/projects/${projectId}/extraction?page=${progress.pagination.page - 1}`} rel="prev" aria-label="Previous page">Previous</Link>
                : <button className="button secondary" type="button" disabled aria-label="Previous page">Previous</button>}
              <span aria-current="page">Page {progress.pagination.page} of {Math.max(1, progress.pagination.totalPages)}</span>
              {progress.pagination.page < progress.pagination.totalPages
                ? <Link className="button secondary" href={`/projects/${projectId}/extraction?page=${progress.pagination.page + 1}`} rel="next" aria-label="Next page">Next</Link>
                : <button className="button secondary" type="button" disabled aria-label="Next page">Next</button>}
            </div>
          </nav>
        </section>
      </div>
      <p className="footer-note">Structured observations remain distinct from verbatim Evidence. Each revision records the Evidence that supported it at that time.</p>
    </div></div>;
}
