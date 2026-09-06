import { DomainError } from "@/domain/errors";
import type { FormattedManuscriptProjection } from "@/application/manuscript-formatting";
import { serializeManuscriptMarkdown } from "@/application/manuscript-formatting";
import { reviewServices } from "@/app/server";

type ManuscriptExportServices = {
  getFormattedManuscript: (projectId: string, manuscriptId: string) => Promise<FormattedManuscriptProjection>;
};

// The application service is extended by Slice 8's style/projection seam.  A
// structural cast keeps this route independent from the concrete service
// object and, importantly, prevents it from rebuilding provenance queries.
const services = reviewServices as unknown as ManuscriptExportServices;

function errorStatus(error: unknown): number {
  if (!(error instanceof DomainError)) return 500;
  if (["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND"].includes(error.code)) return 404;
  if (error.code === "VALIDATION_ERROR") return 400;
  return 500;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  try {
    const { projectId } = await params;
    const manuscriptId = new URL(request.url).searchParams.get("manuscriptId");
    if (!manuscriptId) return Response.json({ error: "manuscriptId is required" }, { status: 400 });
    const projection = await services.getFormattedManuscript(projectId, manuscriptId);
    const body = serializeManuscriptMarkdown(projection);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="manuscript-${manuscriptId}.md"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Manuscript export failed" }, { status: errorStatus(error) });
  }
}
