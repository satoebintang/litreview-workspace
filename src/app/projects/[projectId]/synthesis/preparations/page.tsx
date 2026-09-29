import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

type SearchParams = { cursor?: string; error?: string };

function pageHref(projectId: string, cursor?: string | null) {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return `/projects/${projectId}/synthesis/preparations${query ? `?${query}` : ""}`;
}

export default async function SynthesisPreparationsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<SearchParams>;
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

  let ledger;
  let cursorNotice: string | undefined;
  try {
    ledger = await reviewServices.listSynthesisPreparationLedger(projectId, {
      cursor: query.cursor,
      pageSize: 50,
    });
  } catch (error) {
    if (query.cursor && error instanceof DomainError && error.code === "VALIDATION_ERROR") {
      cursorNotice = error.message;
      ledger = await reviewServices.listSynthesisPreparationLedger(projectId, { pageSize: 50 });
    } else if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND"].includes(error.code)) {
      notFound();
    } else {
      throw error;
    }
  }

  if (!ledger) notFound();
  const nextHref = pageHref(projectId, ledger.nextCursor);
  const firstHref = pageHref(projectId);

  return (
    <div className="project-page">
      <div className="container workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Synthesis preparation</p>
            <h1>{project.title}</h1>
            <p>
              Researcher-controlled workspaces connect an exact pinned Evidence Set composition to an Extraction Field.
            </p>
          </div>
          <Link className="button ghost" href={`/projects/${projectId}/evidence-sets`}>
            Browse Evidence Sets →
          </Link>
        </div>

        {query.error && <div className="error-banner" role="alert">{query.error}</div>}
        {cursorNotice && (
          <div className="error-banner" role="alert">
            {cursorNotice} The ledger has returned to its first page.
          </div>
        )}

        <section className="card section-card">
          <div className="section-heading">
            <div>
              <h2>Preparation workspaces</h2>
              <p className="hint">Showing at most {ledger.pageSize} preparations on this page.</p>
            </div>
            <span className="count">{ledger.items.length} shown{ledger.hasMore ? " · more available" : ""}</span>
          </div>

          {ledger.items.length === 0 ? (
            <div className="empty">
              No synthesis preparations found. Start one from an active{" "}
              <Link href={`/projects/${projectId}/evidence-sets`} style={{ textDecoration: "underline" }}>Evidence Set</Link>.
            </div>
          ) : (
            <div className="item-list">
              {ledger.items.map((prep) => (
                <article className="item item-row" key={prep.id}>
                  <div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <Link className="item-title" href={`/projects/${projectId}/synthesis/preparations/${prep.id}`}>
                        {prep.workingTitlePreview ?? "Untitled preparation"}{prep.workingTitleTruncated ? "…" : ""}
                      </Link>
                      <span className={`status ${prep.status === "abandoned" ? "stale" : "supported"}`}>
                        {prep.status === "active" ? "● Active" : prep.status === "finalized" ? "✓ Finalized" : "Abandoned"}
                      </span>
                      {prep.evidenceSetArchivedAt && <span className="status stale">Evidence Set archived</span>}
                      {prep.sourceSetChanged && <span className="status stale">Source Set changed since pinned revision</span>}
                    </div>
                    <div className="item-meta">
                      Set: {prep.evidenceSetName} (pinned sequence {prep.pinnedCompositionSequence}) · Field: {prep.extractionFieldName} ({prep.extractionFieldType})
                    </div>
                    <div className="item-meta">
                      {prep.selectedCount} selected · {prep.createdAt.toLocaleString()}
                      {prep.workingNotePreview ? ` · Note: ${prep.workingNotePreview}${prep.workingNoteTruncated ? "…" : ""}` : ""}
                    </div>
                    {prep.targetSynthesisStatementId && (
                      <div className="item-meta">
                        Target statement:{" "}
                        <Link href={`/projects/${projectId}/synthesis/${prep.targetSynthesisStatementId}`}>
                          {prep.targetSynthesisStatementTitle ?? "Open statement"}
                        </Link>
                        {prep.targetSynthesisCurrentRevisionState && ` · ${prep.targetSynthesisCurrentRevisionState}`}
                      </div>
                    )}
                    <div className="item-meta">
                      Exact pin: <Link href={`/projects/${projectId}/evidence-sets/${prep.evidenceSetId}/history/${prep.pinnedCompositionRevisionId}`}>
                        composition revision {prep.pinnedCompositionRevisionId}
                      </Link>
                    </div>
                  </div>
                  <Link className="button ghost" href={`/projects/${projectId}/synthesis/preparations/${prep.id}`}>
                    Open workspace →
                  </Link>
                </article>
              ))}
            </div>
          )}

          <div className="item-row" style={{ marginTop: 18 }}>
            {query.cursor && <Link className="button ghost" href={firstHref}>First page</Link>}
            {ledger.nextCursor && <Link className="button secondary" href={nextHref}>Next page</Link>}
          </div>
        </section>

        <p className="footer-note">
          Preparation workspaces are workflow context. Finalized synthesis supports retain exact ExtractionRevision identities.
        </p>
      </div>
    </div>
  );
}
