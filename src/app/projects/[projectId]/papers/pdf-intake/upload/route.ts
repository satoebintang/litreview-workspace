import Busboy from "busboy";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ projectId: string }> };

function redirectTo(request: Request, projectId: string, key: string, value: string, intakeId?: string) {
  const origin = request.headers.get("origin") ?? "http://127.0.0.1:3000";
  const path = intakeId ? `/projects/${projectId}/papers/pdf-intake/${intakeId}` : `/projects/${projectId}/papers/pdf-intake`;
  const url = new URL(path, origin);
  url.searchParams.set(key, value);
  return NextResponse.redirect(url, { status: 303 });
}
function message(error: unknown) {
  return error instanceof DomainError ? error.message : error instanceof Error ? error.message : "PDF intake upload failed";
}

function asError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

export async function POST(request: Request, context: RouteContext) {
  const { projectId } = await context.params;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return redirectTo(request, projectId, "error", "A multipart PDF upload is required");
  if (!request.body) return redirectTo(request, projectId, "error", "The upload body was empty");

  let fileSeen = false;
  let uploadedFilename = "";
  let uploadedMimeType = "";
  let fileStage: ReturnType<typeof reviewServices.uploadPdfIntake> | undefined;
  let parserFailure: Error | undefined;
  let oversized = false;
  const parser = Busboy({ headers: { "content-type": contentType }, limits: { files: 1, fields: 2, parts: 3, fileSize: 50 * 1024 * 1024 + 1 } });
  const incoming = Readable.fromWeb(request.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
  const abortHandler = () => {
    const error = new Error("PDF intake upload was cancelled");
    incoming.destroy(error);
    parser.destroy(error);
  };
  request.signal.addEventListener("abort", abortHandler, { once: true });

  const parsed = new Promise<void>((resolve, reject) => {
    parser.on("file", (name, stream, info) => {
      if (name !== "file" || fileSeen) {
        stream.resume();
        parserFailure = new Error("Exactly one PDF file is required");
        reject(parserFailure);
        return;
      }
      fileSeen = true;
      uploadedFilename = info.filename;
      uploadedMimeType = info.mimeType;
      if (uploadedMimeType.toLowerCase() !== "application/pdf") {
        stream.resume();
        parserFailure = new Error("Only application/pdf uploads are accepted");
        reject(parserFailure);
        return;
      }
      stream.on("limit", () => {
        oversized = true;
        stream.destroy(new Error("PDF exceeds the 50 MiB upload limit"));
      });
      fileStage = reviewServices.uploadPdfIntake(projectId, { originalFilename: uploadedFilename, mediaType: "application/pdf" }, stream);
      fileStage.catch((error) => {
        parserFailure = error instanceof Error ? error : new Error("PDF intake stream failed");
        reject(parserFailure);
      });
    });
    parser.on("filesLimit", () => { parserFailure = new Error("Exactly one PDF file is required"); reject(parserFailure); });
    parser.on("fieldsLimit", () => { parserFailure = new Error("PDF intake metadata is too large"); reject(parserFailure); });
    parser.on("partsLimit", () => { parserFailure = new Error("PDF intake contains too many parts"); reject(parserFailure); });
    parser.on("error", (error) => { parserFailure = asError(error, "Multipart parser failed"); reject(parserFailure); });
    parser.on("finish", () => resolve());
  });
  incoming.on("error", (error) => { parserFailure = asError(error, "Upload stream failed"); parser.destroy(parserFailure); });
  incoming.pipe(parser);

  try {
    await parsed;
    if (parserFailure) throw parserFailure;
    if (!fileSeen || !fileStage) throw new Error("A PDF file is required");
    if (request.signal.aborted) throw new Error("PDF intake upload was cancelled");
    if (oversized) throw new Error("PDF exceeds the 50 MiB upload limit");
    const intake = await fileStage;
    if (!intake) throw new Error("PDF intake was not created");
    return redirectTo(request, projectId, "saved", "staged", intake.id);
  } catch (error) {
    incoming.destroy();
    return redirectTo(request, projectId, "error", message(error));
  } finally {
    request.signal.removeEventListener("abort", abortHandler);
  }
}
