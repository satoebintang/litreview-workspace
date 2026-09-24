import Link from "next/link";
import { notFound } from "next/navigation";
import { fullTextQueueReadServices, reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

const states = ["all", "not_sought", "pending", "unavailable", "retrieved", "conflict"] as const;

function stateHref(projectId: string, state: typeof states[number]) {
  const path = `/projects/${projectId}/screening/full-text/retrieval`;
  return state === "all" ? path : `${path}?state=${state}`;
}

export default async function FullTextRetrievalPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ state?: string; page?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }

  const queue = await fullTextQueueReadServices.listFullTextRetrievalQueuePage(projectId, { state: query.state, page: query.page });
  const state = queue.state;
  const nextPageHref = (page: number) => {
    const queryParams = new URLSearchParams();
    if (state !== "all") queryParams.set("state", state);
    queryParams.set("page", String(page));
    return `/projects/${projectId}/screening/full-text/retrieval?${queryParams.toString()}`;
  };

  return <div className="project-page">
    <div className="container workspace">
      <div className="workspace-header">
        <div>
          <p className="eyebrow">Retrieval stage · {project.title}</p>
          <h1>Full-text retrieval</h1>
          <p>Record attempts to obtain sufficient full-text material. Retrieval history is separate from eligibility screening.</p>
        </div>
      </div>

      <div className="screening-stats">
        {states.map((key) => <Link key={key} className={`screening-stat ${state === key ? "active" : ""}`} href={stateHref(projectId, key)}><span>{key.replaceAll("_", " ")}</span><strong>{queue.counts[key]}</strong></Link>)}
      </div>

      <section className="card section-card full">
        <div className="section-heading"><h2>Retrieval queue</h2><span className="count">{queue.from}–{queue.to} of {queue.totalCount}</span></div>
        {queue.items.length === 0 ? <div className="empty">No Papers match this retrieval state.</div> : <div className="item-list">
          {queue.items.map(({ paper, reviewStatus }) => <Link className="item item-row" key={paper.id} href={`/projects/${projectId}/screening/full-text/retrieval/${paper.id}`}>
            <div>
              <div className="item-title">{paper.title}</div>
              <div className="item-meta">TA: {reviewStatus.titleAbstractState} · current retrieval: {reviewStatus.fullTextRetrievalState} · ever retrieved: {reviewStatus.everRetrieved ? "yes" : "no"}</div>
            </div>
            <span className="status supported">{reviewStatus.fullTextRetrievalState.replaceAll("_", " ")}</span>
          </Link>)}
        </div>}
        <nav aria-label="Full-text retrieval queue pagination" className="filter-row">
          {queue.page > 1 ? <Link className="button ghost" href={nextPageHref(queue.page - 1)} aria-label="Previous page">Previous</Link> : <button className="button ghost" type="button" disabled>Previous</button>}
          <span aria-current="page">Page {queue.page} of {queue.totalPages}</span>
          {queue.page < queue.totalPages ? <Link className="button ghost" href={nextPageHref(queue.page + 1)} aria-label="Next page">Next</Link> : <button className="button ghost" type="button" disabled>Next</button>}
        </nav>
      </section>
      <p className="footer-note">Only currently title/abstract-included Papers can receive new retrieval attempts. Historical retrieval and screening records remain readable.</p>
    </div>
  </div>;
}
