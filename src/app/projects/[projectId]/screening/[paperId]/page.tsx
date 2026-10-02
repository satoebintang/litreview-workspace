import Link from "next/link";
import { notFound } from "next/navigation";
import { recordScreeningDecisionAction } from "@/app/actions";
import { screeningHistoryReadServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function ScreeningPaperPage({ params, searchParams }: {
  params: Promise<{ projectId: string; paperId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, paperId } = await params;
  const query = searchParams ? await searchParams : {};
  let screening;
  try { screening = await screeningHistoryReadServices.getTitleAbstractScreeningDetail(projectId, paperId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const exclusionCriteria = screening.criteria.filter((criterion) => criterion.type === "exclusion");
  const historyPath = `/projects/${projectId}/screening/${paperId}/history`;
  const exactPath = (decisionId: string) => `${historyPath}/${decisionId}`;
  const currentIsOutsidePage = screening.currentEvent != null && !screening.history.items.some((item) => item.id === screening.currentEvent?.id);
  return <div className="project-page">
    <div className="container workspace">
      <div className="workspace-header"><div><p className="eyebrow">Title/abstract screening · Paper {screening.navigation.position} of {screening.navigation.totalCount}</p><h1>{screening.paper.title}</h1><p>{screening.paper.authors.join(", ") || "Author details not added"}{screening.paper.publicationYear ? ` · ${screening.paper.publicationYear}` : ""}{screening.paper.venue ? ` · ${screening.paper.venue}` : ""}</p></div><span className={`status screening-${screening.reviewStatus.titleAbstractState}`}>{screening.reviewStatus.titleAbstractState}</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">Decision recorded in screening history.</div>}
      <div className="workspace-grid">
        <section className="card section-card"><div className="section-heading"><h2>Abstract</h2></div>{screening.paper.abstract ? <p className="abstract-text">{screening.paper.abstract}</p> : <div className="empty">No abstract was added for this paper.</div>}{screening.paper.doi && <p className="item-meta">DOI: {screening.paper.doi}</p>}
          <nav className="screening-nav" aria-label="Screening paper navigation">{screening.navigation.previousPaperId ? <Link className="button ghost" href={`/projects/${projectId}/screening/${screening.navigation.previousPaperId}`}>← Previous</Link> : <span />}{screening.navigation.nextPaperId ? <Link className="button ghost" href={`/projects/${projectId}/screening/${screening.navigation.nextPaperId}`}>Next →</Link> : <span />}</nav>
        </section>
        <section className="card section-card"><div className="section-heading"><h2>Record decision</h2></div><p className="hint">Each button adds an immutable history entry. Exclusions require a project-defined reason.</p>
          <form action={recordScreeningDecisionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="decision" value="include" /><div className="field"><label htmlFor="include-note">Include note <span className="hint">optional</span></label><textarea id="include-note" name="note" placeholder="Why is this abstract relevant?" /></div><button className="button" type="submit">Include</button></form>
          <form action={recordScreeningDecisionAction} style={{ marginTop: 18 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="decision" value="maybe" /><div className="field"><label htmlFor="maybe-note">Maybe note <span className="hint">optional</span></label><textarea id="maybe-note" name="note" placeholder="What remains uncertain?" /></div><button className="button secondary" type="submit">Maybe / uncertain</button></form>
          <form action={recordScreeningDecisionAction} style={{ marginTop: 18 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="decision" value="exclude" /><div className="field"><label htmlFor="exclusion-criterion">Exclusion reason <span className="hint">required</span></label><select id="exclusion-criterion" name="exclusionCriterionId" required defaultValue=""><option value="" disabled>Select a project exclusion criterion</option>{exclusionCriteria.map((criterion) => <option key={criterion.id} value={criterion.id}>{criterion.text}</option>)}</select>{exclusionCriteria.length === 0 && <span className="hint">Create an exclusion criterion before recording an exclusion.</span>}</div><div className="field"><label htmlFor="exclude-note">Exclusion note <span className="hint">optional</span></label><textarea id="exclude-note" name="note" placeholder="Add context for this exclusion" /></div><button className="button danger" type="submit" disabled={exclusionCriteria.length === 0}>Confirm exclusion</button></form>
        </section>
        <section className="card section-card full"><div className="section-heading"><h2>Screening history</h2><span className="count">{screening.history.items.length} shown</span></div>
          {screening.history.items.length === 0 ? <div className="empty">This paper has not been screened yet.</div> : <div className="item-list">{screening.history.items.map((decision) => <article className="item" key={decision.id}><div className="item-row"><div className="item-title">{decision.decision.toUpperCase()}</div>{decision.isCurrent && <span className="status supported">current</span>}</div>{decision.exclusionCriterion && <div className="item-meta">Reason: {decision.exclusionCriterion.text}{decision.criterionTextTruncated && " (preview shortened)"}</div>}{decision.note && <div className="item-meta">{decision.note}{decision.noteTruncated && " (preview shortened)"}</div>}<div className="item-meta">{decision.createdAt.toLocaleString()}</div><Link href={exactPath(decision.id)}>View full event →</Link></article>)}</div>}
          {currentIsOutsidePage && screening.currentEvent && <p className="item-meta">Current event {screening.currentEvent.decision} is outside this page. <Link href={exactPath(screening.currentEvent.id)}>View exact current event →</Link></p>}
          {screening.history.hasMore && screening.history.nextCursor && <p className="pagination"><Link className="button ghost" href={`${historyPath}?cursor=${encodeURIComponent(screening.history.nextCursor)}`}>More history →</Link></p>}
          {!screening.history.hasMore && screening.history.items.length > 0 && <p className="item-meta"><Link href={historyPath}>Open history view →</Link></p>}
        </section>
      </div>
      <p className="footer-note">Decisions are append-only. Revising a decision adds a new history entry and preserves earlier reasoning.</p>
    </div>
  </div>;
}
