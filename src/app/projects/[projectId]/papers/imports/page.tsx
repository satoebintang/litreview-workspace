import Link from "next/link";
import { notFound } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

type ImportSummary = { id: string; projectId: string; format: string; filename: string; parserVersion: string; status: string; sourceByteSize: number; recordCount: number; resolvedCount: number };

export default async function BibliographicImportsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const services = reviewServices as typeof reviewServices & { listImports?: (projectId: string) => Promise<ImportSummary[]> };
  let imports: ImportSummary[];
  try { imports = services.listImports ? await services.listImports(projectId) : []; } catch (error) { if (error instanceof DomainError && (error.code === "PROJECT_NOT_FOUND" || error.code === "VALIDATION_ERROR")) notFound(); throw error; }
  return <main className="shell"><div className="container workspace"><Link className="back-link" href={`/projects/${projectId}`}>← Project</Link><div className="workspace-header"><div><p className="eyebrow">Paper collection</p><h1>Import history</h1></div><Link className="button" href={`/projects/${projectId}/papers/imports/upload`}>Import BibTeX / RIS</Link></div><section className="card section-card"><p className="hint">Imported records are intake provenance. They do not alter search totals or canonical metadata until a resolution is submitted.</p>{imports.length === 0 ? <div className="empty">No bibliographic imports yet.</div> : <div className="item-list">{imports.map((item) => <div className="item" key={item.id}><div className="item-row"><div><Link className="item-title" href={`/projects/${projectId}/papers/imports/${item.id}`}>{item.filename}</Link><div className="item-meta">{item.format.toUpperCase()} · {item.recordCount} records · {item.resolvedCount} resolved · parser {item.parserVersion}</div><div className="item-meta">{item.sourceByteSize} bytes · {item.status}</div></div><span className="status">{item.resolvedCount}/{item.recordCount}</span></div></div>)}</div>}</section></div></main>;
}
