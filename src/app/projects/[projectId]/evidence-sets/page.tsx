import Link from "next/link";
import { notFound } from "next/navigation";
import { createEvidenceSetAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function EvidenceSetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  try {
    project = await reviewServices.getProject(projectId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const sets = await reviewServices.listEvidenceSets(projectId, true);
  const active = sets.filter((item) => !item.set.archivedAt);
  const archived = sets.filter((item) => item.set.archivedAt);
  const savedMessage = query.saved === "created" ? "Evidence Set created." : undefined;
  return <main className="shell">
    <header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace">
      <Link className="back-link" href={`/projects/${projectId}`}>← Back to workspace</Link>
      <div className="workspace-header"><div><p className="eyebrow">Evidence Sets</p><h1>{project.title}</h1><p>Organize exact Evidence passages into researcher-defined thematic collections.</p></div><span className="status supported">● Researcher-organized</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      <div className="workspace-grid">
        <section className="card section-card"><div className="section-heading"><h2>New Evidence Set</h2><span className="count">{active.length} active</span></div><form action={createEvidenceSetAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="set-name">Name</label><input id="set-name" name="name" required maxLength={100} placeholder="Primary outcome: symptom reduction" /></div><div className="field"><label htmlFor="set-description">Purpose or theme <span className="hint">optional</span></label><textarea id="set-description" name="description" maxLength={500} placeholder="Why these passages are being compared" /></div><button className="button" type="submit">Create Evidence Set</button></form></section>
        <section className="card section-card"><div className="section-heading"><h2>Active Sets</h2><span className="count">{active.length}</span></div>{active.length === 0 ? <div className="empty">No active Evidence Sets yet.</div> : <div className="item-list">{active.map((item) => <article className="item" key={item.set.id}><div className="item-row"><div><Link className="item-title" href={`/projects/${projectId}/evidence-sets/${item.set.id}`}>{item.set.name}</Link>{item.set.description && <div className="item-meta">{item.set.description}</div>}</div><span className="status supported">{item.memberCount} {item.memberCount === 1 ? "Evidence" : "Evidence items"}</span></div><div className="item-meta">{item.distinctPaperCount} {item.distinctPaperCount === 1 ? "Paper" : "Papers"} · {item.curationCounts.unreviewed} unreviewed · {item.curationCounts.needsReview} needs review · {item.curationCounts.rejected} rejected</div></article>)}</div>}</section>
        <section className="card section-card full"><div className="section-heading"><h2>Archived Sets</h2><span className="count">{archived.length}</span></div>{archived.length === 0 ? <div className="empty">No archived Evidence Sets.</div> : <div className="item-list">{archived.map((item) => <article className="item" key={item.set.id}><div className="item-row"><div><Link className="item-title" href={`/projects/${projectId}/evidence-sets/${item.set.id}`}>{item.set.name}</Link>{item.set.description && <div className="item-meta">{item.set.description}</div>}</div><span className="status stale">Archived</span></div><div className="item-meta">{item.memberCount} {item.memberCount === 1 ? "Evidence" : "Evidence items"} · frozen and readable</div></article>)}</div>}</section>
      </div>
      <p className="footer-note">Evidence Sets organize research work; they never become source provenance or Synthesis support.</p>
    </div>
  </main>;
}
