import Busboy from "busboy";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { DomainError } from "@/domain/errors";
import { reviewServices } from "@/app/server";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ projectId: string; paperId: string }> };

function redirectTo(request: Request, projectId: string, paperId: string, key: string, value: string) {
  const origin = request.headers.get("origin") ?? "http://127.0.0.1:3000";
  const url = new URL(`/projects/${projectId}/papers/${paperId}/documents`, origin);
  url.searchParams.set(key, value);
  return NextResponse.redirect(url, { status: 303 });
}

function message(error: unknown) {
  return error instanceof DomainError ? error.message : error instanceof Error ? error.message : "Document upload failed";
}

function asError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

export async function POST(request: Request, context: RouteContext) {
  const { projectId, paperId } = await context.params;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return redirectTo(request, projectId, paperId, "error", "A multipart PDF upload is required");
  if (!request.body) return redirectTo(request, projectId, paperId, "error", "The upload body was empty");

  const fields: Record<string, string> = {};
  let fileSeen = false;
  let uploadedFilename = "";
  let uploadedMimeType = "";
  let fileStage: ReturnType<typeof reviewServices.stageFullTextDocument> | undefined;
  let staged: Awaited<ReturnType<typeof reviewServices.stageFullTextDocument>> | undefined;
  let parserFailure: Error | undefined;
  let oversized = false;
  const parser = Busboy({ headers: { "content-type": contentType }, limits: { files: 1, fields: 3, parts: 4, fileSize: 50 * 1024 * 1024 + 1 } });
  const incoming = Readable.fromWeb(request.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
  const abortHandler = () => {
    const error = new Error("Document upload was cancelled");
    incoming.destroy(error);
    parser.destroy(error);
  };
  request.signal.addEventListener("abort", abortHandler, { once: true });

  const parsed = new Promise<void>((resolve, reject) => {
    parser.on("field", (name, value) => {
      if (name !== "originalFilename" && name !== "mediaType") fields[name] = value;
    });
    parser.on("file", (name, stream, info) => {
      if (name !== "file" || fileSeen) {
        stream.resume();
        parserFailure = new Error("Exactly one document file is required");
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
      stream.on("limit", () => { oversized = true; stream.destroy(new Error("Document exceeds the 50 MiB upload limit")); });
      fileStage = reviewServices.stageFullTextDocument(stream, request.signal);
      fileStage.catch((error) => { parserFailure = error instanceof Error ? error : new Error("Document stream failed"); reject(parserFailure); });
    });
    parser.on("filesLimit", () => { parserFailure = new Error("Exactly one document file is required"); reject(parserFailure); });
    parser.on("fieldsLimit", () => { parserFailure = new Error("Document metadata is too large"); reject(parserFailure); });
    parser.on("partsLimit", () => { parserFailure = new Error("Document upload contains too many parts"); reject(parserFailure); });
    parser.on("error", (error) => { parserFailure = asError(error, "Multipart parser failed"); reject(parserFailure); });
    parser.on("finish", () => resolve());
  });
  incoming.on("error", (error) => { parserFailure = asError(error, "Upload stream failed"); parser.destroy(parserFailure); });
  incoming.pipe(parser);

  try {
    await parsed;
    if (parserFailure) throw parserFailure;
    if (!fileSeen || !fileStage) throw new Error("A document file is required");
    staged = await fileStage;
    if (request.signal.aborted) throw new Error("Document upload was cancelled");
    if (oversized) throw new Error("Document exceeds the 50 MiB upload limit");
    if (uploadedMimeType.toLowerCase() !== "application/pdf") throw new Error("Only application/pdf uploads are accepted");
    const result = await reviewServices.attachStagedFullTextDocument(projectId, paperId, {
      originalFilename: uploadedFilename,
      mediaType: "application/pdf",
      note: fields.note || null,
    }, staged);
    return redirectTo(request, projectId, paperId, "saved", result.kind === "duplicate" ? "duplicate" : "uploaded");
  } catch (error) {
    incoming.destroy();
    const completedStage = staged ?? await fileStage?.catch(() => undefined);
    if (completedStage) await reviewServices.discardStagedFullTextDocument(completedStage);
    return redirectTo(request, projectId, paperId, "error", message(error));
  } finally {
    request.signal.removeEventListener("abort", abortHandler);
  }
}
