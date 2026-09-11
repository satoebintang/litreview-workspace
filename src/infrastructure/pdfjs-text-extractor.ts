import path from "node:path";
import { getDocument, version as pdfjsVersion } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import {
  codePointLength,
  normalizeLineEndings,
} from "@/domain/unicode-offsets";

/** The fixed parser identity persisted with every extraction run. */
export const PDFJS_EXTRACTOR_KEY = "pdfjs" as const;
export const PDFJS_EXTRACTOR_VERSION = pdfjsVersion;
/** Increment whenever the researcher-visible page normalization changes. */
export const PDFJS_ALGORITHM_VERSION = "pdfjs-text-v1" as const;

export const PDF_TEXT_LIMITS = Object.freeze({
  maxInputBytes: 50 * 1024 * 1024,
  maxPages: 2_000,
  maxPageCodePoints: 500_000,
  maxRunCodePoints: 10_000_000,
  maxErrorMessageCharacters: 1_000,
  deadlineMs: 60_000,
});

export type PdfExtractionStatus = "succeeded" | "partial" | "failed";

export type PdfExtractionError = Readonly<{
  code: string;
  message: string;
}>;

export type ExtractedPdfPage = Readonly<{
  pageNumber: number;
  status: "succeeded" | "failed";
  /** Failed pages are deliberately typed empty placeholders. */
  text: string;
  characterCount: number;
  textItemCount: number;
  error: PdfExtractionError | null;
}>;

export type PdfTextExtractionResult = Readonly<{
  status: PdfExtractionStatus;
  /** Null means that PDF.js never established a reliable page count. */
  pageCount: number | null;
  /** Global failures always return zero page rows. */
  pages: readonly ExtractedPdfPage[];
  characterCount: number | null;
  error: PdfExtractionError | null;
  extractorKey: typeof PDFJS_EXTRACTOR_KEY;
  extractorVersion: typeof PDFJS_EXTRACTOR_VERSION;
  algorithmVersion: typeof PDFJS_ALGORITHM_VERSION;
}>;

export type PdfTextExtractionOptions = Readonly<{
  password?: string;
  signal?: AbortSignal;
  /** Primarily useful for deterministic cancellation tests. Defaults to 60 s. */
  deadlineMs?: number;
  limits?: Partial<{
    maxInputBytes: number;
    maxPages: number;
    maxPageCodePoints: number;
    maxRunCodePoints: number;
    maxErrorMessageCharacters: number;
  }>;
}>;

/** Parser-neutral shape consumed by the application extraction service. */
export type PdfjsTextExtractionParser = Readonly<{
  extractorKey: typeof PDFJS_EXTRACTOR_KEY;
  extractorVersion: typeof PDFJS_EXTRACTOR_VERSION;
  algorithmVersion: typeof PDFJS_ALGORITHM_VERSION;
  extract(
    bytes: Uint8Array,
    options: {
      signal: AbortSignal;
      maxPages: number;
      maxPageCodePoints: number;
      maxRunCodePoints: number;
      deadlineMs: number;
    },
  ): Promise<PdfTextExtractionResult>;
}>;

export class PdfTextExtractionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PdfTextExtractionError";
  }
}

type EffectiveLimits = {
  maxInputBytes: number;
  maxPages: number;
  maxPageCodePoints: number;
  maxRunCodePoints: number;
  maxErrorMessageCharacters: number;
};

/**
 * PDF.js resolves its cMap and standard-font assets relative to these package
 * directories. The package stays externalized by Next, so this resolution is
 * valid in the built server and does not introduce client worker plumbing.
 */
function parserDataOptions() {
  const builtinModule = process.getBuiltinModule("module");
  if (!builtinModule) {
    throw new PdfTextExtractionError("runtime_unsupported", "Node's built-in module resolver is unavailable");
  }
  const runtimeRequire = builtinModule.createRequire(path.join(process.cwd(), "package.json"));
  const packageRoot = path.dirname(runtimeRequire.resolve("pdfjs-dist/package.json"));
  return {
    // PDF.js's URL factory requires a literal trailing slash even on Windows;
    // path.sep would produce a backslash and is rejected as an invalid URL.
    cMapUrl: `${path.join(packageRoot, "cmaps")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${path.join(packageRoot, "standard_fonts")}/`,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  };
}

