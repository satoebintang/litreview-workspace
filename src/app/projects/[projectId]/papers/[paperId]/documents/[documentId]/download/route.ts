import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ projectId: string; paperId: string; documentId: string }> }) {
  const { projectId, paperId, documentId } = await context.params;
  try {
    const { document, stream } = await reviewServices.openFullTextDocumentDownload(projectId, documentId);
    if (document.paperId !== paperId) {
      stream.destroy();
      throw new DomainError("DOCUMENT_NOT_FOUND", "Document does not belong to this Paper");
    }
    const filename = document.originalFilename.replace(/["\\\r\n]/g, "_");
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": document.mediaType,
        "Content-Length": String(document.byteSize),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof DomainError && error.code === "DOCUMENT_NOT_FOUND" ? 404 : error instanceof DomainError && error.code === "STORAGE_ERROR" ? 503 : 400;
    return NextResponse.json({ error: error instanceof DomainError ? error.message : "Document download failed" }, { status });
  }
}
