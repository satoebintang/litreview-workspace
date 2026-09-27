import Link from "next/link";
import { notFound } from "next/navigation";
import {
  addEvidenceToSetAction,
  appendEvidenceSetAnnotationAction,
  archiveEvidenceSetAction,
  createSynthesisPreparationAction,
  moveEvidenceSetMembershipAction,
  removeEvidenceFromSetAction,
  updateEvidenceSetMetadataAction,
} from "@/app/actions";
import { evidenceSetWorkspaceReadServices } from "@/app/server";
import { ConfirmAction } from "@/components/ConfirmAction";
import { DomainError } from "@/domain/errors";

type Search = {
  error?: string; saved?: string; revisionId?: string; direction?: string;
  memberCursor?: string; candidateBrowse?: string; candidateQuery?: string; candidateCursor?: string;
  historyCursor?: string; annotationCursor?: string; fieldCursor?: string; relatedCursor?: string;
};

function pageHref(projectId: string, setId: string, key: string, cursor: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ ...extra, [key]: cursor });
  return `/projects/${projectId}/evidence-sets/${setId}?${params.toString()}`;
}

export default async function EvidenceSetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; setId: string }>;
  searchParams?: Promise<Search>;
}) {
  const { projectId, setId } = await params;
  const query = searchParams ? await searchParams : {};
  let shell;
  try {
    shell = await evidenceSetWorkspaceReadServices.getEvidenceSetWorkspace(projectId, setId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }
  const active = !shell.set.archivedAt;
  const revisionId = shell.currentRevision.id;
  const candidateBrowse = active && query.candidateBrowse === "1";
  let cursorNotice: string | undefined;
  async function readPage<T>(cursor: string | undefined, read: (cursor?: string) => Promise<T>): Promise<T> {
    try {
      return await read(cursor);
    } catch (error) {
      if (cursor && error instanceof DomainError && error.code === "VALIDATION_ERROR") {
        cursorNotice = error.message;
        return read(undefined);
      }
      throw error;
    }
  }
  const [members, history, annotations, fields, related, candidates] = await Promise.all([
    readPage(query.memberCursor, (cursor) => evidenceSetWorkspaceReadServices.listCurrentMembersPage(projectId, setId, { expectedRevisionId: revisionId, cursor })),
    readPage(query.historyCursor, (cursor) => evidenceSetWorkspaceReadServices.listCompositionHistoryPage(projectId, setId, { cursor })),
    readPage(query.annotationCursor, (cursor) => evidenceSetWorkspaceReadServices.listAnnotationsPage(projectId, setId, { cursor })),
    active ? readPage(query.fieldCursor, (cursor) => evidenceSetWorkspaceReadServices.listSynthesisFieldOptionsPage(projectId, setId, { expectedRevisionId: revisionId, cursor })) : Promise.resolve(null),
    readPage(query.relatedCursor, (cursor) => evidenceSetWorkspaceReadServices.listRelatedExtractionRevisionsPage(projectId, setId, { expectedRevisionId: revisionId, cursor })),
    candidateBrowse ? readPage(query.candidateCursor, (cursor) => evidenceSetWorkspaceReadServices.searchEvidenceSetCandidates(projectId, setId, { expectedRevisionId: revisionId, query: query.candidateQuery ?? "", cursor })) : Promise.resolve(null),
  ]);
  const savedMessage = query.saved === "created" ? "Evidence Set created." : query.saved === "metadata" ? "Evidence Set metadata saved." : query.saved === "member" ? "Evidence Set membership saved." : query.saved === "boundary" ? query.direction === "up" ? "This Evidence is already first in the current order." : "This Evidence is already last in the current order." : query.saved === "annotation" ? "Evidence Set annotation saved." : query.saved === "archived" ? "Evidence Set archived and frozen." : undefined;
  const stale = members.cursorStatus === "stale" || candidates?.cursorStatus === "stale" || fields?.cursorStatus === "stale" || related.cursorStatus === "stale";
  const candidateExtra = { candidateBrowse: "1", candidateQuery: query.candidateQuery ?? "" };
  return <div className="project-page">
    <div className="container workspace">
      <div className="workspace-header"><div><p className="eyebrow"><Link href={`/projects/${projectId}/evidence-sets`}>Evidence Sets</Link> / Evidence Set</p><h1>{shell.set.name}</h1><p>{shell.set.description ?? "Researcher-defined thematic organization"}</p></div><span className={`status ${active ? "supported" : "stale"}`}>{active ? "● Active" : "Archived · frozen"}</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      {cursorNotice && <div className="error-banner" role="alert">{cursorNotice} The affected list has returned to its first page.</div>}
      {stale && <div className="error-banner" role="alert">This Evidence Set changed after the page was opened. Reload the current composition before continuing.</div>}
      <div className="workspace-grid">
        <section className="card section-card">
          <div className="section-heading"><h2>Set metadata</h2><span className="count">{shell.currentRevision.memberCount} Evidence · {shell.currentRevision.distinctPaperCount} Papers</span></div>
          {active ? <><form action={updateEvidenceSetMetadataAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><div className="field"><label htmlFor="set-name">Name</label><input id="set-name" name="name" defaultValue={shell.set.name} required maxLength={100} /></div><div className="field"><label htmlFor="set-description">Purpose or theme</label><textarea id="set-description" name="description" defaultValue={shell.set.description ?? ""} maxLength={500} /></div><button className="button secondary" type="submit">Save metadata</button></form><div style={{ marginTop: 12 }}><ConfirmAction action={archiveEvidenceSetAction} label="Archive and freeze set" title="Archive and freeze this Evidence Set?" description="This is a researcher-controlled organizational snapshot." consequence="The set will become read-only. Its composition and annotations will remain available for historical review." hiddenFields={{ projectId, evidenceSetId: setId }} confirmLabel="Archive and freeze set" /></div></> : <><div className="item-meta">Created {shell.set.createdAt.toLocaleString()} · Archived {shell.set.archivedAt?.toLocaleString()}</div><p className="support-warning">This set is frozen. Its composition and annotations remain readable, but no changes are allowed.</p></>}
          <div className="item-meta" data-testid="composition-revision">Composition revision {revisionId}</div>
        </section>

        <section className="card section-card">
          <div className="section-heading"><h2>Researcher annotations</h2><span className="count">{annotations.items.length} shown</span></div>
          {active && <form action={appendEvidenceSetAnnotationAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><div className="field"><label htmlFor="set-annotation">Append note</label><textarea id="set-annotation" name="body" required maxLength={10000} placeholder="Explain the emerging pattern or comparison question" /></div><button className="button" type="submit">Append set note</button></form>}
          <div className="item-list" style={{ marginTop: 18 }}>{annotations.items.length === 0 ? <div className="empty">No set annotations yet.</div> : annotations.items.map((annotation) => <article className="item" key={annotation.id}><div className="item-meta">Sequence {annotation.sequence} · {annotation.createdAt.toLocaleString()}</div><p>{annotation.bodyPreview}{annotation.bodyCodePointLength > [...annotation.bodyPreview].length ? "…" : ""}</p><Link href={`/projects/${projectId}/evidence-sets/${setId}/annotations/${annotation.id}`} className="button ghost">Open note</Link></article>)}</div>
          {annotations.nextCursor && <Link className="button secondary" href={pageHref(projectId, setId, "annotationCursor", annotations.nextCursor)}>More annotations</Link>}
        </section>

        <section className="card section-card full">
          <div className="section-heading"><div><h2>Ordered Evidence comparison</h2><p className="hint">Source previews are bounded; open an Evidence item for its full provenance.</p></div><span className="count">{shell.currentRevision.memberCount} total · {members.items.length} shown</span></div>
          {members.items.length === 0 ? <div className="empty">This set is empty. Add Evidence below.</div> : <div className="item-list">{members.items.map((member) => <article className="item" key={member.membershipId} data-testid="evidence-set-member">
            <div className="item-row"><div><strong>Page row {member.position}.</strong> <Link className="item-title" href={`/projects/${projectId}/evidence/${member.evidenceId}`}>{member.paperTitle}</Link></div>{active && <div style={{ display: "flex", gap: 8 }}>
              <form action={moveEvidenceSetMembershipAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><input type="hidden" name="expectedRevisionId" value={revisionId} /><input type="hidden" name="membershipId" value={member.membershipId} /><input type="hidden" name="direction" value="up" /><button className="button ghost" type="submit" aria-label={`Move ${member.paperTitle} up`}>Move up</button></form>
              <form action={moveEvidenceSetMembershipAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><input type="hidden" name="expectedRevisionId" value={revisionId} /><input type="hidden" name="membershipId" value={member.membershipId} /><input type="hidden" name="direction" value="down" /><button className="button ghost" type="submit" aria-label={`Move ${member.paperTitle} down`}>Move down</button></form>
              <form action={removeEvidenceFromSetAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><input type="hidden" name="expectedRevisionId" value={revisionId} /><input type="hidden" name="evidenceId" value={member.evidenceId} /><button className="button ghost" type="submit">Remove</button></form>
            </div>}</div>
            <div className="quote">“{member.sourcePreview}”</div><div className="item-meta">Page {member.pageNumber}{member.publicationYear ? ` · ${member.publicationYear}` : ""} · {member.isUsed ? "Used downstream" : "No downstream use"}</div>
            <div className="item-meta">{member.fullTextDocumentId ? <Link href={`/projects/${projectId}/papers/${member.paperId}/documents/${member.fullTextDocumentId}`}>Document provenance{member.documentArchivedAt ? " (archived)" : ""}</Link> : "Document artifact: none recorded"}{member.documentTextExtractionId ? ` · exact extraction span [${member.extractionStartOffset}, ${member.extractionEndOffset})` : ""}</div>
            {member.labels.length > 0 && <div className="path-list">{member.labels.map((label) => <span key={label.id}>{label.name}{label.archivedAt ? " (archived)" : ""}</span>)}</div>}
            {member.reviewState !== "accepted" && <div className="support-warning">{member.reviewState === "rejected" ? "Currently rejected for new direct use; retained here for comparison." : member.reviewState === "needs_review" ? "This Evidence needs review." : "This Evidence has never been reviewed."}</div>}
          </article>)}</div>}
          <div className="item-row" style={{ marginTop: 18 }}>{query.memberCursor && <Link className="button ghost" href={`/projects/${projectId}/evidence-sets/${setId}`}>First member page</Link>}{members.nextCursor && <Link className="button secondary" href={pageHref(projectId, setId, "memberCursor", members.nextCursor)}>Next member page</Link>}</div>
        </section>

        {active && <section className="card section-card full"><div className="section-heading"><h2>Add Evidence</h2><span className="count">Browse when requested</span></div>
          <form method="get"><input type="hidden" name="candidateBrowse" value="1" /><div className="field"><label htmlFor="candidate-query">Paper title or DOI</label><input id="candidate-query" name="candidateQuery" defaultValue={query.candidateQuery ?? ""} maxLength={200} /><span className="hint">Search runs after you choose Browse or Search. Maximum 200 Unicode code points.</span></div><button className="button secondary" type="submit">{query.candidateBrowse === "1" ? "Search candidates" : "Browse candidates"}</button></form>
          {candidateBrowse && candidates && <><div className="item-list" style={{ marginTop: 18 }}>{candidates.items.length === 0 ? <div className="empty">No matching Evidence candidates.</div> : candidates.items.map((candidate) => <article className="item" key={candidate.evidenceId}><div className="item-row"><div><Link className="item-title" href={`/projects/${projectId}/evidence/${candidate.evidenceId}`}>{candidate.paperTitle}</Link><div className="item-meta">Page {candidate.pageNumber}{candidate.doi ? ` · DOI ${candidate.doi}` : ""}</div></div><form action={addEvidenceToSetAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><input type="hidden" name="expectedRevisionId" value={revisionId} /><input type="hidden" name="evidenceId" value={candidate.evidenceId} /><button className="button" type="submit">Add to this set</button></form></div><div className="quote">“{candidate.excerpt}”</div></article>)}</div>{candidates.nextCursor && <Link className="button secondary" href={pageHref(projectId, setId, "candidateCursor", candidates.nextCursor, candidateExtra)}>More candidates</Link>}</>}
        </section>}

        <section className="card section-card"><div className="section-heading"><h2>Composition history</h2><span className="count">{history.items.length} revisions shown</span></div>{history.items.length === 0 ? <div className="empty">No composition history.</div> : <div className="item-list">{history.items.map((entry) => <article className="item" key={entry.revisionId}><div className="item-row"><div><strong>{entry.operationKind}</strong> · sequence {entry.sequence} · {entry.memberCount} Evidence</div><Link className="button ghost" href={`/projects/${projectId}/evidence-sets/${setId}/history/${entry.revisionId}`}>Open exact members</Link></div><div className="item-meta">{entry.createdAt.toLocaleString()} · {entry.distinctPaperCount} Papers</div></article>)}</div>}{history.nextCursor && <Link className="button secondary" href={pageHref(projectId, setId, "historyCursor", history.nextCursor)}>Older revisions</Link>}</section>

        <section className="card section-card full"><div className="section-heading"><div><h2>Prepare synthesis workspace</h2><p className="hint">Preparation starts from this exact composition revision and one ExtractionField.</p></div><span className="count">{fields?.items.length ?? 0} fields shown</span></div>
          {!fields || fields.items.length === 0 ? <div className="empty">No ExtractionRevisions connect to Evidence in this set yet.</div> : <div className="item-list">{fields.items.map((fieldSummary) => <article className="item item-row" key={fieldSummary.field.id}><div><div className="item-title">{fieldSummary.field.name}</div><div className="item-meta">Field type: {fieldSummary.field.fieldType} · {fieldSummary.candidateRevisionCount} candidate revisions across {fieldSummary.candidatePaperCount} Papers</div></div>{active && <form action={createSynthesisPreparationAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="evidenceSetId" value={setId} /><input type="hidden" name="extractionFieldId" value={fieldSummary.field.id} /><input type="hidden" name="expectedRevisionId" value={revisionId} /><button className="button" type="submit">Prepare synthesis →</button></form>}</article>)}</div>}
          {fields?.nextCursor && <Link className="button secondary" href={pageHref(projectId, setId, "fieldCursor", fields.nextCursor)}>More fields</Link>}
        </section>

        <section className="card section-card full"><div className="section-heading"><h2>Related ExtractionRevisions</h2><span className="count">{related.items.length} shown</span></div>{related.items.length === 0 ? <div className="empty">No ExtractionRevisions currently reference these Evidence passages.</div> : <div className="item-list">{related.items.map((item) => <article className="item" key={item.id}><div className="item-row"><div><div className="item-title">{item.fieldName} · {item.paperTitle}</div><div className="item-meta">Revision {item.sequence} · {item.valueState}{item.isCurrent ? " · current" : " · superseded"}</div></div><div style={{ display: "flex", gap: 8 }}><Link className="button ghost" href={`/projects/${projectId}/extraction/${item.paperId}`}>Open extraction</Link><Link className="button ghost" href={`/projects/${projectId}/synthesis?fieldId=${item.fieldId}`}>Open synthesis field</Link></div></div></article>)}</div>}{related.nextCursor && <Link className="button secondary" href={pageHref(projectId, setId, "relatedCursor", related.nextCursor)}>More revisions</Link>}<p className="hint" style={{ marginTop: 14 }}>These are navigation links only. No Synthesis or Claim support is created by set membership.</p></section>
      </div>
      <p className="footer-note">Evidence Sets are organizational snapshots. Source provenance, curation history, analytical support, citations, manuscripts, and reporting remain unchanged.</p>
    </div>
  </div>;
}
