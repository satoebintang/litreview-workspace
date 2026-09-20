import Link from "next/link";
import { notFound } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { beginDoiLookupAction } from "@/app/actions";
import { formatDate, loadDoiIntakeLanding } from "./ui";

export default async function DoiIntakePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<{ doi?: string; error?: string; saved?: string }> }) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let view;
  try {
    view = await loadDoiIntakeLanding(projectId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }

  return <main className="shell"><div className="container workspace">
    <Link className="back-link" href={`/projects/${projectId}`}>← Project</Link>
    <div className="workspace-header"><div><p className="eyebrow">Paper collection</p><h1>DOI lookup</h1><p className="hint">Fetch a bounded bibliographic proposal for researcher review. A lookup never creates or changes a canonical Paper by itself.</p></div><Link className="button ghost" href={`/projects/${projectId}`}>Paper collection</Link></div>
    {query.error && <div className="error-banner" role="alert">{query.error}</div>}
    {query.saved && <div className="success-note" role="status">DOI lookup request recorded.</div>}

    {!view.configured && <div className="support-warning" role="status">The DOI lookup read adapter is not exported by the shared server wiring in this worktree yet. The review surface is ready for the expected request/list interfaces; no placeholder Paper data is shown.</div>}

    <section className="card section-card"><h2>Look up a DOI</h2><p className="hint">Enter a DOI or DOI URL. The provider response is reduced to bounded bibliographic fields and transport diagnostics; abstracts and raw provider payloads are intentionally excluded.</p><form action={beginDoiLookupAction}>
      <input type="hidden" name="projectId" value={projectId} />
      <div className="field"><label htmlFor="doi">DOI</label><input id="doi" name="submittedDoi" defaultValue={query.doi ?? ""} placeholder="10.1000/example" required /></div>
      <button className="button" type="submit" disabled={!view.configured}>Start bounded DOI lookup</button>
    </form>
    </section>

    <section className="card section-card"><div className="section-heading"><h2>Lookup history</h2><span className="count">{view.requests.length} {view.requests.length === 1 ? "request" : "requests"}</span></div>
      {view.requests.length === 0 ? <div className="empty">No DOI lookup requests are available yet.</div> : <div className="item-list">{view.requests.map((request) => <article className="item" key={request.id}><div className="item-row"><div><Link className="item-title" href={`/projects/${projectId}/papers/doi-intake/${request.id}`}>{request.doi || "Unnamed DOI request"}</Link><div className="item-meta">{request.provider} · {request.status} · created {formatDate(request.createdAt)}</div>{request.outcome && <div className="item-meta">Outcome: {request.outcome}{request.diagnostic ? ` · ${request.diagnostic}` : ""}</div>}</div><span className="status">{request.status}</span></div></article>)}</div>}
    </section>
    <p className="footer-note">Resolution is explicit: review the bounded proposal and candidate Papers before choosing create, match, or clear.</p>
  </div></main>;
}
