import Link from "next/link";
import { notFound } from "next/navigation";
import { archiveFullTextScreeningCriterionAction, createFullTextScreeningCriterionAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

const states = ["all", "ready", "awaiting", "included", "excluded", "maybe", "legacy", "conflict"] as const;

export default async function FullTextScreeningDashboardPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string; state?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const [criteria, queue] = await Promise.all([
    reviewServices.listFullTextScreeningCriteria(projectId, true),
    reviewServices.listFullTextScreeningQueue(projectId),
  ]);
  const state = states.includes(query.state as typeof states[number]) ? query.state as typeof states[number] : "all";
  const matches = (reviewStatus: (typeof queue)[number]["reviewStatus"], key: typeof states[number]) => key === "conflict" ? reviewStatus.crossStageConflict || reviewStatus.warnings.includes("retrieval_history_without_current_title_abstract_inclusion") : key === "ready" ? reviewStatus.titleAbstractState === "included" && reviewStatus.fullTextRetrievalState === "retrieved" && reviewStatus.fullTextState === "not_started" : key === "legacy" ? reviewStatus.warnings.includes("legacy_full_text_decision_without_retrieval_record") : key === "awaiting" ? reviewStatus.finalEligibility === "pending_full_text" : key === "included" ? reviewStatus.finalEligibility === "included" : key === "excluded" ? reviewStatus.finalEligibility === "excluded" : reviewStatus.finalEligibility === "unresolved_full_text";
  const filtered = state === "all" ? queue : queue.filter(({ reviewStatus }) => matches(reviewStatus, state));
  const counts = Object.fromEntries(states.slice(1).map((key) => [key, queue.filter(({ reviewStatus }) => matches(reviewStatus, key)).length]));
  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/screening`}>← Title/abstract screening</Link>
      <div className="workspace-header"><div><p className="eyebrow">Eligibility screening · {project.title}</p><h1>Full-text screening</h1><p>Only Papers currently included at title/abstract screening and currently retrieved can receive a new full-text decision.</p></div>{queue[0] ? <Link className="button" href={`/projects/${projectId}/screening/full-text/${(queue.find(({ reviewStatus }) => matches(reviewStatus, "ready")) ?? queue.find(({ reviewStatus }) => reviewStatus.finalEligibility === "pending_full_text") ?? queue[0]).paper.id}`}>Open queue</Link> : <span className="hint">No title/abstract-included Papers yet.</span>}</div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">Full-text screening protocol updated.</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}><Link className="button ghost" href={`/projects/${projectId}/screening/full-text/retrieval`}>Full-text retrieval →</Link><Link className="button ghost" href={`/projects/${projectId}/review-flow`}>Review flow →</Link><Link className="button ghost" href={`/projects/${projectId}/review-report`}>Review report →</Link></div>
      <div className="screening-stats">{states.slice(1).map((key) => <Link key={key} className={`screening-stat ${state === key ? "active" : ""}`} href={`/projects/${projectId}/screening/full-text?state=${key}`}><span>{key}</span><strong>{counts[key]}</strong></Link>)}</div>
      <div className="workspace-grid"><section className="card section-card"><div className="section-heading"><h2>Full-text queue</h2><span className="count">{filtered.length} shown</span></div><div className="filter-row">{states.map((key) => <Link key={key} className={`button ghost ${state === key ? "active-filter" : ""}`} href={key === "all" ? `/projects/${projectId}/screening/full-text` : `/projects/${projectId}/screening/full-text?state=${key}`}>{key}</Link>)}</div>{filtered.length === 0 ? <div className="empty">No Papers match this full-text state.</div> : <div className="item-list">{filtered.map(({ paper, reviewStatus }) => <Link className="item item-row" key={paper.id} href={`/projects/${projectId}/screening/full-text/${paper.id}`}><div><div className="item-title">{paper.title}</div><div className="item-meta">TA: {reviewStatus.titleAbstractState} · retrieval: {reviewStatus.fullTextRetrievalState} · FT: {reviewStatus.fullTextState}</div></div><span className={`status screening-${reviewStatus.finalEligibility}`}>{reviewStatus.crossStageConflict || reviewStatus.warnings.includes("retrieval_history_without_current_title_abstract_inclusion") ? "conflict" : reviewStatus.finalEligibility.replaceAll("_", " ")}</span></Link>)}</div>}</section>
        <section className="card section-card"><div className="section-heading"><h2>Full-text criteria</h2><span className="count">{criteria.filter((criterion) => !criterion.archivedAt).length} active</span></div><p className="hint">Criteria are distinct from title/abstract criteria. Archived criteria remain readable in history but cannot be used for new exclusions.</p><form action={createFullTextScreeningCriterionAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="full-text-criterion-text">Criterion</label><textarea id="full-text-criterion-text" name="text" required placeholder="Why is a full-text report excluded?" /></div><button className="button" type="submit">Add full-text criterion</button></form><div className="item-list" style={{ marginTop: 22 }}>{criteria.length === 0 ? <div className="empty">No full-text criteria recorded.</div> : criteria.map((criterion) => <div className="item" key={criterion.id}><div className="item-row"><span>{criterion.text}</span>{criterion.archivedAt ? <span className="status unsupported">archived</span> : <form action={archiveFullTextScreeningCriterionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="criterionId" value={criterion.id} /><button className="button ghost" type="submit">Archive</button></form>}</div></div>)}</div></section></div>
      <p className="footer-note">Full-text decisions are append-only. Cross-stage conflicts remain visible and historical, but do not count as current eligible-stage outcomes.</p>
    </div></main>;
}
