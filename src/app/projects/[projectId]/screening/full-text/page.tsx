import Link from "next/link";
import { notFound } from "next/navigation";
import { archiveFullTextScreeningCriterionAction, createFullTextScreeningCriterionAction } from "@/app/actions";
import { fullTextQueueReadServices, reviewServices } from "@/app/server";
import { ConfirmAction } from "@/components/ConfirmAction";
import { DomainError } from "@/domain/errors";

const states = ["all", "ready", "awaiting", "included", "excluded", "maybe", "legacy", "conflict"] as const;

function stateHref(projectId: string, state: typeof states[number]) {
  const path = `/projects/${projectId}/screening/full-text`;
  return state === "all" ? path : `${path}?state=${state}`;
}

export default async function FullTextScreeningDashboardPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string; state?: string; page?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }

  const [criteria, queue] = await Promise.all([
    reviewServices.listFullTextScreeningCriteria(projectId, true),
    fullTextQueueReadServices.listFullTextScreeningQueuePage(projectId, { state: query.state, page: query.page }),
  ]);
  const state = queue.state;
  const nextPageHref = (page: number) => {
    const queryParams = new URLSearchParams();
    if (state !== "all") queryParams.set("state", state);
    queryParams.set("page", String(page));
    return `/projects/${projectId}/screening/full-text?${queryParams.toString()}`;
  };
  const firstQueueItem = queue.items.find(({ reviewStatus }) => reviewStatus.titleAbstractState === "included" && reviewStatus.fullTextRetrievalState === "retrieved" && reviewStatus.fullTextState === "not_started")
    ?? queue.items.find(({ reviewStatus }) => reviewStatus.finalEligibility === "pending_full_text")
    ?? queue.items[0];

  return <div className="project-page">
    <div className="container workspace">
      <div className="workspace-header">
        <div>
          <p className="eyebrow">Eligibility screening · {project.title}</p>
          <h1>Full-text screening</h1>
          <p>Only Papers currently included at title/abstract screening and currently retrieved can receive a new full-text decision.</p>
        </div>
        {firstQueueItem ? <Link className="button" href={`/projects/${projectId}/screening/full-text/${firstQueueItem.paper.id}`}>Open queue</Link> : <span className="hint">No title/abstract-included Papers yet.</span>}
      </div>

      {query.error && <div className="error-banner" role="alert">{query.error}</div>}
      {query.saved && <div className="success-note" role="status">Full-text screening protocol updated.</div>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
        <Link className="button ghost" href={`/projects/${projectId}/screening/full-text/retrieval`}>Full-text retrieval →</Link>
        <Link className="button ghost" href={`/projects/${projectId}/review-flow`}>Review flow →</Link>
        <Link className="button ghost" href={`/projects/${projectId}/review-report`}>Review report →</Link>
      </div>

      <div className="screening-stats">
        {states.slice(1).map((key) => <Link key={key} className={`screening-stat ${state === key ? "active" : ""}`} href={stateHref(projectId, key)}><span>{key}</span><strong>{queue.counts[key]}</strong></Link>)}
      </div>

      <div className="workspace-grid">
        <section className="card section-card">
          <div className="section-heading"><h2>Full-text queue</h2><span className="count">{queue.from}–{queue.to} of {queue.totalCount}</span></div>
          <div className="filter-row">
            {states.map((key) => <Link key={key} className={`button ghost ${state === key ? "active-filter" : ""}`} href={stateHref(projectId, key)}>{key}</Link>)}
          </div>
          {queue.items.length === 0 ? <div className="empty">No Papers match this full-text state.</div> : <div className="item-list">
            {queue.items.map(({ paper, reviewStatus }) => <Link className="item item-row" key={paper.id} href={`/projects/${projectId}/screening/full-text/${paper.id}`}>
              <div>
                <div className="item-title">{paper.title}</div>
                <div className="item-meta">TA: {reviewStatus.titleAbstractState} · retrieval: {reviewStatus.fullTextRetrievalState} · FT: {reviewStatus.fullTextState}</div>
              </div>
              <span className={`status screening-${reviewStatus.finalEligibility}`}>{reviewStatus.crossStageConflict || reviewStatus.warnings.includes("retrieval_history_without_current_title_abstract_inclusion") ? "conflict" : reviewStatus.finalEligibility.replaceAll("_", " ")}</span>
            </Link>)}
          </div>}
          <nav aria-label="Full-text queue pagination" className="filter-row">
            {queue.page > 1 ? <Link className="button ghost" href={nextPageHref(queue.page - 1)} aria-label="Previous page">Previous</Link> : <button className="button ghost" type="button" disabled>Previous</button>}
            <span aria-current="page">Page {queue.page} of {queue.totalPages}</span>
            {queue.page < queue.totalPages ? <Link className="button ghost" href={nextPageHref(queue.page + 1)} aria-label="Next page">Next</Link> : <button className="button ghost" type="button" disabled>Next</button>}
          </nav>
        </section>

        <section className="card section-card">
          <div className="section-heading"><h2>Full-text criteria</h2><span className="count">{criteria.filter((criterion) => !criterion.archivedAt).length} active</span></div>
          <p className="hint">Criteria are distinct from title/abstract criteria. Archived criteria remain readable in history but cannot be used for new exclusions.</p>
          <form action={createFullTextScreeningCriterionAction}>
            <input type="hidden" name="projectId" value={projectId} />
            <div className="field"><label htmlFor="full-text-criterion-text">Criterion</label><textarea id="full-text-criterion-text" name="text" required placeholder="Why is a full-text report excluded?" /></div>
            <button className="button" type="submit">Add full-text criterion</button>
          </form>
          <div className="item-list" style={{ marginTop: 22 }}>
            {criteria.length === 0 ? <div className="empty">No full-text criteria recorded.</div> : criteria.map((criterion) => <div className="item" key={criterion.id}>
              <div className="item-row"><span>{criterion.text}</span>{criterion.archivedAt ? <span className="status unsupported">archived</span> : <ConfirmAction action={archiveFullTextScreeningCriterionAction} label="Archive" title="Archive this full-text criterion?" consequence="The criterion will remain readable in history but will no longer be available for active full-text decisions." hiddenFields={{ projectId, criterionId: criterion.id }} confirmLabel="Archive criterion" />}</div>
            </div>)}
          </div>
        </section>
      </div>
      <p className="footer-note">Full-text decisions are append-only. Cross-stage conflicts remain visible and historical, but do not count as current eligible-stage outcomes.</p>
    </div>
  </div>;
}
