"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { finalizeResearchQuestionAnswerBoundedAction, listResearchQuestionAnswerCandidatePageAction, listResearchQuestionAnswerHistoryPageAction } from "@/app/actions/research-question-bounded";
import type {
  ResearchQuestionAnswerBoundedCandidate,
  ResearchQuestionAnswerBoundedCandidateType,
  ResearchQuestionAnswerCandidatePage,
  ResearchQuestionAnswerHistoryPage,
  ResearchQuestionAnswerHistoryItem,
  ResearchQuestionWorkspaceSummary,
} from "@/application/research-question-bounded-read-types";
import type { ResearchQuestionAnswerContextDriftFlag } from "@/domain/types";

type SelectedContext = {
  targetType: ResearchQuestionAnswerBoundedCandidateType;
  targetId: string;
  revisionId: string;
  revisionSequence: string;
  label: string;
};

type SnapshotCardValue = {
  id: string;
  sequence: string | number;
  answerText: string;
  researcherNote: string | null;
  finalizedAt: Date;
  claimContexts: Array<{
    claimRevisionId: string;
    claimRevisionSequence: string | number;
    claimText: string | null;
    claimRevisionState: string;
    isCurrentRevision: boolean;
    supportStatus: string;
    driftFlags: ResearchQuestionAnswerContextDriftFlag[];
  }>;
  synthesisContexts: Array<{
    synthesisRevisionId: string;
    synthesisRevisionSequence: string | number;
    title: string | null;
    statementText: string | null;
    synthesisRevisionState: string;
    isCurrentRevision: boolean;
    supportStatus: string;
    driftFlags: ResearchQuestionAnswerContextDriftFlag[];
  }>;
};

const candidateTypes: ResearchQuestionAnswerBoundedCandidateType[] = ["claim", "synthesis"];

function shortId(value: string) { return value.slice(0, 8); }
function formatDate(value: Date) { return new Date(value).toLocaleString(); }
function humanize(value: string) { return value.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" "); }

function driftLabel(flag: ResearchQuestionAnswerContextDriftFlag): string {
  switch (flag) {
    case "referenced_claim_revision_superseded": return "Claim revision superseded";
    case "referenced_claim_now_withdrawn": return "Claim now withdrawn";
    case "referenced_claim_no_longer_linked_to_rq": return "Claim no longer linked to this RQ";
    case "referenced_synthesis_revision_superseded": return "Synthesis revision superseded";
    case "referenced_synthesis_now_withdrawn": return "Synthesis statement now withdrawn";
    case "referenced_synthesis_no_longer_linked_to_rq": return "Synthesis statement no longer linked to this RQ";
  }
}

export function AnswerSnapshotCard({ snapshot, compact = false }: { snapshot: SnapshotCardValue; compact?: boolean }) {
  const contextCount = snapshot.claimContexts.length + snapshot.synthesisContexts.length;
  return <article className="item" data-testid="answer-snapshot">
    <div className="item-row"><div><div className="item-title">Answer #{snapshot.sequence}</div><div className="item-meta">Finalized {formatDate(snapshot.finalizedAt)} · {contextCount} exact {contextCount === 1 ? "context" : "contexts"}</div></div>{!compact && <span className="status supported">Immutable snapshot</span>}</div>
    <div className="quote" style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{snapshot.answerText}</div>
    {snapshot.researcherNote && <p className="item-meta" style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>Researcher note: {snapshot.researcherNote}</p>}
    {snapshot.claimContexts.length > 0 && <div style={{ marginTop: 16 }}><h4 style={{ margin: "0 0 8px", fontSize: 14 }}>Claim contexts</h4><div className="item-list">
      {snapshot.claimContexts.map((context) => <div className="item" key={context.claimRevisionId}>
        <div className="item-title">Claim revision <code>{shortId(context.claimRevisionId)}</code> · sequence {context.claimRevisionSequence}</div>
        {context.claimText && <div className="quote-inline" style={{ margin: "5px 0" }}>“{context.claimText}”</div>}
        <div className="item-meta">Historical state: {context.claimRevisionState} · current revision: {context.isCurrentRevision ? "same exact revision" : "newer revision exists"} · support status: {context.supportStatus}</div>
        {context.driftFlags.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>{context.driftFlags.map((flag) => <span className="status unsupported" key={flag}>{driftLabel(flag)}</span>)}</div>}
      </div>)}
    </div></div>}
    {snapshot.synthesisContexts.length > 0 && <div style={{ marginTop: 16 }}><h4 style={{ margin: "0 0 8px", fontSize: 14 }}>Synthesis contexts</h4><div className="item-list">
      {snapshot.synthesisContexts.map((context) => <div className="item" key={context.synthesisRevisionId}>
        <div className="item-title">Synthesis revision <code>{shortId(context.synthesisRevisionId)}</code> · sequence {context.synthesisRevisionSequence}</div>
        {context.title && <div style={{ fontWeight: 600, marginTop: 5 }}>{context.title}</div>}
        {context.statementText && <div className="quote-inline" style={{ margin: "5px 0" }}>“{context.statementText}”</div>}
        <div className="item-meta">Historical state: {context.synthesisRevisionState} · current revision: {context.isCurrentRevision ? "same exact revision" : "newer revision exists"} · support status: {context.supportStatus}</div>
        {context.driftFlags.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>{context.driftFlags.map((flag) => <span className="status unsupported" key={flag}>{driftLabel(flag)}</span>)}</div>}
      </div>)}
    </div></div>}
  </article>;
}

