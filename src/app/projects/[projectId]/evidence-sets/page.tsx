import Link from "next/link";
import { notFound } from "next/navigation";
import { createEvidenceSetAction } from "@/app/actions";
import { evidenceSetWorkspaceReadServices, reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function EvidenceSetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string; cursor?: string; query?: string; visibility?: "all" | "active" | "archived" }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let page;
  let cursorNotice: string | undefined;
  try {
    await reviewServices.getProject(projectId);
    try {
      page = await evidenceSetWorkspaceReadServices.listEvidenceSetCollectionPage(projectId, { cursor: query.cursor, query: query.query ?? "", visibility: query.visibility ?? "all" });
    } catch (error) {
      if (!query.cursor || !(error instanceof DomainError) || error.code !== "VALIDATION_ERROR") throw error;
      cursorNotice = error.message;
      page = await evidenceSetWorkspaceReadServices.listEvidenceSetCollectionPage(projectId, { query: query.query ?? "", visibility: query.visibility ?? "all" });
    }
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const active = page.items.filter((item) => !item.set.archivedAt);
  const archived = page.items.filter((item) => item.set.archivedAt);
  const savedMessage = query.saved === "created" ? "Evidence Set created." : undefined;
  const nextParams = page.nextCursor ? new URLSearchParams({ cursor: page.nextCursor, query: page.query, visibility: page.visibility }) : null;
  const nextHref = nextParams ? `/projects/${projectId}/evidence-sets?${nextParams.toString()}` : null;
  return <div className="project-page">
    <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Evidence Sets</p><h1>Researcher-defined comparisons</h1><p>Organize exact Evidence passages into thematic collections.</p></div><span className="status supported">● Researcher-organized</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      {cursorNotice && <div className="error-banner" role="alert">{cursorNotice} Search results have returned to the first page.</div>}
      <div className="workspace-grid">
        <section className="card section-card"><div className="section-heading"><h2>New Evidence Set</h2><span className="count">{page.totals.active} active · {page.totals.archived} archived</span></div><form action={createEvidenceSetAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="set-name">Name</label><input id="set-name" name="name" required maxLength={100} placeholder="Primary outcome: symptom reduction" /></div><div className="field"><label htmlFor="set-description">Purpose or theme <span className="hint">optional</span></label><textarea id="set-description" name="description" maxLength={500} placeholder="Why these passages are being compared" /></div><button className="button" type="submit">Create Evidence Set</button></form></section>
        <section className="card section-card"><div className="section-heading"><h2>Evidence Sets</h2><span className="count">{page.totals.active} active · {page.totals.archived} archived</span></div><form method="get"><div className="field"><label htmlFor="evidence-set-query">Search Sets</label><input id="evidence-set-query" name="query" type="search" maxLength={200} defaultValue={page.query} placeholder="Set name or purpose" /></div><div className="field"><label htmlFor="evidence-set-visibility">Browse</label><select id="evidence-set-visibility" name="visibility" defaultValue={page.visibility}><option value="all">All Sets</option><option value="active">Active Sets</option><option value="archived">Archived Sets</option></select></div><button className="button secondary" type="submit">Search or browse</button></form><p className="hint">Showing {active.length} active and {archived.length} archived Sets on this page.</p>{page.items.length === 0 ? <div className="empty">No Evidence Sets match this search.</div> : <div className="item-list">{page.items.map((item) => <article className="item" key={item.set.id}><div className="item-row"><div><Link className="item-title" href={`/projects/${projectId}/evidence-sets/${item.set.id}`}>{item.set.name}</Link>{item.set.description && <div className="item-meta">{item.set.description}</div>}</div><span className={`status ${item.set.archivedAt ? "stale" : "supported"}`}>{item.set.archivedAt ? "Archived" : `${item.memberCount} Evidence`}</span></div><div className="item-meta">{item.distinctPaperCount} {item.distinctPaperCount === 1 ? "Paper" : "Papers"} · {item.curationCounts.unreviewed} unreviewed · {item.curationCounts.needsReview} needs review · {item.curationCounts.rejected} rejected</div></article>)}</div>}
          {nextHref && <div style={{ marginTop: 18 }}><Link className="button secondary" href={nextHref}>Next page</Link></div>}
        </section>
      </div>
      <p className="footer-note">Evidence Sets organize research work; they never become source provenance or Synthesis support.</p>
    </div>
  </div>;
}
