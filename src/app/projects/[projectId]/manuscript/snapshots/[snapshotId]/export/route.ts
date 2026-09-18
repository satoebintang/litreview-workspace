/* eslint-disable @typescript-eslint/no-explicit-any */
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; snapshotId: string }> }) {
  try {
    const { projectId, snapshotId } = await params; const manuscriptId = new URL(request.url).searchParams.get("manuscriptId");
    if (!manuscriptId) return Response.json({ error: "manuscriptId is required" }, { status: 400 });
    const body = await (reviewServices as any).getManuscriptSnapshotMarkdown(projectId, manuscriptId, snapshotId);
    return new Response(body, { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="manuscript-snapshot-${snapshotId}.md"`, "Cache-Control": "no-store" } });
  } catch (error) { const status = error instanceof DomainError && ["NOT_FOUND", "PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE"].includes(error.code) ? 404 : 500; return Response.json({ error: error instanceof Error ? error.message : "Snapshot export failed" }, { status }); }
}
