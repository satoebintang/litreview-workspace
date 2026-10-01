import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import ResearchQuestionMatrixBrowser from "./ResearchQuestionMatrixBrowser";

export default async function ResearchQuestionsMatrixPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let matrix;
  try {
    matrix = await reviewServices.getResearchQuestionMatrixPage(projectId, { pageSize: 50, status: "all" });
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }

  return (
    <div className="project-page">
      <div className="container workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Review protocol &amp; planning</p>
            <h1>Research Questions Traceability</h1>
            <p>{matrix.project.title} · track question coverage across extraction, evidence sets, synthesis, and manuscript claims.</p>
          </div>
          <Link className="button secondary" href={`/projects/${projectId}/protocol`}>Open protocol &amp; search →</Link>
        </div>
        {query.error && <div className="error-banner" role="alert">{query.error}</div>}
        {query.saved && <div className="success-note" role="status">Traceability updated.</div>}
        <section className="card section-card full" style={{ marginBottom: 24, background: "#f8faf9", borderColor: "#cddbd2" }}>
          <div className="section-heading">
            <div>
              <h2 style={{ fontSize: 20, margin: 0 }}>Project Protocol Context</h2>
              <p className="hint" style={{ margin: "4px 0 0" }}><strong>Project-wide search context:</strong> Search strategies and search runs define the protocol across the whole project and are never attributed to individual research questions.</p>
            </div>
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <div style={{ textAlign: "right" }}>
                <span className="status supported">{matrix.protocolContext.searchStrategyCount} active {matrix.protocolContext.searchStrategyCount === 1 ? "strategy" : "strategies"}</span>{" "}
                <span className="status supported">{matrix.protocolContext.searchRunCount} search {matrix.protocolContext.searchRunCount === 1 ? "run" : "runs"}</span>
              </div>
              <Link className="button ghost" href={`/projects/${projectId}/protocol`}>Manage protocol →</Link>
            </div>
          </div>
        </section>
        <ResearchQuestionMatrixBrowser projectId={projectId} initialPage={matrix} />
        <p className="footer-note">Traceability is non-destructive planning state. Linked entities remain fully editable in their canonical workspaces.</p>
      </div>
    </div>
  );
}
