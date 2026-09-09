import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";
import { serializeReviewFlowMarkdown } from "@/application/review-reporting";

function errorStatus(error: unknown): number {
  if (!(error instanceof DomainError)) return 500;
  if (["PROJECT_NOT_FOUND", "CROSS_PROJECT_REFERENCE", "NOT_FOUND"].includes(error.code)) return 404;
  if (error.code === "VALIDATION_ERROR") return 400;
  return 500;
}

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  try {
    const { projectId } = await params;
    const projection = await reviewServices.getReviewReport(projectId);
    return new Response(serializeReviewFlowMarkdown(projection), {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": 'attachment; filename="review-flow-report.md"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Review report export failed" }, { status: errorStatus(error) });
  }
}