function effectiveLimits(options: PdfTextExtractionOptions): EffectiveLimits {
  const limits = { ...PDF_TEXT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new PdfTextExtractionError("invalid_limit", `${name} must be a positive integer`);
    }
  }
  return limits;
}

function boundedError(error: unknown, maxCharacters: number): PdfExtractionError {
  if (error instanceof PdfTextExtractionError) {
    return {
      code: error.code.slice(0, maxCharacters),
      message: error.message.slice(0, maxCharacters),
    };
  }
  const candidate = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : undefined;
  const code = typeof candidate?.name === "string" && candidate.name.length > 0
    ? candidate.name.slice(0, maxCharacters)
    : "parser_failure";
  const rawMessage = typeof candidate?.message === "string" ? candidate.message : String(error);
  return { code, message: rawMessage.slice(0, maxCharacters) };
}

function globalFailure(error: unknown, pageCount: number | null, maxErrorMessageCharacters: number): PdfTextExtractionResult {
  const failure = boundedError(error, maxErrorMessageCharacters);
  return {
    status: "failed",
    pageCount,
    pages: [],
    characterCount: null,
    error: failure,
    extractorKey: PDFJS_EXTRACTOR_KEY,
    extractorVersion: PDFJS_EXTRACTOR_VERSION,
    algorithmVersion: PDFJS_ALGORITHM_VERSION,
  };
}

function pageFailure(pageNumber: number, error: unknown, maxErrorMessageCharacters: number): ExtractedPdfPage {
  return {
    pageNumber,
    status: "failed",
    text: "",
    characterCount: 0,
    textItemCount: 0,
    error: boundedError(error, maxErrorMessageCharacters),
  };
}

function pageText(items: readonly unknown[]): { text: string; textItemCount: number } {
  const textItems = items.filter((item): item is TextItem => {
    if (!item || typeof item !== "object" || !("str" in item)) return false;
    return typeof (item as { str?: unknown }).str === "string";
  });
  // Keep PDF.js traversal order and only honor explicit EOL markers. This is
  // intentionally not semantic whitespace cleanup: Evidence must quote the
  // exact stored representation. Line ending normalization is the sole text
  // rewrite performed here.
  return {
    text: normalizeLineEndings(textItems.map((item) => `${item.str}${item.hasEOL ? "\n" : ""}`).join("")),
    textItemCount: textItems.length,
  };
}

function abortError(): PdfTextExtractionError {
  return new PdfTextExtractionError("cancelled", "PDF text extraction was cancelled or exceeded its deadline");
}

/** Await a PDF.js operation while retaining a best-effort cancellation path. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function deadlineSignal(parent: AbortSignal | undefined, deadlineMs: number) {
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
    throw new PdfTextExtractionError("invalid_deadline", "deadlineMs must be a positive integer");
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * Extract deterministic, page-aware native text from one PDF byte view.
 *
 * The returned result is already shaped for the immutable terminal extraction
 * contract: global failures have no pages; partial results contain one typed
 * page row for every declared page; failed page rows have empty text.
 */
