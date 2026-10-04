import Link from "next/link";
import { notFound } from "next/navigation";
import { withReviewReadTransaction } from "@/app/server";
import { DomainError } from "@/domain/errors";

function displaySupportValue(support: {
  valueState: string;
  textValue: string | null;
  numberValue: string | null;
  booleanValue: boolean | null;
  optionId: string | null;
  optionLabel: string | null;
}): string {
  if (support.valueState !== "present") return support.valueState.replaceAll("_", " ");
  return support.textValue ?? support.numberValue ?? support.optionLabel ??
    (support.booleanValue === null ? (support.optionId ? "Selected option" : "—") : support.booleanValue ? "Yes" : "No");
}

export default async function ExactSynthesisInterpretationPage({
  params,
}: {
  params: Promise<{ projectId: string; statementId: string; revisionId: string; interpretationId: string }>;
}) {
  const { projectId, statementId, revisionId, interpretationId } = await params;
  let snapshot;
  try {
    snapshot = await withReviewReadTransaction(({ synthesisInterpretationExactReadServices }) =>
      synthesisInterpretationExactReadServices.getExactSynthesisInterpretation(projectId, statementId, revisionId, interpretationId),
    );
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }

  return (
    <div className="project-page">
      <div className="container workspace">
        <div className="workspace-header">
          <div>
            <p className="eyebrow">Exact synthesis interpretation · Snapshot {snapshot.sequence}</p>
            <h1>{snapshot.convergenceState} interpretation</h1>
            <p>
              Finalized {new Date(snapshot.finalizedAt).toLocaleString()} · Synthesis revision {" "}
              <Link href={`/projects/${projectId}/synthesis/${statementId}/revisions/${revisionId}`}>view exact synthesis provenance →</Link>
              {snapshot.isCurrent ? " · Current interpretation" : " · Historical interpretation"}
            </p>
          </div>
          <span className={`badge-convergence ${snapshot.convergenceState}`}>{snapshot.convergenceState}</span>
        </div>

        <section className="card section-card full">
          <div className="section-heading"><h2>Interpretation summary</h2></div>
          <p style={{ whiteSpace: "pre-wrap" }}>{snapshot.summary}</p>
          {snapshot.researcherNote && <p className="hint" style={{ whiteSpace: "pre-wrap" }}><strong>Researcher note:</strong> {snapshot.researcherNote}</p>}
        </section>

        <div className="workspace-grid">
          <section className="card section-card">
            <div className="section-heading"><h2>Structured limitations</h2><span className="count">{snapshot.limitations.length}</span></div>
            {snapshot.limitations.length === 0 ? <p className="empty">No limitations recorded.</p> : <div className="item-list">{snapshot.limitations.map((item) => <article className="item" key={item.id}><div className="item-title">{item.category.replaceAll("_", " ")}</div><p style={{ whiteSpace: "pre-wrap" }}>{item.body}</p></article>)}</div>}
          </section>

          <section className="card section-card">
            <div className="section-heading"><h2>Open research questions</h2><span className="count">{snapshot.questions.length}</span></div>
            {snapshot.questions.length === 0 ? <p className="empty">No open questions recorded.</p> : <div className="item-list">{snapshot.questions.map((item) => <article className="item" key={item.id}><p style={{ whiteSpace: "pre-wrap" }}>{item.body}</p></article>)}</div>}
          </section>

          <section className="card section-card full">
            <div className="section-heading"><h2>Contradiction pairs</h2><span className="count">{snapshot.contradictions.length}</span></div>
            {snapshot.contradictions.length === 0 ? <p className="empty">No contradiction pairs recorded.</p> : <div className="item-list">{snapshot.contradictions.map((pair) => <article className="item" key={pair.id}>
              <div className="item-row">
                {[pair.leftSupport, pair.rightSupport].map((support, index) => <div key={index}>
                  <div className="item-title">{support ? support.paperTitle : "Support not pinned to this exact revision"}</div>
                  {support && <div className="item-meta">{support.fieldName}: {displaySupportValue(support)} · Extraction revision {support.sequence} · {support.isCurrentExtractionRevision ? "Current extraction" : "Superseded extraction"}</div>}
                </div>)}
              </div>
              {pair.note && <p className="hint" style={{ whiteSpace: "pre-wrap" }}>{pair.note}</p>}
            </article>)}</div>}
          </section>
        </div>
        <p className="footer-note">This exact snapshot is scoped to the selected Project, statement, and finalized revision. Interpretation remains distinct from formal support and citation paths.</p>
      </div>
    </div>
  );
}
