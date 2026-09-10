import Link from "next/link";
import { notFound } from "next/navigation";
import { archiveFullTextDocumentAction, clearPreferredFullTextDocumentAction, setPreferredFullTextDocumentAction } from "@/app/actions";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

type Params = { projectId: string; paperId: string };
type Search = { error?: string; saved?: string };

export default async function FullTextDocumentsPage({ params, searchParams }: { params: Promise<Params>; searchParams?: Promise<Search> }) {
  const { projectId, paperId } = await params;
  const query = searchParams ? await searchParams : {};
  let project;
  let paper;
  try {
    [project, paper] = await Promise.all([reviewServices.getProject(projectId), reviewServices.getPaper(projectId, paperId)]);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  const [documents, preferred] = await Promise.all([
    reviewServices.listFullTextDocuments(projectId, paperId),
    reviewServices.getPreferredFullTextDocument(projectId, paperId),
  ]);
  const savedMessage = query.saved === "uploaded" ? "PDF document uploaded." : query.saved === "duplicate" ? "Duplicate active bytes detected; the existing artifact was kept." : query.saved === "preferred" ? "Preferred document updated." : query.saved === "preference-cleared" ? "Preferred document cleared." : query.saved === "archived" ? "Document archived; its historical Evidence remains available." : undefined;
  return (
    <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
      <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}`}>← {project.title}</Link>
        <div className="workspace-header"><div><p className="eyebrow">Full-text documents</p><h1>{paper.title}</h1><p>Immutable PDF artifacts attached to this Paper.</p></div><Link className="button ghost" href={`/projects/${projectId}`}>Workspace →</Link></div>
        {query.error && <div className="error-banner" role="alert">{query.error}</div>}{savedMessage && <div className="success-note" role="status">{savedMessage}</div>}
        <div className="workspace-grid">
          <section className="card section-card"><div className="section-heading"><h2>Upload PDF</h2><span className="count">50 MiB maximum</span></div>
            <p className="hint">The stored bytes, SHA-256, and byte size become immutable artifact identity. Uploading identical bytes is deduplicated only while an active artifact exists.</p>
            <form action={`/projects/${projectId}/papers/${paperId}/documents/upload`} method="post" encType="multipart/form-data">
              <div className="field"><label htmlFor="document-file">PDF file</label><input id="document-file" name="file" type="file" accept="application/pdf,.pdf" required /></div>
              <div className="field"><label htmlFor="document-note">Researcher note <span className="hint">optional</span></label><textarea id="document-note" name="note" placeholder="Acquisition or provenance note" /></div>
              <button className="button" type="submit">Upload document</button>
            </form>
          </section>
          <section className="card section-card"><div className="section-heading"><h2>Document preference</h2><span className="count">Presentation only</span></div>
            <p className="hint">Preference never changes Evidence provenance. It only identifies the document shown first for this Paper.</p>
            {preferred ? <div className="item"><div className="item-title">{preferred.originalFilename}</div><div className="item-meta">Preferred active artifact · {preferred.sha256}</div><form action={clearPreferredFullTextDocumentAction} style={{ marginTop: 10 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><button className="button ghost" type="submit">Clear preference</button></form></div> : <div className="empty">No preferred document is set.</div>}
          </section>
          <section className="card section-card full"><div className="section-heading"><h2>Artifacts</h2><span className="count">{documents.length} {documents.length === 1 ? "document" : "documents"}</span></div>
            {documents.length === 0 ? <div className="empty">No PDF artifacts are attached to this Paper yet.</div> : <div className="item-list">{documents.map((document) => <article className="item" key={document.id}><div className="item-row"><div><div className="item-title"><Link href={`/projects/${projectId}/papers/${paperId}/documents/${document.id}`}>{document.originalFilename}</Link></div><div className="item-meta">{document.byteSize.toLocaleString()} bytes · SHA-256 {document.sha256}</div><div className="item-meta">{document.archivedAt ? `Archived ${document.archivedAt.toLocaleString()}` : "Active artifact"}{preferred?.id === document.id ? " · Preferred" : ""}</div></div><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><Link className="button ghost" href={`/projects/${projectId}/papers/${paperId}/documents/${document.id}/download`}>Download</Link>{!document.archivedAt && <form action={setPreferredFullTextDocumentAction}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="documentId" value={document.id} /><button className="button secondary" type="submit">Make preferred</button></form>}</div></div>{!document.archivedAt && <form action={archiveFullTextDocumentAction} style={{ marginTop: 10 }}><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="paperId" value={paperId} /><input type="hidden" name="documentId" value={document.id} /><button className="button ghost" type="submit">Archive artifact</button></form>}</article>)}</div>}
          </section>
        </div>
        <p className="footer-note">Archived artifacts remain downloadable and continue to ground historical Evidence; new Evidence must use an active artifact.</p>
      </div>
    </main>
  );
}