export async function extractPdfText(
  data: Uint8Array,
  options: PdfTextExtractionOptions = {},
): Promise<PdfTextExtractionResult> {
  const limits = effectiveLimits(options);
  const deadline = deadlineSignal(options.signal, options.deadlineMs ?? PDF_TEXT_LIMITS.deadlineMs);
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  let loadedDocument: Awaited<ReturnType<typeof getDocument>["promise"]> | undefined;
  let knownPageCount: number | null = null;

  try {
    if (data.byteLength > limits.maxInputBytes) {
      return globalFailure(new PdfTextExtractionError("input_too_large", "PDF exceeds the 50 MiB extraction limit"), null, limits.maxErrorMessageCharacters);
    }
    if (deadline.signal.aborted) throw abortError();

    // PDF.js transfers its input buffer in some configurations. Copy the
    // caller's view so sliced/non-zero-offset Buffer inputs remain isolated.
    const ownedData = new Uint8Array(data);
    loadingTask = getDocument({
      ...parserDataOptions(),
      data: ownedData,
      password: options.password,
    });
    loadedDocument = await raceAbort(loadingTask.promise, deadline.signal);
    knownPageCount = loadedDocument.numPages;
    if (knownPageCount <= 0) {
      return globalFailure(new PdfTextExtractionError("invalid_page_count", "PDF did not declare a positive page count"), knownPageCount, limits.maxErrorMessageCharacters);
    }
    if (knownPageCount > limits.maxPages) {
      return globalFailure(new PdfTextExtractionError("page_limit_exceeded", "PDF exceeds the 2,000 page extraction limit"), knownPageCount, limits.maxErrorMessageCharacters);
    }

    const pages: ExtractedPdfPage[] = [];
    let characterCount = 0;
    let succeededPages = 0;
    let failedPages = 0;
    for (let pageNumber = 1; pageNumber <= knownPageCount; pageNumber += 1) {
      if (deadline.signal.aborted) throw abortError();
      let page: PDFPageProxy | undefined;
      try {
        page = await raceAbort(loadedDocument.getPage(pageNumber), deadline.signal);
        const content = await raceAbort(page.getTextContent(), deadline.signal);
        const normalized = pageText(content.items);
        const pageCharacters = codePointLength(normalized.text);
        if (pageCharacters > limits.maxPageCodePoints) {
          throw new PdfTextExtractionError("page_text_limit_exceeded", "Page text exceeds the 500,000 code-point extraction limit");
        }
        if (characterCount + pageCharacters > limits.maxRunCodePoints) {
          throw new PdfTextExtractionError("run_text_limit_exceeded", "Run text exceeds the 10,000,000 code-point extraction limit");
        }
        characterCount += pageCharacters;
        succeededPages += 1;
        pages.push({
          pageNumber,
          status: "succeeded",
          text: normalized.text,
          characterCount: pageCharacters,
          textItemCount: normalized.textItemCount,
          error: null,
        });
      } catch (error) {
        if (error instanceof PdfTextExtractionError && ["cancelled", "run_text_limit_exceeded"].includes(error.code)) {
          // A cancellation or run-wide limit invalidates all transient page
          // output. The terminal failed shape has zero page rows.
          throw error;
        }
        failedPages += 1;
        pages.push(pageFailure(pageNumber, error, limits.maxErrorMessageCharacters));
      } finally {
        page?.cleanup();
      }
    }
    if (succeededPages === 0) {
      return globalFailure(new PdfTextExtractionError("no_page_text", "No page could be extracted"), knownPageCount, limits.maxErrorMessageCharacters);
    }
    return {
      status: failedPages === 0 ? "succeeded" : "partial",
      pageCount: knownPageCount,
      pages,
      characterCount,
      error: failedPages === 0 ? null : { code: "page_extraction_issue", message: `${failedPages} page(s) failed extraction` },
      extractorKey: PDFJS_EXTRACTOR_KEY,
      extractorVersion: PDFJS_EXTRACTOR_VERSION,
      algorithmVersion: PDFJS_ALGORITHM_VERSION,
    };
  } catch (error) {
    return globalFailure(error, knownPageCount, limits.maxErrorMessageCharacters);
  } finally {
    try {
      if (loadedDocument) await loadedDocument.cleanup();
    } catch {
      // Cleanup failure must not turn a terminal extraction result into an
      // ambiguous state; the parser result is already complete at this point.
    }
    try {
      await loadingTask?.destroy();
    } catch {
      // PDF.js may already have destroyed the task after a cancellation.
    }
    deadline.cleanup();
  }
}

/** Build the production parser object without leaking any PDF.js API types. */
export function createPdfjsTextExtractionParser(): PdfjsTextExtractionParser {
  return {
    extractorKey: PDFJS_EXTRACTOR_KEY,
    extractorVersion: PDFJS_EXTRACTOR_VERSION,
    algorithmVersion: PDFJS_ALGORITHM_VERSION,
    extract: (bytes, options) => extractPdfText(bytes, {
      signal: options.signal,
      deadlineMs: options.deadlineMs,
      limits: {
        maxPages: options.maxPages,
        maxPageCodePoints: options.maxPageCodePoints,
        maxRunCodePoints: options.maxRunCodePoints,
      },
    }),
  };
}
