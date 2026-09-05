import Link from "next/link";
import { notFound } from "next/navigation";
import { reviseExtractionValueAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

function displayValue(revision: { valueState: string; textValue: string | null; numberValue: string | null; booleanValue: boolean | null; optionId: string | null }, options: { id: string; label: string }[]) {
  if (revision.valueState !== "present") return revision.valueState.replace("_", " ");
  if (revision.optionId) return options.find((option) => option.id === revision.optionId)?.label ?? "Archived option";
  if (revision.textValue !== null) return revision.textValue;
  if (revision.numberValue !== null) return revision.numberValue;
  if (revision.booleanValue !== null) return revision.booleanValue ? "Yes" : "No";
  return "—";
}

function inputValue(revision: { textValue: string | null; numberValue: string | null; booleanValue: boolean | null; optionId: string | null } | null) {
  if (!revision) return "";
  if (revision.textValue !== null) return revision.textValue;
  if (revision.numberValue !== null) return revision.numberValue;
  if (revision.booleanValue !== null) return revision.booleanValue ? "true" : "false";
  return revision.optionId ?? "";
}

export default async function ExtractionPaperPage({ params, searchParams }: {
  params: Promise<{ projectId: string; paperId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, paperId } = await params;
  const query = searchParams ? await searchParams : {};
  let extraction;
  let screening;
  try {
    [extraction, screening] = await Promise.all([
      reviewServices.getPaperExtraction(projectId, paperId),
      reviewServices.getPaperScreening(projectId, paperId),
    ]);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const [evidence, progress] = await Promise.all([
    reviewServices.listEvidence(projectId).then((items) => items.filter((item) => item.paperId === paperId)),
    reviewServices.getProjectExtractionProgress(projectId),
  ]);
  const optionsByField = new Map(await Promise.all(extraction.fields.map(async (field) => [field.id, await reviewServices.listExtractionOptions(projectId, field.id, true)] as const)));
  const histories = new Map(await Promise.all(extraction.fields.map(async (field) => [field.id, await reviewServices.getExtractionValueHistory(projectId, paperId, field.id)] as const)));
  const progressItem = progress.papers.find((item) => item.paper.id === paperId);
  const included = screening.currentState === "included";
  const savedMessage = query.saved === "value" ? "Extraction revision saved." : query.saved === "evidence" ? "Evidence support revised as a new extraction revision." : undefined;

  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/extraction`}>← Extraction dashboard</Link>
      <div className="workspace-header"><div><p className="eyebrow">Structured extraction · {included ? "Included paper" : "Paper not included"}</p><h1>{extraction.paper.title}</h1><p>{extraction.paper.authors.join(", ") || "Author details not added"}{extraction.paper.publicationYear ? ` · ${extraction.paper.publicationYear}` : ""}{extraction.paper.venue ? ` · ${extraction.paper.venue}` : ""}</p></div><span className={`status screening-${screening.currentState}`}>{screening.currentState}</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      {!included && <div className="error-banner" role="status">Extraction is available for included papers only. This paper’s existing extraction history remains readable, but new revisions cannot be saved.</div>}
      <section className="card section-card extraction-worksheet"><div className="section-heading"><div><h2>Extraction worksheet</h2><p className="hint">Structured observations are separate from the verbatim Evidence passages that support them.</p></div>{progressItem && <span className="count">{progressItem.completedRequired} / {progressItem.requiredCount} required · {progressItem.percentage ?? 0}%</span>}</div>
        {extraction.values.length === 0 ? <div className="empty">No active extraction fields are configured yet.</div> : <div className="extraction-values">{extraction.values.map((item) => { const field = item.field; const options = optionsByField.get(field.id) ?? []; const current = item.currentRevision; const history = histories.get(field.id) ?? []; return <article className="extraction-value" key={field.id}><div className="extraction-value-header"><div><h3>{field.name} {field.required && <span className="required-mark">Required</span>}</h3>{field.description && <p className="hint">{field.description}</p>}</div>{current && <span className={`status ${item.supportStatus === "grounded" ? "supported" : "unsupported"}`}>{item.supportStatus === "grounded" ? "● Grounded" : "○ Not yet grounded"}</span>}</div>
          <form action={reviseExtractionValueAction} className="extraction-form"><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="fieldId" value={field.id} /><input type="hidden" name="valueKind" value={field.fieldType} />
            <div className="field"><label htmlFor={`state-${field.id}`}>Response state</label><select id={`state-${field.id}`} name="state" defaultValue={current?.valueState ?? "present"} disabled={!included}><option value="present">Value reported</option><option value="not_reported">Not reported in paper</option><option value="not_applicable">Not applicable</option><option value="cleared">Clear response</option></select></div>
            {field.fieldType === "short_text" && <div className="field"><label htmlFor={`value-${field.id}`}>Structured value</label><input id={`value-${field.id}`} name="value" defaultValue={inputValue(current)} maxLength={500} disabled={!included} /></div>}
            {field.fieldType === "long_text" && <div className="field"><label htmlFor={`value-${field.id}`}>Structured value</label><textarea id={`value-${field.id}`} name="value" defaultValue={inputValue(current)} maxLength={10000} disabled={!included} /></div>}
            {field.fieldType === "number" && <div className="field"><label htmlFor={`value-${field.id}`}>Structured value</label><input id={`value-${field.id}`} name="value" type="number" step="any" defaultValue={inputValue(current)} disabled={!included} /></div>}
            {field.fieldType === "boolean" && <div className="field"><label htmlFor={`value-${field.id}`}>Structured value</label><select id={`value-${field.id}`} name="value" defaultValue={inputValue(current)} disabled={!included}><option value="">Select yes or no</option><option value="true">Yes</option><option value="false">No</option></select></div>}
            {field.fieldType === "single_select" && <div className="field"><label htmlFor={`value-${field.id}`}>Structured value</label><select id={`value-${field.id}`} name="value" defaultValue={inputValue(current)} disabled={!included}><option value="">Select an option</option>{options.map((option) => <option key={option.id} value={option.id} disabled={Boolean(option.archivedAt) && option.id !== current?.optionId}>{option.label}{option.archivedAt ? " (archived)" : ""}</option>)}</select></div>}
            <div className="field"><label htmlFor={`note-${field.id}`}>Researcher note <span className="hint">optional · interpretation/commentary</span></label><textarea id={`note-${field.id}`} name="researcherNote" defaultValue={current?.researcherNote ?? ""} disabled={!included} /></div>
            <fieldset className="evidence-picker"><legend>Supporting Evidence <span className="hint">verbatim passages from this Paper</span></legend>{evidence.length === 0 ? <div className="empty">No Evidence has been captured for this Paper yet.</div> : evidence.map((item) => <label className="checkbox-row" key={item.id}><input type="checkbox" name="evidenceIds" value={item.id} defaultChecked={Boolean(current?.evidence.some((linked) => linked.id === item.id))} disabled={!included} /><span><strong>Page {item.pageNumber}</strong> — <span className="quote-inline">“{item.sourceText}”</span>{item.note && <small>Researcher note: {item.note}</small>}</span></label>)}</fieldset>
            <button className="button" type="submit" disabled={!included}>Save new revision</button>
          </form>
          <div className="current-observation"><div className="item-meta">Current structured observation</div><p>{current ? displayValue(current, options) : "Not yet extracted"}</p>{current?.researcherNote && <p className="item-meta">Researcher note: {current.researcherNote}</p>}</div>
          <details className="revision-history"><summary>Revision history ({history.length})</summary>{history.length === 0 ? <div className="empty">No revisions yet.</div> : <div className="item-list">{history.slice().reverse().map((revision, index) => <article className="item" key={revision.id}><div className="item-row"><strong>Revision {history.length - index}</strong>{current?.id === revision.id && <span className="status supported">current</span>}</div><div className="item-meta">{displayValue(revision, options)} · {revision.createdAt.toLocaleString()}</div>{revision.researcherNote && <div className="item-meta">Researcher note: {revision.researcherNote}</div>}<div className="item-meta">{revision.evidence.length} supporting {revision.evidence.length === 1 ? "passage" : "passages"}</div>{revision.evidence.map((item) => <div className="history-evidence" key={item.id}><strong>Page {item.pageNumber}</strong> — “{item.sourceText}”</div>)}</article>)}</div>}</details>
        </article>; })}</div>}
      </section>
      <p className="footer-note">Each save records the complete observation, note, and Evidence set as a new immutable revision. Older revisions retain their own provenance.</p>
    </div></main>;
}
