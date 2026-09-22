import Link from "next/link";
import { notFound } from "next/navigation";
import {
  acceptAiSynthesisSuggestionAction,
  abandonSynthesisPreparationAction,
  beginAiSynthesisSuggestionAction,
  executeAiSynthesisSuggestionAction,
  expireAiSynthesisSuggestionAction,
  finalizeSynthesisPreparationAction,
  rejectAiSynthesisSuggestionAction,
  replaceSynthesisPreparationSelectionsAction,
  updateSynthesisPreparationAction,
} from "@/app/actions";
import { aiSynthesisProviderAvailable, aiSynthesisServices, reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import type { SynthesisCandidate } from "@/domain/types";
import { AuditDetails, ConfirmAction } from "@/components";
import { humanizeWorkspaceToken } from "@/application/project-workspace-labels";

function displayCandidateValue(candidate: SynthesisCandidate) {
  const rev = candidate.extractionRevision;
  if (rev.valueState !== "present") return rev.valueState.replaceAll("_", " ");
  return (
    rev.textValue ??
    rev.numberValue ??
    (rev.booleanValue === null
      ? rev.optionId
        ? "Selected option"
        : "—"
      : rev.booleanValue
      ? "Yes"
      : "No")
  );
}

function warningLabel(warning: string) {
  switch (warning) {
    case "underlying_evidence_unreviewed":
      return "Evidence unreviewed";
    case "underlying_evidence_needs_review":
      return "Evidence needs review";
    case "underlying_evidence_rejected":
      return "Evidence rejected";
    case "paper_not_finally_included":
      return "Paper excluded";
    case "extraction_revision_superseded":
      return "Superseded extraction";
    case "extraction_revision_cleared":
      return "Value cleared";
    default:
      return humanizeWorkspaceToken(warning);
  }
}

function frozenSupportValue(support: Record<string, unknown>) {
  const state = String(support.value_state ?? "").replaceAll("_", " ");
  if (state !== "present") return state;
  switch (String(support.field_type)) {
    case "short_text":
    case "long_text":
      return support.text_value == null ? "—" : String(support.text_value);
    case "number":
      return support.number_value == null ? "—" : String(support.number_value);
    case "boolean":
      return support.boolean_value == null ? "—" : Boolean(support.boolean_value) ? "Yes" : "No";
    case "single_select":
      return `${String(support.option_id ?? "—")} · ${String(support.option_label_snapshot ?? "(label unavailable)")}`;
    default:
      return String(support.value_canonical ?? "—");
  }
}

export default async function SynthesisPreparationWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; preparationId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, preparationId } = await params;
  const query = searchParams ? await searchParams : {};

  let workspace;
  try {
    workspace = await reviewServices.getSynthesisPreparationWorkspace(projectId, preparationId);
  } catch (error) {
    if (
      error instanceof DomainError &&
      ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)
    ) {
      notFound();
    }
    throw error;
  }

  const existingStatements = await reviewServices.listProjectSynthesis(projectId);
  const prep = workspace.preparation;
  const active = prep.status === "active";
  type AiDetail = {
    request: Record<string, unknown>;
    result: Record<string, unknown> | null;
    supports: Record<string, unknown>[];
    sources: Record<string, unknown>[];
    groundings: Record<string, unknown>[];
    decision: Record<string, unknown> | null;
    dispatch: Record<string, unknown> | null;
  };
  const aiDetails = (await Promise.all(
    (await aiSynthesisServices.listAiSynthesisSuggestions(projectId, preparationId)).map(async (item) =>
      aiSynthesisServices.getAiSynthesisSuggestion(String((item.request as Record<string, unknown>).id), projectId),
    ),
  )) as unknown as AiDetail[];

  const savedMessage =
    query.saved === "updated"
      ? "Preparation settings saved."
      : query.saved === "selections"
      ? "Candidate selections updated."
      : query.saved === "abandoned"
      ? "Preparation abandoned and frozen."
      : query.saved === "ai-requested"
      ? "AI synthesis request created. Execute it below when ready."
      : query.saved === "ai-rejected"
      ? "AI synthesis suggestion rejected."
      : query.saved === "ai-accepted"
      ? "AI synthesis suggestion accepted into the canonical synthesis path."
      : undefined;

  return (
    <div className="project-page">
      <div className="container workspace"><div className="workspace-header">
          <div>
            <p className="eyebrow">Preparation workspace</p>
            <h1>{prep.workingTitle ?? "Untitled preparation"}</h1>
            <p>
              Pinned Evidence Set:{" "}
              <Link
                href={`/projects/${projectId}/evidence-sets/${workspace.evidenceSet.id}`}
                style={{ textDecoration: "underline" }}
              >
                {workspace.evidenceSet.name}
              </Link>{" "}
              (pinned sequence {workspace.pinnedCompositionSequence}) · Field:{" "}
              <strong>{workspace.field.name}</strong> ({workspace.field.fieldType})
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span
              className={`status ${
                prep.status === "active"
                  ? "supported"
                  : prep.status === "finalized"
                  ? "supported"
                  : "stale"
              }`}
            >
              {prep.status === "active"
                ? "● Active"
                : prep.status === "finalized"
                ? "✓ Finalized"
                : "Abandoned"}
            </span>
            {workspace.sourceSetChanged && (
              <span className="status stale">
                Evidence Set drifted (seq {workspace.latestCompositionSequence})
              </span>
            )}
          </div>
        </div>

        {query.error && (
          <div className="error-banner" role="alert">
            {query.error}
          </div>
        )}
        {savedMessage && (
          <div className="success-note" role="status">
            {savedMessage}
          </div>
        )}

        <AuditDetails items={[{ label: "Preparation identity", value: preparationId }, { label: "Evidence Set", value: workspace.evidenceSet.name }, { label: "Pinned composition", value: workspace.pinnedCompositionSequence }, { label: "Extraction field", value: workspace.field.name }, { label: "Candidate observations", value: workspace.candidates.length }, { label: "Selected observations", value: workspace.selectedCount }, { label: "Status", value: humanizeWorkspaceToken(prep.status) }]} />

        {active && workspace.selectedCount > 0 && (
          <section className="card section-card" style={{ marginBottom: 16 }}>
            <div className="section-heading">
              <div>
                <h2>AI synthesis suggestion</h2>
                <p className="hint">
                  AI will draft from the currently selected extraction value versions and every connecting Evidence passage in this pinned composition. It cannot choose formal support or write canonical research state without your decision.
                </p>
              </div>
              <span className={`status ${aiSynthesisProviderAvailable ? "supported" : "stale"}`}>
                {aiSynthesisProviderAvailable ? "Provider configured" : "Provider unavailable"}
              </span>
            </div>
            <form action={beginAiSynthesisSuggestionAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="preparationId" value={preparationId} />
              <input type="hidden" name="disclosureVersion" value="openai-synthesis-transmission-v1" />
              <div className="field">
                <label>
                  <input type="checkbox" name="externalTransmissionAcknowledged" required /> I understand the selected values, paper metadata, researcher notes, and connecting Evidence text may be transmitted to the configured AI provider.
                </label>
              </div>
              <button className="button primary" type="submit">Suggest synthesis with AI</button>
            </form>
          </section>
        )}

        {aiDetails.length > 0 && (
          <section className="card section-card" style={{ marginBottom: 16 }}>
            <div className="section-heading"><h2>AI suggestion history</h2><span className="count">{aiDetails.length} request{aiDetails.length === 1 ? "" : "s"}</span></div>
            {aiDetails.map((detail) => {
              const request = detail.request;
              const result = detail.result;
              const decision = detail.decision;
              const outcome = result == null ? "unresolved" : String(result.outcome);
              const candidate = result != null && String(result.outcome) === "succeeded";
              return (
                <div key={String(request.id)} className="item" style={{ marginBottom: 12 }}>
                  <div className="item-row">
                    <div>
                      <div className="item-title">AI request details</div>
                      <div className="item-meta">{outcome} · {String(request.supportCount ?? request.support_count ?? "?")} frozen supports · {detail.sources.length} frozen Evidence passages</div>
                    </div>
                    <span className={`status ${decision ? "supported" : result ? "stale" : "unsupported"}`}>{decision ? String(decision.decision) : outcome}</span>
                  </div>
                  {detail.sources.length > 0 && (
                    <div className="hint" style={{ marginTop: 8 }}>
                      Curation states: {[...new Set(detail.sources.map((source) => String(source.evidence_review_state)))].join(", ")}. Source coverage is frozen and includes all connecting Evidence, including rejected or needs-review items.
                    </div>
                  )}
                  <div className="hint" style={{ marginTop: 8 }}>
                    Frozen field snapshot: {String(request.fieldName ?? request.field_name_snapshot ?? "")} · type {String(request.fieldType ?? request.field_type ?? "")}
                    {request.fieldDescription != null || request.field_description_snapshot != null ? ` · ${String(request.fieldDescription ?? request.field_description_snapshot)}` : ""}
                  </div>
                  {detail.sources.length > 0 && <details style={{ marginTop: 8 }}><summary>Frozen Evidence manifest ({detail.sources.length})</summary><ul className="hint">{detail.sources.map((source) => <li key={`${String(source.extraction_revision_id)}-${String(source.evidence_id)}`}><div><strong>Evidence {String(source.evidence_id)}</strong> · revision {String(source.extraction_revision_id)} · page {String(source.page_number)} · {String(source.evidence_review_state)}</div><div>Frozen text: <span>{String(source.source_text)}</span></div>{source.evidence_note_snapshot != null && <div>Frozen Evidence note: <span>{String(source.evidence_note_snapshot)}</span></div>}</li>)}</ul></details>}
                  {detail.supports.length > 0 && (
                    <details style={{ marginTop: 8 }}>
                      <summary>Frozen support manifest ({detail.supports.length})</summary>
                      <ul className="hint">
                        {detail.supports.map((support) => <li key={String(support.extraction_revision_id)}><div><strong>{String(support.paper_title_snapshot)}</strong>{support.paper_publication_year_snapshot != null ? ` (${String(support.paper_publication_year_snapshot)})` : ""} · extraction value version {String(support.extraction_revision_id)}</div><div>Field type: {String(support.field_type)} · value state: {String(support.value_state)} · typed value: <span>{frozenSupportValue(support)}</span></div>{support.researcher_note != null && <div>Frozen researcher extraction note: <span>{String(support.researcher_note)}</span></div>}</li>)}
                      </ul>
                    </details>
                  )}
                  {detail.groundings.length > 0 && <details className="hint" style={{ marginTop: 8 }}><summary>Frozen grounding locators ({detail.groundings.length})</summary><ul>{detail.groundings.map((grounding) => <li key={String(grounding.id)}><div>extraction value version {String(grounding.extraction_revision_id)} · Evidence {String(grounding.evidence_id)} · offsets {String(grounding.start_offset)}–{String(grounding.end_offset)}</div><div>Exact quote: <span>{String(grounding.locator_quote)}</span></div>{grounding.locator_prefix != null && <div>Prefix: <span>{String(grounding.locator_prefix)}</span></div>}{grounding.locator_suffix != null && <div>Suffix: <span>{String(grounding.locator_suffix)}</span></div>}</li>)}</ul></details>}
                  {result == null && (
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <form action={executeAiSynthesisSuggestionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={String(request.id)} /><button className="button secondary" type="submit">Generate suggestion</button></form>
                      <form action={expireAiSynthesisSuggestionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={String(request.id)} /><button className="button ghost" type="submit">Mark request timed out</button></form>
                    </div>
                  )}
                  {candidate && !decision && (
                    <>
                      <div className="quote" style={{ marginTop: 8 }}><strong>{String(result?.title ?? "Untitled suggestion")}</strong><br />{String(result?.statementText ?? "")}</div>
                      {result?.explanation != null && <p className="hint">{String(result.explanation)}</p>}
                      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                        <form action={acceptAiSynthesisSuggestionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={String(request.id)} /><input type="hidden" name="mode" value="accept" /><button className="button primary" type="submit">Use unchanged</button></form>
                        <form action={rejectAiSynthesisSuggestionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={String(request.id)} /><button className="button ghost" type="submit">Reject</button></form>
                      </div>
                      <form action={acceptAiSynthesisSuggestionAction} style={{ marginTop: 10 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={String(request.id)} /><input type="hidden" name="mode" value="edit_and_accept" /><div className="field"><label htmlFor={`ai-title-${String(request.id)}`}>Edit title</label><input id={`ai-title-${String(request.id)}`} name="title" defaultValue={String(result?.title ?? "")} maxLength={500} /></div><div className="field"><label htmlFor={`ai-statement-${String(request.id)}`}>Edit statement</label><textarea id={`ai-statement-${String(request.id)}`} name="statementText" defaultValue={String(result?.statementText ?? "")} maxLength={10000} required /></div><div className="field"><label htmlFor={`ai-note-${String(request.id)}`}>Researcher note</label><textarea id={`ai-note-${String(request.id)}`} name="researcherNote" maxLength={10000} /></div><button className="button secondary" type="submit">Edit and accept</button></form>
                    </>
                  )}
                  {result != null && String(result.outcome) === "no_candidate" && !decision && (
                    <>
                      {result.explanation != null && <p className="hint">{String(result.explanation)}</p>}
                      <form action={rejectAiSynthesisSuggestionAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="preparationId" value={preparationId} /><input type="hidden" name="requestId" value={String(request.id)} /><button className="button ghost" type="submit">Acknowledge and reject</button></form>
                    </>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {workspace.sourceSetChanged && (
          <div
            className="card"
            style={{
              marginBottom: 16,
              background: "#fffbeb",
              border: "1px solid #fde68a",
              padding: 16,
              borderRadius: 8,
            }}
          >
            <strong>Note on composition drift:</strong> The underlying Evidence Set{" "}
            <em>{workspace.evidenceSet.name}</em> has been modified since this preparation workspace
            was created (current composition is sequence {workspace.latestCompositionSequence}). This workspace
            remains safely pinned to sequence {workspace.pinnedCompositionSequence}.
          </div>
        )}

        {prep.status === "finalized" && (
          <div
            className="card"
            style={{
              marginBottom: 16,
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              padding: 16,
              borderRadius: 8,
            }}
          >
            <strong>Finalized workspace:</strong> This preparation was finalized on{" "}
            {prep.finalizedAt?.toLocaleString()}. It is now terminal and frozen.
            {prep.targetSynthesisStatementId && (
              <span style={{ marginLeft: 12 }}>
                <Link
                  className="button secondary"
                  href={`/projects/${projectId}/synthesis/${prep.targetSynthesisStatementId}`}
                >
                  View finalized synthesis statement →
                </Link>
              </span>
            )}
          </div>
        )}

        {prep.status === "abandoned" && (
          <div
            className="card"
            style={{
              marginBottom: 16,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              padding: 16,
              borderRadius: 8,
            }}
          >
            <strong>Abandoned workspace:</strong> This preparation was abandoned on{" "}
            {prep.abandonedAt?.toLocaleString()} and is frozen. No further edits or finalization are permitted.
          </div>
        )}

        <div className="workspace-grid">
          {/* Metadata & Settings Section */}
          <section className="card section-card">
            <div className="section-heading">
              <h2>Workspace settings</h2>
              <span className="count">{active ? "Editable" : "Frozen"}</span>
            </div>
            {active ? (
              <>
                <form action={updateSynthesisPreparationAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="preparationId" value={prep.id} />
                  <div className="field">
                    <label htmlFor="prep-title">Working title</label>
                    <input
                      id="prep-title"
                      name="workingTitle"
                      defaultValue={prep.workingTitle ?? ""}
                      maxLength={100}
                      placeholder="e.g. Preparation for primary outcome comparison"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="prep-note">Working note</label>
                    <textarea
                      id="prep-note"
                      name="workingNote"
                      defaultValue={prep.workingNote ?? ""}
                      maxLength={5000}
                      placeholder="Context or criteria guiding this comparison"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="prep-target">Target synthesis statement</label>
                    <select
                      id="prep-target"
                      name="targetSynthesisStatementId"
                      defaultValue={prep.targetSynthesisStatementId ?? ""}
                    >
                      <option value="">(Create new statement upon finalization)</option>
                      {existingStatements.map((stmt) => (
                        <option key={stmt.synthesisStatementId} value={stmt.synthesisStatementId}>
                          {stmt.title ?? "Untitled statement"} · {stmt.state} (existing statement)
                        </option>
                      ))}
                    </select>
                  </div>
                  <button className="button secondary" type="submit">
                    Save settings
                  </button>
                </form>
                <ConfirmAction action={abandonSynthesisPreparationAction} label="Abandon preparation" title="Abandon this preparation?" description="The pinned selection and its history will remain available for audit." consequence="This preparation will be frozen and cannot be edited or finalized." hiddenFields={{ projectId, preparationId: prep.id }} confirmLabel="Abandon preparation" />
              </>
            ) : (
              <div className="item-list">
                <div className="item-meta">Title: {prep.workingTitle ?? "Untitled"}</div>
                <div className="item-meta">Note: {prep.workingNote ?? "None"}</div>
                <div className="item-meta">
                  Target statement:{" "}
                  {prep.targetSynthesisStatementId ? (
                    <Link href={`/projects/${projectId}/synthesis/${prep.targetSynthesisStatementId}`}>Existing synthesis statement</Link>
                  ) : (
                    "New statement"
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Finalization Section */}
          {active && (
            <section className="card section-card">
              <div className="section-heading">
                <h2>Finalize into synthesis</h2>
                <span className="count">{workspace.selectedCount} selected</span>
              </div>
              <p className="hint">
                Finalizing transitions selected candidate observations into an immutable synthesis version with exact support links. Zero supports are permitted.
              </p>
              <form action={finalizeSynthesisPreparationAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="preparationId" value={prep.id} />
                <div className="field">
                  <label htmlFor="final-title">
                    Statement title <span className="hint">optional</span>
                  </label>
                  <input
                    id="final-title"
                    name="title"
                    defaultValue={prep.workingTitle ?? ""}
                    placeholder="e.g. Cross-study findings on effect size"
                    maxLength={100}
                  />
                </div>
                <div className="field">
                  <label htmlFor="final-statement">
                    Synthesis statement <span className="hint">required</span>
                  </label>
                  <textarea
                    id="final-statement"
                    name="statementText"
                    required
                    maxLength={10000}
                    placeholder="Author a source-backed synthesis conclusion from the selected candidate observations"
                  />
                </div>
                <div className="field">
                  <label htmlFor="final-note">
                    Researcher note <span className="hint">optional</span>
                  </label>
                  <textarea
                    id="final-note"
                    name="researcherNote"
                    defaultValue={prep.workingNote ?? ""}
                    maxLength={5000}
                    placeholder="Rationale or notes for this finalized synthesis revision"
                  />
                </div>
                <button className="button primary" type="submit">
                  Finalize preparation →
                </button>
              </form>
            </section>
          )}

          {/* Candidate Comparison & Selection Section */}
          <section className="card section-card full">
            <div className="section-heading">
              <div>
                <h2>Candidate extraction value versions</h2>
                <p className="hint">
                  Revisions reachable through Evidence in the pinned Evidence Set composition for field &ldquo;{workspace.field.name}&rdquo;.
                </p>
              </div>
              <span className="count">
                {workspace.selectedCount} of {workspace.candidates.length} selected
              </span>
            </div>

            {workspace.candidates.length === 0 ? (
              <div className="empty">
                No candidate extraction revisions connect to Evidence in this pinned set for field &ldquo;{workspace.field.name}&rdquo;.
              </div>
            ) : (
              <form action={replaceSynthesisPreparationSelectionsAction}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="preparationId" value={prep.id} />

                <div className="matrix-list">
                  {workspace.candidates.map((candidate) => (
                    <label
                      className={`item matrix-row ${
                        !candidate.selectable ? "muted" : ""
                      }`}
                      key={candidate.extractionRevision.id}
                      style={{ display: "block", marginBottom: 12 }}
                    >
                      <div className="item-row" style={{ alignItems: "flex-start" }}>
                        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                          <input
                            type="checkbox"
                            name="extractionRevisionIds"
                            value={candidate.extractionRevision.id}
                            defaultChecked={candidate.selected}
                            disabled={!active || !candidate.selectable}
                            aria-label={`Select candidate observation from ${candidate.paper.title}`}
                          />
                          <div>
                            <div className="item-title">{candidate.paper.title}</div>
                            <div className="item-meta">
                              Value: <strong>{displayCandidateValue(candidate)}</strong> (rev {candidate.extractionRevision.sequence})
                              {candidate.isCurrentExtractionRevision
                                ? " · Current extraction"
                                : " · Superseded extraction"}
                            </div>
                            {/* Warnings / Eligibility Badges */}
                            {candidate.warnings.length > 0 && (
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                                {candidate.warnings.map((w) => (
                                  <span className="status stale" key={w}>
                                    {warningLabel(w)}
                                  </span>
                                ))}
                              </div>
                            )}
                            {/* Connecting Evidence */}
                            {candidate.connectingEvidence.length > 0 && (
                              <div style={{ marginTop: 8 }}>
                                <div className="hint" style={{ fontSize: "0.8rem", marginBottom: 2 }}>
                                  Connecting evidence in pinned set ({candidate.connectingEvidence.length}):
                                </div>
                                {candidate.connectingEvidence.map((ev) => (
                                  <div
                                    className="quote"
                                    key={ev.evidenceId}
                                    style={{ fontSize: "0.85rem", margin: "4px 0" }}
                                  >
                                    &ldquo;{ev.sourceText}&rdquo;{" "}
                                    <span className="item-meta">
                                      · Page {ev.pageNumber}
                                      {ev.curationWarning && ` (${ev.curationWarning.replaceAll("_", " ")})`}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        <span
                          className={`status ${
                            candidate.selected
                              ? "supported"
                              : candidate.selectable
                              ? "unsupported"
                              : "stale"
                          }`}
                        >
                          {candidate.selected ? "Selected" : candidate.selectable ? "Available" : "Ineligible"}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>

                {active && (
                  <div style={{ marginTop: 16 }}>
                    <button className="button secondary" type="submit">
                      Save candidate selections
                    </button>
                  </div>
                )}
              </form>
            )}
          </section>
        </div>

        <p className="footer-note">
          Preparation workspaces maintain isolated selections and do not mutate analytical support until finalization.
        </p>
      </div>
    </div>
  );
}
