import { uploadBibliographicImportAction } from "@/app/actions";

export default async function BibliographicImportUploadPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<{ error?: string }> }) {
  const { projectId } = await params;
  const query = searchParams ? await searchParams : {};
  return <div className="project-page"><div className="container workspace"><section className="card section-card"><p className="eyebrow">Paper collection</p><h1>Import BibTeX or RIS</h1><p className="hint">The source file is retained as an immutable intake record. Parsed records remain unresolved until you explicitly match or create canonical Papers.</p>{query.error && <div className="error-banner" role="alert">{query.error}</div>}<form action={uploadBibliographicImportAction} encType="multipart/form-data"><input type="hidden" name="projectId" value={projectId} /><div className="field"><label htmlFor="import-format">Format</label><select id="import-format" name="format" defaultValue="bibtex"><option value="bibtex">BibTeX</option><option value="ris">RIS</option></select></div><div className="field"><label htmlFor="import-file">File</label><input id="import-file" name="file" type="file" accept=".bib,.bibtex,.ris,text/plain" required /></div><button className="button" type="submit">Import records</button></form></section></div></div>;
}

