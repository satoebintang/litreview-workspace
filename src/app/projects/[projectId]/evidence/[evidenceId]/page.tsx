import Link from "next/link";
import { notFound } from "next/navigation";
import {
  appendEvidenceAnnotationAction,
  appendEvidenceReviewDecisionAction,
  assignEvidenceLabelAction,
  removeEvidenceLabelAction,
} from "@/app/actions";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

export default async function EvidenceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; evidenceId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, evidenceId } = await params;
  const query = searchParams ? await searchParams : {};
  let detail;
  try {
    detail = await reviewServices.getEvidenceCurationDetail(projectId, evidenceId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }
  const labels = await reviewServices.listEvidenceLabels(projectId, true);
  const currentLabelIds = new Set(detail.labels.map((label) => label.id));
  const assignableLabels = labels.filter((label) => !label.archivedAt && !currentLabelIds.has(label.id));
  const evidence = detail.evidence;
  const reviewLabel = detail.reviewState === "unreviewed" ? "Unreviewed" : detail.reviewState === "needs_review" ? "Needs review" : detail.reviewState === "accepted" ? "Accepted" : "Rejected";
  return <main className="shell">
    <header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace">
      <Link className="back-link" href={`/projects/${projectId}/evidence`}>← Evidence workspace</Link>
      <div className="workspace-header"><div><p className="eyebrow">Evidence detail</p><h1>{evidence.paper?.title ?? "Source Evidence"}</h1><p>Immutable source passage · page {evidence.pageNumber}</p></div><span className={`status ${detail.reviewState === "accepted" ? "supported" : detail.reviewState === "rejected" ? "withdrawn" : "stale"}`}>{reviewLabel}</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">Curation change saved.</div>}
      {detail.warnings.length > 0 && <div className="support-warning">{detail.reviewState === "rejected" ? "Currently rejected for new direct use." : detail.reviewState === "needs_review" ? "Needs review; direct use remains allowed." : "Never reviewed; direct use remains allowed."}</div>}
      <div className="workspace-grid">
        <section className="card section-card full"><div className="section-heading"><h2>Source and provenance</h2><span className="count">Source fact</span></div><p className="quote">“{evidence.sourceText}”</p><div className="item-meta">Paper: {evidence.paper?.title ?? evidence.paperId} · page {evidence.pageNumber}</div>{evidence.fullTextDocumentId ? <div className="item-meta"><Link href={`/projects/${projectId}/papers/${evidence.paperId}/documents/${evidence.fullTextDocumentId}`}>Document: {evidence.document?.originalFilename ?? evidence.fullTextDocumentId}</Link>{evidence.document?.sha256 && <> · SHA-256 {evidence.document.sha256}</>}{evidence.document?.archivedAt && " · archived"}</div> : <div className="item-meta">Document artifact: none recorded</div>}{evidence.documentTextExtractionId && <div className="item-meta"><Link href={`/projects/${projectId}/papers/${evidence.paperId}/documents/${evidence.fullTextDocumentId}/extractions/${evidence.documentTextExtractionId}`}>Extraction run: {evidence.documentTextExtractionId}</Link> · code-point offsets [{evidence.extractionStartOffset}, {evidence.extractionEndOffset})</div>}{evidence.note && <div className="item-meta">Creation-time recording note: {evidence.note}</div>}<p className="hint" style={{ marginTop: 16 }}>Source text, Paper linkage, document linkage, extraction identity, page, and offsets cannot be changed by curation.</p></section>

        <section className="card section-card"><div className="section-heading"><h2>Review</h2><span className="count">{detail.reviewHistory.length} decisions</span></div><form action={appendEvidenceReviewDecisionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceId" value={evidenceId} /><div className="field"><label htmlFor="review-decision">New decision</label><select id="review-decision" name="decision" defaultValue="needs_review"><option value="needs_review">Needs review</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option></select></div><div className="field"><label htmlFor="review-note">Decision note <span className="hint">optional · 2,000 characters</span></label><textarea id="review-note" name="note" maxLength={2000} /></div><button className="button" type="submit">Append review decision</button></form><div className="item-list" style={{ marginTop: 18 }}>{detail.reviewHistory.length === 0 ? <div className="empty">No decision yet. This Evidence is unreviewed.</div> : detail.reviewHistory.slice().reverse().map((decision) => <article className="item" key={decision.id}><div className="item-row"><div className="item-title">{decision.decision}</div><span className="item-meta">Sequence {decision.sequence}</span></div>{decision.note && <div className="item-meta">{decision.note}</div>}</article>)}</div></section>

        <section className="card section-card"><div className="section-heading"><h2>Annotations</h2><span className="count">{detail.annotations.length}</span></div><form action={appendEvidenceAnnotationAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceId" value={evidenceId} /><div className="field"><label htmlFor="annotation-body">Researcher annotation</label><textarea id="annotation-body" name="body" required maxLength={10000} placeholder="Record interpretation, context, or a follow-up question" /></div><button className="button" type="submit">Append annotation</button></form><div className="item-list" style={{ marginTop: 18 }}>{detail.annotations.length === 0 ? <div className="empty">No annotations yet.</div> : detail.annotations.slice().reverse().map((annotation) => <article className="item" key={annotation.id}><div className="item-meta">Sequence {annotation.sequence}</div><p>{annotation.body}</p></article>)}</div></section>

        <section className="card section-card"><div className="section-heading"><h2>Labels</h2><span className="count">{detail.labels.length} current</span></div>{detail.labels.length === 0 ? <p className="hint">No current labels.</p> : <div className="item-list">{detail.labels.map((label) => <article className="item" key={label.id}><div className="item-row"><span className="item-title">{label.name}</span><form action={removeEvidenceLabelAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceId" value={evidenceId} /><input type="hidden" name="labelId" value={label.id} /><button className="button ghost" type="submit">Remove</button></form></div>{label.archivedAt && <div className="item-meta">Archived label retained for history.</div>}</article>)}</div>}{assignableLabels.length > 0 && <form action={assignEvidenceLabelAction} style={{ marginTop: 14 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceId" value={evidenceId} /><div className="field"><label htmlFor="assign-label">Assign active label</label><select id="assign-label" name="labelId" required defaultValue=""><option value="" disabled>Select a label</option>{assignableLabels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}</select></div><button className="button secondary" type="submit">Assign label</button></form>}<div className="item-list" style={{ marginTop: 18 }}>{detail.labelHistory.length > 0 && detail.labelHistory.slice().reverse().map((event) => <article className="item" key={event.id}><div className="item-meta">{event.event} · label {labels.find((label) => label.id === event.labelId)?.name ?? event.labelId} · sequence {event.sequence}</div></article>)}</div></section>

        <section className="card section-card full"><div className="section-heading"><h2>Used by</h2><span className="count">{detail.usage.counts.claimRevisions + detail.usage.counts.extractionRevisions + detail.usage.counts.synthesisRevisions} analytical paths</span></div>{detail.usage.extractionRevisions.length > 0 && <div className="item-list"><h3>Extraction revisions</h3>{detail.usage.extractionRevisions.map((item) => <article className="item" key={item.id}>Revision {item.sequence} · {item.fieldName} · {item.valueState}</article>)}</div>}{detail.usage.synthesisRevisions.length > 0 && <div className="item-list"><h3>Synthesis revisions</h3>{detail.usage.synthesisRevisions.map((item) => <article className="item" key={item.id}>Revision {item.sequence} · {item.title ?? item.statementText ?? "Synthesis"}</article>)}</div>}{detail.usage.claimRevisions.length > 0 && <div className="item-list"><h3>Claim revisions</h3>{detail.usage.claimRevisions.map((item) => <article className="item" key={`${item.id}-${item.path}`}>Revision {item.sequence} · {item.path} · {item.claimText ?? "Claim"}</article>)}</div>}{detail.usage.manuscriptPlacements.length > 0 && <div className="item-list"><h3>Manuscript placements</h3>{detail.usage.manuscriptPlacements.map((item) => <article className="item" key={item.id}>Placement {item.id}{item.removedAt ? " · removed" : " · active"}</article>)}</div>}{detail.usage.counts.claimRevisions === 0 && detail.usage.counts.extractionRevisions === 0 && detail.usage.counts.synthesisRevisions === 0 && <div className="empty">This Evidence has no downstream analytical uses yet.</div>}</section>
      </div>
      <p className="footer-note">Current curation warnings annotate provenance; they do not rewrite immutable Extraction, Synthesis, Claim, citation, manuscript, or export history.</p>
    </div>
  </main>;
}
