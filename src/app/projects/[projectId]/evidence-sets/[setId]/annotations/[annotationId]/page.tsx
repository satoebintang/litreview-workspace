import Link from "next/link";
import { notFound } from "next/navigation";
import { evidenceSetWorkspaceReadServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export default async function EvidenceSetAnnotationPage({
  params,
}: {
  params: Promise<{ projectId: string; setId: string; annotationId: string }>;
}) {
  const { projectId, setId, annotationId } = await params;
  let shell;
  let annotation;
  try {
    [shell, annotation] = await Promise.all([
      evidenceSetWorkspaceReadServices.getEvidenceSetWorkspace(projectId, setId),
      evidenceSetWorkspaceReadServices.getAnnotationDetail(projectId, setId, annotationId),
    ]);
  } catch (error) {
    if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "VALIDATION_ERROR", "NOT_FOUND"].includes(error.code)) notFound();
    throw error;
  }
  return <div className="project-page"><div className="container workspace">
    <div className="workspace-header"><div><p className="eyebrow"><Link href={`/projects/${projectId}/evidence-sets/${setId}`}>{shell.set.name}</Link> / Annotation</p><h1>Researcher annotation</h1><p>Sequence {annotation.sequence} · {annotation.createdAt.toLocaleString()}</p></div><span className={`status ${shell.set.archivedAt ? "stale" : "supported"}`}>{shell.set.archivedAt ? "Archived · frozen" : "Evidence Set note"}</span></div>
    <section className="card section-card"><p style={{ whiteSpace: "pre-wrap" }}>{annotation.body}</p><p className="hint">{annotation.bodyCodePointLength > [...annotation.body].length ? `Showing the first ${[...annotation.body].length} of ${annotation.bodyCodePointLength} Unicode code points.` : `Note length: ${annotation.bodyCodePointLength} Unicode code points.`}</p><Link className="button secondary" href={`/projects/${projectId}/evidence-sets/${setId}`}>Back to Evidence Set</Link></section>
  </div></div>;
}
