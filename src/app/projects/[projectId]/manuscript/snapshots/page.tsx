/* eslint-disable @typescript-eslint/no-explicit-any */
import Link from "next/link";
import { notFound } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

export default async function ManuscriptSnapshotsPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams?: Promise<{ manuscriptId?: string }> }) {
  const { projectId } = await params; const query = searchParams ? await searchParams : {}; const manuscriptId = query.manuscriptId;
  if (!manuscriptId) notFound();
  try {
    const [project, snapshots] = await Promise.all([reviewServices.getProject(projectId), (reviewServices as any).listManuscriptSnapshots(projectId, manuscriptId)]);
    return <main className="shell"><div className="container workspace"><Link className="back-link" href={`/projects/${projectId}/manuscript`}>← {project.title} manuscript</Link><div className="workspace-header"><div><p className="eyebrow">Immutable milestones</p><h1>Manuscript snapshots</h1><p>Historical captures remain unchanged when the working manuscript evolves.</p></div></div><section className="card section-card full">{snapshots.length ? <div className="item-list">{snapshots.map((snapshot: any) => <div className="item" key={snapshot.id}><div className="item-row"><div><Link className="item-title" href={`/projects/${projectId}/manuscript/snapshots/${snapshot.id}?manuscriptId=${manuscriptId}`}>Snapshot {snapshot.sequence}</Link><div className="item-meta">{snapshot.title} · {snapshot.citationStyle} · {new Date(snapshot.capturedAt).toISOString()}</div></div><span className="status supported">{snapshot.counts.items} items</span></div></div>)}</div> : <div className="empty">No snapshots have been captured.</div>}</section></div></main>;
  } catch (error) { if (error instanceof DomainError && ["PROJECT_NOT_FOUND", "NOT_FOUND", "CROSS_PROJECT_REFERENCE"].includes(error.code)) notFound(); throw error; }
}
