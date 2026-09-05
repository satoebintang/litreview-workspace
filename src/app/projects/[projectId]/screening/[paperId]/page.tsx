import Link from "next/link";
import { notFound } from "next/navigation";
import { recordScreeningDecisionAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function ScreeningPaperPage({ params, searchParams }: {
  params: Promise<{ projectId: string; paperId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, paperId } = await params;
  const query = searchParams ? await searchParams : {};
  let screening;
  try { screening = await reviewServices.getPaperScreening(projectId, paperId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const papers = await reviewServices.listScreeningPapers(projectId);
  const index = papers.findIndex((paper) => paper.id === paperId);
  const previous = index > 0 ? papers[index - 1] : null;
  const next = index >= 0 && index < papers.length - 1 ? papers[index + 1] : null;
  const exclusionCriteria = screening.criteria.filter((criterion) => criterion.type === "exclusion" && !criterion.archivedAt);
  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/screening`}>← Screening dashboard</Link>
      <div className="workspace-header"><div><p className="eyebrow">Title/abstract screening · Paper {index + 1} of {papers.length}</p><h1>{screening.paper.title}</h1><p>{screening.paper.authors.join(", ") || "Author details not added"}{screening.paper.publicationYear ? ` · ${screening.paper.publicationYear}` : ""}{screening.paper.venue ? ` · ${screening.paper.venue}` : ""}</p></div><span className={`status screening-${screening.currentState}`}>{screening.currentState}</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">Decision recorded in screening history.</div>}
      <div className="workspace-grid"><section className="card section-card"><div className="section-heading"><h2>Abstract</h2></div>{screening.paper.abstract ? <p className="abstract-text">{screening.paper.abstract}</p> : <div className="empty">No abstract was added for this paper.</div>}{screening.paper.doi && <p className="item-meta">DOI: {screening.paper.doi}</p>}
        <div className="screening-nav">{previous ? <Link className="button ghost" href={`/projects/${projectId}/screening/${previous.id}`}>← Previous</Link> : <span />}{next ? <Link className="button ghost" href={`/projects/${projectId}/screening/${next.id}`}>Next →</Link> : <span />}</div>
      </section>
      <section className="card section-card"><div className="section-heading"><h2>Record decision</h2></div><p className="hint">Each button adds an immutable history entry. Exclusions require a project-defined reason.</p>
        <form action={recordScreeningDecisionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="decision" value="include" /><div className="field"><label htmlFor="include-note">Include note <span className="hint">optional</span></label><textarea id="include-note" name="note" placeholder="Why is this abstract relevant?" /></div><button className="button" type="submit">Include</button></form>
        <form action={recordScreeningDecisionAction} style={{ marginTop: 18 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="decision" value="maybe" /><div className="field"><label htmlFor="maybe-note">Maybe note <span className="hint">optional</span></label><textarea id="maybe-note" name="note" placeholder="What remains uncertain?" /></div><button className="button secondary" type="submit">Maybe / uncertain</button></form>
        <form action={recordScreeningDecisionAction} style={{ marginTop: 18 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="decision" value="exclude" /><div className="field"><label htmlFor="exclusion-criterion">Exclusion reason <span className="hint">required</span></label><select id="exclusion-criterion" name="exclusionCriterionId" required defaultValue=""><option value="" disabled>Select a project exclusion criterion</option>{exclusionCriteria.map((criterion) => <option key={criterion.id} value={criterion.id}>{criterion.text}</option>)}</select>{exclusionCriteria.length === 0 && <span className="hint">Create an exclusion criterion before recording an exclusion.</span>}</div><div className="field"><label htmlFor="exclude-note">Exclusion note <span className="hint">optional</span></label><textarea id="exclude-note" name="note" placeholder="Add context for this exclusion" /></div><button className="button danger" type="submit" disabled={exclusionCriteria.length === 0}>Confirm exclusion</button></form>
      </section>
      <section className="card section-card full"><div className="section-heading"><h2>Screening history</h2><span className="count">{screening.history.length} {screening.history.length === 1 ? "decision" : "decisions"}</span></div>{screening.history.length === 0 ? <div className="empty">This paper has not been screened yet.</div> : <div className="item-list">{screening.history.map((decision) => <article className="item" key={decision.id}><div className="item-row"><div className="item-title">{decision.decision.toUpperCase()}</div>{screening.currentDecision?.id === decision.id && <span className="status supported">current</span>}</div>{decision.exclusionCriterion && <div className="item-meta">Reason: {decision.exclusionCriterion.text}</div>}{decision.note && <div className="item-meta">{decision.note}</div>}<div className="item-meta">{decision.createdAt.toLocaleString()}</div></article>)}</div>}</section></div>
      <p className="footer-note">Decisions are append-only. Revising a decision adds a new history entry and preserves earlier reasoning.</p>
    </div></main>;
}
