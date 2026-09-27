import Link from "next/link";
import { notFound } from "next/navigation";
import { evidenceSetWorkspaceReadServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function EvidenceSetHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; setId: string; revisionId: string }>;
  searchParams?: Promise<{ cursor?: string }>;
}) {
  const { projectId, setId, revisionId } = await params;
  const query = searchParams ? await searchParams : {};
  let set;
  let page;
  let cursorNotice: string | undefined;
  try {
    set = await evidenceSetWorkspaceReadServices.getEvidenceSetWorkspace(projectId, setId);
    page = await evidenceSetWorkspaceReadServices.listRevisionMembersPage(projectId, setId, revisionId, { cursor: query.cursor });
  } catch (error) {
    if (query.cursor && error instanceof DomainError && error.code === "VALIDATION_ERROR") {
      cursorNotice = error.message;
      page = await evidenceSetWorkspaceReadServices.listRevisionMembersPage(projectId, setId, revisionId);
    } else if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    else throw error;
  }
  if (!set || !page) notFound();
  const nextHref = page.nextCursor ? `/projects/${projectId}/evidence-sets/${setId}/history/${revisionId}?cursor=${encodeURIComponent(page.nextCursor)}` : null;
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow"><Link href={`/projects/${projectId}/evidence-sets/${setId}`}>{set.set.name}</Link> / Exact historical composition</p><h1>{page.revision.operationKind} · sequence {page.revision.sequence}</h1><p>Immutable revision {page.revision.id}</p></div><span className={`status ${set.set.archivedAt ? "stale" : "supported"}`}>{set.set.archivedAt ? "Archived · frozen" : "Historical composition"}</span></div>
    {cursorNotice && <div className="error-banner" role="alert">{cursorNotice} This revision list has returned to its first page.</div>}
    <section className="card section-card"><div className="section-heading"><h2>Exact ordered members</h2><span className="count">{page.revision.memberCount} Evidence · {page.revision.distinctPaperCount} Papers</span></div>
      {page.items.length === 0 ? <div className="empty">This revision contains no Evidence members.</div> : <div className="item-list">{page.items.map((member) => <article className="item" key={member.membershipId}><div className="item-row"><div><strong>Page row {member.position}.</strong> <Link className="item-title" href={`/projects/${projectId}/evidence/${member.evidenceId}`}>{member.paperTitle}</Link></div><span className="item-meta">Page {member.pageNumber}</span></div><div className="quote">“{member.sourcePreview}”</div><div className="item-meta">{member.isUsed ? "Used downstream" : "No downstream use"}{member.publicationYear ? ` · ${member.publicationYear}` : ""}</div></article>)}</div>}
      <div className="item-row" style={{ marginTop: 18 }}>{query.cursor && <Link className="button ghost" href={`/projects/${projectId}/evidence-sets/${setId}/history/${revisionId}`}>First page</Link>}{nextHref && <Link className="button secondary" href={nextHref}>Next page</Link>}</div>
    </section>
  </div></div>;
}