function selectedKey(type: ResearchQuestionAnswerBoundedCandidateType, revisionId: string) { return `${type}:${revisionId}`; }

export default function ResearchQuestionAnswerPanel({
  projectId,
  questionId,
  isArchived,
  initialSummary,
  initialHistory,
}: {
  projectId: string;
  questionId: string;
  isArchived: boolean;
  initialSummary: ResearchQuestionWorkspaceSummary["answerSummary"];
  initialHistory: ResearchQuestionAnswerHistoryPage;
}) {
  const router = useRouter();
  const [history, setHistory] = useState<ResearchQuestionAnswerHistoryPage>(initialHistory);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [candidatePages, setCandidatePages] = useState<Partial<Record<ResearchQuestionAnswerBoundedCandidateType, ResearchQuestionAnswerCandidatePage>>>({});
  const [opened, setOpened] = useState<ResearchQuestionAnswerBoundedCandidateType[]>([]);
  const [candidateSearch, setCandidateSearch] = useState<Record<ResearchQuestionAnswerBoundedCandidateType, string>>({ claim: "", synthesis: "" });
  const [appliedCandidateSearch, setAppliedCandidateSearch] = useState<Record<ResearchQuestionAnswerBoundedCandidateType, string>>({ claim: "", synthesis: "" });
  const [candidateBusy, setCandidateBusy] = useState<Partial<Record<ResearchQuestionAnswerBoundedCandidateType, boolean>>>({});
  const [candidateErrors, setCandidateErrors] = useState<Partial<Record<ResearchQuestionAnswerBoundedCandidateType, string>>>({});
  const [selected, setSelected] = useState<Record<ResearchQuestionAnswerBoundedCandidateType, Record<string, SelectedContext>>>({ claim: {}, synthesis: {} });
  const [answerText, setAnswerText] = useState("");
  const [researcherNote, setResearcherNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ code: string; message: string } | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  useEffect(() => setHistory(initialHistory), [initialHistory]);

  async function loadCandidates(type: ResearchQuestionAnswerBoundedCandidateType, cursor?: string | null, search = candidateSearch[type]) {
    setCandidateBusy((current) => ({ ...current, [type]: true }));
    setCandidateErrors((current) => ({ ...current, [type]: undefined }));
    const result = await listResearchQuestionAnswerCandidatePageAction(projectId, questionId, type, { pageSize: 25, cursor, search });
    setCandidateBusy((current) => ({ ...current, [type]: false }));
    if (!result.ok) {
      setCandidateErrors((current) => ({ ...current, [type]: result.message }));
      return;
    }
    setCandidatePages((current) => ({ ...current, [type]: result.value }));
    setAppliedCandidateSearch((current) => ({ ...current, [type]: search }));
  }

  async function openCandidates(type: ResearchQuestionAnswerBoundedCandidateType) {
    setOpened((current) => current.includes(type) ? current : [...current, type]);
    if (!candidatePages[type]) await loadCandidates(type, null, "");
  }

  async function loadHistory(cursor?: string | null) {
    setHistoryBusy(true);
    setHistoryError(null);
    const result = await listResearchQuestionAnswerHistoryPageAction(projectId, questionId, { pageSize: 10, cursor });
    setHistoryBusy(false);
    if (!result.ok) {
      setHistoryError(result.message);
      return;
    }
    setHistory(result.value);
  }

  function toggleCandidate(candidate: ResearchQuestionAnswerBoundedCandidate) {
    if (!candidate.revisionId || !candidate.isSelectable) return;
    const type = candidate.targetType;
    const revisionId = candidate.revisionId;
    const key = selectedKey(type, revisionId);
    if (!selected[type][key] && Object.keys(selected[type]).length >= 100) {
      setSelectionError(`At most 100 ${type === "claim" ? "Claim" : "Synthesis"} contexts can be selected.`);
      return;
    }
    setSelectionError(null);
    setSelected((current) => {
      const byType = { ...current[type] };
      if (byType[key]) delete byType[key];
      else byType[key] = { targetType: type, targetId: candidate.targetId, revisionId, revisionSequence: candidate.revisionSequence ?? "", label: candidate.label };
      return { ...current, [type]: byType };
    });
  }

  function removeSelected(context: SelectedContext) {
    const key = selectedKey(context.targetType, context.revisionId);
    setSelected((current) => {
      const byType = { ...current[context.targetType] };
      delete byType[key];
      return { ...current, [context.targetType]: byType };
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    setSelectionError(null);
    const claimRevisionIds = Object.values(selected.claim).map((context) => context.revisionId);
    const synthesisRevisionIds = Object.values(selected.synthesis).map((context) => context.revisionId);
    if (claimRevisionIds.length + synthesisRevisionIds.length === 0) {
      setSelectionError("Select at least one exact current Claim or Synthesis revision before finalizing.");
      return;
    }
    setSubmitting(true);
    const result = await finalizeResearchQuestionAnswerBoundedAction({ projectId, questionId, answerText, researcherNote, claimRevisionIds, synthesisRevisionIds });
    setSubmitting(false);
    if (result.ok) {
      router.push(`/projects/${projectId}/research-questions/${questionId}/answers/${result.answerId}?saved=answer`);
      return;
    }
    setSubmitError({ code: result.code, message: result.message });
    // Refresh the visible latest candidates without changing the exact IDs held
    // in the review/remove state. A newer revision is always a separate choice.
    await Promise.all(opened.map((type) => loadCandidates(type, null, appliedCandidateSearch[type])));
  }

  const selectedItems = candidateTypes.flatMap((type) => Object.values(selected[type]));

  function candidateSection(type: ResearchQuestionAnswerBoundedCandidateType) {
    const page = candidatePages[type];
    const title = type === "claim" ? "Claim contexts" : "Synthesis contexts";
    const browseLabel = type === "claim" ? "Browse Claim candidates" : "Browse Synthesis candidates";
    const searchLength = Array.from(candidateSearch[type].trim()).length;
    return <section key={type} style={{ marginTop: 14 }}>
      <div className="section-heading"><h3 style={{ fontSize: 15, margin: 0 }}>{title}</h3><span className="count">{Object.keys(selected[type]).length} selected · max 100</span></div>
      {!opened.includes(type) ? <button className="button secondary" type="button" onClick={() => void openCandidates(type)}>{browseLabel}</button> : <>
        <div className="inline-form" style={{ flexWrap: "wrap", marginBottom: 10 }}>
          <label htmlFor={`answer-${type}-search`}>Search {type} labels</label>
          <input id={`answer-${type}-search`} value={candidateSearch[type]} maxLength={400} onChange={(event) => setCandidateSearch((current) => ({ ...current, [type]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (searchLength <= 200) void loadCandidates(type, null, candidateSearch[type]); } }} placeholder="Literal substring" />
          <button className="button ghost" type="button" disabled={candidateBusy[type] || searchLength > 200} onClick={() => void loadCandidates(type, null, candidateSearch[type])}>Search</button>
          <span className="hint">{searchLength}/200 Unicode code points</span>
        </div>
        {candidateErrors[type] && <div className="curation-warning-box" role="alert">{candidateErrors[type]} <button className="button ghost" type="button" disabled={candidateBusy[type]} onClick={() => void loadCandidates(type, null, candidateSearch[type])}>Refresh {type} candidates</button></div>}
        {page && page.items.length === 0 && <p className="hint">No currently linked {type} targets match this search.</p>}
        {page && page.items.length > 0 && <div className="item-list">
          {page.items.map((candidate) => {
            const revisionId = candidate.revisionId;
            const key = revisionId ? selectedKey(type, revisionId) : "";
            const checked = Boolean(key && selected[type][key]);
            const disabled = !candidate.isSelectable || !revisionId || (!checked && Object.keys(selected[type]).length >= 100);
            const reason = candidate.reason ? humanize(candidate.reason) : null;
            return <label className="item" key={candidate.targetId} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: disabled ? "default" : "pointer" }}>
              <input type="checkbox" data-testid="answer-candidate-checkbox" data-revision-id={revisionId ?? ""} checked={checked} disabled={disabled} onChange={() => toggleCandidate(candidate)} style={{ marginTop: 4 }} />
              <span>
                <span className="item-title">{type === "claim" ? "Claim" : "Synthesis statement"} <code>{shortId(candidate.targetId)}</code> · {candidate.label}</span>
                <span className="item-meta">{revisionId ? `Current finalized revision · sequence ${candidate.revisionSequence}` : "No finalized revision"} · {candidate.supportCount} formal support edge{candidate.supportCount === 1 ? "" : "s"}{candidate.interpretationAvailable ? " · interpretation available" : ""}</span>
                {!candidate.isSelectable && <span className="item-meta" role="status">Currently linked but not selectable: {reason ?? "ineligible"}. This row remains visible; an existing Answer selection is not replaced.</span>}
              </span>
            </label>;
          })}
        </div>}
        {page && <div className="inline-form" style={{ justifyContent: "space-between", marginTop: 10 }}>
          <span className="hint">Candidate membership is the set of currently linked stable targets. Eligibility is shown per row and revalidated by the writer.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button ghost" type="button" disabled={candidateBusy[type]} onClick={() => void loadCandidates(type, null, candidateSearch[type])}>Refresh {type}</button>
            <button className="button secondary" type="button" disabled={candidateBusy[type] || !page.hasMore} onClick={() => void loadCandidates(type, page.nextCursor, appliedCandidateSearch[type])}>Next {type}</button>
          </div>
        </div>}
      </>}
    </section>;
  }

  return <section className="card section-card full" data-testid="answer-workspace" style={{ marginTop: 22 }}>
    <div className="section-heading"><div><h2>Research Question Answers</h2><p className="hint" style={{ margin: "4px 0 0" }}>Record researcher-authored immutable snapshots with exact Claim and Synthesis revision context. These contexts do not create support, citation, manuscript, ReviewFlow, or PRISMA edges.</p></div><span className="count">{initialSummary.finalizedAnswerCount} finalized</span></div>
    {!isArchived && <form onSubmit={(event) => void submit(event)} style={{ marginTop: 18 }}>
      <input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="questionId" value={questionId} />
      {Object.values(selected.claim).map((context) => <input key={context.revisionId} type="hidden" name="claimRevisionIds" value={context.revisionId} />)}
      {Object.values(selected.synthesis).map((context) => <input key={context.revisionId} type="hidden" name="synthesisRevisionIds" value={context.revisionId} />)}
      <div className="field"><label htmlFor="answer-text">Researcher-authored Answer</label><textarea id="answer-text" name="answerText" required value={answerText} onChange={(event) => setAnswerText(event.target.value)} placeholder="State the answer in your own words" /></div>
      <div className="field"><label htmlFor="answer-note">Researcher note <span className="hint">optional</span></label><textarea id="answer-note" name="researcherNote" value={researcherNote} onChange={(event) => setResearcherNote(event.target.value)} placeholder="Add drafting context for this Answer snapshot" /></div>
      <p className="hint" style={{ margin: "0 0 12px" }}>Select exact current finalized, active, supported revisions below. Your selection survives candidate paging and search; a later revision is shown separately and never replaces the selected ID.</p>
      {candidateTypes.map(candidateSection)}
      {selectionError && <div className="curation-warning-box" role="alert">{selectionError}</div>}
      {submitError && <div className="error-banner" role="alert"><strong>{submitError.code}:</strong> {submitError.message} Your Answer text and exact selected IDs remain in the review/remove list. Current candidates have been refreshed separately; review and choose a newer revision explicitly if appropriate.</div>}
      <section className="card section-card" aria-labelledby="selected-context-heading" style={{ marginTop: 18 }}>
        <div className="section-heading"><h3 id="selected-context-heading">Selected exact contexts</h3><span className="count">{Object.keys(selected.claim).length} Claim · {Object.keys(selected.synthesis).length} Synthesis</span></div>
        {selectedItems.length === 0 ? <p className="hint">No contexts selected yet.</p> : <div className="item-list">
          {selectedItems.map((context) => <div className="item" key={`${context.targetType}:${context.revisionId}`}>
            <div className="item-row"><div><div className="item-title">{context.targetType === "claim" ? "Claim" : "Synthesis"} · {context.label}</div><div className="item-meta">Exact revision <code>{context.revisionId}</code> · sequence {context.revisionSequence || "unknown"} · target <code>{context.targetId}</code></div></div><button className="button ghost danger" type="button" onClick={() => removeSelected(context)}>Remove</button></div>
          </div>)}
        </div>}
      </section>
      <button className="button secondary" type="submit" disabled={submitting} style={{ marginTop: 16 }}>{submitting ? "Finalizing…" : "Finalize Answer snapshot"}</button>
    </form>}
    {isArchived && <p className="hint" style={{ marginTop: 16 }}>This archived question is read-only. Existing Answer snapshots remain available below.</p>}
    <div style={{ marginTop: 22, borderTop: "1px solid var(--line)", paddingTop: 18 }}>
      <div className="section-heading"><h3 style={{ margin: 0, fontSize: 17 }}>Answer history</h3><span className="count">Newest first · {history.totalCount} finalized</span></div>
      <p className="hint">History shows bounded summaries only. An Answer may commit late after reserving a sequence, so a continuation can include a late commit below the captured high-water. Refresh starts a new traversal; drift is live on each request.</p>
      {history.items.length === 0 ? <div className="empty">No finalized Answer snapshots recorded for this question.</div> : <div className="item-list" style={{ marginTop: 12 }}>
        {history.items.map((answer: ResearchQuestionAnswerHistoryItem) => <article className="item" key={answer.id} data-testid="answer-history-row">
          <div className="item-row"><div><div className="item-title">Answer #{answer.sequence}</div><div className="item-meta">Finalized {formatDate(answer.finalizedAt)} · {answer.claimContextCount} Claim · {answer.synthesisContextCount} Synthesis contexts · {answer.driftedContextCount} currently drifted</div></div><Link href={`/projects/${projectId}/research-questions/${questionId}/answers/${answer.id}`} className="button ghost">Open exact snapshot →</Link></div>
          <div className="quote-inline" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{answer.textPreview}</div>
        </article>)}
      </div>}
      {historyError && <div className="curation-warning-box" role="alert">{historyError} Refresh to start a new Answer history traversal. <button className="button ghost" type="button" onClick={() => void loadHistory(null)}>Refresh Answer history</button></div>}
      <div className="inline-form" style={{ justifyContent: "space-between", marginTop: 12 }}><span className="hint">Showing {history.items.length} summaries · page size {history.pageSize} · high-water sequence {history.highWaterSequence}</span><div style={{ display: "flex", gap: 8 }}><button className="button ghost" type="button" disabled={historyBusy} onClick={() => void loadHistory(null)}>Refresh</button><button className="button secondary" type="button" disabled={historyBusy || !history.hasMore} onClick={() => void loadHistory(history.nextCursor)}>Next Answers</button></div></div>
    </div>
  </section>;
}
