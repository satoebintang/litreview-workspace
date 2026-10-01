import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import ResearchQuestionAnswerPanel from "./ResearchQuestionAnswerPanel";
import ResearchQuestionLinkLedger from "./ResearchQuestionLinkLedger";

const diagnosticNames: Record<string, string> = {
  no_linked_extraction_fields: "No linked Extraction Fields",
  linked_field_without_current_data: "Linked Field without current data",
  no_linked_evidence_sets: "No linked Evidence Sets",
  linked_set_empty: "Linked Evidence Set is empty",
  linked_set_contains_rejected_evidence: "Linked Evidence Set contains rejected Evidence",
  no_linked_synthesis_statements: "No linked Synthesis Statements",
  linked_statement_without_current_active_revision: "Linked Statement without current active revision",
  linked_current_synthesis_without_support: "Active Synthesis without formal support",
  linked_current_synthesis_without_interpretation: "Active Synthesis without interpretation",
  no_linked_claims: "No linked Claims",
  linked_claim_without_current_active_revision: "Linked Claim without current active revision",
  linked_current_claim_unsupported: "Active Claim without formal support",
  linked_current_claim_not_placed: "Active Claim not placed in the manuscript",
};

export default async function ResearchQuestionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; questionId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, questionId } = await params;
  const query = searchParams ? await searchParams : {};
  let workspace;
  try {
    workspace = await reviewServices.getResearchQuestionWorkspace(projectId, questionId);
  } catch (error) {
    if (error instanceof DomainError && ["NOT_FOUND", "PROJECT_NOT_FOUND", "VALIDATION_ERROR", "CROSS_PROJECT_REFERENCE"].includes(error.code)) notFound();
    throw error;
  }

  const { project, question, protocolContext, currentLinkCounts, diagnostics, answerSummary, links, answerHistory } = workspace;
  const isArchived = Boolean(question.archivedAt);
  const diagnosticGroups = [
    ["Extraction Fields", diagnostics.extraction],
    ["Evidence Sets", diagnostics.evidenceSets],
    ["Synthesis Statements", diagnostics.synthesis],
    ["Manuscript Claims", diagnostics.claims],
  ] as const;
  const hasDiagnostics = diagnosticGroups.some(([, group]) => Object.values(group).some((count) => Number(count) > 0));

  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header">
      <div>
        <p className="eyebrow">Question Traceability Workspace</p>
        <h1>{question.identifier} <small style={{ fontSize: 24, color: "var(--muted)", fontWeight: 400 }}>· {question.label}</small></h1>
        <p>{project.title} · Order {question.sortOrder + 1}</p>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {isArchived ? <span className="status withdrawn">● Question Archived</span> : <span className="status supported">● Question Active</span>}
        <Link className="button ghost" href={`/projects/${projectId}/research-questions`}>Back to matrix</Link>
      </div>
    </div>
    {query.error && <div className="error-banner" role="alert">{query.error}</div>}
    {query.saved && <div className="success-note" role="status">{query.saved === "answer" ? "Answer snapshot finalized." : "Traceability link updated."}</div>}
    {isArchived && <div className="curation-warning-box" style={{ background: "#fff0ed", borderColor: "#fecaca", color: "#991b1b" }}><strong>Read-only question:</strong> this question is archived. Linking and unlinking are disabled; historical traceability and current coverage remain visible.</div>}

    <section className="card section-card full" style={{ marginBottom: 22, background: "#f8faf9", borderColor: "#cddbd2" }}>
      <div className="section-heading">
        <div><h2 style={{ fontSize: 18, margin: 0 }}>Project Protocol Context</h2><p className="hint" style={{ margin: "4px 0 0" }}><strong>Project-wide protocol context:</strong> search strategies and search runs define the protocol across the whole project and are never attributed to individual research questions.</p></div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}><span className="status supported">{protocolContext.searchStrategyCount} active strategies</span><span className="status supported">{protocolContext.searchRunCount} search runs</span><Link className="button ghost" href={`/projects/${projectId}/protocol`}>Manage protocol →</Link></div>
      </div>
    </section>

    <section className="card section-card full">
      <div className="section-heading"><div><h2>Coverage overview</h2><p className="hint">Current counts and diagnostic flags across all four bounded linked-target ledgers.</p></div><span className={`status ${diagnostics.fullyCovered ? "supported" : "unsupported"}`}>{diagnostics.fullyCovered ? "Fully Covered" : "Coverage gaps"}</span></div>
      {!hasDiagnostics ? <p className="hint">No current traceability diagnostic flags.</p> : <div className="item-list">
        {diagnosticGroups.flatMap(([dimension, group]) => Object.entries(group).filter(([, count]) => Number(count) > 0).map(([code, count]) => <div className="item" key={`${dimension}-${code}`}><div className="item-row"><strong>{dimension}</strong><span className="status unsupported">{count}</span></div><div>{diagnosticNames[code] ?? code}</div></div>))}
      </div>}
    </section>

    <div style={{ display: "grid", gap: 20, marginTop: 20 }}>
      <ResearchQuestionLinkLedger key={`extraction-field:${workspace.traceabilityEpoch}`} projectId={projectId} questionId={questionId} targetType="extraction-field" initialPage={links.extractionFields} linkedCount={currentLinkCounts.extractionFields} isArchived={isArchived} />
      <ResearchQuestionLinkLedger key={`evidence-set:${workspace.traceabilityEpoch}`} projectId={projectId} questionId={questionId} targetType="evidence-set" initialPage={links.evidenceSets} linkedCount={currentLinkCounts.evidenceSets} isArchived={isArchived} />
      <ResearchQuestionLinkLedger key={`synthesis-statement:${workspace.traceabilityEpoch}`} projectId={projectId} questionId={questionId} targetType="synthesis-statement" initialPage={links.synthesisStatements} linkedCount={currentLinkCounts.synthesisStatements} isArchived={isArchived} />
      <ResearchQuestionLinkLedger key={`claim:${workspace.traceabilityEpoch}`} projectId={projectId} questionId={questionId} targetType="claim" initialPage={links.claims} linkedCount={currentLinkCounts.claims} isArchived={isArchived} />
    </div>

    <ResearchQuestionAnswerPanel projectId={projectId} questionId={questionId} isArchived={isArchived} initialSummary={answerSummary} initialHistory={answerHistory} />
    <p className="footer-note">Traceability is non-destructive planning state. Linked entities remain fully editable in their canonical workspaces.</p>
  </div></div>;
}
