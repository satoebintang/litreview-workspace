import { notFound } from "next/navigation";
import { reactivateClaimAction, reviseClaimAction, withdrawClaimAction } from "@/app/actions";
import { DomainError } from "@/domain/errors";
import { claimReadServices, claimSupportReadServices, reviewServices } from "@/app/server";
import { idSchema } from "@/domain/validation";
import { ConfirmAction } from "@/components";
import { normalizeClaim, type ClaimRevisionView, type ClaimSupportView } from "../model";
import { ClaimSupportPicker, DirectEvidenceSelector } from "./ClaimSupportPicker";

function supportLabel(support: ClaimSupportView) {
  if (support.kind === "evidence") {
    const item = support.evidence;
    return `${item?.paper?.title ?? "Evidence"} · page ${item?.pageNumber ?? "—"} · ${item?.createdAt?.slice(0, 10) ?? "date unavailable"} · ${item?.sourceText.slice(0, 100) ?? support.id}`;
  }
  if (support.kind === "extraction") {
    const item = support.extraction;
    return `${item?.field?.name ?? "Observation"} · ${item?.paper?.title ?? "Source paper"} · revision ${item?.sequence ?? "—"} · ${item?.isCurrent === false ? "superseded" : "current"}`;
  }
  return `Synthesis revision ${support.synthesis?.sequence ?? "—"} · ${support.synthesis?.title ?? support.synthesis?.statementText?.slice(0, 100) ?? support.id}`;
}

function typedSupportIds(supports: ClaimRevisionView["supports"]) {
  return {
    evidenceIds: supports.evidence.map((item) => item.id),
    extractionRevisionIds: supports.extraction.map((item) => item.id),
    synthesisRevisionIds: supports.synthesis.map((item) => item.id),
  };
}

function freshnessLabel(support: ClaimSupportView) {
  if (support.kind === "extraction" && support.extraction && support.extraction.isCurrent === false) return <span className="status stale">Superseded extraction</span>;
  if (support.kind === "synthesis" && support.synthesis && support.synthesis.isCurrent === false) return <span className="status stale">Superseded synthesis</span>;
  return null;
}

function SupportEvidence({ support }: { support: ClaimSupportView }) {
  const item = support.evidence;
  if (!item) return null;
  return <article className="item support-item"><div className="item-row"><div className="support-kind">Supporting Evidence</div>{item.curationWarning && <span className="status stale">{item.curationWarning === "currently_rejected" ? "Evidence currently rejected" : item.curationWarning === "needs_review" ? "Evidence needs review" : "Evidence unreviewed"}</span>}</div><p className="quote">“{item.sourceText}”</p><div className="item-meta"><span>Page {item.pageNumber}</span>{item.paper ? <> · <span className="paper-chip">{item.paper.title}</span></> : null}</div><div className="item-meta">{item.fullTextDocumentId ? `Document artifact: ${item.document?.originalFilename || item.fullTextDocumentId}${item.document?.archivedAt ? " (archived)" : ""}` : "Document artifact: none recorded"}</div>{item.documentTextExtractionId && <div className="item-meta">Extraction run: {item.documentTextExtractionId} · code-point offsets [{item.extractionStartOffset}, {item.extractionEndOffset})</div>}{item.note && <div className="item-meta">Researcher note: {item.note}</div>}</article>;
}

function SupportExtraction({ support }: { support: ClaimSupportView }) {
  const item = support.extraction;
  if (!item) return null;
  return <article className="item support-item"><div className="item-row"><div className="support-kind">Supporting extracted observation</div><div style={{ display: "flex", gap: 6 }}>{freshnessLabel(support)}{item.paperScreeningState === "excluded" && <span className="status stale">Paper excluded</span>}</div></div><div className="item-title">{item.field?.name ?? "Extraction observation"} · {item.paper?.title ?? "Source paper"}</div><div className="extraction-value-display">{item.textValue ?? item.numberValue ?? (item.booleanValue === null || item.booleanValue === undefined ? item.optionId : item.booleanValue ? "Yes" : "No") ?? item.valueState ?? "No value"}</div><div className="item-meta">Extraction revision {item.sequence || "—"} · {item.evidence.length} source {item.evidence.length === 1 ? "passage" : "passages"}</div>{item.evidence.length > 0 && <div className="provenance-list">{item.evidence.map((evidence) => <div className="quote quote-inline" key={evidence.id}>“{evidence.sourceText}” <span className="item-meta">· Page {evidence.pageNumber}</span>{evidence.curationWarning && <span className="status stale"> · {evidence.curationWarning === "currently_rejected" ? "currently rejected" : evidence.curationWarning === "needs_review" ? "needs review" : "unreviewed"}</span>}</div>)}</div>}{item.evidence.length === 0 && <div className="support-warning">Structural support only — no Evidence path reaches a citation.</div>}</article>;
}

