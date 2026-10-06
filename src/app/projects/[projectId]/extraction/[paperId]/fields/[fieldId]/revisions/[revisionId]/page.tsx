import Link from "next/link";
import { notFound } from "next/navigation";
import { withReviewReadTransaction } from "@/app/server";
import { DomainError } from "@/domain/errors";

function fullValue(revision: {
  valueState: string;
  textValue: string | null;
  numberValue: string | null;
  booleanValue: boolean | null;
  optionId: string | null;
  optionLabel: string | null;
}) {
  if (revision.valueState !== "present") return revision.valueState.replaceAll("_", " ");
  if (revision.textValue !== null) return revision.textValue;
  if (revision.numberValue !== null) return revision.numberValue;
  if (revision.booleanValue !== null) return revision.booleanValue ? "Yes" : "No";
  return revision.optionLabel ?? revision.optionId ?? "No value";
}

export default async function ExactExtractionRevisionPage({ params }: {
  params: Promise<{ projectId: string; paperId: string; fieldId: string; revisionId: string }>;
}) {
  const { projectId, paperId, fieldId, revisionId } = await params;
  let exact;
  try {
    exact = await withReviewReadTransaction(({ extractionHistoryReadServices, executor }) =>
      extractionHistoryReadServices.getExtractionRevisionExact(projectId, paperId, fieldId, revisionId, executor),
    );
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }
  const { revision } = exact;
  const historyHref = `/projects/${projectId}/extraction/${paperId}/fields/${fieldId}/history`;

  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow">Exact ExtractionRevision · sequence {revision.sequence}</p><h1>{exact.field.name}</h1><p>{exact.paper.title} · {exact.field.fieldType.replaceAll("_", " ")} · {exact.field.archivedAt ? "Archived Field" : "Active Field"}</p></div><span className={`status ${revision.valueState === "cleared" ? "unsupported" : "supported"}`}>{revision.valueState.replaceAll("_", " ")}</span></div>
    <p><Link href={historyHref}>Return to Field revision history →</Link> · <Link href={`/projects/${projectId}/extraction/${paperId}`}>Current worksheet →</Link></p>
    <section className="card section-card full"><div className="section-heading"><h2>Exact immutable value</h2><span className="count">{exact.isCurrentRevision ? "Current revision" : "Superseded revision"}</span></div><p style={{ whiteSpace: "pre-wrap" }}>{fullValue(revision)}</p>
      {revision.optionId && <p className="item-meta">Option {revision.optionLabel ?? "label unavailable"} · {revision.optionArchivedAt ? "archived Option" : "active Option"} · {revision.optionId}</p>}
      {revision.researcherNote && <><h3>Researcher note</h3><p style={{ whiteSpace: "pre-wrap" }}>{revision.researcherNote}</p></>}
      <p className="item-meta">Created {new Date(revision.createdAt).toLocaleString()} · finalized {new Date(revision.finalizedAt).toLocaleString()} · slot {revision.extractionValueId}</p>
    </section>
    <section className="card section-card full"><div className="section-heading"><h2>Exact Evidence membership</h2><span className="count">{revision.evidence.length}</span></div>
      {revision.evidence.length === 0 ? <p className="empty">No Evidence passages were linked to this revision.</p> : <div className="item-list">{revision.evidence.map((item) => <article className="item" key={item.id}>
        <div className="item-row"><div className="item-title">Page {item.pageNumber}</div><span className="status">{item.reviewState}{item.curationWarning ? ` · ${item.curationWarning.replaceAll("_", " ")}` : ""}</span></div>
        <p className="quote">“{item.sourceText}”</p>
        {item.note && <p className="item-meta">Evidence note: {item.note}</p>}
        <p className="item-meta">Evidence {item.id} · created {new Date(item.createdAt).toLocaleString()}{item.fullTextDocumentId ? ` · Document ${item.fullTextDocumentId}` : ""}{item.documentTextExtractionId ? ` · text extraction ${item.documentTextExtractionId}` : ""}</p>
      </article>)}</div>}
    </section>
    <p className="footer-note">This page returns the exact finalized Field, typed value, researcher note, selected Option, and Evidence membership for this revision. Current Evidence review annotations can change without altering that membership.</p>
  </div></div>;
}
