import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function SynthesisPreparationsListPage({
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
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }

  const preparations = await reviewServices.listSynthesisPreparations(projectId);

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brand-mark">T</span> Tracework
        </Link>
        <span className="top-note">Evidence-first literature reviews</span>
      </header>
      <div className="container workspace">
        <Link className="back-link" href={`/projects/${projectId}/synthesis`}>
          ← Back to synthesis
        </Link>
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Synthesis preparation</p>
            <h1>{project.title}</h1>
            <p>
              Researcher-controlled workspaces connecting pinned Evidence Set compositions and ExtractionFields into stable comparison surfaces.
            </p>
          </div>
          <Link className="button ghost" href={`/projects/${projectId}/evidence-sets`}>
            Browse Evidence Sets →
          </Link>
        </div>
        {query.error && (
          <div className="error-banner" role="alert">
            {query.error}
          </div>
        )}
        <div className="workspace-grid">
          <section className="card section-card full">
            <div className="section-heading">
              <h2>Preparation workspaces</h2>
              <span className="count">{preparations.length} total</span>
            </div>
            {preparations.length === 0 ? (
              <div className="empty">
                No synthesis preparations found. Start one from an active <Link href={`/projects/${projectId}/evidence-sets`} style={{ textDecoration: "underline" }}>Evidence Set</Link>.
              </div>
            ) : (
              <div className="item-list">
                {preparations.map((prep) => (
                  <article className="item item-row" key={prep.id}>
                    <div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <div className="item-title">
                          {prep.workingTitle ?? "Untitled preparation"}
                        </div>
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
                        {prep.sourceSetChanged && (
                          <span className="status stale">
                            Evidence Set updated
                          </span>
                        )}
                      </div>
                      <div className="item-meta">
                        Set: {prep.evidenceSetName} (pinned seq {prep.pinnedCompositionSequence}) · Field: {prep.extractionFieldName} ({prep.extractionFieldType})
                      </div>
                      <div className="item-meta">
                        {prep.selectedCount} of {prep.candidateCount} candidates selected
                        {prep.workingNote ? ` · Note: ${prep.workingNote}` : ""}
                      </div>
                      {prep.targetSynthesisStatementId && (
                        <div className="item-meta">
                          Target statement:{" "}
                          <Link href={`/projects/${projectId}/synthesis/${prep.targetSynthesisStatementId}`}>
                            View statement
                          </Link>
                        </div>
                      )}
                    </div>
                    <Link
                      className="button ghost"
                      href={`/projects/${projectId}/synthesis/preparations/${prep.id}`}
                    >
                      Open workspace →
                    </Link>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
        <p className="footer-note">
          Preparation workspaces are workflow context, not analytical provenance. Supports remain strictly attached to exact ExtractionRevisions upon finalization.
        </p>
      </div>
    </main>
  );
}