function SupportSynthesis({ support }: { support: ClaimSupportView }) {
  const item = support.synthesis;
  if (!item) return null;
  return <article className="item support-item"><div className="item-row"><div className="support-kind">Supporting synthesis</div>{freshnessLabel(support)}</div><p className="synthesis-statement">{item.statementText ?? "Synthesis withdrawn"}</p><div className="item-meta">Synthesis revision {item.sequence || "—"} · {item.extractions.length} supporting observation{item.extractions.length === 1 ? "" : "s"}</div><div className="provenance-list">{item.extractions.map((extraction) => <div className="nested-support" key={extraction.id}><div className="item-title">{extraction.field?.name ?? "Observation"} · {extraction.paper?.title ?? "Source paper"}{extraction.isCurrent === false && <span className="status stale">Superseded extraction</span>}</div><div className="item-meta">{extraction.textValue ?? extraction.numberValue ?? extraction.valueState ?? "No value"} · {extraction.evidence.length} Evidence {extraction.evidence.length === 1 ? "passage" : "passages"}</div>{extraction.evidence.map((evidence) => <div className="quote quote-inline" key={evidence.id}>“{evidence.sourceText}” <span className="item-meta">· Page {evidence.pageNumber}</span>{evidence.curationWarning && <span className="status stale"> · {evidence.curationWarning === "currently_rejected" ? "currently rejected" : evidence.curationWarning === "needs_review" ? "needs review" : "unreviewed"}</span>}</div>)}</div>)}{item.extractions.length === 0 && <div className="support-warning">No underlying observations are attached to this synthesis revision.</div>}</div></article>;
}

