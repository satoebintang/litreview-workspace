import Link from "next/link";
import { notFound } from "next/navigation";
import {
  abandonSynthesisPreparationAction,
  finalizeSynthesisPreparationAction,
  replaceSynthesisPreparationSelectionsAction,
  updateSynthesisPreparationAction,
} from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import type { SynthesisCandidate } from "@/domain/types";

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
      return warning.replaceAll("_", " ");
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

  const savedMessage =
    query.saved === "updated"
      ? "Preparation settings saved."
      : query.saved === "selections"
      ? "Candidate selections updated."
      : query.saved === "abandoned"
      ? "Preparation abandoned and frozen."
      : undefined;

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brand-mark">T</span> Tracework
        </Link>
        <span className="top-note">Evidence-first literature reviews</span>
      </header>
      <div className="container workspace">
        <Link className="back-link" href={`/projects/${projectId}/synthesis/preparations`}>
          ← Synthesis preparations
        </Link>
        <div className="workspace-header">
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
                          {stmt.title ?? "Untitled statement"} · {stmt.state} (id: {stmt.synthesisStatementId.slice(0, 8)}...)
                        </option>
                      ))}
                    </select>
                  </div>
                  <button className="button secondary" type="submit">
                    Save settings
                  </button>
                </form>
                <form action={abandonSynthesisPreparationAction} style={{ marginTop: 16 }}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="preparationId" value={prep.id} />
                  <button className="button ghost" type="submit">
                    Abandon preparation
                  </button>
                </form>
              </>
            ) : (
              <div className="item-list">
                <div className="item-meta">Title: {prep.workingTitle ?? "Untitled"}</div>
                <div className="item-meta">Note: {prep.workingNote ?? "None"}</div>
                <div className="item-meta">
                  Target statement:{" "}
                  {prep.targetSynthesisStatementId ? (
                    <Link href={`/projects/${projectId}/synthesis/${prep.targetSynthesisStatementId}`}>
                      {prep.targetSynthesisStatementId}
                    </Link>
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
                Finalizing transitions selected candidate observations into an immutable SynthesisRevision with exact Slice 4 supports. Zero supports are permitted.
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
                <h2>Candidate ExtractionRevisions</h2>
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
    </main>
  );
}
