import Link from "next/link";
import { notFound } from "next/navigation";
import {
  linkExtractionFieldAction,
  unlinkExtractionFieldAction,
  linkEvidenceSetAction,
  unlinkEvidenceSetAction,
  linkSynthesisStatementAction,
  unlinkSynthesisStatementAction,
  linkClaimAction,
  unlinkClaimAction,
} from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import type { TraceabilityFlag } from "@/domain/types";

function formatFlag(flag: TraceabilityFlag | string): string {
  if (typeof flag === "string") {
    return flag
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
  const label = flag.targetLabel ? ` (${flag.targetLabel})` : "";
  switch (flag.code) {
    case "no_linked_extraction_fields":
      return "No Linked Extraction Fields";
    case "linked_field_without_current_data":
      return `Field Without Current Data${label}`;
    case "no_linked_evidence_sets":
      return "No Linked Evidence Sets";
    case "linked_set_empty":
      return `Evidence Set Is Empty${label}`;
    case "linked_set_contains_rejected_evidence":
      return `Evidence Set Contains Rejected Evidence${label}`;
    case "no_linked_synthesis_statements":
      return "No Linked Synthesis Statements";
    case "linked_statement_without_current_active_revision":
      return `Statement Without Active Revision${label}`;
    case "linked_current_synthesis_without_support":
      return `Synthesis Statement Without Support${label}`;
    case "linked_current_synthesis_without_interpretation":
      return `Synthesis Statement Without Interpretation${label}`;
    case "no_linked_claims":
      return "No Linked Claims";
    case "linked_claim_without_current_active_revision":
      return `Claim Without Active Revision${label}`;
    case "linked_current_claim_unsupported":
      return `Claim Unsupported${label}`;
    case "linked_current_claim_not_placed":
      return `Claim Not Placed In Manuscript${label}`;
    default:
      return (flag.code as string).split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
}

export default async function ResearchQuestionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; questionId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, questionId } = await params;
  const query = searchParams ? await searchParams : {};

  let project;
  try {
    project = await reviewServices.getProject(projectId);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) {
      notFound();
    }
    throw error;
  }

  let detail;
  try {
    detail = await reviewServices.getQuestionTraceability(projectId, questionId);
  } catch (error) {
    if (error instanceof DomainError && ["NOT_FOUND", "VALIDATION_ERROR", "CROSS_PROJECT_REFERENCE"].includes(error.code)) {
      notFound();
    }
    throw error;
  }

  const { question, currentLinks, protocolContext, extractionCoverage, evidenceSetCoverage, synthesisCoverage, claimCoverage, flags, histories, candidateTargets } = detail;
  const isArchived = Boolean(question.archivedAt);

  const availableFields = candidateTargets.extractionFields.filter(
    (f) => !currentLinks.extractionFieldIds.includes(f.id),
  );
  const availableEvidenceSets = candidateTargets.evidenceSets.filter(
    (s) => !currentLinks.evidenceSetIds.includes(s.id),
  );
  const availableStatements = candidateTargets.synthesisStatements.filter(
    (s) => !currentLinks.synthesisStatementIds.includes(s.id),
  );
  const availableClaims = candidateTargets.claims.filter(
    (c) => !currentLinks.claimIds.includes(c.id),
  );

  const hasFlags =
    flags.extraction.length > 0 ||
    flags.evidenceSets.length > 0 ||
    flags.synthesis.length > 0 ||
    flags.claims.length > 0;

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brand-mark">T</span> Tracework
        </Link>
        <span className="top-note">Evidence-first literature reviews</span>
      </header>

      <div className="container workspace">
        <Link className="back-link" href={`/projects/${projectId}/research-questions`}>
          ← Back to research questions matrix
        </Link>

        <div className="workspace-header">
          <div>
            <p className="eyebrow">Question Traceability Workspace</p>
            <h1>
              {question.identifier} <small style={{ fontSize: 24, color: "var(--muted)", fontWeight: 400 }}>· {question.label}</small>
            </h1>
            <p>{project.title} · Order {question.sortOrder + 1}</p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {isArchived ? (
              <span className="status withdrawn">● Question Archived</span>
            ) : (
              <span className="status supported">● Question Active</span>
            )}
          </div>
        </div>

        {query.error && <div className="error-banner" role="alert">{query.error}</div>}
        {query.saved && <div className="success-note" role="status">Traceability link updated.</div>}

        {isArchived && (
          <div className="curation-warning-box" style={{ background: "#fff0ed", borderColor: "#fecaca", color: "#991b1b" }}>
            <strong>Read-only question:</strong> This research question has been archived. Linking and unlinking operations are disabled, but full historical traceability and current coverage remain visible.
          </div>
        )}

        {/* Project Protocol Context Banner */}
        <section className="card section-card full" style={{ marginBottom: 22, background: "#f8faf9", borderColor: "#cddbd2" }}>
          <div className="section-heading">
            <div>
              <h2 style={{ fontSize: 18, margin: 0 }}>Project Protocol Context</h2>
              <p className="hint" style={{ margin: "4px 0 0" }}>
                <strong>Project-wide protocol context:</strong> Search strategies and search runs define the protocol across the whole project and are never attributed to individual research questions.
              </p>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span className="status supported">{protocolContext.searchStrategyCount} active strategies</span>
              <span className="status supported">{protocolContext.searchRunCount} runs</span>
              <Link className="button ghost" href={`/projects/${projectId}/protocol`}>
                Protocol &amp; search →
              </Link>
            </div>
          </div>
        </section>

        {/* Diagnostic Flags Overview */}
        <section className="card section-card full" style={{ marginBottom: 22 }}>
          <div className="section-heading">
            <h2>Diagnostic Coverage Status</h2>
            {!hasFlags ? (
              <span className="status supported">● All Dimensions Covered</span>
            ) : (
              <span className="status unsupported">● Attention Required</span>
            )}
          </div>
          {!hasFlags ? (
            <p className="hint" style={{ margin: 0 }}>
              All 6 research dimensions (Extraction, Evidence Sets, Synthesis, Interpretation, Claims, and Manuscript Placement) are actively linked and covered with finalized data.
            </p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {flags.extraction.map((f) => (
                <span key={f.code + (f.targetId ?? "")} className="status unsupported">
                  Extraction: {formatFlag(f)}
                </span>
              ))}
              {flags.evidenceSets.map((f) => (
                <span key={f.code + (f.targetId ?? "")} className="status unsupported">
                  Evidence Sets: {formatFlag(f)}
                </span>
              ))}
              {flags.synthesis.map((f) => (
                <span key={f.code + (f.targetId ?? "")} className="status unsupported">
                  Synthesis: {formatFlag(f)}
                </span>
              ))}
              {flags.claims.map((f) => (
                <span key={f.code + (f.targetId ?? "")} className="status unsupported">
                  Claims: {formatFlag(f)}
                </span>
              ))}
            </div>
          )}
        </section>

        <div className="workspace-grid">
          {/* Panel 1: Extraction Fields */}
          <section className="card section-card full">
            <div className="section-heading">
              <h2>Extraction Fields</h2>
              <span className="count">{extractionCoverage.length} linked</span>
            </div>
            <p className="hint" style={{ marginBottom: 18 }}>
              Structured observation fields linked to this research question. Coverage reflects finalized ExtractionRevisions across included papers.
            </p>

            {extractionCoverage.length === 0 ? (
              <div className="empty">No extraction fields linked to this research question yet.</div>
            ) : (
              <div className="item-list">
                {extractionCoverage.map((field) => {
                  const fieldHistory = histories.fieldEvents.filter(
                    (e) => e.extractionFieldId === field.fieldId,
                  );

                  return (
                    <article className="item" key={field.fieldId}>
                      <div className="item-row">
                        <div>
                          <div className="item-title">
                            {field.fieldName}
                            {field.archivedAt && <span className="status withdrawn" style={{ marginLeft: 8 }}>Archived</span>}
                          </div>
                          <div className="item-meta">
                            Type: {field.fieldType} · Included Papers Covered: {field.paperCoverage.filter((p) => p.status === "present").length} / {field.paperCoverage.length}
                          </div>
                        </div>
                        {!isArchived && (
                          <form action={unlinkExtractionFieldAction} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="questionId" value={questionId} />
                            <input type="hidden" name="fieldId" value={field.fieldId} />
                            <input
                              name="note"
                              placeholder="Optional unlink note"
                              style={{ width: 180, padding: "5px 8px", fontSize: 12 }}
                            />
                            <button className="button ghost danger" type="submit">
                              Unlink
                            </button>
                          </form>
                        )}
                      </div>

                      {/* Paper-by-Paper Coverage Matrix */}
                      <div style={{ marginTop: 12, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6, color: "var(--forest-dark)" }}>
                          Included Paper Coverage ({field.paperCoverage.length} papers):
                        </div>
                        <div style={{ display: "grid", gap: 4 }}>
                          {field.paperCoverage.map((p) => (
                            <div
                              key={p.paperId}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                fontSize: 12,
                                padding: "4px 8px",
                                background: "#f8faf9",
                                borderRadius: 4,
                              }}
                            >
                              <span>{p.paperTitle}</span>
                              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                {p.displayValue && (
                                  <strong style={{ color: "var(--forest-dark)" }}>{p.displayValue}</strong>
                                )}
                                <span className={`status ${p.status === "present" ? "supported" : "unsupported"}`}>
                                  {formatFlag(p.status)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Event History */}
                      <details className="revision-history">
                        <summary>Event History ({fieldHistory.length} {fieldHistory.length === 1 ? "event" : "events"})</summary>
                        <div className="item-list" style={{ marginTop: 8 }}>
                          {fieldHistory.map((ev) => (
                            <div key={ev.id} style={{ fontSize: 11, padding: "6px 8px", background: "#ffffff", border: "1px solid var(--line)", borderRadius: 4 }}>
                              <span style={{ fontWeight: 700, textTransform: "uppercase" }}>{ev.action}</span> · seq #{ev.sequence} · {new Date(ev.createdAt).toLocaleString()}
                              {ev.note && <div style={{ color: "var(--muted)", marginTop: 2 }}>Note: {ev.note}</div>}
                            </div>
                          ))}
                        </div>
                      </details>
                    </article>
                  );
                })}
              </div>
            )}

            {/* Link Form */}
            {!isArchived && (
              <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
                <h3 style={{ fontSize: 15 }}>Link Extraction Field</h3>
                {availableFields.length === 0 ? (
                  <p className="hint">All project extraction fields are already linked.</p>
                ) : (
                  <form action={linkExtractionFieldAction} className="inline-form" style={{ flexWrap: "wrap" }}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="questionId" value={questionId} />
                    <select name="fieldId" required defaultValue="" style={{ minWidth: 260 }}>
                      <option value="" disabled>Select an extraction field...</option>
                      {availableFields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name} ({f.fieldType}){f.archivedAt ? " [Archived]" : ""}
                        </option>
                      ))}
                    </select>
                    <input
                      name="note"
                      placeholder="Optional link rationale or note (max 2000 chars)"
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <button className="button secondary" type="submit">
                      Link field
                    </button>
                  </form>
                )}
              </div>
            )}
          </section>

          {/* Panel 2: Evidence Sets */}
          <section className="card section-card full">
            <div className="section-heading">
              <h2>Evidence Sets</h2>
              <span className="count">{evidenceSetCoverage.length} linked</span>
            </div>
            <p className="hint" style={{ marginBottom: 18 }}>
              Curated collections of source evidence linked to this research question.
            </p>

            {evidenceSetCoverage.length === 0 ? (
              <div className="empty">No evidence sets linked to this research question yet.</div>
            ) : (
              <div className="item-list">
                {evidenceSetCoverage.map((set) => {
                  const setHistory = histories.evidenceSetEvents.filter(
                    (e) => e.evidenceSetId === set.evidenceSetId,
                  );

                  return (
                    <article className="item" key={set.evidenceSetId}>
                      <div className="item-row">
                        <div>
                          <div className="item-title">
                            {set.name}
                            {set.archivedAt && <span className="status withdrawn" style={{ marginLeft: 8 }}>Archived</span>}
                          </div>
                          <div className="item-meta">
                            {set.memberCount} {set.memberCount === 1 ? "member" : "members"} across {set.distinctPaperCount} {set.distinctPaperCount === 1 ? "paper" : "papers"}
                          </div>
                          <div className="item-meta">
                            Reviews: {set.reviewCounts.accepted} accepted · {set.reviewCounts.needsReview} needs review · {set.reviewCounts.unreviewed} unreviewed · {set.reviewCounts.rejected} rejected
                          </div>
                        </div>
                        {!isArchived && (
                          <form action={unlinkEvidenceSetAction} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="questionId" value={questionId} />
                            <input type="hidden" name="evidenceSetId" value={set.evidenceSetId} />
                            <input
                              name="note"
                              placeholder="Optional unlink note"
                              style={{ width: 180, padding: "5px 8px", fontSize: 12 }}
                            />
                            <button className="button ghost danger" type="submit">
                              Unlink
                            </button>
                          </form>
                        )}
                      </div>

                      <details className="revision-history">
                        <summary>Event History ({setHistory.length} {setHistory.length === 1 ? "event" : "events"})</summary>
                        <div className="item-list" style={{ marginTop: 8 }}>
                          {setHistory.map((ev) => (
                            <div key={ev.id} style={{ fontSize: 11, padding: "6px 8px", background: "#ffffff", border: "1px solid var(--line)", borderRadius: 4 }}>
                              <span style={{ fontWeight: 700, textTransform: "uppercase" }}>{ev.action}</span> · seq #{ev.sequence} · {new Date(ev.createdAt).toLocaleString()}
                              {ev.note && <div style={{ color: "var(--muted)", marginTop: 2 }}>Note: {ev.note}</div>}
                            </div>
                          ))}
                        </div>
                      </details>
                    </article>
                  );
                })}
              </div>
            )}

            {!isArchived && (
              <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
                <h3 style={{ fontSize: 15 }}>Link Evidence Set</h3>
                {availableEvidenceSets.length === 0 ? (
                  <p className="hint">All project evidence sets are already linked.</p>
                ) : (
                  <form action={linkEvidenceSetAction} className="inline-form" style={{ flexWrap: "wrap" }}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="questionId" value={questionId} />
                    <select name="evidenceSetId" required defaultValue="" style={{ minWidth: 260 }}>
                      <option value="" disabled>Select an evidence set...</option>
                      {availableEvidenceSets.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}{s.archivedAt ? " [Archived]" : ""}
                        </option>
                      ))}
                    </select>
                    <input
                      name="note"
                      placeholder="Optional link rationale or note (max 2000 chars)"
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <button className="button secondary" type="submit">
                      Link set
                    </button>
                  </form>
                )}
              </div>
            )}
          </section>

          {/* Panel 3: Synthesis Statements */}
          <section className="card section-card full">
            <div className="section-heading">
              <h2>Synthesis Statements</h2>
              <span className="count">{synthesisCoverage.length} linked</span>
            </div>
            <p className="hint" style={{ marginBottom: 18 }}>
              Cross-paper synthesis statements linked to this research question. Coverage reflects the current active revision and interpretation.
            </p>

            {synthesisCoverage.length === 0 ? (
              <div className="empty">No synthesis statements linked to this research question yet.</div>
            ) : (
              <div className="item-list">
                {synthesisCoverage.map((stmt) => {
                  const candidateStmt = candidateTargets.synthesisStatements.find(
                    (s) => s.id === stmt.statementId,
                  );
                  const title = candidateStmt?.currentTitle ?? "Synthesis Statement";
                  const stmtHistory = histories.synthesisEvents.filter(
                    (e) => e.synthesisStatementId === stmt.statementId,
                  );

                  return (
                    <article className="item" key={stmt.statementId}>
                      <div className="item-row">
                        <div>
                          <div className="item-title">
                            {title}
                            {stmt.hasActiveRevision ? (
                              <span className="status supported" style={{ marginLeft: 8 }}>Active (Rev {stmt.currentActiveSequence})</span>
                            ) : (
                              <span className="status withdrawn" style={{ marginLeft: 8 }}>No Active Revision</span>
                            )}
                          </div>
                          <div className="item-meta">
                            Supports: {stmt.supportCount} {stmt.supportCount === 1 ? "support" : "supports"}
                          </div>
                          <div className="item-meta">
                            Interpretation:{" "}
                            {stmt.hasInterpretation ? (
                              <span className={`badge-convergence ${stmt.currentInterpretationConvergence ?? "inconclusive"}`}>
                                {stmt.currentInterpretationConvergence}
                              </span>
                            ) : (
                              <span className="status unsupported">Missing Interpretation</span>
                            )}
                          </div>
                        </div>
                        {!isArchived && (
                          <form action={unlinkSynthesisStatementAction} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="questionId" value={questionId} />
                            <input type="hidden" name="statementId" value={stmt.statementId} />
                            <input
                              name="note"
                              placeholder="Optional unlink note"
                              style={{ width: 180, padding: "5px 8px", fontSize: 12 }}
                            />
                            <button className="button ghost danger" type="submit">
                              Unlink
                            </button>
                          </form>
                        )}
                      </div>

                      <details className="revision-history">
                        <summary>Event History ({stmtHistory.length} {stmtHistory.length === 1 ? "event" : "events"})</summary>
                        <div className="item-list" style={{ marginTop: 8 }}>
                          {stmtHistory.map((ev) => (
                            <div key={ev.id} style={{ fontSize: 11, padding: "6px 8px", background: "#ffffff", border: "1px solid var(--line)", borderRadius: 4 }}>
                              <span style={{ fontWeight: 700, textTransform: "uppercase" }}>{ev.action}</span> · seq #{ev.sequence} · {new Date(ev.createdAt).toLocaleString()}
                              {ev.note && <div style={{ color: "var(--muted)", marginTop: 2 }}>Note: {ev.note}</div>}
                            </div>
                          ))}
                        </div>
                      </details>
                    </article>
                  );
                })}
              </div>
            )}

            {!isArchived && (
              <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
                <h3 style={{ fontSize: 15 }}>Link Synthesis Statement</h3>
                {availableStatements.length === 0 ? (
                  <p className="hint">All project synthesis statements are already linked.</p>
                ) : (
                  <form action={linkSynthesisStatementAction} className="inline-form" style={{ flexWrap: "wrap" }}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="questionId" value={questionId} />
                    <select name="statementId" required defaultValue="" style={{ minWidth: 260 }}>
                      <option value="" disabled>Select a synthesis statement...</option>
                      {availableStatements.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.currentTitle} [{s.currentState}]
                        </option>
                      ))}
                    </select>
                    <input
                      name="note"
                      placeholder="Optional link rationale or note (max 2000 chars)"
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <button className="button secondary" type="submit">
                      Link statement
                    </button>
                  </form>
                )}
              </div>
            )}
          </section>

          {/* Panel 4: Claims & Manuscript Placement */}
          <section className="card section-card full">
            <div className="section-heading">
              <h2>Manuscript Claims</h2>
              <span className="count">{claimCoverage.length} linked</span>
            </div>
            <p className="hint" style={{ marginBottom: 18 }}>
              Author-asserted claims linked to this research question, tracking formal grounding and manuscript placement.
            </p>

            {claimCoverage.length === 0 ? (
              <div className="empty">No claims linked to this research question yet.</div>
            ) : (
              <div className="item-list">
                {claimCoverage.map((claim) => {
                  const claimHistory = histories.claimEvents.filter(
                    (e) => e.claimId === claim.claimId,
                  );

                  return (
                    <article className="item" key={claim.claimId}>
                      <div className="item-row">
                        <div>
                          <div className="item-title">
                            {claim.hasActiveRevision ? (
                              <span className="status supported">Active (Rev {claim.currentActiveSequence})</span>
                            ) : (
                              <span className="status withdrawn">No Active Revision</span>
                            )}
                            <span className={`status ${claim.hasSupport ? "supported" : "unsupported"}`} style={{ marginLeft: 8 }}>
                              {claim.hasSupport ? "Supported" : "Unsupported"}
                            </span>
                            <span className={`status ${claim.currentClaimPlaced ? "supported" : "unsupported"}`} style={{ marginLeft: 8 }}>
                              {claim.currentClaimPlaced ? "Placed in Manuscript" : "Not Placed"}
                            </span>
                          </div>
                          {claim.claimText && (
                            <div className="quote-inline" style={{ margin: "6px 0", color: "var(--ink)", fontWeight: 500 }}>
                              “{claim.claimText}”
                            </div>
                          )}
                          <div className="item-meta">
                            Placement: {claim.currentClaimPlaced ? `Active in ${claim.activePlacementSections.join(", ") || "section"}` : "Not in active manuscript section"}
                            {claim.hasAnyHistoricalPlacement && !claim.currentClaimPlaced && " (Has earlier revision placement)"}
                          </div>
                        </div>
                        {!isArchived && (
                          <form action={unlinkClaimAction} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="questionId" value={questionId} />
                            <input type="hidden" name="claimId" value={claim.claimId} />
                            <input
                              name="note"
                              placeholder="Optional unlink note"
                              style={{ width: 180, padding: "5px 8px", fontSize: 12 }}
                            />
                            <button className="button ghost danger" type="submit">
                              Unlink
                            </button>
                          </form>
                        )}
                      </div>

                      <details className="revision-history">
                        <summary>Event History ({claimHistory.length} {claimHistory.length === 1 ? "event" : "events"})</summary>
                        <div className="item-list" style={{ marginTop: 8 }}>
                          {claimHistory.map((ev) => (
                            <div key={ev.id} style={{ fontSize: 11, padding: "6px 8px", background: "#ffffff", border: "1px solid var(--line)", borderRadius: 4 }}>
                              <span style={{ fontWeight: 700, textTransform: "uppercase" }}>{ev.action}</span> · seq #{ev.sequence} · {new Date(ev.createdAt).toLocaleString()}
                              {ev.note && <div style={{ color: "var(--muted)", marginTop: 2 }}>Note: {ev.note}</div>}
                            </div>
                          ))}
                        </div>
                      </details>
                    </article>
                  );
                })}
              </div>
            )}

            {!isArchived && (
              <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--line)" }}>
                <h3 style={{ fontSize: 15 }}>Link Claim</h3>
                {availableClaims.length === 0 ? (
                  <p className="hint">All project claims are already linked.</p>
                ) : (
                  <form action={linkClaimAction} className="inline-form" style={{ flexWrap: "wrap" }}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="questionId" value={questionId} />
                    <select name="claimId" required defaultValue="" style={{ minWidth: 260 }}>
                      <option value="" disabled>Select a claim...</option>
                      {availableClaims.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.currentText.slice(0, 60)} [{c.currentState}]
                        </option>
                      ))}
                    </select>
                    <input
                      name="note"
                      placeholder="Optional link rationale or note (max 2000 chars)"
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <button className="button secondary" type="submit">
                      Link claim
                    </button>
                  </form>
                )}
              </div>
            )}
          </section>
        </div>

        <p className="footer-note">
          Traceability is non-destructive planning state. Linked entities remain fully editable in their canonical workspaces.
        </p>
      </div>
    </main>
  );
}
