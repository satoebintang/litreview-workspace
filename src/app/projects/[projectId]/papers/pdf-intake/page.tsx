import Link from "next/link";
import { notFound } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

export default async function PdfIntakePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<{ error?: string; saved?: string }> }) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  let intakes;
  try { intakes = await reviewServices.listPdfIntakes(projectId); }
  catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "VALIDATION_ERROR"].includes(error.code)) notFound(); throw error; }
  return <div className="project-page"><div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Paper collection</p><h1>PDF intake</h1><p className="hint">PDFs are staged as project-owned source artifacts until you explicitly create or select a canonical Paper.</p></div><Link className="button ghost" href={`/projects/${projectId}`}>Paper collection</Link></div>
    {query.error && <div className="error-banner" role="alert">{query.error}</div>}
    {query.saved && <div className="success-note" role="status">PDF staged. Review the deterministic metadata proposal before resolution.</div>}
    <section className="card section-card"><h2>Upload PDF</h2><form method="post" action={`/projects/${projectId}/papers/pdf-intake/upload`} encType="multipart/form-data"><div className="field"><label htmlFor="pdf-file">PDF file</label><input id="pdf-file" name="file" type="file" accept="application/pdf" required /></div><button className="button" type="submit">Stage PDF</button></form></section>
    <section className="card section-card"><h2>Staged artifacts</h2>{intakes.length === 0 ? <div className="empty">No staged PDFs yet.</div> : <div className="item-list">{intakes.map((intake) => <div className="item" key={intake.id}><div className="item-row"><div><Link className="item-title" href={`/projects/${projectId}/papers/pdf-intake/${intake.id}`}>{intake.originalFilename}</Link><div className="item-meta">{intake.byteSize} bytes · SHA-256 {intake.sha256}</div><div className="item-meta">{intake.state}{intake.resolutionPaperId ? ` · Paper ${intake.resolutionPaperId}` : ""}</div></div><span className="status">{intake.state}</span></div></div>)}</div>}</section>
  </div></div>;
}
