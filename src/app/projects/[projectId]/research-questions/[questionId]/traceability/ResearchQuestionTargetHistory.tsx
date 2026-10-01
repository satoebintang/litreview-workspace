"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getResearchQuestionTargetDetailPageAction } from "@/app/actions/research-question-bounded";
import type {
  ResearchQuestionTraceabilityHistoryEvent,
  ResearchQuestionTraceabilityTargetDetail,
  ResearchQuestionTraceabilityTargetType,
} from "@/application/research-question-bounded-read-types";

export default function ResearchQuestionTargetHistory({
  projectId,
  questionId,
  targetType,
  targetId,
  initialDetail,
}: {
  projectId: string;
  questionId: string;
  targetType: ResearchQuestionTraceabilityTargetType;
  targetId: string;
  initialDetail: ResearchQuestionTraceabilityTargetDetail;
}) {
  const router = useRouter();
  const [history, setHistory] = useState(initialDetail.history);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHistory(initialDetail.history);
    setError(null);
  }, [initialDetail]);

  async function load(cursor?: string | null) {
    setBusy(true);
    setError(null);
    const result = await getResearchQuestionTargetDetailPageAction(projectId, questionId, targetType, targetId, { pageSize: 20, cursor });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setHistory(result.value.history);
  }

  function refresh() { router.refresh(); }

  const rows = history.items as ResearchQuestionTraceabilityHistoryEvent[];
  return <section className="card section-card full" style={{ marginTop: 18 }}>
    <div className="section-heading"><h2>Event History</h2><span className="count">Oldest first · {rows.length} events on this page</span></div>
    {rows.length === 0 ? <div className="empty">No traceability events were recorded for this Question and target.</div> : <div className="item-list">
      {rows.map((event) => <article className="item" key={event.id}>
        <div className="item-row"><div className="item-title" style={{ textTransform: "capitalize" }}>{event.action}</div><span className={`status ${event.action === "linked" ? "supported" : "withdrawn"}`}>Sequence {event.sequence}</span></div>
        <div className="item-meta">{new Date(event.createdAt).toLocaleString()} · <code>{event.id}</code></div>
        {event.note && <div className="quote-inline" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>Note: {event.note}</div>}
      </article>)}
    </div>}
    {error && <div className="curation-warning-box" role="alert">{error} A traceability event changed this Question&apos;s cursor epoch. Refresh the exact target to start a new history traversal.</div>}
    <div className="inline-form" style={{ justifyContent: "space-between", marginTop: 12 }}>
      <span className="hint">History is bounded to 20 events here, up to 25 per page. Notes show the complete stored event note.</span>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="button ghost" type="button" disabled={busy} onClick={refresh}>Refresh exact target</button>
        <button className="button secondary" type="button" disabled={busy || !history.hasMore} onClick={() => void load(history.nextCursor)}>Next events</button>
      </div>
    </div>
  </section>;
}
