import Link from "next/link";
import { notFound } from "next/navigation";
import {
  abandonSynthesisPreparationAction,
  beginAiSynthesisSuggestionAction,
  deselectSynthesisPreparationRevisionAction,
  finalizeSynthesisPreparationAction,
  selectSynthesisPreparationRevisionAction,
  updateSynthesisPreparationAction,
} from "@/app/actions";
import { aiSynthesisProviderAvailable, aiSynthesisServices, reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import { ConfirmAction } from "@/components";
import { humanizeWorkspaceToken } from "@/application/project-workspace-labels";

type SearchParams = {
  candidateCursor?: string;
  candidateFilter?: string;
  targetBrowse?: string;
  targetQuery?: string;
  targetCursor?: string;
  aiCursor?: string;
  error?: string;
  saved?: string;
};

const candidateFilters = ["all", "selected", "selectable", "ineligible"] as const;
type CandidateFilter = (typeof candidateFilters)[number];

function isCandidateFilter(value: string | undefined): value is CandidateFilter {
  return candidateFilters.includes(value as CandidateFilter);
}

function workspaceHref(
  projectId: string,
  preparationId: string,
  current: SearchParams,
  overrides: Partial<Record<keyof SearchParams, string | null>> = {},
) {
  const state: { [Key in keyof SearchParams]: string | null | undefined } = { ...current, ...overrides };
  const params = new URLSearchParams();
  for (const key of ["candidateCursor", "candidateFilter", "targetBrowse", "targetQuery", "targetCursor", "aiCursor"] as const) {
    const value = state[key];
    if (value) params.set(key, value);
  }
  const search = params.toString();
  return `/projects/${projectId}/synthesis/preparations/${preparationId}${search ? `?${search}` : ""}`;
}

function candidateDetailHref(projectId: string, preparationId: string, extractionRevisionId: string, query: SearchParams) {
  const params = new URLSearchParams();
  if (query.candidateFilter && isCandidateFilter(query.candidateFilter)) params.set("returnCandidateFilter", query.candidateFilter);
  if (query.candidateCursor && query.candidateCursor.length <= 4096) params.set("returnCandidateCursor", query.candidateCursor);
  const search = params.toString();
  return `/projects/${projectId}/synthesis/preparations/${preparationId}/candidates/${extractionRevisionId}${search ? `?${search}` : ""}`;
}

function valueText(value: string | null, valueState: string) {
  return valueState === "present" ? value ?? "—" : valueState.replaceAll("_", " ");
}

function warningLabel(warning: string) {
  switch (warning) {
    case "underlying_evidence_unreviewed": return "Evidence unreviewed";
    case "underlying_evidence_needs_review": return "Evidence needs review";
    case "underlying_evidence_rejected": return "Evidence rejected";
    case "paper_not_finally_included": return "Paper not finally included";
    case "extraction_revision_superseded": return "Superseded extraction";
    case "extraction_revision_cleared": return "Value cleared";
    default: return humanizeWorkspaceToken(warning);
  }
}

function savedMessage(saved: string | undefined) {
  switch (saved) {
    case "updated": return "Preparation settings saved.";
    case "selected": return "Candidate revision selected.";
    case "deselected": return "Candidate revision deselected.";
    case "abandoned": return "Preparation abandoned and frozen.";
    case "ai-requested": return "AI synthesis request created. Open its history entry to inspect or execute it.";
    default: return undefined;
  }
}

export default async function SynthesisPreparationWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; preparationId: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  const { projectId, preparationId } = await params;
  const query = searchParams ? await searchParams : {};
  const candidateFilter = isCandidateFilter(query.candidateFilter) ? query.candidateFilter : "all";
  const targetBrowse = query.targetBrowse === "1";

  let header;
  try {
    header = await reviewServices.getSynthesisPreparationHeader(projectId, preparationId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }

  let candidatePage;
  let candidateCursorNotice: string | undefined;
  try {
    candidatePage = await reviewServices.listSynthesisPreparationCandidates(projectId, preparationId, {
      cursor: query.candidateCursor,
      pageSize: 50,
      filter: candidateFilter,
    });
  } catch (error) {
    if (query.candidateCursor && error instanceof DomainError && error.code === "VALIDATION_ERROR") {
      candidateCursorNotice = error.message;
      candidatePage = await reviewServices.listSynthesisPreparationCandidates(projectId, preparationId, {
        pageSize: 50,
        filter: candidateFilter,
      });
    } else if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND"].includes(error.code)) {
      notFound();
    } else {
      throw error;
    }
  }

  let historyPage;
  let historyCursorNotice: string | undefined;
  try {
    historyPage = await aiSynthesisServices.listAiSynthesisSuggestionHistoryPage(projectId, preparationId, {
      cursor: query.aiCursor,
      pageSize: 25,
    });
  } catch (error) {
    if (query.aiCursor && error instanceof DomainError && error.code === "VALIDATION_ERROR") {
      historyCursorNotice = error.message;
      historyPage = await aiSynthesisServices.listAiSynthesisSuggestionHistoryPage(projectId, preparationId, { pageSize: 25 });
    } else if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND"].includes(error.code)) {
      notFound();
    } else {
      throw error;
    }
  }

  let targetPage;
  let targetNotice: string | undefined;
  if (targetBrowse) {
    try {
      targetPage = await reviewServices.listSynthesisTargetStatementOptions(projectId, {
        query: query.targetQuery,
        cursor: query.targetCursor,
        pageSize: 20,
      });
    } catch (error) {
      if (query.targetCursor && error instanceof DomainError && error.code === "VALIDATION_ERROR") {
        targetNotice = error.message;
        targetPage = await reviewServices.listSynthesisTargetStatementOptions(projectId, {
          query: query.targetQuery,
          pageSize: 20,
        });
      } else if (error instanceof DomainError && error.code === "VALIDATION_ERROR") {
        targetNotice = error.message;
      } else if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND"].includes(error.code)) {
        notFound();
      } else {
        throw error;
      }
    }
  }

  if (!candidatePage || !historyPage) notFound();
  const prep = header.preparation;
  const active = prep.status === "active";
  const basePath = `/projects/${projectId}/synthesis/preparations/${preparationId}`;
  const currentTarget = header.targetStatement?.currentRevision ?? null;
  let selectedTargetStatementPreview: string | null = null;
  if (header.targetStatement && currentTarget && !currentTarget.title) {
    const selectedTarget = await reviewServices.resolveSynthesisTargetStatement(projectId, header.targetStatement.id);
    selectedTargetStatementPreview = selectedTarget?.currentRevision?.statementPreview ?? null;
  }
  const message = savedMessage(query.saved);

  return (
    <div className="project-page">
      <div className="container workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow"><Link href={`/projects/${projectId}/synthesis/preparations`}>Synthesis preparations</Link> / Workspace</p>
            <h1>{prep.workingTitle ?? "Untitled preparation"}</h1>
            <p>
              Pinned Evidence Set:{" "}
              <Link href={`/projects/${projectId}/evidence-sets/${header.evidenceSet.id}`} style={{ textDecoration: "underline" }}>
                {header.evidenceSet.name}
              </Link>{" "}
              (pinned sequence {header.pinnedComposition.sequence}) · Field: <strong>{header.field.name}</strong> ({header.field.fieldType})
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className={`status ${active || prep.status === "finalized" ? "supported" : "stale"}`}>
              {prep.status === "active" ? "● Active" : prep.status === "finalized" ? "✓ Finalized" : "Abandoned"}
            </span>
            {header.sourceSetChanged && <span className="status stale">Evidence Set changed since pin</span>}
          </div>
        </div>

        {query.error && <div className="error-banner" role="alert">{query.error}</div>}
        {message && <div className="success-note" role="status">{message}</div>}

        <section className="card section-card" aria-label="Preparation metadata">
          <div className="section-heading">
            <h2>Preparation record</h2>
            <span className="count">{header.selectedCount} selected</span>
          </div>
          <div className="item-list">
            <div className="item-meta">Preparation ID: {prep.id}</div>
            <div className="item-meta">Evidence Set: {header.evidenceSet.name} · exact pinned composition revision {header.pinnedComposition.id}, sequence {header.pinnedComposition.sequence}, set ordinal {header.pinnedComposition.setOrdinal}</div>
            <div className="item-meta">Pinned composition size: {header.pinnedComposition.memberCount} Evidence · {header.pinnedComposition.distinctPaperCount} Papers</div>
            <div className="item-meta">Extraction Field: {header.field.name} ({header.field.fieldType})</div>
            <div className="item-meta">Status: {humanizeWorkspaceToken(prep.status)} · created {prep.createdAt.toLocaleString()}</div>
            {prep.workingNote && <div className="item-meta">Working note: {prep.workingNote}</div>}
            {header.finalizedRevision && <div className="item-meta">Finalized synthesis revision: {header.finalizedRevision.id} · revision {header.finalizedRevision.sequence}</div>}
          </div>
          {header.sourceSetChanged && header.latestComposition && (
            <p className="hint" style={{ marginTop: 10 }}>
              The Evidence Set now has sequence {header.latestComposition.sequence}. This preparation stays pinned to its recorded composition revision.
            </p>
          )}
        </section>

        <div className="workspace-grid" style={{ marginTop: 16 }}>
          <section className="card section-card">
            <div className="section-heading">
              <div><h2>Workspace settings</h2><p className="hint">Metadata can be edited without loading the candidate universe.</p></div>
              <span className="count">{active ? "Editable" : "Frozen"}</span>
            </div>
            {active ? (
              <>
                <form action={updateSynthesisPreparationAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="preparationId" value={preparationId} />
                  <div className="field">
                    <label htmlFor="prep-title">Working title</label>
                    <input id="prep-title" name="workingTitle" defaultValue={prep.workingTitle ?? ""} maxLength={100} />
                  </div>
                  <div className="field">
                    <label htmlFor="prep-note">Working note</label>
                    <textarea id="prep-note" name="workingNote" defaultValue={prep.workingNote ?? ""} maxLength={5000} />
                  </div>
                  <button className="button secondary" type="submit">Save metadata</button>
                </form>
                <ConfirmAction action={abandonSynthesisPreparationAction} label="Abandon preparation" title="Abandon this preparation?" description="The pinned selection and its history will remain available for audit." consequence="This preparation will be frozen and cannot be edited or finalized." hiddenFields={{ projectId, preparationId }} confirmLabel="Abandon preparation" />
              </>
            ) : (
              <div className="item-list">
                <div className="item-meta">Title: {prep.workingTitle ?? "Untitled"}</div>
                <div className="item-meta">Note: {prep.workingNote ?? "None"}</div>
              </div>
            )}
          </section>

          <section className="card section-card">
            <div className="section-heading">
              <div><h2>Target Synthesis statement</h2><p className="hint">Any existing statement in this Project is eligible, including one without an active revision.</p></div>
              <span className="count">{header.targetStatement ? "Linked" : "Create on finalize"}</span>
            </div>
            {header.targetStatement ? (
              <div className="item">
                <div className="item-title">{currentTarget?.title ?? "Untitled statement"}</div>
                <div className="item-meta">Statement ID: {header.targetStatement.id}{currentTarget ? ` · revision ${currentTarget.sequence} · ${currentTarget.state}` : " · no current revision"}</div>
                {selectedTargetStatementPreview && <div className="hint">{selectedTargetStatementPreview}</div>}
                <div className="item-row" style={{ marginTop: 10 }}>
                  <Link className="button ghost" href={`/projects/${projectId}/synthesis/${header.targetStatement.id}`}>Open statement</Link>
                  {active && <form action={updateSynthesisPreparationAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="targetSynthesisStatementId" value="" /><button className="button ghost" type="submit">Clear target</button></form>}
                </div>
              </div>
            ) : <p className="item-meta">Finalization will create a new Synthesis statement.</p>}
            {active && (
              <div style={{ marginTop: 12 }}>
                <form method="get" action={basePath}>
                  <input type="hidden" name="targetBrowse" value="1" />
                  {query.candidateCursor && <input type="hidden" name="candidateCursor" value={query.candidateCursor} />}
                  <input type="hidden" name="candidateFilter" value={candidateFilter} />
                  {query.aiCursor && <input type="hidden" name="aiCursor" value={query.aiCursor} />}
                  <div className="field">
                    <label htmlFor="target-query">Browse or search existing statements</label>
                    <input id="target-query" type="search" name="targetQuery" defaultValue={targetBrowse ? query.targetQuery ?? "" : ""} maxLength={200} />
                  </div>
                  <button className="button ghost" type="submit">{targetBrowse ? "Search statements" : "Browse statements"}</button>
                </form>
                {targetBrowse && (
                  <>
                    {targetNotice && <div className="error-banner" role="alert">{targetNotice}</div>}
                    {targetPage && (
                      <>
                        <div className="section-heading" style={{ marginTop: 12 }}>
                          <span className="hint">Showing at most {targetPage.pageSize} statements on this page.</span>
                          <span className="count">{targetPage.items.length} shown{targetPage.hasMore ? " · more available" : ""}</span>
                        </div>
                        {targetPage.items.length === 0 ? <div className="empty">No statements match this search.</div> : (
                          <div className="item-list">
                            {targetPage.items.map((option) => (
                              <article className="item" key={option.id}>
                                <div className="item-row">
                                  <div>
                                    <div className="item-title">{option.currentRevision?.title ?? "Untitled statement"}</div>
                                    <div className="item-meta">{option.currentRevision ? `Revision ${option.currentRevision.sequence} · ${option.currentRevision.state}` : "No current revision"} · {option.id}</div>
                                    {option.currentRevision?.statementPreview && <div className="hint">{option.currentRevision.statementPreview}</div>}
                                  </div>
                                  {active && <form action={updateSynthesisPreparationAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="targetSynthesisStatementId" value={option.id} /><button className="button secondary" type="submit">Use this target</button></form>}
                                </div>
                              </article>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    {query.targetCursor && <Link className="button ghost" href={workspaceHref(projectId, preparationId, query, { targetCursor: null })}>First target page</Link>}
                    {targetPage?.nextCursor && <Link className="button secondary" href={workspaceHref(projectId, preparationId, query, { targetBrowse: "1", targetCursor: targetPage.nextCursor })}>Next target page</Link>}
                  </>
                )}
              </div>
            )}
          </section>
        </div>

        {active && header.selectedCount > 0 && (
          <section className="card section-card" style={{ marginTop: 16 }}>
            <div className="section-heading">
              <div>
                <h2>AI synthesis suggestion</h2>
                <p className="hint">A request freezes the currently selected revisions and their connecting Evidence. You decide whether a returned suggestion enters canonical synthesis.</p>
              </div>
              <span className={`status ${aiSynthesisProviderAvailable ? "supported" : "stale"}`}>
                {aiSynthesisProviderAvailable ? "Provider configured" : "Provider unavailable"}
              </span>
            </div>
            <form action={beginAiSynthesisSuggestionAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="preparationId" value={preparationId} />
              <input type="hidden" name="disclosureVersion" value="openai-synthesis-transmission-v1" />
              <div className="field"><label><input type="checkbox" name="externalTransmissionAcknowledged" required /> I understand selected values, paper metadata, researcher notes, and connecting Evidence text may be sent to the configured AI provider.</label></div>
              <button className="button primary" type="submit">Suggest synthesis with AI</button>
            </form>
          </section>
        )}

        <section className="card section-card" style={{ marginTop: 16 }}>
          <div className="section-heading">
            <div><h2>AI suggestion history</h2><p className="hint">Showing at most {historyPage.pageSize} compact request summaries. Open one request for its exact audit record.</p></div>
            <span className="count">{historyPage.items.length} shown{historyPage.hasMore ? " · more available" : ""}</span>
          </div>
          {historyCursorNotice && <div className="error-banner" role="alert">{historyCursorNotice} History has returned to its first page.</div>}
          {historyPage.items.length === 0 ? <div className="empty">No AI synthesis requests for this preparation.</div> : (
            <div className="item-list">
              {historyPage.items.map((item) => (
                <article className="item" key={item.requestId}>
                  <div className="item-row">
                    <div>
                      <Link className="item-title" href={`${basePath}/ai-requests/${item.requestId}`}>Open exact AI request</Link>
                      <div className="item-meta">{item.createdAt?.toLocaleString() ?? "Unknown time"} · {item.provider} · {item.model}{item.returnedModel ? ` → ${item.returnedModel}` : ""}</div>
                      <div className="item-meta">
                        {item.outcome ?? "pending"}{item.candidateState ? ` · candidate ${item.candidateState}` : ""}{item.errorCode ? ` · ${item.errorCode}` : ""}
                        {item.resultFinalizedAt ? ` · completed ${item.resultFinalizedAt.toLocaleString()}` : ""}
                        {item.decision ? ` · decision ${item.decision}` : ""}
                        {item.resultingSynthesisRevisionId ? ` · synthesis revision ${item.resultingSynthesisRevisionId}` : ""}
                      </div>
                      <div className="item-meta">{item.supportCount} supports · {item.sourceCount} Evidence passages · {item.groundingCount} grounding locators · {item.inputTokens ?? "—"} input / {item.outputTokens ?? "—"} output tokens · {item.durationMs ?? "—"} ms</div>
                      {item.providerDiagnostic && <div className="hint">{item.providerDiagnostic}</div>}
                    </div>
                    <span className={`status ${item.decision ? "supported" : item.outcome ? "stale" : "unsupported"}`}>
                      {item.decision ?? item.outcome ?? "Pending"}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
          {query.aiCursor && <Link className="button ghost" href={workspaceHref(projectId, preparationId, query, { aiCursor: null })}>Latest AI requests</Link>}
          {historyPage.nextCursor && <Link className="button secondary" href={workspaceHref(projectId, preparationId, query, { aiCursor: historyPage.nextCursor })}>Older AI requests</Link>}
        </section>

        <section className="card section-card full" style={{ marginTop: 16 }}>
          <div className="section-heading">
            <div>
              <h2>Candidate extraction revisions</h2>
              <p className="hint">Membership is frozen for each candidate cursor epoch; selection, eligibility, current-revision state, and Evidence warnings are refreshed on every page request.</p>
            </div>
            <span className="count">{header.selectedCount} selected</span>
          </div>
          {candidateCursorNotice && <div className="error-banner" role="alert">{candidateCursorNotice} Candidate browsing has returned to its first page.</div>}
          <div className="item-meta" style={{ marginBottom: 12 }}>
            {candidatePage.candidateCount} candidate revisions in this snapshot · captured {candidatePage.candidateSnapshotAt}
          </div>
          <div className="item-row" style={{ marginBottom: 14, flexWrap: "wrap" }}>
            <nav aria-label="Candidate filter" className="item-row" style={{ flexWrap: "wrap" }}>
              {candidateFilters.map((filter) => (
                <Link
                  key={filter}
                  className={`button ${candidateFilter === filter ? "secondary" : "ghost"}`}
                  href={workspaceHref(projectId, preparationId, query, { candidateFilter: filter, candidateCursor: null })}
                  aria-current={candidateFilter === filter ? "page" : undefined}
                >
                  {filter === "all" ? "All candidates" : filter === "selectable" ? "Eligible" : filter[0]!.toUpperCase() + filter.slice(1)}
                </Link>
              ))}
            </nav>
            <Link className="button ghost" href={workspaceHref(projectId, preparationId, query, { candidateCursor: null })}>Refresh candidate snapshot</Link>
          </div>

          {candidatePage.items.length === 0 ? (
            <div className="empty">No candidate revisions match this filter in the pinned composition.</div>
          ) : (
            <div className="matrix-list">
              {candidatePage.items.map((candidate) => (
                <article className="item matrix-row" key={candidate.extractionRevisionId} data-testid="synthesis-preparation-candidate">
                  <div className="item-row" style={{ alignItems: "flex-start" }}>
                    <div>
                      <Link className="item-title" href={`/projects/${projectId}/extraction/${candidate.paper.id}`}>{candidate.paper.title}</Link>
                      <div className="item-meta">
                        Value: <strong>{valueText(candidate.value, candidate.valueState)}</strong> · revision {candidate.sequence} · pinned membership position {candidate.membershipOrder} · connecting Evidence {candidate.connectingEvidenceCount} · direct Evidence {candidate.directEvidenceCount}
                        {candidate.isCurrentExtractionRevision ? " · current extraction" : " · superseded extraction"}
                        {candidate.isFinallyIncluded ? " · finally included" : " · not finally included"}
                      </div>
                      <div className="item-row" style={{ marginTop: 8, flexWrap: "wrap" }}>
                        <Link className="button ghost" href={candidateDetailHref(projectId, preparationId, candidate.extractionRevisionId, query)}>View exact provenance</Link>
                        <span className={`status ${candidate.selected ? "supported" : candidate.selectable ? "unsupported" : "stale"}`}>
                          {candidate.selected ? "Selected" : candidate.selectable ? "Available" : "Ineligible"}
                        </span>
                      </div>
                      {candidate.eligibilityReasons.length > 0 && <div className="hint" style={{ marginTop: 6 }}>{candidate.eligibilityReasons.map(humanizeWorkspaceToken).join(" · ")}</div>}
                      {candidate.warnings.length > 0 && (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                          {candidate.warnings.map((warning) => <span className="status stale" key={warning}>{warningLabel(warning)}</span>)}
                        </div>
                      )}
                    </div>
                    {active && (
                      candidate.selected ? (
                        <form action={deselectSynthesisPreparationRevisionAction}>
                          <input type="hidden" name="projectId" value={projectId} />
                          <input type="hidden" name="preparationId" value={preparationId} />
                          <input type="hidden" name="extractionRevisionId" value={candidate.extractionRevisionId} />
                          <input type="hidden" name="candidateFilter" value={candidateFilter} />
                          {query.candidateCursor && <input type="hidden" name="candidateCursor" value={query.candidateCursor} />}
                          <button className="button ghost" type="submit">Deselect</button>
                        </form>
                      ) : (
                        <form action={selectSynthesisPreparationRevisionAction}>
                          <input type="hidden" name="projectId" value={projectId} />
                          <input type="hidden" name="preparationId" value={preparationId} />
                          <input type="hidden" name="extractionRevisionId" value={candidate.extractionRevisionId} />
                          <input type="hidden" name="candidateFilter" value={candidateFilter} />
                          {query.candidateCursor && <input type="hidden" name="candidateCursor" value={query.candidateCursor} />}
                          <button className="button secondary" type="submit" disabled={!candidate.selectable}>Select</button>
                        </form>
                      )
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="item-row" style={{ marginTop: 18 }}>
            {query.candidateCursor && <Link className="button ghost" href={workspaceHref(projectId, preparationId, query, { candidateCursor: null })}>First candidate page</Link>}
            {candidatePage.nextCursor && <Link className="button secondary" href={workspaceHref(projectId, preparationId, query, { candidateCursor: candidatePage.nextCursor })}>Next candidate page</Link>}
          </div>
        </section>

        {active && (
          <section className="card section-card" style={{ marginTop: 16 }}>
            <div className="section-heading"><h2>Finalize into synthesis</h2><span className="count">{header.selectedCount} selected</span></div>
            <p className="hint">Finalization freezes exact selected ExtractionRevision identities as synthesis supports. Zero supports remain permitted.</p>
            <form action={finalizeSynthesisPreparationAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="preparationId" value={preparationId} />
              <div className="field"><label htmlFor="final-title">Statement title <span className="hint">optional</span></label><input id="final-title" name="title" defaultValue={prep.workingTitle ?? ""} maxLength={500} /></div>
              <div className="field"><label htmlFor="final-statement">Synthesis statement <span className="hint">required</span></label><textarea id="final-statement" name="statementText" required maxLength={10000} /></div>
              <div className="field"><label htmlFor="final-note">Researcher note <span className="hint">optional</span></label><textarea id="final-note" name="researcherNote" defaultValue={prep.workingNote ?? ""} maxLength={5000} /></div>
              <button className="button primary" type="submit">Finalize preparation →</button>
            </form>
          </section>
        )}

        {prep.status === "finalized" && header.finalizedRevision && (
          <section className="card section-card" style={{ marginTop: 16 }}>
            <strong>Finalized workspace:</strong> exact supports are frozen in revision {header.finalizedRevision.sequence}.
            {prep.targetSynthesisStatementId && <div style={{ marginTop: 8 }}><Link className="button secondary" href={`/projects/${projectId}/synthesis/${prep.targetSynthesisStatementId}`}>View finalized synthesis statement →</Link></div>}
          </section>
        )}
        {prep.status === "abandoned" && <section className="card section-card" style={{ marginTop: 16 }}><strong>Abandoned workspace:</strong> this preparation is frozen.</section>}

        <p className="footer-note">Selections are mutable preparation state. Canonical synthesis support changes only when the preparation is finalized.</p>
      </div>
    </div>
  );
}
