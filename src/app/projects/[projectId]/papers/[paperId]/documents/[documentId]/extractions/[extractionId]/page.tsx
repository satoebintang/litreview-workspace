import Link from "next/link";
import { notFound } from "next/navigation";
import { recordExtractedEvidenceAction } from "@/app/actions";
import { reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";
import { ExtractedEvidenceForm } from "./ExtractedEvidenceForm";

export default async function DocumentTextExtractionPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; paperId: string; documentId: string; extractionId: string }>;
  searchParams?: Promise<{ error?: string; saved?: string }>;
}) {
  const { projectId, paperId, documentId, extractionId } = await params;
  const query = searchParams ? await searchParams : {};
  let document;
  let paper;
  let extraction;
  try {
    [document, paper, extraction] = await Promise.all([
      reviewServices.getFullTextDocument(projectId, documentId),
      reviewServices.getPaper(projectId, paperId),
      reviewServices.getDocumentTextExtraction(projectId, documentId, extractionId),
    ]);
  } catch (error) {
    if (error instanceof DomainError && ["DOCUMENT_NOT_FOUND", "NOT_FOUND", "CROSS_PROJECT_REFERENCE", "PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound();
    throw error;
  }
  if (document.paperId !== paper.id || extraction.paperId !== paper.id) notFound();
  const pages = extraction.pages ?? [];
  return (
    <main className="shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">T</span> Tracework</Link><span className="top-note">Evidence-first literature reviews</span></header>
      <div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/papers/${paperId}/documents/${documentId}`}>← Document artifact</Link>
        <div className="workspace-header"><div><p className="eyebrow">Immutable text extraction · Run {extraction.sequence}</p><h1>{document.originalFilename}</h1><p>{paper.title} · {extraction.extractorKey} {extraction.extractorVersion} · algorithm {extraction.algorithmVersion}</p></div><span className={`status ${extraction.status === "succeeded" ? "supported" : extraction.status === "partial" ? "warning" : "unsupported"}`}>{extraction.status}</span></div>
        {query.error && <div className="error-banner" role="alert">{query.error}</div>}{query.saved === "extracted" && <div className="success-note" role="status">Text extraction completed.</div>}{query.saved === "evidence" && <div className="success-note" role="status">Evidence recorded from the exact extracted span.</div>}
        <section className="card section-card"><div className="section-heading"><h2>Run metadata</h2><span className="count">{extraction.pageCount ?? "Unknown"} pages</span></div><div className="item-list"><div className="item"><div className="item-meta">Extraction ID</div><div className="item-title">{extraction.id}</div><div className="item-meta">Character count</div><div className="item-title">{extraction.characterCount == null ? "Not persisted" : `${extraction.characterCount.toLocaleString()} Unicode code points`}</div>{extraction.errorMessage && <><div className="item-meta">{extraction.errorCode ?? "Error"}</div><div>{extraction.errorMessage}</div></>}</div></div>{document.archivedAt && <p className="hint">This document is archived. Historical extraction text remains readable; new extraction-grounded Evidence is disabled.</p>}</section>
        {pages.length === 0 ? <section className="card section-card"><div className="empty">This globally failed extraction has no persisted page rows.</div></section> : <div className="workspace-grid">{pages.map((page) => <section className="card section-card full" key={page.pageNumber}><div className="section-heading"><div><h2>Page {page.pageNumber}</h2><p className="hint">{page.status === "succeeded" ? `${page.characterCount.toLocaleString()} Unicode code points` : "Failed page placeholder · no text persisted"}</p></div><span className={`status ${page.status === "succeeded" ? "supported" : "unsupported"}`}>{page.status}</span></div>{page.status === "succeeded" ? <><pre className="quote" style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>{page.text || "(No extractable native text on this page.)"}</pre>{!document.archivedAt && <ExtractedEvidenceForm action={recordExtractedEvidenceAction} projectId={projectId} paperId={paperId} documentId={documentId} extractionId={extractionId} pageNumber={page.pageNumber} text={page.text} />}</> : <div className="empty">{page.errorCode ?? "page_extraction_issue"}: {page.errorMessage ?? "Text could not be extracted from this page."}</div>}</section>)}</div>}
        <p className="footer-note">Extraction runs and pages are immutable. Rerunning extraction creates a new run and never retargets historical Evidence.</p>
      </div>
    </main>
  );
}
