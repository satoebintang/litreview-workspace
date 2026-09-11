import Link from "next/link";
import { notFound } from "next/navigation";
import {
  archiveEvidenceLabelAction,
  createEvidenceLabelAction,
} from "@/app/actions";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

const states = ["attention", "unreviewed", "needs_review", "accepted", "rejected", "all"] as const;

export default async function EvidenceWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ state?: string; paperId?: string; labelId?: string; error?: string; saved?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  const state = states.includes(query.state as typeof states[number]) ? query.state as typeof states[number] : "attention";
  let project;
  try { project = await reviewServices.getProject(projectId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const [workspace, papers, labels] = await Promise.all([
    reviewServices.listEvidenceWorkspace(projectId, { state, paperId: query.paperId, labelId: query.labelId }),
    reviewServices.listPapers(projectId),
    reviewServices.listEvidenceLabels(projectId, true),
  ]);
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  const stateLabel: Record<string, string> = { attention: "Attention", unreviewed: "Unreviewed", needs_review: "Needs review", accepted: "Accepted", rejected: "Rejected", all: "All" };
  return <main className="shell">
    <header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace">
      <Link className="back-link" href={`/projects/${projectId}`}>← {project.title}</Link>
      <div className="workspace-header"><div><p className="eyebrow">Evidence curation</p><h1>Evidence workspace</h1><p>Review researcher curation around immutable source passages.</p></div><span className="status supported">{workspace.total} matching</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}
      {query.saved && <div className="success-note" role="status">{query.saved === "label" ? "Label change saved." : query.saved === "label-archived" ? "Label archived." : "Curation change saved."}</div>}
      <nav className="stagebar" aria-label="Evidence review states">{states.map((item) => <Link key={item} className={`stage ${state === item ? "active" : ""}`} href={`/projects/${projectId}/evidence?state=${item}`}>{stateLabel[item]}</Link>)}</nav>
      <div className="workspace-grid">
        <section className="card section-card full">
          <div className="section-heading"><h2>Filter Evidence</h2><span className="count">{stateLabel[state]}</span></div>
          <form method="get" className="filter-grid">
            <div className="field"><label htmlFor="evidence-state">Review state</label><select id="evidence-state" name="state" defaultValue={state}>{states.map((item) => <option key={item} value={item}>{stateLabel[item]}</option>)}</select></div>
            <div className="field"><label htmlFor="evidence-paper-filter">Paper</label><select id="evidence-paper-filter" name="paperId" defaultValue={query.paperId ?? ""}><option value="">All Papers</option>{papers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}</option>)}</select></div>
            <div className="field"><label htmlFor="evidence-label-filter">Current label</label><select id="evidence-label-filter" name="labelId" defaultValue={query.labelId ?? ""}><option value="">All labels</option>{labels.map((label) => <option key={label.id} value={label.id}>{label.name}{label.archivedAt ? " (archived)" : ""}</option>)}</select></div>
            <div className="field" style={{ alignSelf: "end" }}><button className="button secondary" type="submit">Apply filters</button></div>
          </form>
        </section>
        <section className="card section-card full">
          <div className="section-heading"><h2>Evidence queue</h2><span className="count">{workspace.items.length} shown</span></div>
          {workspace.items.length === 0 ? <div className="empty">No Evidence matches this curation view.</div> : <div className="item-list">{workspace.items.map((item) => <article className="item" key={item.id}>
            <div className="item-row"><div><div className="quote">“{item.sourceText}”</div><div className="item-meta">Page {item.pageNumber} · <span className="paper-chip">{paperById.get(item.paperId)?.title ?? item.paper?.title ?? "Source paper"}</span></div></div><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><span className={`status ${item.reviewState === "rejected" ? "withdrawn" : item.reviewState === "accepted" ? "supported" : "stale"}`}>{stateLabel[item.reviewState]}</span>{item.usage === "used" && <span className="status supported">Used downstream</span>}</div></div>
            <div className="item-meta">{item.fullTextDocumentId ? <Link href={`/projects/${projectId}/papers/${item.paperId}/documents/${item.fullTextDocumentId}`}>Document artifact{item.document?.archivedAt ? " (archived)" : ""}</Link> : "Document artifact: none recorded"}{item.documentTextExtractionId ? <> · exact extraction span [{item.extractionStartOffset}, {item.extractionEndOffset})</> : null}</div>
            {item.labels.length > 0 && <div className="path-list">{item.labels.map((label) => <span key={label.id}>{label.name}{label.archivedAt ? " (archived)" : ""}</span>)}</div>}
            {item.warnings.length > 0 && <div className="support-warning">{item.reviewState === "rejected" ? "Currently rejected for new direct use." : item.reviewState === "needs_review" ? "This Evidence needs review." : "This Evidence has never been reviewed."}</div>}
            <div style={{ marginTop: 10 }}><Link className="button ghost" href={`/projects/${projectId}/evidence/${item.id}`}>Open Evidence detail →</Link></div>
          </article>)}</div>}
        </section>
        <section className="card section-card">
          <div className="section-heading"><h2>Project labels</h2><span className="count">{labels.filter((label) => !label.archivedAt).length} active</span></div>
          <form action={createEvidenceLabelAction}><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="label-name">New label</label><input id="label-name" name="name" required maxLength={100} placeholder="methodology" /></div><div className="field"><label htmlFor="label-description">Description <span className="hint">optional</span></label><textarea id="label-description" name="description" maxLength={500} /></div><button className="button" type="submit">Create label</button></form>
          <div className="item-list" style={{ marginTop: 18 }}>{labels.length === 0 ? <div className="empty">No labels yet.</div> : labels.map((label) => <article className="item" key={label.id}><div className="item-row"><div><div className="item-title">{label.name}</div>{label.description && <div className="item-meta">{label.description}</div>}</div>{label.archivedAt ? <span className="status stale">Archived</span> : <form action={archiveEvidenceLabelAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="labelId" value={label.id} /><button className="button ghost" type="submit">Archive</button></form>}</div></article>)}</div>
        </section>
      </div>
      <p className="footer-note">Curation never edits source text, Paper identity, document provenance, extraction identity, page, or offsets.</p>
    </div>
  </main>;
}
