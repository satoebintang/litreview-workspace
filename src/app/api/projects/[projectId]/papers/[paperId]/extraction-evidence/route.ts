import { extractionReadServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export const dynamic = "force-dynamic";

function safeMessage(error: unknown): string {
  return error instanceof DomainError
    ? error.message
    : "Evidence could not be loaded. Your selected supports were kept unchanged.";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; paperId: string }> },
) {
  const { projectId, paperId } = await params;
  const url = new URL(request.url);
  const rawPageSize = url.searchParams.get("pageSize");
  const pageSize = rawPageSize === null ? undefined : /^\d+$/.test(rawPageSize) ? Number(rawPageSize) : Number.NaN;
  try {
    const page = await extractionReadServices.getPaperExtractionEvidenceCandidatePage(projectId, paperId, {
      pageSize,
      after: url.searchParams.get("after"),
    });
    return Response.json({ status: "success", page }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const invalidBrowseState = error instanceof DomainError && error.code === "VALIDATION_ERROR";
    const status = invalidBrowseState ? 400
      : error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE"].includes(error.code) ? 404
        : 500;
    return Response.json({
      status: "error",
      safeErrorMessage: safeMessage(error),
      invalidBrowseState,
    }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
