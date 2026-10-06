import Link from "next/link";
import { notFound } from "next/navigation";
import { withReviewReadTransaction } from "@/app/server";
import { DomainError } from "@/domain/errors";

function valueSummary(item: {
  valueState: string;
  textValuePreview: string | null;
  textValueTruncated: boolean;
  numberValue: string | null;
  booleanValue: boolean | null;
  optionLabelPreview: string | null;
  optionLabelTruncated: boolean;
}) {
  if (item.valueState !== "present") return item.valueState.replaceAll("_", " ");
  if (item.textValuePreview !== null) return `${item.textValuePreview}${item.textValueTruncated ? "…" : ""}`;
  if (item.numberValue !== null) return item.numberValue;
  if (item.booleanValue !== null) return item.booleanValue ? "Yes" : "No";
  if (item.optionLabelPreview !== null) return `${item.optionLabelPreview}${item.optionLabelTruncated ? "…" : ""}`;
  return "No value";
}

export default async function ExtractionFieldRevisionHistoryPage({ params, searchParams }: {
  params: Promise<{ projectId: string; paperId: string; fieldId: string }>;
  searchParams?: Promise<{ pageSize?: string; cursor?: string }>;
}) {
  const { projectId, paperId, fieldId } = await params;
  const query = searchParams ? await searchParams : {};
  let history;
  try {
    history = await withReviewReadTransaction(({ extractionHistoryReadServices, executor }) =>
      extractionHistoryReadServices.getExtractionFieldRevisionHistoryPage(projectId, paperId, fieldId, {
        pageSize: query.pageSize === undefined ? undefined : Number(query.pageSize),
        cursor: query.cursor,
      }, executor),
    );
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }

  const worksheetHref = `/projects/${projectId}/extraction/${paperId}`;
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Extraction audit · {history.field.archivedAt ? "Archived Field" : "Active Field"}</p><h1>{history.field.namePreview}{history.field.nameTruncated ? "…" : ""}</h1><p>{history.field.fieldType.replaceAll("_", " ")} · {history.items.length} revision summaries on this page</p></div><span className="count">Page size {history.pageSize}</span></div>
    <p><Link href={worksheetHref}>Return to current worksheet →</Link></p>
    {history.current && <section className="card section-card full"><div className="section-heading"><h2>Current revision</h2><span className="count">Sequence {history.current.sequence}</span></div><p>The full current value and Evidence picker remain on the worksheet.</p><Link className="button ghost small" href={`/projects/${projectId}/extraction/${paperId}/fields/${fieldId}/revisions/${history.current.id}`}>Open exact current revision →</Link></section>}
    <section className="card section-card full"><div className="section-heading"><h2>Historical revision summaries</h2><span className="count">{history.items.length} revisions</span></div>
      {history.items.length === 0 ? <p className="empty">There are no finalized revisions for this Field slot.</p> : <div className="item-list">{history.items.map((item) => <article className="item" key={item.id}>
        <div className="item-row"><div><div className="item-title">Sequence {item.sequence} · {item.valueState.replaceAll("_", " ")}{item.isCurrent ? " · Current" : ""}</div><div className="item-meta">{valueSummary(item)}</div></div><span className="status">{item.evidenceCount} Evidence · {item.supportStatus}</span></div>
        {item.optionId && item.optionArchivedAt && <div className="item-meta">Selected Option is archived; its original identity and label remain attached.</div>}
        {item.researcherNotePreview && <p className="item-meta">Note: {item.researcherNotePreview}{item.researcherNoteTruncated ? "…" : ""}</p>}
        <div className="item-meta">Created {new Date(item.createdAt).toLocaleString()} · finalized {new Date(item.finalizedAt).toLocaleString()}</div>
        <Link className="button ghost small" href={item.href}>Open exact revision →</Link>
      </article>)}</div>}
      {history.hasMore && history.nextCursor && <div style={{ marginTop: 14 }}><Link className="button ghost" href={`/projects/${projectId}/extraction/${paperId}/fields/${fieldId}/history?pageSize=${history.pageSize}&cursor=${encodeURIComponent(history.nextCursor)}`}>Next Field history page →</Link></div>}
    </section>
    <p className="footer-note">History summaries show the exact immutable extraction snapshot compactly. Open a revision to inspect its full value, note, and Evidence membership.</p>
  </div></div>;
}
