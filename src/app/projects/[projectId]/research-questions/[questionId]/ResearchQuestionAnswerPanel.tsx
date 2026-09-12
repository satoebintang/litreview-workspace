import Link from "next/link";
import { appendResearchQuestionAnswerAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import type {
  ResearchQuestionAnswerCandidateProjection,
  ResearchQuestionAnswerContextDriftFlag,
  ResearchQuestionAnswerSnapshot,
} from "@/domain/types";

function formatDate(value: Date): string {
  return new Date(value).toLocaleString();
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function driftLabel(flag: ResearchQuestionAnswerContextDriftFlag): string {
  switch (flag) {
    case "referenced_claim_revision_superseded":
      return "Claim revision superseded";
    case "referenced_claim_now_withdrawn":
      return "Claim now withdrawn";
    case "referenced_claim_no_longer_linked_to_rq":
      return "Claim no longer linked to this RQ";
    case "referenced_synthesis_revision_superseded":
      return "Synthesis revision superseded";
    case "referenced_synthesis_now_withdrawn":
      return "Synthesis statement now withdrawn";
    case "referenced_synthesis_no_longer_linked_to_rq":
      return "Synthesis statement no longer linked to this RQ";
  }
}

function CandidateList({ candidates }: { candidates: ResearchQuestionAnswerCandidateProjection }) {
  const selectableClaims = candidates.claims.filter((candidate) => candidate.isSelectable && candidate.revisionId);
  const selectableSyntheses = candidates.syntheses.filter((candidate) => candidate.isSelectable && candidate.revisionId);
  const hasCandidates = selectableClaims.length > 0 || selectableSyntheses.length > 0;

  return (
    <div data-testid="answer-candidates" style={{ display: "grid", gap: 12 }}>
      <div>
        <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>Claim contexts</h3>
        {selectableClaims.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>No current supported Claim revisions are linked to this question.</p>
        ) : (
          <div className="item-list">
            {selectableClaims.map((candidate) => (
              <label className="item" key={candidate.revisionId} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  name="claimRevisionIds"
                  value={candidate.revisionId!}
                  style={{ marginTop: 4 }}
                />
                <span>
                  <span className="item-title">Claim <code>{shortId(candidate.targetId)}</code></span>
                  <span className="item-meta">
                    Exact current finalized revision · sequence {candidate.revisionSequence} · {candidate.supportCount} formal support {candidate.supportCount === 1 ? "edge" : "edges"}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 style={{ fontSize: 15, margin: "0 0 8px" }}>Synthesis contexts</h3>
        {selectableSyntheses.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>No current supported Synthesis revisions are linked to this question.</p>
        ) : (
          <div className="item-list">
            {selectableSyntheses.map((candidate) => (
              <label className="item" key={candidate.revisionId} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  name="synthesisRevisionIds"
                  value={candidate.revisionId!}
                  style={{ marginTop: 4 }}
                />
                <span>
                  <span className="item-title">Synthesis statement <code>{shortId(candidate.targetId)}</code></span>
                  <span className="item-meta">
                    Exact current finalized revision · sequence {candidate.revisionSequence} · {candidate.supportCount} formal support {candidate.supportCount === 1 ? "edge" : "edges"}
                    {candidate.interpretationAvailable ? " · interpretation available" : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {!hasCandidates && (
        <div className="empty">Finalize and formally ground a Claim or Synthesis revision, then link it to this question before recording an Answer.</div>
      )}
    </div>
  );
}

export function AnswerSnapshotCard({
  snapshot,
  compact = false,
}: {
  snapshot: ResearchQuestionAnswerSnapshot;
  compact?: boolean;
}) {
  const contextCount = snapshot.claimContexts.length + snapshot.synthesisContexts.length;
  return (
    <article className="item" data-testid="answer-snapshot">
      <div className="item-row">
        <div>
          <div className="item-title">Answer #{snapshot.sequence}</div>
          <div className="item-meta">
            Finalized {formatDate(snapshot.finalizedAt)} · {contextCount} exact {contextCount === 1 ? "context" : "contexts"}
          </div>
        </div>
        {!compact && <span className="status supported">Immutable snapshot</span>}
      </div>

      <div className="quote" style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{snapshot.answerText}</div>
      {snapshot.researcherNote && <p className="item-meta" style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>Researcher note: {snapshot.researcherNote}</p>}

      {snapshot.claimContexts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>Claim contexts</h4>
          <div className="item-list">
            {snapshot.claimContexts.map((context) => (
              <div className="item" key={context.claimRevisionId}>
                <div className="item-title">Claim revision <code>{shortId(context.claimRevisionId)}</code> · sequence {context.claimRevisionSequence}</div>
                {context.claimText && <div className="quote-inline" style={{ margin: "5px 0" }}>“{context.claimText}”</div>}
                <div className="item-meta">
                  Historical state: {context.claimRevisionState} · current revision: {context.isCurrentRevision ? "same exact revision" : "newer revision exists"} · support status: {context.supportStatus}
                </div>
                {context.driftFlags.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {context.driftFlags.map((flag) => <span className="status unsupported" key={flag}>{driftLabel(flag)}</span>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {snapshot.synthesisContexts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ margin: "0 0 8px", fontSize: 14 }}>Synthesis contexts</h4>
          <div className="item-list">
            {snapshot.synthesisContexts.map((context) => (
              <div className="item" key={context.synthesisRevisionId}>
                <div className="item-title">Synthesis revision <code>{shortId(context.synthesisRevisionId)}</code> · sequence {context.synthesisRevisionSequence}</div>
                {context.title && <div style={{ fontWeight: 600, marginTop: 5 }}>{context.title}</div>}
                {context.statementText && <div className="quote-inline" style={{ margin: "5px 0" }}>“{context.statementText}”</div>}
                <div className="item-meta">
                  Historical state: {context.synthesisRevisionState} · current revision: {context.isCurrentRevision ? "same exact revision" : "newer revision exists"} · support status: {context.supportStatus}
                </div>
                {context.driftFlags.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {context.driftFlags.map((flag) => <span className="status unsupported" key={flag}>{driftLabel(flag)}</span>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

export default async function ResearchQuestionAnswerPanel({
  projectId,
  questionId,
  isArchived,
}: {
  projectId: string;
  questionId: string;
  isArchived: boolean;
}) {
  const [candidates, projection] = await Promise.all([
    reviewServices.listResearchQuestionAnswerCandidates(projectId, questionId),
    reviewServices.getResearchQuestionAnswerProjection(projectId, questionId),
  ]);

  return (
    <section className="card section-card full" data-testid="answer-workspace" style={{ marginTop: 22 }}>
      <div className="section-heading">
        <div>
          <h2>Research Question Answers</h2>
          <p className="hint" style={{ margin: "4px 0 0" }}>
            Record researcher-authored Answer snapshots with exact Claim and Synthesis revision context. Contexts are historical analytical references only; they do not create support, citation, manuscript, ReviewFlow, or PRISMA edges.
          </p>
        </div>
        <span className="count">{projection.finalizedAnswerCount} finalized</span>
      </div>

      {!isArchived && (
        <form action={appendResearchQuestionAnswerAction} style={{ marginTop: 18 }}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="questionId" value={questionId} />
          <div className="field">
            <label htmlFor="answer-text">Researcher-authored Answer</label>
            <textarea id="answer-text" name="answerText" required placeholder="State the answer in your own words" />
          </div>
          <div className="field">
            <label htmlFor="answer-note">Researcher note <span className="hint">optional</span></label>
            <textarea id="answer-note" name="researcherNote" placeholder="Add drafting context for this Answer snapshot" />
          </div>
          <p className="hint" style={{ margin: "0 0 12px" }}>
            Select at least one current finalized, active, supported revision below. Candidate IDs are submitted exactly as shown and are never automatically replaced by a newer revision.
          </p>
          <CandidateList candidates={candidates} />
          <button className="button secondary" type="submit" style={{ marginTop: 16 }}>Finalize Answer snapshot</button>
        </form>
      )}

      {isArchived && <p className="hint" style={{ marginTop: 16 }}>This archived question is read-only. Existing Answer snapshots remain available below.</p>}

      <div style={{ marginTop: 22, borderTop: "1px solid var(--line)", paddingTop: 18 }}>
        <div className="section-heading">
          <h3 style={{ margin: 0, fontSize: 17 }}>Answer history</h3>
          <span className="count">Newest first</span>
        </div>
        {projection.history.length === 0 ? (
          <div className="empty">No finalized Answer snapshots recorded for this question.</div>
        ) : (
          <div className="item-list" style={{ marginTop: 12 }}>
            {projection.history.map((snapshot) => (
              <div key={snapshot.id}>
                <AnswerSnapshotCard snapshot={snapshot} compact />
                <div style={{ marginTop: 6, marginLeft: 8 }}>
                  <Link href={`/projects/${projectId}/research-questions/${questionId}/answers/${snapshot.id}`} className="button ghost">Open exact snapshot →</Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
