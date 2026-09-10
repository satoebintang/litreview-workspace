import Link from "next/link";
import { notFound } from "next/navigation";
import { archiveFullTextDocumentAction, recordEvidenceAction } from "@/app/actions";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

export default async function FullTextDocumentPage({ params, searchParams }: { params: Promise<{ projectId: string; paperId: string; documentId: string }>; searchParams?: Promise<{ error?: string }> }) {
  const { projectId, paperId, documentId } = await params;
  const query = searchParams ? await searchParams : {};
  let document;
  let paper;
  try {
    [document, paper] = await Promise.all([reviewServices.getFullTextDocument(projectId, documentId), reviewServices.getPaper(projectId, paperId)]);
  } catch (error) {
    if (error instanceof DomainError && ["DOCUMENT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  if (document.paperId !== paper.id) notFound();
  const evidence = await reviewServices.listEvidenceForFullTextDocument(projectId, document.id);
  return (
    <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
      <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/papers/${paperId}/documents`}>← All documents</Link>
        <div className="workspace-header"><div><p className="eyebrow">Document artifact</p><h1>{document.originalFilename}</h1><p>{paper.title}</p></div><Link className="button ghost" href={`/projects/${projectId}/papers/${paperId}/documents/${document.id}/download`}>Download PDF</Link></div>
        {query.error && <div className="error-banner" role="alert">{query.error}</div>}
        <div className="workspace-grid">
          <section className="card section-card"><div className="section-heading"><h2>Immutable metadata</h2><span className={`status ${document.archivedAt ? "unsupported" : "supported"}`}>{document.archivedAt ? "Archived" : "Active"}</span></div>
            <div className="item-list"><div className="item"><div className="item-meta">Document ID</div><div className="item-title">{document.id}</div><div className="item-meta">SHA-256</div><div className="item-title">{document.sha256}</div><div className="item-meta">Byte size · media type</div><div className="item-title">{document.byteSize.toLocaleString()} · {document.mediaType}</div>{document.note && <><div className="item-meta">Researcher note</div><div>{document.note}</div></>}</div></div>
            {!document.archivedAt && <form action={archiveFullTextDocumentAction} style={{ marginTop: 14 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="documentId" value={document.id} /><button className="button ghost" type="submit">Archive artifact</button></form>}
          </section>
          <section className="card section-card"><div className="section-heading"><h2>Add Evidence from this document</h2><span className="count">Exact artifact required</span></div>
            {document.archivedAt ? <div className="empty">This artifact is archived. Historical Evidence remains below, but new Evidence must use an active document.</div> : <form action={recordEvidenceAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="fullTextDocumentId" value={document.id} /><div className="field"><label htmlFor="document-source-text">Verbatim source passage</label><textarea id="document-source-text" name="sourceText" required /></div><div className="field"><label htmlFor="document-page-number">Page number</label><input id="document-page-number" name="pageNumber" required type="number" min="1" /></div><div className="field"><label htmlFor="document-evidence-note">Researcher note <span className="hint">optional</span></label><textarea id="document-evidence-note" name="note" /></div><button className="button" type="submit">Record Evidence</button></form>}
          </section>
          <section className="card section-card full"><div className="section-heading"><h2>Evidence history</h2><span className="count">{evidence.length} {evidence.length === 1 ? "passage" : "passages"}</span></div>{evidence.length === 0 ? <div className="empty">No Evidence is attached to this exact artifact.</div> : <div className="item-list">{evidence.map((item) => <article className="item" key={item.id}><div className="quote">“{item.sourceText}”</div><div className="item-meta">Page {item.pageNumber} · Exact document artifact {item.fullTextDocumentId}</div>{item.note && <div className="item-meta">Researcher note: {item.note}</div>}</article>)}</div>}</section>
        </div>
      </div>
    </main>
  );
}
