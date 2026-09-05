import Link from "next/link";
import { notFound } from "next/navigation";
import { archiveScreeningCriterionAction, createScreeningCriterionAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

const states = ["all", "unscreened", "included", "excluded", "maybe"] as const;

export default async function ScreeningDashboardPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string; state?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const criteria = await reviewServices.listScreeningCriteria(projectId, true);
  const allPapers = await reviewServices.listScreeningPapers(projectId);
  const state = states.includes(query.state as typeof states[number]) ? query.state as typeof states[number] : "all";
  const papers = state === "all" ? allPapers : allPapers.filter((paper) => paper.screeningState === state);
  const counts = Object.fromEntries(states.slice(1).map((key) => [key, allPapers.filter((paper) => paper.screeningState === key).length]));
  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}`}>← Back to workspace</Link>
      <div className="workspace-header"><div><p className="eyebrow">Paper collection</p><h1>Title/abstract screening</h1><p>{project.title} · {allPapers.length} {allPapers.length === 1 ? "paper" : "papers"}</p></div>{allPapers.length > 0 ? <a className="button" href={`/projects/${projectId}/screening/${allPapers.find((paper) => paper.screeningState === "unscreened")?.id ?? allPapers[0].id}`}>Start screening</a> : <span className="hint">Add a paper to start screening.</span>}</div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">Screening protocol updated.</div>}
      <div className="screening-stats">{states.slice(1).map((key) => <Link key={key} className={`screening-stat ${state === key ? "active" : ""}`} href={`/projects/${projectId}/screening?state=${key}`}><span>{key}</span><strong>{counts[key]}</strong></Link>)}</div>
      <div className="workspace-grid"><section className="card section-card"><div className="section-heading"><h2>Screening queue</h2><span className="count">{papers.length} shown</span></div>
        <div className="filter-row">{states.map((key) => <Link key={key} className={`button ghost ${state === key ? "active-filter" : ""}`} href={key === "all" ? `/projects/${projectId}/screening` : `/projects/${projectId}/screening?state=${key}`}>{key}</Link>)}</div>
        {papers.length === 0 ? <div className="empty">No papers match this screening state.</div> : <div className="item-list">{papers.map((paper) => <Link className="item item-row" key={paper.id} href={`/projects/${projectId}/screening/${paper.id}`}><div><div className="item-title">{paper.title}</div><div className="item-meta">{paper.authors.length ? paper.authors.join(", ") : "Author details not added"}{paper.publicationYear ? ` · ${paper.publicationYear}` : ""}</div></div><span className={`status screening-${paper.screeningState}`}>{paper.screeningState}</span></Link>)}</div>}
      </section>
      <section className="card section-card"><div className="section-heading"><h2>Screening criteria</h2><span className="count">{criteria.filter((criterion) => !criterion.archivedAt).length} active</span></div>
        <form action={createScreeningCriterionAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="criterion-type">Type</label><select id="criterion-type" name="type" defaultValue="inclusion"><option value="inclusion">Inclusion</option><option value="exclusion">Exclusion</option></select></div><div className="field"><label htmlFor="criterion-text">Criterion</label><textarea id="criterion-text" name="text" required placeholder="Document the review protocol" /></div><button className="button" type="submit">Add criterion</button></form>
        <div className="item-list" style={{ marginTop: 22 }}>{criteria.length === 0 ? <div className="empty">Add criteria to document why papers are included or excluded.</div> : criteria.map((criterion) => <div className="item" key={criterion.id}><div className="item-row"><div><div className="item-meta">{criterion.type}</div><div className="item-title">{criterion.text}</div></div>{criterion.archivedAt ? <span className="status unsupported">archived</span> : <form action={archiveScreeningCriterionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="criterionId" value={criterion.id} /><button className="button ghost" type="submit">Archive</button></form>}</div></div>)}</div>
      </section></div>
    </div></main>;
}
