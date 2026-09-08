import Link from "next/link";
import { notFound } from "next/navigation";
import {
  confirmSameWorkAction,
  confirmSameWorkAndResolveAction,
  correctDifferentWorkAndResolveAction,
  decideDifferentWorkAction,
} from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

type Pair = {
  leftRetrievedRecord: { id: string; title: string; authors: string[]; abstract: string | null; doi: string | null; sourceRecordId: string | null; publicationYear: number | null };
  rightRetrievedRecord: { id: string; title: string; authors: string[]; abstract: string | null; doi: string | null; sourceRecordId: string | null; publicationYear: number | null };
  reasons: string[];
  strength: "strong" | "possible" | null;
  decision: "same_work" | "different_work" | null;
  decisionNote: string | null;
  leftPaperId: string | null;
  rightPaperId: string | null;
};
type Paper = { id: string; title: string; publicationYear: number | null };
type Decision = { id: string; sequence: number; decision: string; note: string | null; createdAt: Date };

const reasonLabels: Record<string, string> = {
  normalized_doi: "normalized DOI",
  same_source_record_id: "same source record ID",
  normalized_title_year: "normalized title + year",
};

export default async function DeduplicationPairPage({ params, searchParams }: {
  params: Promise<{ projectId: string; leftRecordId: string; rightRecordId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, leftRecordId, rightRecordId } = await params;
  const query = searchParams ? await searchParams : {};
  let pair: Pair;
  try { pair = await reviewServices.getDeduplicationPair(projectId, leftRecordId, rightRecordId) as Pair; }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  const [project, history, papers] = await Promise.all([
    reviewServices.getProject(projectId),
    reviewServices.listDeduplicationHistory(projectId, leftRecordId, rightRecordId),
    reviewServices.listPapers(projectId),
  ]) as unknown as [{ title: string }, Decision[], Paper[]];
  const left = pair.leftRetrievedRecord;
  const right = pair.rightRetrievedRecord;
  const samePaper = pair.leftPaperId && pair.leftPaperId === pair.rightPaperId ? pair.leftPaperId : null;
  const distinctPapers = Boolean(pair.leftPaperId && pair.rightPaperId && pair.leftPaperId !== pair.rightPaperId);
  const targetPaperId = pair.leftPaperId ?? pair.rightPaperId;
  const pairFields = <><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="leftRecordId" value={left.id} /><input type="hidden" name="rightRecordId" value={right.id} /></>;

  return <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
    <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/deduplication`}>← Deduplication queue</Link>
      <div className="workspace-header"><div><p className="eyebrow">Pair inspection · {project.title}</p><h1>Candidate records</h1><p>Inspect the evidence, then record an explicit equivalence decision.</p></div><Link className="button secondary" href={`/projects/${projectId}/review-flow`}>Review flow →</Link></div>
      {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved && <div className="success-note" role="status">Deduplication decision recorded.</div>}
      {distinctPapers && <div className="error-banner" role="alert">These records currently resolve to different canonical Papers. Same-work confirmation is blocked; Paper merging is not part of this slice.</div>}
      {pair.decision === "same_work" && <div className="success-note" role="status">{samePaper ? "Same-work adjudicated and canonically resolved." : "Same-work adjudicated; canonical resolution is incomplete."}</div>}
      <section className="card section-card full"><div className="section-heading"><h2>Candidate evidence</h2><span className={`status ${pair.strength === "strong" ? "supported" : "unsupported"}`}>{pair.strength ?? "adjudicated"}{pair.reasons.length ? ` · ${pair.reasons.map((r) => reasonLabels[r] ?? r).join(" · ")}` : ""}</span></div>
        <div className="workspace-grid"><article className="nested-support"><div className="item-meta">Record A</div><h3>{left.title}</h3><div className="item-meta">{left.authors.join(", ") || "Author details not captured"}{left.publicationYear ? ` · ${left.publicationYear}` : ""}</div>{left.doi && <div className="item-meta">DOI: {left.doi}</div>}{left.sourceRecordId && <div className="item-meta">Source ID: {left.sourceRecordId}</div>}{left.abstract && <p className="abstract-text">{left.abstract}</p>}<div className="item-meta">{pair.leftPaperId ? `Current Paper: ${pair.leftPaperId}` : "Unmatched"}</div></article><article className="nested-support"><div className="item-meta">Record B</div><h3>{right.title}</h3><div className="item-meta">{right.authors.join(", ") || "Author details not captured"}{right.publicationYear ? ` · ${right.publicationYear}` : ""}</div>{right.doi && <div className="item-meta">DOI: {right.doi}</div>}{right.sourceRecordId && <div className="item-meta">Source ID: {right.sourceRecordId}</div>}{right.abstract && <p className="abstract-text">{right.abstract}</p>}<div className="item-meta">{pair.rightPaperId ? `Current Paper: ${pair.rightPaperId}` : "Unmatched"}</div></article></div>
      </section>
      <div className="workspace-grid">
        <section className="card section-card"><div className="section-heading"><h2>Record decision</h2><span className="count">{pair.decision ?? "unreviewed"}</span></div><p className="hint">A decision is append-only. Notes belong to this decision event and can be corrected by recording a new event.</p>
          <form action={confirmSameWorkAction}><>{pairFields}</><div className="field"><label htmlFor="same-work-note">Note <span className="hint">optional</span></label><textarea id="same-work-note" name="note" placeholder="Why are these records the same work?" /></div><button className="button" type="submit" disabled={distinctPapers}>Same work</button></form>
          <form action={decideDifferentWorkAction} style={{ marginTop: 14 }}><>{pairFields}</><div className="field"><label htmlFor="different-work-note">Note <span className="hint">optional</span></label><textarea id="different-work-note" name="note" placeholder="Why are these records different works?" /></div><button className="button secondary" type="submit" disabled={Boolean(samePaper)}>Different work</button></form>
        </section>
        <section className="card section-card"><div className="section-heading"><h2>Same work + resolve</h2><span className="count">atomic</span></div>{samePaper ? <div className="empty">Both records already resolve to the same Paper. Recording Same work is sufficient.</div> : distinctPapers ? <div className="empty">Resolve the conflicting Paper mappings explicitly before adjudicating this pair.</div> : <><p className="hint">Choose an existing Paper or create one from a selected record. The decision and compatible links commit together.</p><form action={confirmSameWorkAndResolveAction}>{<>{pairFields}</>}<input type="hidden" name="resolutionType" value="existing" /><div className="field"><label htmlFor="target-paper">Existing Paper</label><select id="target-paper" name="paperId" required defaultValue={targetPaperId ?? ""}><option value="" disabled>Select a canonical Paper…</option>{papers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}{paper.publicationYear ? ` · ${paper.publicationYear}` : ""}</option>)}</select></div><div className="field"><label htmlFor="resolve-note">Note <span className="hint">optional</span></label><textarea id="resolve-note" name="note" /></div><button className="button" type="submit">Same work and link to Paper</button></form><div className="item-meta" style={{ margin: "18px 0 8px" }}>Or create a new canonical Paper from:</div><form action={confirmSameWorkAndResolveAction} className="inline-form">{pairFields}<input type="hidden" name="resolutionType" value="create" /><input type="hidden" name="createFromRecordId" value={left.id} /><input name="title" aria-label="New canonical Paper title" placeholder="Optional Paper title override" /><button className="button secondary" type="submit">Create from Record A</button></form><form action={confirmSameWorkAndResolveAction} className="inline-form" style={{ marginTop: 8 }}>{pairFields}<input type="hidden" name="resolutionType" value="create" /><input type="hidden" name="createFromRecordId" value={right.id} /><input name="title" aria-label="New canonical Paper title from Record B" placeholder="Optional Paper title override" /><button className="button secondary" type="submit">Create from Record B</button></form></>}
        </section>
      </div>
      {pair.decision === "different_work" && samePaper && <section className="card section-card full"><div className="section-heading"><h2>Correct the shared mapping</h2><span className="status unsupported">explicit correction</span></div><p className="hint">Choose a different existing Paper for one record, then append Different work atomically. This does not merge or split Papers.</p><form action={correctDifferentWorkAndResolveAction} className="inline-form">{pairFields}<label htmlFor="relink-record">Record to relink</label><select id="relink-record" name="relinkRecordId" required defaultValue={left.id}><option value={left.id}>Record A</option><option value={right.id}>Record B</option></select><label htmlFor="relink-paper">New Paper</label><select id="relink-paper" name="toPaperId" required defaultValue=""><option value="" disabled>Select Paper…</option>{papers.filter((paper) => paper.id !== samePaper).map((paper) => <option key={paper.id} value={paper.id}>{paper.title}</option>)}</select><button className="button secondary" type="submit">Correct mapping + Different work</button></form></section>}
      <section className="card section-card full"><div className="section-heading"><h2>Decision history</h2><span className="count">{history.length} {history.length === 1 ? "event" : "events"}</span></div>{history.length === 0 ? <div className="empty">This pair has not been adjudicated.</div> : <div className="item-list">{history.map((event) => <article className="item" key={event.id}><div className="item-row"><strong>{event.decision.replace("_", " ").toUpperCase()}</strong>{event.id === history[history.length - 1]?.id && <span className="status supported">current</span>}</div>{event.note && <div className="item-meta">{event.note}</div>}<div className="item-meta">Event {event.sequence} · {event.createdAt.toLocaleString()}</div></article>)}</div>}</section>
      <p className="footer-note">RetrievedRecordMatch history remains the source of current Paper resolution. This page records the separate researcher judgment about record equivalence.</p>
    </div></main>;
}
