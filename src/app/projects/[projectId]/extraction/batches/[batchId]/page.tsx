import Link from "next/link";
import { notFound } from "next/navigation";
import { cancelAiExtractionBatchAction, processAiExtractionBatchAction } from "@/app/actions";
import { aiExtractionBatchServices } from "@/app/server";
import type { BatchItemState } from "@/application/ai-extraction-batch-services";

export default async function ExtractionBatchDetailPage({ params, searchParams }: { params: Promise<{ projectId: string; batchId: string }>; searchParams?: Promise<{ page?: string; paperId?: string; fieldId?: string; state?: string }> }) {
  const { projectId, batchId } = await params;
  const query = searchParams ? await searchParams : {};
  const allowedStates: BatchItemState[] = ["pending", "request_ready", "running", "suggestion_ready", "accepted", "rejected", "no_candidate", "failed", "outcome_unknown", "stale", "blocked", "ineligible", "cancelled"];
  const state = query.state && allowedStates.includes(query.state as BatchItemState) ? query.state as BatchItemState : undefined;
  const requestedPage = Number(query.page ?? "1");
  const batch = await aiExtractionBatchServices.getAiExtractionBatch(batchId, projectId, { page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1, pageSize: 50, paperId: query.paperId, fieldId: query.fieldId, state });
  if (!batch) notFound();
  const href = (page: number) => {
    const params = new URLSearchParams({ page: String(page) });
    if (query.paperId) params.set("paperId", query.paperId);
    if (query.fieldId) params.set("fieldId", query.fieldId);
    if (state) params.set("state", state);
    return `/projects/${projectId}/extraction/batches/${batch.batchId}?${params.toString()}`;
  };
  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/extraction/batches`}>← AI extraction batches</Link>
      <div className="workspace-header"><div><p className="eyebrow">Immutable batch manifest</p><h1>Batch {batch.batchId}</h1><p>{batch.items.length} cells · {batch.configuredModel} · {batch.state}</p></div><div style={{ display: "flex", gap: 8 }}>{batch.state === "active" && <form action={processAiExtractionBatchAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="batchId" value={batch.batchId} /><button className="button" type="submit">Process next two</button></form>}{batch.state === "active" && <form action={cancelAiExtractionBatchAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="batchId" value={batch.batchId} /><button className="button ghost" type="submit">Cancel batch</button></form>}</div></div>
      <section className="card section-card"><p className="hint">Batch execution links exact Slice 26 requests and dispatches. It never accepts suggestions or creates ExtractionRevisions.</p><div className="item-meta">{batch.totalItems} cells · {batch.matchingItems} matching this view · results {batch.usage.resultCount} · successful {batch.usage.successCount} · failed {batch.usage.failureCount} · {batch.usage.inputTokens + batch.usage.outputTokens} tokens · {batch.usage.durationMs} ms</div><form method="get" className="inline-form" style={{ marginTop: 14 }}><input name="paperId" placeholder="Filter Paper UUID" defaultValue={query.paperId ?? ""} /><input name="fieldId" placeholder="Filter field UUID" defaultValue={query.fieldId ?? ""} /><select name="state" defaultValue={state ?? ""}><option value="">All states</option>{allowedStates.map((value) => <option key={value} value={value}>{value}</option>)}</select><button className="button ghost" type="submit">Filter</button></form><div className="item-list">{batch.items.length === 0 ? <div className="empty">No batch items match these filters.</div> : batch.items.map((item) => <article className="item" key={item.itemId}><div className="item-row"><div><div className="item-title">{item.ordinal}. {item.paperTitle} · {item.fieldName}</div><div className="item-meta">Initial: {item.initialDisposition} · {item.initialReasonCode}{item.requestId ? ` · request ${item.requestId}` : ""}</div></div><span className={`status ${["accepted", "suggestion_ready"].includes(item.state) ? "supported" : item.state === "blocked" || item.state === "stale" ? "unsupported" : "screening-maybe"}`}>{item.state}</span></div>{item.initialReasonCode === "existing_cleared_revision" && <p className="hint" role="status">Existing cleared revision. <Link href={`/projects/${projectId}/extraction/${item.paperId}`}>Continue in the individual extraction workflow.</Link></p>}{item.requestId && <Link className="button ghost" href={`/projects/${projectId}/extraction/${item.paperId}/suggestions/${item.requestId}`}>Review Slice 26 suggestion →</Link>}</article>)}</div><div style={{ display: "flex", gap: 8, marginTop: 16 }}>{batch.page > 1 && <Link className="button ghost" href={href(batch.page - 1)}>Previous 50</Link>}{batch.hasNextPage && <Link className="button ghost" href={href(batch.page + 1)}>Next 50</Link>}</div></section>
    </div></main>;
}
