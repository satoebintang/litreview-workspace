"use client";

import Link from "next/link";
import { useState } from "react";
import { getResearchQuestionMatrixPageAction } from "@/app/actions/research-question-bounded";
import type {
  ResearchQuestionMatrixPage,
  ResearchQuestionMatrixPageOptions,
} from "@/application/research-question-bounded-read-types";
import type { TraceabilityFlagCode } from "@/domain/types";

const dimensions = [
  ["extraction", "Extraction"],
  ["evidenceSets", "Evidence Sets"],
  ["synthesis", "Synthesis"],
  ["claims", "Claims"],
] as const;

function flagLabel(code: TraceabilityFlagCode): string {
  return code.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function flagEntries(page: ResearchQuestionMatrixPage, rowIndex: number) {
  const row = page.rows[rowIndex]!;
  return dimensions.flatMap(([key, label]) => Object.entries(row.diagnostics[key])
    .filter((entry): entry is [TraceabilityFlagCode, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([code, count]) => ({ key, label, code, count })));
}

export default function ResearchQuestionMatrixBrowser({
  projectId,
  initialPage,
}: {
  projectId: string;
  initialPage: ResearchQuestionMatrixPage;
}) {
  const [page, setPage] = useState(initialPage);
  const [status, setStatus] = useState<NonNullable<ResearchQuestionMatrixPageOptions["status"]>>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(options: ResearchQuestionMatrixPageOptions) {
    setBusy(true);
    setError(null);
    const result = await getResearchQuestionMatrixPageAction(projectId, { pageSize: page.pageSize, ...options });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPage(result.value);
  }

  async function changeStatus(next: typeof status) {
    setStatus(next);
    await load({ status: next });
  }

  return (
    <>
      <section className="card section-card full">
        <div className="section-heading">
          <h2>Traceability Matrix</h2>
          <span className="count">{page.questionCounts.active} active · {page.questionCounts.archived} archived</span>
        </div>
        <p className="hint" style={{ marginBottom: 16 }}>
          Bounded live pages ordered by question order. Counts and ordering can change between requests. Traceability is planning history; it does not alter formal provenance or PRISMA reporting.
        </p>
        <div className="inline-form" style={{ marginBottom: 16 }}>
          <label htmlFor="question-status-filter">Show</label>
          <select id="question-status-filter" value={status} disabled={busy} onChange={(event) => void changeStatus(event.target.value as typeof status)}>
            <option value="all">All questions</option>
            <option value="active">Active questions</option>
            <option value="archived">Archived questions</option>
          </select>
          <button className="button ghost" type="button" disabled={busy} onClick={() => void load({ status })}>Refresh first page</button>
        </div>
        {error && <div className="error-banner" role="alert">{error} <button className="button ghost" type="button" onClick={() => void load({ status })}>Refresh</button></div>}
        {page.rows.length === 0 ? (
          <div className="empty">
            No research questions in this view. <Link href={`/projects/${projectId}/protocol`} style={{ color: "var(--forest)", fontWeight: 700 }}>Define research questions in Protocol →</Link>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: 13 }}>
              <thead><tr style={{ borderBottom: "2px solid var(--line)", background: "#f7faf8" }}>
                <th style={{ padding: "12px 14px" }}>Question</th><th style={{ padding: "12px 14px" }}>Status</th>
                <th style={{ padding: "12px 14px" }}>Extraction Fields</th><th style={{ padding: "12px 14px" }}>Evidence Sets</th>
                <th style={{ padding: "12px 14px" }}>Synthesis Statements</th><th style={{ padding: "12px 14px" }}>Claims &amp; Manuscript</th>
                <th style={{ padding: "12px 14px" }}>Answers</th><th style={{ padding: "12px 14px" }}>Diagnostic Flags</th>
                <th style={{ padding: "12px 14px", textAlign: "right" }}>Actions</th>
              </tr></thead>
              <tbody>
                {page.rows.map((row, index) => {
                  const question = row.question;
                  const flags = flagEntries(page, index);
                  const counts = row.counts;
                  return <tr key={question.id} style={{ borderBottom: "1px solid var(--line)", opacity: question.archivedAt ? 0.75 : 1 }}>
                    <td style={{ padding: 14, verticalAlign: "top" }}>
                      <strong>{question.identifier}</strong><div style={{ maxWidth: 280, marginTop: 3 }}>{question.label}</div>
                      <div className="hint" style={{ marginTop: 3 }}>Order: {question.sortOrder + 1}</div>
                    </td>
                    <td style={{ padding: 14, verticalAlign: "top", whiteSpace: "nowrap" }}><span className={`status ${question.archivedAt ? "withdrawn" : "supported"}`}>{question.archivedAt ? "Archived" : "Active"}</span></td>
                    <td style={{ padding: 14, verticalAlign: "top", whiteSpace: "nowrap" }}><strong>{counts.linkedExtractionFields}</strong> linked</td>
                    <td style={{ padding: 14, verticalAlign: "top", whiteSpace: "nowrap" }}><strong>{counts.linkedEvidenceSets}</strong> linked</td>
                    <td style={{ padding: 14, verticalAlign: "top", whiteSpace: "nowrap" }}><strong>{counts.linkedSynthesisStatements}</strong> linked<div className="hint">{counts.activeSynthesisStatements} active · {counts.interpretations} interpreted</div></td>
                    <td style={{ padding: 14, verticalAlign: "top", whiteSpace: "nowrap" }}><strong>{counts.linkedClaims}</strong> linked<div className="hint">{counts.activeClaims} active · {counts.currentManuscriptPlacements} placed</div></td>
                    <td style={{ padding: 14, verticalAlign: "top", whiteSpace: "nowrap" }}>
                      <div><strong>{counts.finalizedAnswers}</strong> finalized</div>
                      <div className="hint">{counts.claimAnswerContexts} Claim · {counts.synthesisAnswerContexts} Synthesis contexts</div>
                      <div className="hint">Latest seq {counts.latestAnswerSequence ?? "—"} · {counts.driftedAnswerContexts} derived drift</div>
                    </td>
                    <td style={{ padding: 14, verticalAlign: "top" }}>
                      {row.diagnostics.fullyCovered ? <span className="status supported">● Fully Covered</span> : <div style={{ display: "grid", gap: 4 }}>
                        {flags.map((flag) => <span className="status unsupported" key={`${flag.key}-${flag.code}`}>{flag.label}: {flagLabel(flag.code)} ({flag.count})</span>)}
                      </div>}
                    </td>
                    <td style={{ padding: 14, verticalAlign: "top", textAlign: "right", whiteSpace: "nowrap" }}><Link className="button ghost" href={`/projects/${projectId}/research-questions/${question.id}`}>Open workspace →</Link></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="inline-form" style={{ justifyContent: "space-between", marginTop: 16 }}>
          <span className="hint">Showing {page.rows.length} questions on this page · counts reflect the current request.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button secondary" type="button" disabled={busy || !page.hasMore} onClick={() => void load({ status, cursor: page.nextCursor })}>Next page</button>
          </div>
        </div>
      </section>
    </>
  );
}