export default async function ClaimDetailPage({ params, searchParams }: { params: Promise<{ projectId: string; claimId: string }>; searchParams?: Promise<{ error?: string; saved?: string; synthesisRevisionId?: string }> }) {
  const { projectId, claimId } = await params;
  const query = searchParams ? await searchParams : {};
  let claim;
  try { claim = normalizeClaim(await reviewServices.getCurrentClaim(projectId, claimId)); } catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound(); throw error; }
  const current = claim.currentRevision;
  const canEdit = current.state === "active";
  const [claimHistory, latestActiveRevisionId] = await Promise.all([
    claimReadServices.getClaimHistorySummaries(projectId, claimId),
    canEdit ? Promise.resolve(null) : claimReadServices.getLatestActiveClaimRevisionId(projectId, claimId),
  ]);
  const historicalSource = canEdit
    ? current
    : latestActiveRevisionId
      ? normalizeClaim(await reviewServices.getClaimRevision(projectId, claimId, latestActiveRevisionId)).currentRevision
      : undefined;
  const historicalSupports = historicalSource?.supports ?? { evidence: [], extraction: [], synthesis: [] };
  const requestedSynthesisId = query.synthesisRevisionId ? idSchema.safeParse(query.synthesisRevisionId) : null;
  const exactSynthesisRevisionId = requestedSynthesisId?.success ? requestedSynthesisId.data : undefined;
  const historicalIds = typedSupportIds(historicalSupports);
  const eligibleIds = await claimSupportReadServices.resolveEligibleClaimSupportIds({
    projectId,
    evidenceIds: historicalIds.evidenceIds,
    extractionRevisionIds: historicalIds.extractionRevisionIds,
    synthesisRevisionIds: [...new Set([...historicalIds.synthesisRevisionIds, ...(exactSynthesisRevisionId ? [exactSynthesisRevisionId] : [])])],
  });
  const eligible = {
    evidence: new Set(eligibleIds.evidence),
    extraction: new Set(eligibleIds.extractionRevision),
    synthesis: new Set(eligibleIds.synthesisRevision),
  };
  const initialSelected = {
    evidence: canEdit ? historicalSupports.evidence.filter((item) => eligible.evidence.has(item.id)).map((item) => ({ id: item.id, label: supportLabel(item) })) : [],
    extractionRevision: canEdit ? historicalSupports.extraction.filter((item) => eligible.extraction.has(item.id)).map((item) => ({ id: item.id, label: supportLabel(item) })) : [],
    synthesisRevision: canEdit ? historicalSupports.synthesis.filter((item) => eligible.synthesis.has(item.id)).map((item) => ({ id: item.id, label: supportLabel(item) })) : [],
  };
  if (exactSynthesisRevisionId && eligible.synthesis.has(exactSynthesisRevisionId) && !initialSelected.synthesisRevision.some((item) => item.id === exactSynthesisRevisionId)) {
    const known = historicalSupports.synthesis.find((item) => item.id === exactSynthesisRevisionId);
    initialSelected.synthesisRevision.push({ id: exactSynthesisRevisionId, label: known ? supportLabel(known) : `Synthesis revision ${exactSynthesisRevisionId.slice(0, 8)}` });
  }
  const historicalContext = [
    ...historicalSupports.evidence,
    ...historicalSupports.extraction,
    ...historicalSupports.synthesis,
  ].filter((support) => !canEdit || !(support.kind === "evidence" ? eligible.evidence : support.kind === "extraction" ? eligible.extraction : eligible.synthesis).has(support.id))
    .map((support) => ({
      kind: support.kind === "evidence" ? "Evidence" : support.kind === "extraction" ? "Extraction revision" : "Synthesis revision",
      id: support.id,
      label: supportLabel(support),
      reason: (support.kind === "evidence" ? eligible.evidence : support.kind === "extraction" ? eligible.extraction : eligible.synthesis).has(support.id)
        ? "This prior support is eligible, but reactivation requires explicit selection."
        : "This support no longer meets current eligibility rules and will not be carried forward.",
    }));
  const allSupports = [...current.supports.evidence, ...current.supports.extraction, ...current.supports.synthesis];
  const structuralPaperCount = current.distinctPaperCount || new Set(allSupports.map((item) => item.paper?.id ?? item.evidence?.paper?.id ?? item.extraction?.paper?.id).filter(Boolean)).size;
  return <div className="project-page">
    <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Claim history</p><h1>{current.claimText ?? "Claim withdrawn"}</h1><p>Revision {current.sequence} · exact support snapshot · {structuralPaperCount} reachable {structuralPaperCount === 1 ? "Paper" : "Papers"}</p></div><span className={`status ${current.state === "withdrawn" ? "withdrawn" : current.supportStatus}`}>{current.state === "withdrawn" ? "Withdrawn" : current.supportStatus === "supported" ? "● Supported" : "○ Unsupported"}<span className="visually-hidden">{current.state === "withdrawn" ? "withdrawn" : current.supportStatus}</span></span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">{query.saved === "created_from_interpretation" ? "Claim created with exact synthesis support from interpretation context." : query.saved === "revised" ? "New Claim revision saved." : query.saved === "withdrawn" ? "Claim withdrawn. Historical support remains available." : query.saved === "reactivated" ? "Claim reactivated with an explicit support snapshot." : "Claim saved."}</div>}
      <div className="workspace-grid"><section className="card section-card full"><div className="section-heading"><h2>Claim assertion</h2><span className="count">Revision {current.sequence}</span></div><p className="claim-assertion">{current.claimText ?? "This Claim has been withdrawn."}</p>{current.researcherNote && <p className="item-meta">Researcher note: {current.researcherNote}</p>}<div className="support-summary"><span><strong>{allSupports.length}</strong> supports</span><span><strong>{current.supports.evidence.length}</strong> Evidence</span><span><strong>{current.supports.extraction.length}</strong> observations</span><span><strong>{current.supports.synthesis.length}</strong> syntheses</span><span><strong>{current.citationCandidateCount}</strong> citation candidates</span></div></section>
        <section className="card section-card full"><div className="section-heading"><h2>Exact support snapshot</h2><span className="count">{allSupports.length} supporting {allSupports.length === 1 ? "object" : "objects"}</span></div>{allSupports.length === 0 ? <div className="empty">This active Claim is unsupported. Add exact research support by creating a new revision.<p className="compatibility-copy">This claim has no supporting evidence yet.</p></div> : <div className="provenance-list support-sections">{current.supports.evidence.map((support) => <SupportEvidence key={support.id} support={support} />)}{current.supports.extraction.map((support) => <SupportExtraction key={support.id} support={support} />)}{current.supports.synthesis.map((support) => <SupportSynthesis key={support.id} support={support} />)}</div>}</section>
        {canEdit && <DirectEvidenceSelector projectId={projectId} claimId={claimId} existingEvidenceIds={current.supports.evidence.map((support) => support.id)} />}
        <section className="card section-card"><div className="section-heading"><h2>Citation candidates</h2><span className="count">{current.citationCandidateCount} grounded</span></div><p className="hint">Only exact paths reaching Evidence produce candidates. Papers are deduplicated by Paper identity, not DOI.</p>{current.citationCandidates.length === 0 ? <div className="empty">No citation candidates yet. Structural support without Evidence remains visible above but does not create a citation.</div> : <div className="item-list">{current.citationCandidates.map((candidate) => <article className="item" key={candidate.paper.id}><div className="item-row"><div><div className="item-title">{candidate.paper.title}</div><div className="item-meta">{candidate.paper.authors?.join(", ") || "Author details not added"}{candidate.paper.publicationYear ? ` · ${candidate.paper.publicationYear}` : ""}{candidate.paper.venue ? ` · ${candidate.paper.venue}` : ""}</div>{candidate.paper.doi && <div className="item-meta">DOI: {candidate.paper.doi}</div>}</div><span className="status supported">{candidate.pathCount} {candidate.pathCount === 1 ? "support path" : "support paths"}</span></div>{candidate.paths && <div className="path-list">{candidate.paths.map((path, index) => <span key={index}>{typeof path === "string" ? path : path.label ?? path.kind ?? "Evidence path"}</span>)}</div>}</article>)}</div>}</section>
        <section className="card section-card"><div className="section-heading"><h2>{canEdit ? "Create a new revision" : "Reactivate Claim"}</h2><span className="count">Complete snapshot</span></div><p className="hint">{canEdit ? "Changing text, note, lifecycle, or support always creates an immutable revision. Currently eligible supports are preselected by exact target ID." : "Reactivation never restores support implicitly. Choose the text and every support target explicitly."}</p>{canEdit ? <form action={reviseClaimAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="claimId" value={claimId} /><input type="hidden" name="expectedCurrentRevisionId" value={current.id} /><div className="field"><label htmlFor="revision-claim-text">Claim text</label><textarea id="revision-claim-text" name="claimText" required defaultValue={current.claimText ?? ""} /></div><div className="field"><label htmlFor="revision-claim-note">Researcher note <span className="hint">optional</span></label><textarea id="revision-claim-note" name="researcherNote" defaultValue={current.researcherNote ?? ""} /></div><ClaimSupportPicker projectId={projectId} initialSelected={initialSelected} historicalIneligible={historicalContext} initialSynthesisRevisionId={exactSynthesisRevisionId} /><button className="button" type="submit">Save new Claim revision</button></form> : <form action={reactivateClaimAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="claimId" value={claimId} /><input type="hidden" name="expectedCurrentRevisionId" value={current.id} /><div className="field"><label htmlFor="reactivate-claim-text">Claim text</label><textarea id="reactivate-claim-text" name="claimText" required placeholder="Restate the active manuscript assertion" /></div><div className="field"><label htmlFor="reactivate-claim-note">Researcher note <span className="hint">optional</span></label><textarea id="reactivate-claim-note" name="researcherNote" /></div><ClaimSupportPicker projectId={projectId} initialSelected={initialSelected} historicalIneligible={historicalContext} initialSynthesisRevisionId={exactSynthesisRevisionId} /><button className="button" type="submit">Reactivate Claim</button></form>}</section>
        {canEdit && <section className="card section-card"><div className="section-heading"><h2>Withdraw Claim</h2><span className="count">Preserves history</span></div><p className="hint">Withdrawal creates an immutable revision with no active text or support. The historical assertion and citation provenance remain readable.</p><ConfirmAction action={withdrawClaimAction} label="Withdraw Claim" title="Withdraw this Claim?" description="Withdrawal creates an immutable revision with no active text or support." consequence="The historical assertion and citation provenance remain readable." hiddenFields={{ projectId, claimId, expectedCurrentRevisionId: current.id }} confirmLabel="Withdraw Claim" /></section>}
        <section className="card section-card full"><div className="section-heading"><h2>Complete Claim history</h2><span className="count">{claimHistory.length} revisions</span></div><div className="item-list">{claimHistory.map((revision) => <article className="item history-item" key={revision.revisionId}><div className="item-row"><div><div className="item-title">Revision {revision.sequence} · {revision.lifecycle === "withdrawn" ? "Withdrawn" : revision.supportStatus === "supported" ? "Supported" : "Unsupported"}</div><div className="item-meta">{revision.claimText ?? "Claim withdrawn"}</div></div><span className="status">{revision.totalSupportCount} supports · {revision.citationCandidateCount} citations</span></div>{revision.researcherNote && <div className="item-meta">Note: {revision.researcherNote}</div>}<div className="item-meta">Exact targets are retained; later research revisions do not retarget this history.</div></article>)}</div></section>
      </div><p className="footer-note">This audit trail remains exact: Claim → typed support → historical revision/Evidence → Paper.</p>
    </div></div>;
}
