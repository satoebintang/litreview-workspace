/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { notFound } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

type ProseHistoryServices = {
  getOrCreateDefaultManuscript: (projectId: string) => Promise<any>;
  getProseRevisionHistory: (projectId: string, manuscriptId: string, proseBlockId: string, options?: { beforeSequence?: number; limit?: number }) => Promise<any>;
  getProseRevisionComparison: (projectId: string, manuscriptId: string, proseBlockId: string, leftRevisionId: string, rightRevisionId: string) => Promise<any>;
};

const services = reviewServices as unknown as ProseHistoryServices;

function formatDate(value: unknown) {
  return value instanceof Date ? value.toLocaleString() : String(value ?? "");
}

function parsePositiveInteger(value: unknown) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export default async function ProseRevisionHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; proseBlockId: string }>;
  searchParams?: Promise<{ before?: string; left?: string; right?: string }>;
}) {
  const { projectId, proseBlockId } = await params;
  const query = searchParams ? await searchParams : {};
  let manuscript: any;
  try {
    manuscript = await services.getOrCreateDefaultManuscript(projectId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }

  let history: any;
  try {
    history = await services.getProseRevisionHistory(projectId, manuscript.id, proseBlockId, { beforeSequence: parsePositiveInteger(query.before), limit: 50 });
  } catch (error) {
    if (error instanceof DomainError && ["NOT_FOUND", "VALIDATION_ERROR", "CROSS_PROJECT_REFERENCE"].includes(error.code)) notFound();
    throw error;
  }

  let comparison: any = null;
  const hasComparison = Boolean(query.left && query.right && query.left !== query.right);
  if (hasComparison) {
    try {
      comparison = await services.getProseRevisionComparison(projectId, manuscript.id, proseBlockId, query.left!, query.right!);
    } catch (error) {
      if (error instanceof DomainError && ["NOT_FOUND", "VALIDATION_ERROR", "CROSS_PROJECT_REFERENCE"].includes(error.code)) {
        comparison = { error: "Choose two revisions belonging to this Prose block." };
      } else throw error;
    }
  }

  const contextStatus = history.item.removedAt ? "removed" : history.section.archivedAt ? "section archived" : "active";
  const historyHref = `/projects/${projectId}/manuscript/prose/${proseBlockId}/history`;
  const compareHref = (left: string, right: string) => `${historyHref}?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`;

  return <div className="project-page">
    <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Prose revision history</p><h1>{history.section.title}</h1><p>Immutable wording history for one stable Prose block. The canonical history begins with the baseline available when Slice 24 was migrated.</p></div><span className={`status ${contextStatus === "active" ? "supported" : "unsupported"}`}>{contextStatus}</span></div>
      <section className="card section-card full"><div className="section-heading"><h2>Prose context</h2><span className="count">Stable item identity: {history.item.id}</span></div><div className="item-meta">Section type: {history.section.sectionType} · item position: {history.item.sortOrder + 1} · {history.item.removedAt ? `removed ${formatDate(history.item.removedAt)}` : "currently active"}{history.section.archivedAt ? ` · section archived ${formatDate(history.section.archivedAt)}` : ""}</div><p className="hint">Revisions are exact text snapshots. A migrated baseline uses the best available timestamp associated with the content present at migration; it is not proof of original creation time or complete pre-Slice-24 history.</p></section>
      <section className="card section-card full"><div className="section-heading"><h2>Compare revisions</h2><span className="count">{history.revisionCount} total · choose two exact snapshots</span></div><form method="get" className="inline-form"><label htmlFor="prose-history-left">Left revision</label><select id="prose-history-left" name="left" defaultValue={query.left ?? ""}><option value="" disabled>Select a revision</option>{history.revisions.map((revision: any) => <option key={`left-${revision.id}`} value={revision.id}>Revision {revision.ordinal}</option>)}</select><label htmlFor="prose-history-right">Right revision</label><select id="prose-history-right" name="right" defaultValue={query.right ?? ""}><option value="" disabled>Select a revision</option>{history.revisions.map((revision: any) => <option key={`right-${revision.id}`} value={revision.id}>Revision {revision.ordinal}</option>)}</select><button className="button secondary" type="submit">Compare</button></form>{comparison?.error && <div className="error-banner" role="alert">{comparison.error}</div>}{comparison?.left && comparison?.right && <div className="workspace-grid" style={{ marginTop: 14 }}><div><strong>Revision {comparison.left.ordinal}</strong><div className="item-meta">{formatDate(comparison.left.createdAt)}{comparison.left.isCurrent ? " · current" : ""}</div><pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{comparison.left.proseText}</pre></div><div><strong>Revision {comparison.right.ordinal}</strong><div className="item-meta">{formatDate(comparison.right.createdAt)}{comparison.right.isCurrent ? " · current" : ""}</div><pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{comparison.right.proseText}</pre></div></div>}</section>
      <section className="card section-card full"><div className="section-heading"><h2>History</h2><span className="count">Newest first · {history.revisionCount} {history.revisionCount === 1 ? "revision" : "revisions"}</span></div>{history.revisions.length === 0 ? <div className="empty">No Prose revisions are available.</div> : <div className="item-list">{history.revisions.map((revision: any) => <article className="item" key={revision.id}><div className="item-row"><div><div className="item-title">Revision {revision.ordinal}{revision.isCurrent ? " · Current" : ""}</div><div className="item-meta">{formatDate(revision.createdAt)} · generated sequence {revision.sequence}</div></div><div className="claim-list-actions"><span className="status">{revision.isCurrent ? "current" : "historical"}</span>{history.revisions.some((candidate: any) => candidate.id !== revision.id) && <Link className="button ghost" href={compareHref(revision.id, history.revisions.find((candidate: any) => candidate.id !== revision.id).id)}>Compare</Link>}</div></div><pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", marginTop: 10 }}>{revision.proseText}</pre></article>)}</div>}{history.nextBeforeSequence !== null && <div className="claim-list-actions" style={{ marginTop: 14 }}><Link className="button secondary" href={`${historyHref}?before=${history.nextBeforeSequence}`}>Load older revisions</Link></div>}</section>
      <p className="footer-note">History is item-level and read-only. Editing always appends a new revision; no historical revision is made current by retargeting.</p>
    </div></div>;
}
