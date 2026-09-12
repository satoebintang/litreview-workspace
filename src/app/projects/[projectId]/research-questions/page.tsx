import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import type { TraceabilityFlag } from "@/domain/types";

function formatFlag(flag: TraceabilityFlag): string {
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

export default async function ResearchQuestionsMatrixPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId } = await params;
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

  const matrix = await reviewServices.getResearchQuestionMatrix(projectId);

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brand-mark">T</span> Tracework
        </Link>
        <span className="top-note">Evidence-first literature reviews</span>
      </header>
      <div className="container workspace">
        <Link className="back-link" href={`/projects/${projectId}`}>
          ← Back to workspace
        </Link>
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Review protocol &amp; planning</p>
            <h1>Research Questions Traceability</h1>
            <p>{project.title} · track question coverage across extraction, evidence sets, synthesis, and manuscript claims.</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Link className="button secondary" href={`/projects/${projectId}/protocol`}>
              Open protocol &amp; search →
            </Link>
          </div>
        </div>

        {query.error && <div className="error-banner" role="alert">{query.error}</div>}
        {query.saved && <div className="success-note" role="status">Traceability updated.</div>}

        {/* Project Protocol Context Banner */}
        <section className="card section-card full" style={{ marginBottom: 24, background: "#f8faf9", borderColor: "#cddbd2" }}>
          <div className="section-heading">
            <div>
              <h2 style={{ fontSize: 20, margin: 0 }}>Project Protocol Context</h2>
              <p className="hint" style={{ margin: "4px 0 0" }}>
                <strong>Project-wide search context:</strong> Search strategies and search runs define the protocol across the whole project and are never attributed to individual research questions.
              </p>
            </div>
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <div style={{ textAlign: "right" }}>
                <span className="status supported">{matrix.protocolContext.searchStrategyCount} active {matrix.protocolContext.searchStrategyCount === 1 ? "strategy" : "strategies"}</span>
                {" "}
                <span className="status supported">{matrix.protocolContext.searchRunCount} search {matrix.protocolContext.searchRunCount === 1 ? "run" : "runs"}</span>
              </div>
              <Link className="button ghost" href={`/projects/${projectId}/protocol`}>
                Manage protocol →
              </Link>
            </div>
          </div>
        </section>

        {/* Matrix Table */}
        <section className="card section-card full">
          <div className="section-heading">
            <h2>Traceability Matrix</h2>
            <span className="count">{matrix.rows.length} {matrix.rows.length === 1 ? "question" : "questions"}</span>
          </div>
          <p className="hint" style={{ marginBottom: 20 }}>
            Dynamic read-time projection of factual coverage across all six research dimensions. Traceability represents research planning history and does not alter formal provenance or PRISMA reporting.
          </p>

          {matrix.rows.length === 0 ? (
            <div className="empty">
              No research questions defined for this project yet.{" "}
              <Link href={`/projects/${projectId}/protocol`} style={{ color: "var(--forest)", fontWeight: 700 }}>
                Define research questions in Protocol →
              </Link>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid var(--line)", background: "#f7faf8" }}>
                    <th style={{ padding: "12px 14px", fontWeight: 700 }}>Question</th>
                    <th style={{ padding: "12px 14px", fontWeight: 700 }}>Status</th>
                    <th style={{ padding: "12px 14px", fontWeight: 700 }}>Extraction Fields</th>
                    <th style={{ padding: "12px 14px", fontWeight: 700 }}>Evidence Sets</th>
                    <th style={{ padding: "12px 14px", fontWeight: 700 }}>Synthesis Statements</th>
                    <th style={{ padding: "12px 14px", fontWeight: 700 }}>Claims &amp; Manuscript</th>
                    <th style={{ padding: "12px 14px", fontWeight: 700 }}>Diagnostic Flags</th>
                    <th style={{ padding: "12px 14px", fontWeight: 700, textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows.map((row) => {
                    const isArchived = Boolean(row.question.archivedAt);
                    const hasFlags =
                      row.flags.extraction.length > 0 ||
                      row.flags.evidenceSets.length > 0 ||
                      row.flags.synthesis.length > 0 ||
                      row.flags.claims.length > 0;

                    return (
                      <tr
                        key={row.question.id}
                        style={{
                          borderBottom: "1px solid var(--line)",
                          opacity: isArchived ? 0.75 : 1,
                          background: isArchived ? "#fafafa" : "#ffffff",
                        }}
                      >
                        <td style={{ padding: "14px", verticalAlign: "top" }}>
                          <div style={{ fontWeight: 700, color: "var(--forest-dark)" }}>
                            {row.question.identifier}
                          </div>
                          <div style={{ color: "var(--ink)", marginTop: 2, maxWidth: 280 }}>
                            {row.question.label}
                          </div>
                          <div className="hint" style={{ marginTop: 2 }}>
                            Order: {row.question.sortOrder + 1}
                          </div>
                        </td>

                        <td style={{ padding: "14px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                          {isArchived ? (
                            <span className="status withdrawn">Archived</span>
                          ) : (
                            <span className="status supported">Active</span>
                          )}
                        </td>

                        <td style={{ padding: "14px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                          <div>
                            <strong>{row.counts.linkedExtractionFields}</strong> linked
                          </div>
                        </td>

                        <td style={{ padding: "14px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                          <div>
                            <strong>{row.counts.linkedEvidenceSets}</strong> linked
                          </div>
                        </td>

                        <td style={{ padding: "14px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                          <div>
                            <strong>{row.counts.linkedSynthesisStatements}</strong> linked
                          </div>
                          <div className="hint">
                            {row.counts.activeSynthesisStatements} active · {row.counts.interpretations} interpreted
                          </div>
                        </td>

                        <td style={{ padding: "14px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                          <div>
                            <strong>{row.counts.linkedClaims}</strong> linked
                          </div>
                          <div className="hint">
                            {row.counts.activeClaims} active · {row.counts.currentManuscriptPlacements} placed
                          </div>
                        </td>

                        <td style={{ padding: "14px", verticalAlign: "top" }}>
                          {!hasFlags ? (
                            <span className="status supported">● Fully Covered</span>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              {row.flags.extraction.map((f) => (
                                <span key={f.code + (f.targetId ?? "")} className="status unsupported">
                                  Extraction: {formatFlag(f)}
                                </span>
                              ))}
                              {row.flags.evidenceSets.map((f) => (
                                <span key={f.code + (f.targetId ?? "")} className="status unsupported">
                                  Evidence Sets: {formatFlag(f)}
                                </span>
                              ))}
                              {row.flags.synthesis.map((f) => (
                                <span key={f.code + (f.targetId ?? "")} className="status unsupported">
                                  Synthesis: {formatFlag(f)}
                                </span>
                              ))}
                              {row.flags.claims.map((f) => (
                                <span key={f.code + (f.targetId ?? "")} className="status unsupported">
                                  Claims: {formatFlag(f)}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>

                        <td style={{ padding: "14px", verticalAlign: "top", textAlign: "right", whiteSpace: "nowrap" }}>
                          <Link
                            className="button ghost"
                            href={`/projects/${projectId}/research-questions/${row.question.id}`}
                          >
                            Open workspace →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="footer-note">
          Traceability is non-destructive planning state. Linked entities remain fully editable in their canonical workspaces.
        </p>
      </div>
    </main>
  );
}
