import Link from "next/link";
import { notFound } from "next/navigation";
import { reviseSynthesisStatementAction, withdrawSynthesisStatementAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

function displayExtraction(support: { extractionRevision: { valueState: string; textValue: string | null; numberValue: string | null; booleanValue: boolean | null; optionId: string | null } }) {
  const revision = support.extractionRevision;
  if (revision.valueState !== "present") return revision.valueState.replaceAll("_", " ");
  return revision.textValue ?? revision.numberValue ?? (revision.booleanValue === null ? (revision.optionId ? "Selected option" : "—") : revision.booleanValue ? "Yes" : "No");
}

export default async function SynthesisStatementPage({ params, searchParams }: {
  params: Promise<{ projectId: string; statementId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, statementId } = await params;
  const query = searchParams ? await searchParams : {};
  let current;
  try { current = await reviewServices.getCurrentSynthesis(projectId, statementId); }
  catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }
  if (!current) notFound();
  const [history, screeningPapers] = await Promise.all([
    reviewServices.getSynthesisHistory(projectId, statementId),
    reviewServices.listScreeningPapers(projectId),
  ]);
  const replacementRows = await Promise.all([...new Map(current.supports.map((support) => [support.field.id, support.field])).values()].map(async (field) => [field.id, await reviewServices.listExtractionComparison(projectId, field.id)] as const));
  const replacementByKey = new Map(replacementRows.flatMap(([, rows]) => rows.map((row) => [`${row.paper.id}:${row.field.id}`, row] as const)));
  const screeningByPaperId = new Map(screeningPapers.map((paper) => [paper.id, paper.screeningState]));
  const savedMessage = query.saved === "created" ? "Synthesis statement created." : query.saved === "revised" ? "New synthesis revision saved." : query.saved === "withdrawn" ? "Synthesis withdrawn. Its history remains available." : undefined;
  const active = current.state === "active";

  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/synthesis`}>← Evidence matrix</Link>
      <div className="workspace-header"><div><p className="eyebrow">Synthesis provenance</p><h1>{current.title ?? "Untitled synthesis"}</h1><p>Revision {current.sequence} · {current.supportingRevisionCount} supporting observations across {current.supportingPaperCount} {current.supportingPaperCount === 1 ? "Paper" : "Papers"}</p></div><span className={`status ${active ? (current.supportStatus === "supported" ? "supported" : "unsupported") : "unsupported"}`}>{active ? (current.supportStatus === "supported" ? "● Supported observations" : "○ Unsupported") : "Withdrawn"}</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      <div className="workspace-grid">
        <section className="card section-card full"><div className="section-heading"><h2>Current synthesis</h2><span className="count">Revision {current.sequence}</span></div>
          {current.statementText ? <p className="synthesis-statement">{current.statementText}</p> : <p className="empty">This synthesis has been withdrawn.</p>}
          {current.researcherNote && <p className="hint">Researcher note: {current.researcherNote}</p>}
          <div className="item-list">{current.supports.length === 0 ? <div className="empty">No supporting observations are linked to this revision.</div> : current.supports.map((support) => { const included = screeningByPaperId.get(support.paper.id) === "included"; return <article className="item" key={support.extractionRevisionId}><div className="item-row"><div><div className="item-title">{support.paper.title}</div><div className="item-meta">{support.field.name}: {displayExtraction(support)} · Extraction revision {support.extractionRevision.sequence}</div></div><div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className={`status ${support.isCurrentExtractionRevision ? "supported" : "unsupported"}`}>{support.isCurrentExtractionRevision ? "Current extraction" : "Superseded support"}</span>{!included && <span className="status unsupported">Paper excluded</span>}</div></div><div className="item-meta">{support.extractionRevision.evidence.length} {support.extractionRevision.evidence.length === 1 ? "Evidence passage" : "Evidence passages"}</div><div className="provenance-list">{support.extractionRevision.evidence.map((evidence) => <div className="quote" key={evidence.id}>“{evidence.sourceText}” <span className="item-meta">· Page {evidence.pageNumber}</span></div>)}</div></article>; })}</div>
        </section>
        {active && <section className="card section-card full"><div className="section-heading"><h2>Create a new revision</h2><span className="count">Exact support snapshot</span></div><p className="hint">Existing support is preselected by exact ExtractionRevision ID. Superseded observations are marked and are never silently replaced. Excluded Papers remain visible in history but cannot be selected for a new revision.</p>
          <form action={reviseSynthesisStatementAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="statementId" value={statementId} /><div className="field"><label htmlFor="revision-title">Topic or title <span className="hint">optional</span></label><input id="revision-title" name="title" defaultValue={current.title ?? ""} /></div><div className="field"><label htmlFor="revision-text">Synthesis statement</label><textarea id="revision-text" name="statementText" required defaultValue={current.statementText ?? ""} /></div><div className="field"><label htmlFor="revision-note">Researcher note <span className="hint">optional</span></label><textarea id="revision-note" name="researcherNote" defaultValue={current.researcherNote ?? ""} /></div><div className="item-list">{current.supports.map((support) => { const included = screeningByPaperId.get(support.paper.id) === "included"; const replacement = replacementByKey.get(`${support.paper.id}:${support.field.id}`); const canReplace = included && Boolean(replacement?.extractionRevision && replacement.extractionRevision.id !== support.extractionRevisionId); return <div className="item" key={support.extractionRevisionId}><label className="checkbox-row"><input type="checkbox" name="extractionRevisionIds" value={support.extractionRevisionId} defaultChecked={included} disabled={!included} /><span><strong>{support.paper.title}</strong><br /><span className="hint">{support.field.name}: {displayExtraction(support)} · {support.isCurrentExtractionRevision ? "Current extraction" : "Superseded support — replace explicitly if desired"}{!included ? " · Paper excluded" : ""}</span></span></label>{canReplace && replacement?.extractionRevision && <label className="checkbox-row"><input type="checkbox" name="extractionRevisionIds" value={replacement.extractionRevision.id} aria-label={`Use current extraction from ${support.paper.title}`} /><span><strong>Use current extraction</strong><br /><span className="hint">{support.field.name}: {replacement.displayValue ?? replacement.valueState.replaceAll("_", " ")} · Explicit replacement for superseded revision</span></span></label>}</div>; })}</div><button className="button" type="submit">Save new synthesis revision</button></form></section>}
        {active && <section className="card section-card"><div className="section-heading"><h2>Withdraw conclusion</h2></div><p className="hint">Withdrawal preserves every prior statement and support set. Repeating withdrawal is safe and returns the existing withdrawn revision.</p><form action={withdrawSynthesisStatementAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="statementId" value={statementId} /><div className="field"><label htmlFor="withdraw-note">Withdrawal note <span className="hint">optional</span></label><textarea id="withdraw-note" name="researcherNote" placeholder="Why is this conclusion being withdrawn?" /></div><button className="button secondary" type="submit">Withdraw synthesis</button></form></section>}
        {!active && <section className="card section-card"><div className="section-heading"><h2>Withdrawn</h2></div><p className="hint">This conclusion is already withdrawn. No additional revision is created by repeating the operation.</p></section>}
        <section className="card section-card full"><div className="section-heading"><h2>Complete synthesis history</h2><span className="count">{history.length} revisions</span></div><div className="item-list">{history.map((revision) => <article className="item" key={revision.id}><div className="item-row"><div><div className="item-title">Revision {revision.sequence} · {revision.state === "withdrawn" ? "Withdrawn" : revision.supportStatus === "supported" ? "Supported observations" : "Unsupported"}</div><div className="item-meta">{revision.statementText ?? "Conclusion withdrawn"}</div></div><span className="status">{revision.supportingRevisionCount} revisions · {revision.supportingPaperCount} Papers</span></div>{revision.supports.map((support) => <div className="item-meta" key={support.extractionRevisionId}>↳ {support.paper.title} · {support.field.name}: {displayExtraction(support)} · Extraction revision {support.extractionRevision.sequence}{support.isCurrentExtractionRevision ? "" : " · superseded support"}</div>)}</article>)}</div></section>
      </div>
      <p className="footer-note">Source-backed observations remain distinct from the researcher-authored synthesis statement.</p>
    </div></main>;
}
