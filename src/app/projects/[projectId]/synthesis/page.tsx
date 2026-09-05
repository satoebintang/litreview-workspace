import Link from "next/link";
import { notFound } from "next/navigation";
import { createSynthesisStatementAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

function displayValue(row: { displayValue: string | null; valueState: string }) {
  if (row.displayValue !== null && row.displayValue !== "") return row.displayValue;
  return row.valueState === "not_extracted" ? "Not extracted" : row.valueState.replaceAll("_", " ");
}

export default async function SynthesisDashboardPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ fieldId?: string; error?: string; saved?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const fields = await reviewServices.listExtractionFields(projectId);
  const field = fields.find((item) => item.id === query.fieldId) ?? fields[0];
  const [comparison, syntheses] = await Promise.all([
    field ? reviewServices.listExtractionComparison(projectId, field.id) : Promise.resolve([]),
    reviewServices.listProjectSynthesis(projectId),
  ]);
  const summary = field ? await reviewServices.getExtractionFieldSummary(projectId, field.id) : null;
  const savedMessage = query.saved === "created" ? "Synthesis statement created." : undefined;

  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}`}>← Back to workspace</Link>
      <div className="workspace-header"><div><p className="eyebrow">Evidence synthesis</p><h1>{project.title}</h1><p>Compare structured observations and author source-backed conclusions.</p></div><span className="status supported">● Researcher-entered</span></div>
      <nav className="stagebar" aria-label="Review stages"><span className="stage active">1. Question</span><span className="stage active">2. Papers</span><span className="stage active">3. Evidence</span><span className="stage active">4. Claims</span><span className="stage active">5. Extraction</span><span className="stage active">6. Synthesis</span><span className="stage">7. Writing</span></nav>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      <div className="workspace-grid">
        <section className="card section-card full"><div className="section-heading"><h2>Evidence matrix</h2><span className="count">{comparison.length} included papers</span></div>
          <p className="hint">This is a view over current finalized ExtractionRevisions. Select exact observations to use as supporting findings; missing and ungrounded states remain visible.</p>
          {fields.length === 0 ? <div className="empty">Add an extraction field before comparing observations.</div> : <>
            <nav className="chip-list" aria-label="Extraction fields">{fields.map((item) => <Link className={`button ${item.id === field?.id ? "secondary" : "ghost"}`} key={item.id} href={`/projects/${projectId}/synthesis?fieldId=${item.id}`}>{item.name}</Link>)}</nav>
            {field && summary && <div className="item-meta" style={{ margin: "16px 0" }}>{summary.field.name} · {Object.entries(summary.counts).map(([state, count]) => `${count} ${state.replaceAll("_", " ")}`).join(" · ")}</div>}
            <form action={createSynthesisStatementAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <div className="matrix-list">{comparison.map((row) => <label className={`item matrix-row ${row.extractionRevision && !row.isSelectable ? "muted" : ""}`} key={row.paper.id}>
                <div className="item-row"><div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <input type="checkbox" name="extractionRevisionIds" value={row.extractionRevision?.id ?? ""} disabled={!row.isSelectable} aria-label={`Select observation from ${row.paper.title}`} />
                  <div><div className="item-title">{row.paper.title}</div><div className="item-meta">{displayValue(row)} · {row.supportStatus === "grounded" ? "Grounded" : "Ungrounded"}</div>{row.extractionRevision && <div className="item-meta">{row.extractionRevision.evidence.length} {row.extractionRevision.evidence.length === 1 ? "Evidence passage" : "Evidence passages"}</div>}</div>
                </div><span className={`status ${row.supportStatus === "grounded" ? "supported" : "unsupported"}`}>{row.valueState.replaceAll("_", " ")}</span></div>
              </label>)}</div>
              <div className="form-grid" style={{ marginTop: 18 }}><div className="field"><label htmlFor="synthesis-title">Topic or title <span className="hint">optional</span></label><input id="synthesis-title" name="title" placeholder="e.g. Common attack techniques" /></div><div className="field"><label htmlFor="synthesis-text">Synthesis statement</label><textarea id="synthesis-text" name="statementText" required placeholder="Write a cross-paper analytical conclusion from the selected observations" /></div><div className="field"><label htmlFor="synthesis-note">Researcher note <span className="hint">optional</span></label><textarea id="synthesis-note" name="researcherNote" placeholder="Context for your interpretation" /></div></div>
              <button className="button" type="submit">Create synthesis from selected observations</button>
            </form>
          </>}
        </section>
        <section className="card section-card full"><div className="section-heading"><h2>Synthesis statements</h2><span className="count">{syntheses.length}</span></div>
          {syntheses.length === 0 ? <div className="empty">No synthesis statements yet. Select observations above to author one.</div> : <div className="item-list">{syntheses.map((synthesis) => <article className="item item-row" key={synthesis.synthesisStatementId}><div><div className="item-title">{synthesis.title ?? "Untitled synthesis"}</div><div className="item-meta">{synthesis.state === "withdrawn" ? "Withdrawn" : synthesis.statementText} · Revision {synthesis.sequence}</div><div className="item-meta">{synthesis.supportingRevisionCount} supporting observations across {synthesis.supportingPaperCount} {synthesis.supportingPaperCount === 1 ? "Paper" : "Papers"}</div></div><Link className="button ghost" href={`/projects/${projectId}/synthesis/${synthesis.synthesisStatementId}`}>Inspect provenance →</Link></article>)}</div>}
        </section>
      </div>
      <p className="footer-note">Synthesis is researcher-authored. Supporting observations are descriptive coverage, not proof or statistical certainty.</p>
    </div></main>;
}
