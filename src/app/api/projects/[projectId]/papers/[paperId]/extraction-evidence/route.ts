import { extractionReadServices } from "@/app/server";
import { DomainError } from "@/domain/errors";

export const dynamic = "force-dynamic";

function safeMessage(error: unknown): string {
  return error instanceof DomainError
    ? error.message
    : "Evidence could not be loaded.";
}

function validationInput(error: unknown): "query" | "pagination" | "request" | null {
  if (!(error instanceof DomainError) || error.code !== "VALIDATION_ERROR") return null;
  const input = (error.details as { input?: unknown } | undefined)?.input;
  return input === "query" || input === "pagination" ? input : "request";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; paperId: string }> },
) {
  const { projectId, paperId } = await params;
  const url = new URL(request.url);
  const rawPageSizes = url.searchParams.getAll("pageSize");
  const rawPageSize = rawPageSizes[0] ?? null;
  const pageSize = rawPageSize === null ? undefined : /^\d+$/.test(rawPageSize) ? Number(rawPageSize) : Number.NaN;
  const rawQueries = url.searchParams.getAll("query");
  const query = rawQueries.length === 0 ? undefined : rawQueries.length === 1 ? rawQueries[0] : rawQueries;
  const rawCursors = url.searchParams.getAll("after");
  const after = rawCursors.length > 1 ? "invalid-cursor" : rawCursors[0] ?? null;
  try {
    const page = await extractionReadServices.getPaperExtractionEvidenceCandidatePage(projectId, paperId, {
      pageSize: rawPageSizes.length > 1 ? Number.NaN : pageSize,
      after,
      query,
    });
    return Response.json({ status: "success", page }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const input = validationInput(error);
    const invalidBrowseState = input === "pagination";
    const status = input ? 400
      : error instanceof DomainError && ["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE"].includes(error.code) ? 404
        : 500;
    return Response.json({
      status: "error",
      safeErrorMessage: safeMessage(error),
      invalidBrowseState,
      validationInput: input,
    }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
