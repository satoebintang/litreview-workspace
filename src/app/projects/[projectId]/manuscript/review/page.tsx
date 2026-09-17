/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { notFound } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";
import {
  commentManuscriptReviewThreadAction,
  openManuscriptReviewThreadAction,
  reopenManuscriptReviewThreadAction,
  resolveManuscriptReviewThreadAction,
} from "@/app/actions";

type ReviewServices = {
  getProject: (projectId: string) => Promise<any>;
  getOrCreateDefaultManuscript: (projectId: string) => Promise<any>;
  getFormattedManuscript: (projectId: string, manuscriptId: string) => Promise<any>;
  getManuscriptReviewProjection: (projectId: string, manuscriptId: string, options?: { sectionId?: string; sectionItemId?: string }) => Promise<any>;
};
const services = reviewServices as unknown as ReviewServices;

function itemType(item: any): "claim" | "prose" { return item.itemType ?? item.type; }
function itemPayload(item: any) { return itemType(item) === "claim" ? (item.placement ?? item.claimPlacement ?? item.claim ?? item) : (item.proseBlock ?? item.prose ?? item); }
function formatDate(value: unknown) { return value instanceof Date ? value.toLocaleString() : String(value ?? ""); }

export default async function ManuscriptReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ state?: string; section?: string; item?: string; thread?: string; saved?: string; error?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let manuscript: any;
  try {
    await services.getProject(projectId);
    manuscript = await services.getOrCreateDefaultManuscript(projectId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const [projection, formatted] = await Promise.all([
    services.getManuscriptReviewProjection(projectId, manuscript.id, { sectionId: query.section, sectionItemId: query.item }),
    services.getFormattedManuscript(projectId, manuscript.id),
  ]);
  const requestedState = query.state === "resolved" || query.state === "open" ? query.state : "all";
  const entries = projection.threads
    .filter((entry: any) => requestedState === "all" || entry.state === requestedState)
    .sort((left: any, right: any) => (left.state === right.state ? String(left.thread.createdAt).localeCompare(String(right.thread.createdAt)) : left.state === "open" ? -1 : 1));
  const activeItem = query.item ? (formatted.sections ?? []).flatMap((section: any) => section.items ?? []).find((item: any) => String(item.id) === query.item) : null;
  const activePayload = activeItem ? itemPayload(activeItem) : null;
  const activeSection = activeItem ? (formatted.sections ?? []).find((section: any) => (section.items ?? []).some((item: any) => String(item.id) === query.item)) : null;
  const saveMessage: Record<string, string> = { comment: "Comment added.", resolved: "Thread resolved.", reopened: "Thread reopened." };

  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/manuscript`}>← Manuscript composition</Link>
      <div className="workspace-header"><div><p className="eyebrow">Editorial review</p><h1>Manuscript review threads</h1><p>Editorial concerns keep immutable opening context. They are not manuscript version history and never alter research provenance, support, or citation state.</p></div><div className="claim-list-actions"><span className="status supported">● {projection.counts.open} open</span><span className="status">{projection.counts.resolved} resolved</span></div></div>
      <nav className="stagebar" aria-label="Review stages"><Link className="stage active" href={`/projects/${projectId}`}>1. Question</Link><Link className="stage active" href={`/projects/${projectId}/claims`}>4. Claims</Link><Link className="stage active" href={`/projects/${projectId}/manuscript`}>7. Writing</Link><span className="stage active">Editorial review</span></nav>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">{saveMessage[query.saved] ?? "Review updated."}</div>}
      <section className="card section-card full"><div className="section-heading"><h2>Review workspace</h2><span className="count">Opening snapshots are exact persisted target context</span></div>
        <form className="inline-form" method="get"><label htmlFor="review-state">State</label><select id="review-state" name="state" defaultValue={requestedState}><option value="all">All threads</option><option value="open">Open first</option><option value="resolved">Resolved history</option></select><label htmlFor="review-section">Section</label><select id="review-section" name="section" defaultValue={query.section ?? ""}><option value="">All sections</option>{projection.sections.map((section: any) => <option key={section.id} value={section.id}>{section.title}{section.archivedAt ? " (archived)" : ""}</option>)}</select><button className="button secondary" type="submit">Filter</button></form>
      </section>

      {activeItem && activePayload && activeSection && <section className="card section-card full"><div className="section-heading"><h2>Open review thread</h2><span className="count">{itemType(activeItem) === "prose" ? "Prose opening text is captured byte-for-byte" : "Claim opening identity is captured exactly"}</span></div><form action={openManuscriptReviewThreadAction}><input type="hidden" name="projectId" value={projectId}/><input type="hidden" name="manuscriptId" value={manuscript.id}/><input type="hidden" name="sectionItemId" value={activeItem.id}/><div className="field"><label htmlFor="review-title">Title</label><input id="review-title" name="title" required maxLength={300} placeholder="Clarify this passage" /></div><div className="field"><label htmlFor="review-comment">Opening comment</label><textarea id="review-comment" name="initialComment" required maxLength={10000} rows={3} placeholder="Describe the editorial concern…" /></div><div className="item-meta">Target: {activeSection.title} · {itemType(activeItem) === "prose" ? "Prose" : `ClaimRevision ${activePayload.claimRevision?.sequence ?? ""}`}</div><button className="button" type="submit">Open thread</button></form></section>}

      {entries.length === 0 ? <section className="card section-card full"><div className="empty">No review threads match these filters. Open one from an active manuscript item.</div></section> : <div className="item-list">{entries.map((entry: any) => <article className="card section-card full" key={entry.thread.id} id={entry.thread.id}>
        <div className="section-heading"><div><h2>{entry.thread.title}</h2><div className="item-meta">{entry.sectionTitle ?? "Historical section"} · {entry.target.itemType === "prose" ? "Prose" : "Claim placement"} · opened {formatDate(entry.thread.createdAt)}</div></div><span className={`status ${entry.state === "open" ? "supported" : ""}`}>{entry.state}</span></div>
        <div className="review-target"><h3>Opening/current target context</h3>{entry.target.itemType === "prose" && <div className="item-meta">Opening Prose revision: {entry.target.openingProseRevisionId ?? "NULL (opening snapshot predates Prose revision tracking)"} · Current Prose revision: {entry.target.currentProseRevisionId ?? "unavailable"}</div>}{entry.target.itemType === "prose" ? <><div className="item-meta">Target is {entry.target.targetActive ? "active" : "removed"}; Section is {entry.target.sectionArchived ? "archived" : "active"}; changed since opening: {entry.target.changedSinceOpening ? "yes" : "no"}</div><div className="workspace-grid"><div><strong>Opening Prose text</strong><pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{entry.target.openingText}</pre></div><div><strong>Current retained text</strong><pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{entry.target.currentText ?? "(no retained text)"}</pre></div></div></> : <><div className="item-meta">Target is {entry.target.targetActive ? "active" : "removed"}; Section is {entry.target.sectionArchived ? "archived" : "active"}; placement history is retained.</div><div className="workspace-grid"><div><strong>Opening ClaimRevision</strong><p>{entry.target.openingClaimRevision ? `Revision ${entry.target.openingClaimRevision.sequence}: ${entry.target.openingClaimRevision.claimText ?? "(withdrawn text)"}` : "Unavailable"}</p><div className="item-meta">Support facts at opening: {entry.target.formalSupport.openingSupportCount}</div></div><div><strong>Current/last retained placed ClaimRevision</strong><p>{entry.target.currentClaimRevision ? `Revision ${entry.target.currentClaimRevision.sequence}: ${entry.target.currentClaimRevision.claimText ?? "(withdrawn text)"}` : "Unavailable"}</p><div className="item-meta">{entry.target.currentRevisionAnnotation?.isSuperseded ? "Superseded" : entry.target.currentRevisionAnnotation?.isCurrentClaimRevision ? "Current revision" : "Historical revision"} · {entry.target.currentRevisionAnnotation?.claimLifecycle ?? "unknown"} · support facts: {entry.target.formalSupport.currentSupportCount}</div></div></div></>}</div>
        <div className="item-list" style={{ marginTop: 14 }}><h3>Immutable events</h3>{entry.events.map((event: any) => <div className="item" key={event.id}><div className="item-row"><div><div className="item-meta">#{event.sequence} · {event.eventType} · {formatDate(event.occurredAt)}</div>{event.body && <div style={{ whiteSpace: "pre-wrap" }}>{event.body}</div>}</div></div></div>)}</div>
        <form action={commentManuscriptReviewThreadAction} className="inline-form" style={{ marginTop: 14 }}><input type="hidden" name="projectId" value={projectId}/><input type="hidden" name="manuscriptId" value={manuscript.id}/><input type="hidden" name="threadId" value={entry.thread.id}/><input name="body" aria-label="Comment" required maxLength={10000} placeholder="Add an editorial comment…"/><button className="button ghost" type="submit">Comment</button></form>
        <div className="claim-list-actions" style={{ marginTop: 10 }}>{entry.state === "open" ? <form action={resolveManuscriptReviewThreadAction}><input type="hidden" name="projectId" value={projectId}/><input type="hidden" name="manuscriptId" value={manuscript.id}/><input type="hidden" name="threadId" value={entry.thread.id}/><input name="note" maxLength={10000} placeholder="Optional resolution note"/><button className="button secondary" type="submit">Resolve</button></form> : <form action={reopenManuscriptReviewThreadAction}><input type="hidden" name="projectId" value={projectId}/><input type="hidden" name="manuscriptId" value={manuscript.id}/><input type="hidden" name="threadId" value={entry.thread.id}/><input name="note" maxLength={10000} placeholder="Optional reopening note"/><button className="button secondary" type="submit">Reopen</button></form>}</div>
      </article>)}</div>}
      <p className="footer-note">Editorial review is separate from Evidence, ExtractionRevision, SynthesisRevision, ClaimRevision support, citations, Research Questions, Answers, and PRISMA/ReviewFlow. It is intentionally excluded from Markdown export.</p>
    </div></main>;
}
