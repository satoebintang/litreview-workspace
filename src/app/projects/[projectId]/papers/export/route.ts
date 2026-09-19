import { NextResponse } from "next/server";
import { reviewServices } from "@/app/server";

export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const services = reviewServices as typeof reviewServices & { exportBibtex?: (projectId: string) => Promise<string> };
  if (!services.exportBibtex) return NextResponse.json({ error: "BibTeX export is not configured" }, { status: 503 });
  const body = await services.exportBibtex(projectId);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-bibtex; charset=utf-8",
      "Content-Disposition": `attachment; filename="tracework-${projectId}.bib"`,
      "Cache-Control": "no-store",
    },
  });
}

