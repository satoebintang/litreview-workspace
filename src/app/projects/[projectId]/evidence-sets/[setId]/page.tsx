import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addEvidenceToSetAction,
  appendEvidenceSetAnnotationAction,
  archiveEvidenceSetAction,
  removeEvidenceFromSetAction,
  reorderEvidenceSetAction,
  updateEvidenceSetMetadataAction,
} from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import { EvidenceSetOrderForm } from "../EvidenceSetOrderForm";

export default async function EvidenceSetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; setId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, setId } = await params;
  const query = searchParams ? await searchParams : {};
  let detail;
  try {
    detail = await reviewServices.getEvidenceSet(projectId, setId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }
  const active = !detail.set.archivedAt;
  const candidates = active ? await reviewServices.listCandidateEvidenceForSet(projectId, setId) : [];
  const savedMessage = query.saved === "created" ? "Evidence Set created." : query.saved === "metadata" ? "Evidence Set metadata saved." : query.saved === "member" ? "Evidence Set membership saved." : query.saved === "reordered" ? "Evidence Set order saved." : query.saved === "annotation" ? "Evidence Set annotation saved." : query.saved === "archived" ? "Evidence Set archived and frozen." : undefined;
  const historyEvidenceLabel = new Map(detail.members.filter((item): item is typeof item & { evidence: NonNullable<typeof item.evidence> } => Boolean(item.evidence)).map((item) => [item.evidence!.id, item.evidence!.sourceText]));
  return <main className="shell">
    <header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace">
      <Link className="back-link" href={`/projects/${projectId}/evidence-sets`}>← Evidence Sets</Link>
      <div className="workspace-header"><div><p className="eyebrow">Evidence Set</p><h1>{detail.set.name}</h1><p>{detail.set.description ?? "Researcher-defined thematic organization"}</p></div><span className={`status ${active ? "supported" : "stale"}`}>{active ? "● Active" : "Archived · frozen"}</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      <div className="workspace-grid">
        <section className="card section-card"><div className="section-heading"><h2>Set metadata</h2><span className="count">{detail.members.length} members · {new Set(detail.members.map((item) => item.evidence?.paperId).filter(Boolean)).size} Papers</span></div>{active ? <><form action={updateEvidenceSetMetadataAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><div className="field"><label htmlFor="set-name">Name</label><input id="set-name" name="name" defaultValue={detail.set.name} required maxLength={100} /></div><div className="field"><label htmlFor="set-description">Purpose or theme</label><textarea id="set-description" name="description" defaultValue={detail.set.description ?? ""} maxLength={500} /></div><button className="button secondary" type="submit">Save metadata</button></form><form action={archiveEvidenceSetAction} style={{ marginTop: 12 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><button className="button ghost" type="submit">Archive and freeze set</button></form></> : <><div className="item-meta">Created {detail.set.createdAt.toLocaleString()} · Archived {detail.set.archivedAt?.toLocaleString()}</div><p className="support-warning">This set is frozen. Its composition and annotations remain readable, but no changes are allowed.</p></>}</section>

        <section className="card section-card"><div className="section-heading"><h2>Researcher annotations</h2><span className="count">{detail.annotations.length}</span></div>{active && <form action={appendEvidenceSetAnnotationAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><div className="field"><label htmlFor="set-annotation">Append note</label><textarea id="set-annotation" name="body" required maxLength={10000} placeholder="Explain the emerging pattern or comparison question" /></div><button className="button" type="submit">Append set note</button></form>}<div className="item-list" style={{ marginTop: 18 }}>{detail.annotations.length === 0 ? <div className="empty">No set annotations yet.</div> : detail.annotations.slice().reverse().map((annotation) => <article className="item" key={annotation.id}><div className="item-meta">Sequence {annotation.sequence} · {annotation.createdAt.toLocaleString()}</div><p>{annotation.body}</p></article>)}</div></section>

        <section className="card section-card full"><div className="section-heading"><div><h2>Ordered Evidence comparison</h2><p className="hint">Rows retain exact source provenance while bringing passages from multiple Papers into one researcher workspace.</p></div><span className="count">{detail.members.length} Evidence</span></div>{detail.members.length === 0 ? <div className="empty">This set is empty. Add Evidence below.</div> : <div className="item-list">{detail.members.map((member) => { const item = member.evidence; return <article className="item" key={member.membership.id}><div className="item-row"><div><strong>{member.sortOrder}.</strong> {item ? <Link className="item-title" href={`/projects/${projectId}/evidence/${item.id}`}>{item.paper?.title ?? item.paperId}</Link> : "Evidence unavailable"}</div>{active && <form action={removeEvidenceFromSetAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><input type="hidden" name="evidenceId" value={member.membership.evidenceId} /><button className="button ghost" type="submit">Remove</button></form>}</div>{item && <><div className="quote">“{item.sourceText}”</div><div className="item-meta">Page {item.pageNumber}{item.paper?.publicationYear ? ` · ${item.paper.publicationYear}` : ""} · {item.usage === "used" ? "Used downstream" : "No downstream use"}</div><div className="item-meta">{item.fullTextDocumentId ? <Link href={`/projects/${projectId}/papers/${item.paperId}/documents/${item.fullTextDocumentId}`}>Document provenance{item.document?.archivedAt ? " (archived)" : ""}</Link> : "Document artifact: none recorded"}{item.documentTextExtractionId ? ` · exact extraction span [${item.extractionStartOffset}, ${item.extractionEndOffset})` : ""}</div>{item.labels.length > 0 && <div className="path-list">{item.labels.map((label) => <span key={label.id}>{label.name}{label.archivedAt ? " (archived)" : ""}</span>)}</div>}{item.reviewState !== "accepted" && <div className="support-warning">{item.reviewState === "rejected" ? "Currently rejected for new direct use; retained here for comparison." : item.reviewState === "needs_review" ? "This Evidence needs review." : "This Evidence has never been reviewed."}</div>}</>}</article>; })}</div>}
        </section>

        {active && <section className="card section-card"><div className="section-heading"><h2>Reorder</h2><span className="count">Explicit order</span></div><EvidenceSetOrderForm action={reorderEvidenceSetAction} projectId={projectId} evidenceSetId={setId} initialItems={detail.members.map((member) => ({ evidenceId: member.membership.evidenceId, label: `${member.evidence?.paper?.title ?? "Evidence"} · page ${member.evidence?.pageNumber ?? "?"}` }))} /></section>}

        {active && <section className="card section-card"><div className="section-heading"><h2>Add Evidence</h2><span className="count">{candidates.length} available</span></div>{candidates.length === 0 ? <div className="empty">Every Evidence item in this Project is already in the set.</div> : <form action={addEvidenceToSetAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><div className="field"><label htmlFor="candidate-evidence">Evidence from this Project</label><select id="candidate-evidence" name="evidenceId" required defaultValue=""><option value="" disabled>Select an Evidence passage</option>{candidates.map((item) => <option key={item.id} value={item.id}>{item.paper?.title ?? item.paperId} · page {item.pageNumber} · {item.sourceText.slice(0, 90)}</option>)}</select></div><button className="button secondary" type="submit">Add to this set</button></form>}</section>}

        <section className="card section-card"><div className="section-heading"><h2>Composition history</h2><span className="count">{detail.compositionHistory.length} snapshots</span></div><div className="item-list">{detail.compositionHistory.map((entry) => <details className="item" key={entry.revision.id}><summary><strong>{entry.revision.operationKind}</strong> · sequence {entry.revision.sequence} · {entry.evidenceIds.length} active</summary><div className="item-meta">{entry.revision.createdAt.toLocaleString()}</div>{entry.evidenceIds.length > 0 && <ol>{entry.evidenceIds.map((evidenceId) => <li key={evidenceId}>{historyEvidenceLabel.get(evidenceId) ? `“${historyEvidenceLabel.get(evidenceId)!.slice(0, 120)}”` : evidenceId}</li>)}</ol>}</details>)}</div></section>

        <section className="card section-card"><div className="section-heading"><h2>Related ExtractionRevisions</h2><span className="count">{detail.relatedExtractionRevisions.length}</span></div>{detail.relatedExtractionRevisions.length === 0 ? <div className="empty">No ExtractionRevisions currently reference these Evidence passages.</div> : <div className="item-list">{detail.relatedExtractionRevisions.map((revision) => <article className="item" key={revision.id}><div className="item-row"><div><div className="item-title">{revision.fieldName} · {revision.paperTitle}</div><div className="item-meta">Revision {revision.sequence} · {revision.valueState}{revision.isCurrent ? " · current" : " · superseded"}</div></div><div style={{ display: "flex", gap: 8 }}><Link className="button ghost" href={`/projects/${projectId}/extraction/${revision.paperId}`}>Open extraction</Link><Link className="button ghost" href={`/projects/${projectId}/synthesis?fieldId=${revision.fieldId}`}>Open synthesis field</Link></div></div></article>)}</div>}<p className="hint" style={{ marginTop: 14 }}>These are navigation links only. No Synthesis or Claim support is created by set membership.</p></section>
      </div>
      <p className="footer-note">Evidence Sets are organizational snapshots. Source provenance, curation history, analytical support, citations, manuscripts, and reporting remain unchanged.</p>
    </div>
  </main>;
}
