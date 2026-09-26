import Link from "next/link";
import { notFound } from "next/navigation";
import { reviseSynthesisStatementAction, withdrawSynthesisStatementAction } from "@/app/actions";
import { reviewServices, synthesisReadServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import { ConfirmAction } from "@/components/ConfirmAction";

function displayExtraction(support: { extractionRevision: { valueState: string; textValue: string | null; numberValue: string | null; booleanValue: boolean | null; optionId: string | null } }) {
  const revision = support.extractionRevision;
  if (revision.valueState !== "present") return revision.valueState.replaceAll("_", " ");
  return revision.textValue ?? revision.numberValue ?? (revision.booleanValue === null ? (revision.optionId ? "Selected option" : "—") : revision.booleanValue ? "Yes" : "No");
}

export default async function SynthesisStatementPage({ params, searchParams }: {
  params: Promise<{ projectId: string; statementId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, statementId } = await params;
  const query = searchParams ? await searchParams : {};
  let current;
  try { current = await reviewServices.getCurrentSynthesis(projectId, statementId); }
  catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }
  if (!current) notFound();
  const [history, editContexts, currentInterpretationProjection] = await Promise.all([
    synthesisReadServices.getSynthesisHistorySummaries(projectId, statementId),
    synthesisReadServices.getSynthesisRevisionEditContext(projectId, current.supports.map((support) => ({
      paperId: support.paper.id,
      fieldId: support.field.id,
      extractionRevisionId: support.extractionRevisionId,
    }))),
    reviewServices.getSynthesisInterpretationProjection(projectId, statementId, current.id),
  ]);
  const preparationContexts = await synthesisReadServices.getSynthesisPreparationContextsForRevisions(projectId, history.map((revision) => revision.id));
  const prepContextByRevisionId = new Map(preparationContexts.map((context) => [context.synthesisRevisionId, context]));
  const currentPrepContext = prepContextByRevisionId.get(current.id) ?? null;
  const editContextByRevisionId = new Map(editContexts.map((context) => [context.extractionRevisionId, context]));
  const replacementBySupportId = new Map<string, NonNullable<(typeof editContexts)[number]["latestExtractionRevision"]>>();
  const usedReplacementIds = new Set<string>();
  for (const context of editContexts) {
    const replacement = context.latestExtractionRevision;
    if (context.replacementEligible && replacement && !usedReplacementIds.has(replacement.id)) {
      replacementBySupportId.set(context.extractionRevisionId, replacement);
      usedReplacementIds.add(replacement.id);
    }
  }
  const savedMessage = query.saved === "created" ? "Synthesis statement created." : query.saved === "revised" ? "New synthesis revision saved." : query.saved === "withdrawn" ? "Synthesis withdrawn. Its history remains available." : query.saved === "finalized_from_preparation" ? "Synthesis statement finalized from preparation workspace." : query.saved === "interpretation" ? "Interpretation snapshot saved." : undefined;
  const active = current.state === "active";

  return <div className="project-page">
    <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Synthesis provenance</p><h1>{current.title ?? "Untitled synthesis"}</h1><p>Revision {current.sequence} · {current.supportingRevisionCount} supporting observations across {current.supportingPaperCount} {current.supportingPaperCount === 1 ? "Paper" : "Papers"}</p></div><span className={`status ${active ? (current.supportStatus === "supported" ? "supported" : "unsupported") : "unsupported"}`}>{active ? (current.supportStatus === "supported" ? "● Supported observations" : "○ Unsupported") : "Withdrawn"}</span></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
      <div className="workspace-grid">
        <section className="card section-card full">
          <div className="section-heading">
            <h2>Current synthesis</h2>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="count">Revision {current.sequence}</span>
              <Link
                className="button ghost small"
                href={`/projects/${projectId}/synthesis/${statementId}/revisions/${current.id}`}
              >
                Inspect exact revision & interpretation →
              </Link>
            </div>
          </div>
          {currentInterpretationProjection.currentInterpretation && (
            <div
              style={{
                marginBottom: 16,
                padding: "10px 14px",
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: 6,
              }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 6 }}>
                <span className={`badge-convergence ${currentInterpretationProjection.currentInterpretation.convergenceState}`}>
                  {currentInterpretationProjection.currentInterpretation.convergenceState}
                </span>
                <strong>Interpretation snapshot {currentInterpretationProjection.currentInterpretation.sequence}</strong>
              </div>
              <p style={{ margin: 0, fontSize: "0.95rem" }}>
                {currentInterpretationProjection.currentInterpretation.summary}
              </p>
            </div>
          )}
          {currentPrepContext && (
            <div
              className="card"
              style={{
                marginBottom: 16,
                background: "var(--surface-muted, #f8fafc)",
                border: "1px solid var(--border, #e2e8f0)",
                padding: 14,
                borderRadius: 6,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span className="status supported" style={{ marginBottom: 4, display: "inline-block" }}>
                    Preparation context
                  </span>
                  <div style={{ fontWeight: 500, fontSize: "0.95rem" }}>
                    Finalized from preparation workspace for Evidence Set{" "}
                    <Link
                      href={`/projects/${projectId}/evidence-sets/${currentPrepContext.evidenceSetId}`}
                      style={{ textDecoration: "underline" }}
                    >
                      {currentPrepContext.evidenceSetName}
                    </Link>{" "}
                    (pinned composition revision {currentPrepContext.pinnedCompositionSequence})
                  </div>
                </div>
                <Link
                  className="button ghost"
                  href={`/projects/${projectId}/synthesis/preparations/${currentPrepContext.preparationId}`}
                >
                  Open preparation workspace →
                </Link>
              </div>
            </div>
          )}
          {current.statementText ? <p className="synthesis-statement">{current.statementText}</p> : <p className="empty">This synthesis has been withdrawn.</p>}
          {current.researcherNote && <p className="hint">Researcher note: {current.researcherNote}</p>}
          <div className="item-list">{current.supports.length === 0 ? <div className="empty">No supporting observations are linked to this revision.</div> : current.supports.map((support) => { const editContext = editContextByRevisionId.get(support.extractionRevisionId); const included = editContext?.finalEligibility === "included"; const excluded = editContext?.finalEligibility === "excluded" || editContext?.finalEligibility === "not_eligible"; return <article className="item" key={support.extractionRevisionId}><div className="item-row"><div><div className="item-title">{support.paper.title}</div><div className="item-meta">{support.field.name}{editContext?.fieldArchived ? " · Archived Field" : ""}: {displayExtraction(support)} · Extraction revision {support.extractionRevision.sequence}</div></div><div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className={`status ${support.isCurrentExtractionRevision ? "supported" : "unsupported"}`}>{support.isCurrentExtractionRevision ? "Current extraction" : "Superseded support"}</span>{!included && <span className="status unsupported">{excluded ? "Paper excluded" : "Paper not finally included"}</span>}</div></div><div className="item-meta">{support.extractionRevision.evidence.length} {support.extractionRevision.evidence.length === 1 ? "Evidence passage" : "Evidence passages"}</div><div className="provenance-list">{support.extractionRevision.evidence.map((evidence) => <div className="quote" key={evidence.id}>“{evidence.sourceText}” <span className="item-meta">· Page {evidence.pageNumber}</span>{evidence.curationWarning && <span className="status stale"> · {evidence.curationWarning === "currently_rejected" ? "currently rejected" : evidence.curationWarning === "needs_review" ? "needs review" : "unreviewed"}</span>}</div>)}</div></article>; })}</div>
        </section>
        {active && <section className="card section-card full"><div className="section-heading"><h2>Create a new revision</h2><span className="count">Exact support snapshot</span></div><p className="hint">Existing support is preselected by exact ExtractionRevision ID. Superseded observations are marked and are never silently replaced. Excluded Papers remain visible in history but cannot be selected for a new revision.</p>
          <form action={reviseSynthesisStatementAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="statementId" value={statementId} /><div className="field"><label htmlFor="revision-title">Topic or title <span className="hint">optional</span></label><input id="revision-title" name="title" defaultValue={current.title ?? ""} /></div><div className="field"><label htmlFor="revision-text">Synthesis statement</label><textarea id="revision-text" name="statementText" required defaultValue={current.statementText ?? ""} /></div><div className="field"><label htmlFor="revision-note">Researcher note <span className="hint">optional</span></label><textarea id="revision-note" name="researcherNote" defaultValue={current.researcherNote ?? ""} /></div><div className="item-list">{current.supports.map((support) => { const editContext = editContextByRevisionId.get(support.extractionRevisionId); const included = editContext?.carryForwardEligible ?? false; const replacement = replacementBySupportId.get(support.extractionRevisionId); return <div className="item" key={support.extractionRevisionId}><label className="checkbox-row"><input type="checkbox" name="extractionRevisionIds" value={support.extractionRevisionId} defaultChecked={included} disabled={!included} /><span><strong>{support.paper.title}</strong><br /><span className="hint">{support.field.name}{editContext?.fieldArchived ? " · Archived Field" : ""}: {displayExtraction(support)} · {support.isCurrentExtractionRevision ? "Current extraction" : "Superseded support — replace explicitly if desired"}{!included ? " · Not eligible for carry-forward" : ""}</span></span></label>{replacement && <label className="checkbox-row"><input type="checkbox" name="extractionRevisionIds" value={replacement.id} aria-label={`Use current extraction from ${support.paper.title}`} /><span><strong>Use current extraction</strong><br /><span className="hint">{support.field.name}: {replacement.displayValue ?? replacement.valueState.replaceAll("_", " ")} · Explicit replacement for superseded revision</span></span></label>}</div>; })}</div><button className="button" type="submit">Save new synthesis revision</button></form></section>}
        {active && <section className="card section-card"><div className="section-heading"><h2>Withdraw conclusion</h2></div><p className="hint">Withdrawal preserves every prior statement and support set. Repeating withdrawal is safe and returns the existing withdrawn revision.</p><ConfirmAction action={withdrawSynthesisStatementAction} label="Withdraw synthesis" title="Withdraw this conclusion?" description="Withdrawal creates an immutable withdrawn revision and leaves the complete prior history readable." consequence="This conclusion will no longer be active for new downstream use." hiddenFields={{ projectId, statementId }} optionalTextField={{ name: "researcherNote", label: "Withdrawal note", placeholder: "Why is this conclusion being withdrawn?", maxLength: 10000 }} confirmLabel="Withdraw synthesis" /></section>}
        {!active && <section className="card section-card"><div className="section-heading"><h2>Withdrawn</h2></div><p className="hint">This conclusion is already withdrawn. No additional revision is created by repeating the operation.</p></section>}
        <section className="card section-card full"><div className="section-heading"><h2>Complete synthesis history</h2><span className="count">{history.length} revisions</span></div><div className="item-list">{history.map((revision) => { const prepCtx = prepContextByRevisionId.get(revision.id); return <article className="item" key={revision.id}><div className="item-row"><div><div className="item-title">Revision {revision.sequence} · {revision.state === "withdrawn" ? "Withdrawn" : revision.supportStatus === "supported" ? "Supported observations" : "Unsupported"}</div><div className="item-meta">{revision.statementText ?? "Conclusion withdrawn"}</div></div><div style={{ display: "flex", gap: 10, alignItems: "center" }}><span className="status">{revision.supportingRevisionCount} revisions · {revision.supportingPaperCount} Papers</span><Link className="button ghost small" href={`/projects/${projectId}/synthesis/${statementId}/revisions/${revision.id}`}>Inspect revision & interpretation →</Link></div></div>{prepCtx && <div className="item-meta" style={{ fontStyle: "italic", marginTop: 4 }}>↳ Preparation context: Evidence Set &ldquo;{prepCtx.evidenceSetName}&rdquo; (pinned seq {prepCtx.pinnedCompositionSequence})</div>}{revision.supports.map((support) => <div className="item-meta" key={support.extractionRevisionId}>↳ {support.paperTitle} · {support.fieldName}: {support.displayValue} · Extraction revision {support.extractionRevisionSequence}{support.isCurrentExtractionRevision ? "" : " · superseded support"}</div>)}</article>; })}</div></section>
      </div>
      <p className="footer-note">Source-backed observations remain distinct from the researcher-authored synthesis statement.</p>
    </div></div>;
}
