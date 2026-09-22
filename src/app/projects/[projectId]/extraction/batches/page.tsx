import Link from "next/link";
import { notFound } from "next/navigation";
import { aiExtractionBatchServices, reviewServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function ExtractionBatchListPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  try { await reviewServices.getProject(projectId); } catch (error) { if (error instanceof DomainError) notFound(); throw error; }
  const batches = await aiExtractionBatchServices.listAiExtractionBatches(projectId);
  return <div className="project-page">
    <div className="container workspace"><div className="workspace-header"><div><p className="eyebrow">Batch orchestration</p><h1>AI extraction batches</h1><p>Review immutable batch manifests and advance at most two provider requests per action.</p></div><Link className="button" href={`/projects/${projectId}/extraction/batches/new`}>New batch</Link></div>
      <section className="card section-card">{batches.length === 0 ? <div className="empty">No batches have been created. A batch never writes canonical extraction state by itself.</div> : <div className="item-list">{batches.map((batch) => <Link className="item" key={batch.batchId} href={`/projects/${projectId}/extraction/batches/${batch.batchId}`}><div className="item-row"><div><div className="item-title">Batch {batch.batchId}</div><div className="item-meta">{batch.items.length} cells · model {batch.configuredModel}</div></div><span className={`status ${batch.state === "completed" ? "supported" : batch.state === "cancelled" ? "unsupported" : "screening-maybe"}`}>{batch.state}</span></div></Link>)}</div>}</section>
    </div></div>;
}
