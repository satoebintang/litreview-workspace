import Link from "next/link";
import { notFound } from "next/navigation";
import { appendSynthesisInterpretationAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import type { LimitationCategory } from "@/domain/types";

function displayExtraction(support: {
  extractionRevision: {
    valueState: string;
    textValue: string | null;
    numberValue: string | null;
    booleanValue: boolean | null;
    optionId: string | null;
  };
}) {
  const revision = support.extractionRevision;
  if (revision.valueState !== "present") return revision.valueState.replaceAll("_", " ");
  return (
    revision.textValue ??
    revision.numberValue ??
    (revision.booleanValue === null
      ? revision.optionId
        ? "Selected option"
        : "—"
      : revision.booleanValue
      ? "Yes"
      : "No")
  );
}

const LIMITATION_CATEGORIES: { value: LimitationCategory; label: string }[] = [
  { value: "methodological", label: "Methodological" },
  { value: "population", label: "Population / Sample" },
  { value: "measurement", label: "Measurement / Instrument" },
  { value: "generalizability", label: "Generalizability / External validity" },
  { value: "missing_data", label: "Missing data / Attrition" },
  { value: "heterogeneity", label: "Heterogeneity" },
  { value: "reporting", label: "Reporting / Dissemination bias" },
  { value: "other", label: "Other" },
];

export default async function ExactSynthesisRevisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; statementId: string; revisionId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, statementId, revisionId } = await params;
  const query = searchParams ? await searchParams : {};

  let projection;
  try {
    projection = await reviewServices.getSynthesisInterpretationProjection(
      projectId,
      statementId,
      revisionId,
    );
  } catch (error) {
    if (
      error instanceof DomainError &&
      ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(
        error.code,
      )
    ) {
      notFound();
    }
    throw error;
  }

  const prepContext = await reviewServices.getSynthesisPreparationContextForRevision(
    projectId,
    revisionId,
  );

  const { revision, currentInterpretation, history, evidenceWarnings } = projection;
  const activeWarnings = evidenceWarnings.filter((w) => w.warning !== null);
  const supports = revision.supports;

  // Generate candidate contradiction pairs in canonical order (left < right)
  const candidatePairs: {
    left: typeof supports[0];
    right: typeof supports[0];
    pairKey: string;
  }[] = [];

  for (let i = 0; i < supports.length; i += 1) {
    for (let j = i + 1; j < supports.length; j += 1) {
      const a = supports[i];
      const b = supports[j];
      const [left, right] =
        a.extractionRevisionId < b.extractionRevisionId ? [a, b] : [b, a];
      candidatePairs.push({
        left,
        right,
        pairKey: `${left.extractionRevisionId}:${right.extractionRevisionId}`,
      });
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brand-mark">T</span> Tracework
        </Link>
        <span className="top-note">Evidence-first literature reviews</span>
      </header>
      <div className="container workspace">
        <Link
          className="back-link"
          href={`/projects/${projectId}/synthesis/${statementId}`}
        >
          ← Back to synthesis statement
        </Link>

        <div className="workspace-header">
          <div>
            <p className="eyebrow">
              Synthesis revision {revision.sequence} · Exact interpretation context
            </p>
            <h1>{revision.title ?? "Untitled synthesis"}</h1>
            <p>
              Revision {revision.sequence} · {revision.supportingRevisionCount} supporting{" "}
              {revision.supportingRevisionCount === 1 ? "observation" : "observations"} across{" "}
              {revision.supportingPaperCount}{" "}
              {revision.supportingPaperCount === 1 ? "Paper" : "Papers"}
              {revision.finalizedAt && (
                <> · Finalized {new Date(revision.finalizedAt).toLocaleDateString()}</>
              )}
            </p>
          </div>
          <span
            className={`status ${
              revision.state === "active" ? "supported" : "unsupported"
            }`}
          >
            {revision.state === "active" ? "Active revision" : "Withdrawn"}
          </span>
        </div>

        {query.error && (
          <div className="error-banner" role="alert">
            {query.error}
          </div>
        )}
        {query.saved === "interpretation" && (
          <div className="success-note" role="status">
            Interpretation snapshot saved successfully.
          </div>
        )}

        {prepContext && (
          <div
            className="card"
            style={{
              marginBottom: 16,
              background: "var(--surface-muted, #f8fafc)",
              border: "1px solid var(--border, #e2e8f0)",
              padding: 14,
              borderRadius: 6,
            }}
          >
            <span className="status supported" style={{ marginBottom: 4, display: "inline-block" }}>
              Preparation context
            </span>
            <div style={{ fontWeight: 500, fontSize: "0.95rem" }}>
              Finalized from preparation workspace for Evidence Set{" "}
              <Link
                href={`/projects/${projectId}/evidence-sets/${prepContext.evidenceSetId}`}
                style={{ textDecoration: "underline" }}
              >
                {prepContext.evidenceSetName}
              </Link>{" "}
              (pinned composition revision {prepContext.pinnedCompositionSequence})
            </div>
          </div>
        )}

        {activeWarnings.length > 0 && (
          <div className="curation-warning-box" role="status">
            <strong>Evidence curation notice:</strong> Some underlying Evidence passages supporting this revision have active review flags:
            <ul style={{ margin: "6px 0 0 16px" }}>
              {activeWarnings.map((w) => (
                <li key={w.evidenceId}>
                  Evidence <code>{w.evidenceId.slice(0, 8)}</code>:{" "}
                  <strong>
                    {w.warning === "currently_rejected"
                      ? "Currently rejected"
                      : w.warning === "needs_review"
                      ? "Needs review"
                      : "Unreviewed"}
                  </strong>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="workspace-grid">
          {/* Current Exact Synthesis Revision Card */}
          <section className="card section-card full">
            <div className="section-heading">
              <h2>Exact synthesis statement</h2>
              <span className="count">Revision {revision.sequence}</span>
            </div>
            {revision.statementText ? (
              <p className="synthesis-statement">{revision.statementText}</p>
            ) : (
              <p className="empty">This synthesis revision has been withdrawn.</p>
            )}
            {revision.researcherNote && (
              <p className="hint">Researcher note: {revision.researcherNote}</p>
            )}

            <h3 style={{ marginTop: 20, marginBottom: 10, fontSize: "1.05rem" }}>
              Exact supporting observations ({supports.length})
            </h3>
            <div className="item-list">
              {supports.length === 0 ? (
                <div className="empty">No supporting observations linked to this revision.</div>
              ) : (
                supports.map((support) => (
                  <article className="item" key={support.extractionRevisionId}>
                    <div className="item-row">
                      <div>
                        <div className="item-title">{support.paper.title}</div>
                        <div className="item-meta">
                          {support.field.name}: {displayExtraction(support)} · Extraction revision{" "}
                          {support.extractionRevision.sequence}
                        </div>
                      </div>
                      <span
                        className={`status ${
                          support.isCurrentExtractionRevision ? "supported" : "unsupported"
                        }`}
                      >
                        {support.isCurrentExtractionRevision
                          ? "Current extraction"
                          : "Superseded support"}
                      </span>
                    </div>
                    {support.extractionRevision.evidence.length > 0 && (
                      <div className="provenance-list">
                        {support.extractionRevision.evidence.map((ev) => (
                          <div className="quote" key={ev.id}>
                            “{ev.sourceText}”{" "}
                            <span className="item-meta">· Page {ev.pageNumber}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                ))
              )}
            </div>
          </section>

          {/* Current Interpretation Snapshot Card */}
          <section className="card section-card full">
            <div className="section-heading">
              <h2>Current interpretation snapshot</h2>
              {currentInterpretation && (
                <span className="count">Snapshot sequence {currentInterpretation.sequence}</span>
              )}
            </div>

            {currentInterpretation ? (
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    marginBottom: 14,
                  }}
                >
                  <span
                    className={`badge-convergence ${currentInterpretation.convergenceState}`}
                  >
                    {currentInterpretation.convergenceState}
                  </span>
                  <span className="item-meta">
                    Finalized{" "}
                    {new Date(currentInterpretation.finalizedAt).toLocaleString()}
                  </span>
                </div>

                <p
                  className="synthesis-statement"
                  style={{
                    fontSize: "1.15rem",
                    borderLeftColor: "var(--forest-dark, #2e624d)",
                    background: "#f0fdf4",
                  }}
                >
                  {currentInterpretation.summary}
                </p>

                {currentInterpretation.researcherNote && (
                  <p className="hint" style={{ marginBottom: 16 }}>
                    <strong>Note:</strong> {currentInterpretation.researcherNote}
                  </p>
                )}

                {/* Limitations */}
                <div style={{ marginTop: 16 }}>
                  <h4 style={{ fontSize: "0.95rem", marginBottom: 8 }}>
                    Structured limitations ({currentInterpretation.limitations.length})
                  </h4>
                  {currentInterpretation.limitations.length === 0 ? (
                    <p className="hint">No structured limitations recorded in this snapshot.</p>
                  ) : (
                    <div style={{ display: "grid", gap: 6 }}>
                      {currentInterpretation.limitations.map((lim) => (
                        <div
                          key={lim.id}
                          style={{
                            padding: "6px 10px",
                            background: "#f8fafc",
                            border: "1px solid #e2e8f0",
                            borderRadius: 4,
                            fontSize: "0.9rem",
                          }}
                        >
                          <span className="limitation-tag">{lim.category}</span>
                          {lim.body}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Open Questions */}
                <div style={{ marginTop: 16 }}>
                  <h4 style={{ fontSize: "0.95rem", marginBottom: 8 }}>
                    Open research questions ({currentInterpretation.questions.length})
                  </h4>
                  {currentInterpretation.questions.length === 0 ? (
                    <p className="hint">No research questions recorded in this snapshot.</p>
                  ) : (
                    <ul style={{ margin: "0 0 0 18px", fontSize: "0.9rem" }}>
                      {currentInterpretation.questions.map((q) => (
                        <li key={q.id} style={{ marginBottom: 4 }}>
                          {q.body}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Contradiction Pairs */}
                <div style={{ marginTop: 16 }}>
                  <h4 style={{ fontSize: "0.95rem", marginBottom: 8 }}>
                    Contradiction pairs ({currentInterpretation.contradictions.length})
                  </h4>
                  {currentInterpretation.contradictions.length === 0 ? (
                    <p className="hint">No contradiction pairs recorded in this snapshot.</p>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {currentInterpretation.contradictions.map((pair) => (
                        <div className="contradiction-card" key={pair.id}>
                          <div className="pair-vs">
                            <div className="pair-member">
                              <strong>{pair.leftSupport?.paper.title ?? "Paper"}</strong>
                              <div className="item-meta">
                                {pair.leftSupport?.field.name}:{" "}
                                {pair.leftSupport ? displayExtraction(pair.leftSupport) : "—"}
                              </div>
                            </div>
                            <div className="pair-vs-badge">VS</div>
                            <div className="pair-member">
                              <strong>{pair.rightSupport?.paper.title ?? "Paper"}</strong>
                              <div className="item-meta">
                                {pair.rightSupport?.field.name}:{" "}
                                {pair.rightSupport ? displayExtraction(pair.rightSupport) : "—"}
                              </div>
                            </div>
                          </div>
                          {pair.note && (
                            <p className="item-meta" style={{ marginTop: 6, fontStyle: "italic" }}>
                              Note: {pair.note}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* CTA: Draft Claim */}
                <div className="draft-claim-banner" style={{ marginTop: 24 }}>
                  <h3 style={{ margin: "0 0 6px", fontSize: "1.05rem" }}>
                    Advance this interpretation to a manuscript Claim
                  </h3>
                  <p className="hint" style={{ margin: "0 0 12px" }}>
                    Prefills a new Claim draft from this interpretation snapshot. The resulting claim will be formally grounded in this exact SynthesisRevision, while all interpretation text remains in this descriptive layer.
                  </p>
                  <Link
                    className="button"
                    href={`/projects/${projectId}/claims?interpretationId=${currentInterpretation.id}&synthesisRevisionId=${revision.id}`}
                  >
                    Draft Claim from this interpretation →
                  </Link>
                </div>
              </div>
            ) : (
              <div className="empty">
                No interpretation snapshot has been authored for this exact revision yet.
                Use the form below to record the first interpretation snapshot.
              </div>
            )}
          </section>

          {/* Snapshot Authoring Form */}
          <section className="card section-card full">
            <div className="section-heading">
              <h2>Record an interpretation snapshot</h2>
              <span className="count">Immutable snapshot</span>
            </div>
            <p className="hint">
              Interpretations are researcher-authored, immutable snapshots over this exact finalized revision. Each submission persists a complete snapshot with its limitations, questions, and contradiction pairs.
            </p>

            <form action={appendSynthesisInterpretationAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="synthesisStatementId" value={statementId} />
              <input type="hidden" name="synthesisRevisionId" value={revisionId} />

              <div className="field">
                <label htmlFor="convergence-state">
                  Convergence state <span className="hint">required</span>
                </label>
                <select
                  id="convergence-state"
                  name="convergenceState"
                  required
                  defaultValue="convergent"
                >
                  <option value="convergent">
                    Convergent — all supporting observations agree (0 contradiction pairs)
                  </option>
                  <option value="mixed">
                    Mixed — findings are mixed or heterogeneous (0 or more pairs)
                  </option>
                  <option value="contradictory">
                    Contradictory — findings directly conflict (at least 1 contradiction pair required)
                  </option>
                  <option value="inconclusive">
                    Inconclusive — observations are ambiguous or insufficient (0 or more pairs)
                  </option>
                </select>
              </div>

              <div className="field">
                <label htmlFor="summary">
                  Interpretation summary <span className="hint">required</span>
                </label>
                <textarea
                  id="summary"
                  name="summary"
                  required
                  rows={4}
                  placeholder="Describe your descriptive interpretation, synthesis context, and methodological caveats..."
                />
              </div>

              <div className="field">
                <label htmlFor="researcher-note">
                  Researcher note <span className="hint">optional</span>
                </label>
                <textarea
                  id="researcher-note"
                  name="researcherNote"
                  rows={2}
                  placeholder="Additional context or internal notes..."
                />
              </div>

              {/* Limitations inputs */}
              <fieldset style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: 14, marginBottom: 16 }}>
                <legend style={{ fontWeight: 600, padding: "0 6px" }}>
                  Structured limitations <span className="hint">optional</span>
                </legend>
                <p className="hint" style={{ margin: "0 0 10px" }}>
                  Add up to 3 limitations with categories:
                </p>
                {[0, 1, 2].map((idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      gap: 10,
                      marginBottom: 8,
                      alignItems: "center",
                    }}
                  >
                    <select
                      name="limitationCategory"
                      defaultValue="methodological"
                      style={{ width: "220px" }}
                      aria-label={`Limitation ${idx + 1} category`}
                    >
                      {LIMITATION_CATEGORIES.map((cat) => (
                        <option key={cat.value} value={cat.value}>
                          {cat.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      name="limitationBody"
                      placeholder={`Limitation ${idx + 1} description (leave blank to omit)`}
                      style={{ flex: 1 }}
                      aria-label={`Limitation ${idx + 1} description`}
                    />
                  </div>
                ))}
              </fieldset>

              {/* Research Questions inputs */}
              <fieldset style={{ border: "1px solid #e2e8f0", borderRadius: 6, padding: 14, marginBottom: 16 }}>
                <legend style={{ fontWeight: 600, padding: "0 6px" }}>
                  Open research questions <span className="hint">optional</span>
                </legend>
                <p className="hint" style={{ margin: "0 0 10px" }}>
                  Add open questions raised by this synthesis:
                </p>
                {[0, 1, 2].map((idx) => (
                  <div key={idx} style={{ marginBottom: 8 }}>
                    <input
                      type="text"
                      name="questionBody"
                      placeholder={`Research question ${idx + 1} (leave blank to omit)`}
                      style={{ width: "100%" }}
                      aria-label={`Research question ${idx + 1}`}
                    />
                  </div>
                ))}
              </fieldset>

              {/* Contradiction Pairs Selection */}
              {candidatePairs.length > 0 && (
                <fieldset style={{ border: "1px solid #fecaca", background: "#fffbfb", borderRadius: 6, padding: 14, marginBottom: 16 }}>
                  <legend style={{ fontWeight: 600, padding: "0 6px", color: "#991b1b" }}>
                    Contradiction pairs <span className="hint">required for &apos;contradictory&apos; state</span>
                  </legend>
                  <p className="hint" style={{ margin: "0 0 10px" }}>
                    Select conflicting support pairs from this revision&apos;s exact observations:
                  </p>
                  <div style={{ display: "grid", gap: 8 }}>
                    {candidatePairs.map(({ left, right, pairKey }) => (
                      <label
                        className="checkbox-row"
                        key={pairKey}
                        style={{
                          background: "#ffffff",
                          border: "1px solid #fecaca",
                          padding: "8px 12px",
                          borderRadius: 4,
                        }}
                      >
                        <input
                          type="checkbox"
                          name="contradictionPairs"
                          value={pairKey}
                          aria-label={`Contradiction between ${left.paper.title} and ${right.paper.title}`}
                        />
                        <span>
                          <strong>{left.paper.title}</strong> ({displayExtraction(left)}){" "}
                          <span style={{ color: "#b91c1c", fontWeight: 800 }}>VS</span>{" "}
                          <strong>{right.paper.title}</strong> ({displayExtraction(right)})
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              <button className="button" type="submit">
                Record interpretation snapshot
              </button>
            </form>
          </section>

          {/* Historical Interpretation Timeline */}
          {history.length > 0 && (
            <section className="card section-card full">
              <div className="section-heading">
                <h2>Interpretation history</h2>
                <span className="count">{history.length} snapshots</span>
              </div>
              <div className="item-list">
                {history.map((snap) => (
                  <article className="item" key={snap.id}>
                    <div className="item-row">
                      <div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            marginBottom: 4,
                          }}
                        >
                          <span className={`badge-convergence ${snap.convergenceState}`}>
                            {snap.convergenceState}
                          </span>
                          <strong>Snapshot sequence {snap.sequence}</strong>
                          <span className="item-meta">
                            {new Date(snap.finalizedAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="item-title" style={{ fontSize: "1rem" }}>
                          {snap.summary}
                        </div>
                        {snap.researcherNote && (
                          <div className="item-meta">Note: {snap.researcherNote}</div>
                        )}
                        <div className="item-meta" style={{ marginTop: 4 }}>
                          {snap.limitations.length} {snap.limitations.length === 1 ? "limitation" : "limitations"} · {snap.questions.length} {snap.questions.length === 1 ? "question" : "questions"} · {snap.contradictions.length} {snap.contradictions.length === 1 ? "contradiction pair" : "contradiction pairs"}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>

        <p className="footer-note">
          Interpretation context remains distinct from formal support and citation paths.
        </p>
      </div>
    </main>
  );
}
