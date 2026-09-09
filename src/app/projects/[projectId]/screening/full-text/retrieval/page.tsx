import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

const states = ["all", "not_sought", "pending", "unavailable", "retrieved", "conflict"] as const;

export default async function FullTextRetrievalPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<{ state?: string }> }) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try { project = await reviewServices.getProject(projectId); } catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const state = states.includes(query.state as typeof states[number]) ? query.state as typeof states[number] : "all";
  const queue = await reviewServices.listFullTextRetrievalQueue(projectId, state === "all" ? undefined : state);
  const all = state === "all" ? queue : await reviewServices.listFullTextRetrievalQueue(projectId);
  const count = (key: typeof states[number]) => key === "all" ? all.length : all.filter(({ reviewStatus }) => key === "conflict" ? reviewStatus.warnings.includes("retrieval_history_without_current_title_abstract_inclusion") : reviewStatus.fullTextRetrievalState === key).length;
  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/screening/full-text`}>← Full-text screening</Link>
      <div className="workspace-header"><div><p className="eyebrow">Retrieval stage · {project.title}</p><h1>Full-text retrieval</h1><p>Record attempts to obtain sufficient full-text material. Retrieval history is separate from eligibility screening.</p></div></div>
      <div className="screening-stats">{states.map((key) => <Link key={key} className={`screening-stat ${state === key ? "active" : ""}`} href={key === "all" ? `/projects/${projectId}/screening/full-text/retrieval` : `/projects/${projectId}/screening/full-text/retrieval?state=${key}`}><span>{key.replaceAll("_", " ")}</span><strong>{count(key)}</strong></Link>)}</div>
      <section className="card section-card full"><div className="section-heading"><h2>Retrieval queue</h2><span className="count">{queue.length} shown</span></div>{queue.length === 0 ? <div className="empty">No Papers match this retrieval state.</div> : <div className="item-list">{queue.map(({ paper, reviewStatus }) => <Link className="item item-row" key={paper.id} href={`/projects/${projectId}/screening/full-text/retrieval/${paper.id}`}><div><div className="item-title">{paper.title}</div><div className="item-meta">TA: {reviewStatus.titleAbstractState} · current retrieval: {reviewStatus.fullTextRetrievalState} · ever retrieved: {reviewStatus.everRetrieved ? "yes" : "no"}</div></div><span className="status supported">{reviewStatus.fullTextRetrievalState.replaceAll("_", " ")}</span></Link>)}</div>}</section>
      <p className="footer-note">Only currently title/abstract-included Papers can receive new retrieval attempts. Historical retrieval and screening records remain readable.</p>
    </div></main>;
}
