import path from "node:path";
import { getDocument, version as pdfjsVersion } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import { codePointLength, normalizeLineEndings } from "@/domain/unicode-offsets";
import { isPlausibleDoiForComparison, normalizeDoiForComparison } from "@/domain/search-normalization";

/** The parser identity is intentionally pinned to the installed PDF.js API. */
export const PDF_METADATA_INSPECTOR_KEY = "pdfjs-metadata" as const;
export const PDF_METADATA_INSPECTOR_VERSION = pdfjsVersion;
export const PDF_METADATA_ALGORITHM_VERSION = "pdfjs-metadata-v2" as const;

export const PDF_METADATA_LIMITS = Object.freeze({
  maxInputBytes: 50 * 1024 * 1024,
  maxPhysicalPages: 5,
  maxPageCodePoints: 100_000,
  maxTotalCodePoints: 250_000,
  maxMetadataCharacters: 20_000,
  maxAuthors: 64,
  maxDoiOccurrences: 50,
  maxDistinctDoiCandidates: 20,
  deadlineMs: 60_000,
});

export type PdfMetadataFieldName = "title" | "authors" | "publicationYear" | "venue" | "abstract" | "doi";
export type PdfMetadataSourceKind = "xmp" | "info" | "page_text";

export type PdfMetadataSource = Readonly<{
  kind: PdfMetadataSourceKind;
  key: string;
  rawValue: string;
  pageNumber: number | null;
  /** Code-point offsets into the physical page text; null for PDF metadata. */
  startOffset: number | null;
  endOffset: number | null;
  /** PDF Info Author has no structured author grammar and is one ambiguous candidate. */
  ambiguous?: boolean;
  /** Shared comparison-normalized DOI identity, present only for DOI sources. */
  normalizedValue?: string | null;
}>;

export type PdfIntakeMetadata = Readonly<{
  title: string | null;
  authors: readonly string[];
  publicationYear: number | null;
  venue: string | null;
  abstract: string | null;
  doi: string | null;
}>;

export type PdfMetadataField = Readonly<{
  value: string | number | readonly string[] | null;
  /** The first selected source, retained for consumers that need one origin. */
  source: PdfMetadataSource | null;
  /** All source candidates selected for a multi-valued field (authors). */
  provenance: readonly PdfMetadataSource[];
  diagnostic?: string | null;
}>;

export type PdfMetadataPage = Readonly<{
  pageNumber: number;
  text: string;
  characterCount: number;
  error?: Readonly<{ code: string; message: string }> | null;
}>;

export type PdfMetadataInspectionResult = Readonly<{
  status: "succeeded" | "partial" | "failed" | "metadata_failed";
  metadata: PdfIntakeMetadata;
  fields: Readonly<Record<PdfMetadataFieldName, PdfMetadataField>>;
  /** Alias with a stable name for persistence adapters. */
  fieldProvenance: Readonly<Record<PdfMetadataFieldName, readonly PdfMetadataSource[]>>;
  pages: readonly PdfMetadataPage[];
  pageCount: number | null;
  error: Readonly<{ code: string; message: string }> | null;
  inspectorKey: typeof PDF_METADATA_INSPECTOR_KEY;
  inspectorVersion: typeof PDF_METADATA_INSPECTOR_VERSION;
  algorithmVersion: typeof PDF_METADATA_ALGORITHM_VERSION;
}>;

export type PdfMetadataInspectionOptions = Readonly<{
  signal?: AbortSignal;
  deadlineMs?: number;
  limits?: Partial<{
    maxInputBytes: number;
    maxPhysicalPages: number;
    maxPageCodePoints: number;
    maxTotalCodePoints: number;
    maxMetadataCharacters: number;
    maxAuthors: number;
    maxDoiOccurrences: number;
    maxDistinctDoiCandidates: number;
  }>;
}>;

export class PdfMetadataInspectionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PdfMetadataInspectionError";
  }
}

export type PdfMetadataEffectiveLimits = {
  maxInputBytes: number;
  maxPhysicalPages: number;
  maxPageCodePoints: number;
  maxTotalCodePoints: number;
  maxMetadataCharacters: number;
  maxAuthors: number;
  maxDoiOccurrences: number;
  maxDistinctDoiCandidates: number;
};

type EffectiveLimits = PdfMetadataEffectiveLimits;

function effectiveLimits(options: PdfMetadataInspectionOptions): EffectiveLimits {
  const limits = { ...PDF_METADATA_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) throw new PdfMetadataInspectionError("invalid_limit", `${name} must be a positive integer`);
  }
  return limits;
}

function parserDataOptions() {
  const builtinModule = process.getBuiltinModule("module");
  if (!builtinModule) throw new PdfMetadataInspectionError("runtime_unsupported", "Node's built-in module resolver is unavailable");
  const runtimeRequire = builtinModule.createRequire(path.join(process.cwd(), "package.json"));
  const packageRoot = path.dirname(runtimeRequire.resolve("pdfjs-dist/package.json"));
  return {
    cMapUrl: `${path.join(packageRoot, "cmaps")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${path.join(packageRoot, "standard_fonts")}/`,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  };
}

function boundedError(error: unknown, maxCharacters: number) {
  if (error instanceof PdfMetadataInspectionError) return { code: error.code.slice(0, maxCharacters), message: error.message.slice(0, maxCharacters) };
  const candidate = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : undefined;
  const code = candidate?.name && String(candidate.name).trim() ? String(candidate.name).slice(0, maxCharacters) : "metadata_failed";
  const message = candidate?.message ? String(candidate.message) : String(error);
  return { code, message: message.slice(0, maxCharacters) };
}

function blankMetadata(): PdfIntakeMetadata {
  return { title: null, authors: [], publicationYear: null, venue: null, abstract: null, doi: null };
}

function blankFields(): Record<PdfMetadataFieldName, PdfMetadataField> {
  return {
    title: { value: null, source: null, provenance: [] },
    authors: { value: [], source: null, provenance: [] },
    publicationYear: { value: null, source: null, provenance: [] },
    venue: { value: null, source: null, provenance: [] },
    abstract: { value: null, source: null, provenance: [] },
    doi: { value: null, source: null, provenance: [] },
  };
}

function failure(error: unknown, pageCount: number | null, pages: PdfMetadataPage[], maxCharacters: number): PdfMetadataInspectionResult {
  return {
    status: "metadata_failed",
    metadata: blankMetadata(),
    fields: blankFields(),
    fieldProvenance: { title: [], authors: [], publicationYear: [], venue: [], abstract: [], doi: [] },
    pages,
    pageCount,
    error: boundedError(error, maxCharacters),
    inspectorKey: PDF_METADATA_INSPECTOR_KEY,
    inspectorVersion: PDF_METADATA_INSPECTOR_VERSION,
    algorithmVersion: PDF_METADATA_ALGORITHM_VERSION,
  };
}

function normalizeText(value: string, maxCharacters: number) {
  return normalizeLineEndings(value).replace(/\s+/gu, " ").trim().slice(0, maxCharacters);
}

export function isLowInformationPdfTitle(value: string): boolean {
  const normalized = value.trim();
  if (/^(?:untitled|document|document1|anonymous|unspecified|unknown|none|null)$/iu.test(normalized)) return true;
  return /^microsoft\s+word\s*-\s*[^/\\]+\.docx?$/iu.test(normalized);
}

function usefulMetadataValue(value: string) {
  return value.length > 0 && !isLowInformationPdfTitle(value);
}

function nonblankMetadataValue(value: string) {
  return value.length > 0;
}

function stringValues(value: unknown, maxCharacters: number): string[] {
  if (typeof value === "string") return [normalizeText(value, maxCharacters)].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((item) => stringValues(item, maxCharacters));
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const langMap = object._langMap ?? object.langMap;
  if (langMap && typeof langMap === "object") {
    const entries = Object.entries(langMap as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    const preferred = entries.find(([key]) => key.toLowerCase() === "x-default") ?? entries[0];
    return preferred ? stringValues(preferred[1], maxCharacters) : [];
  }
  if ("value" in object) return stringValues(object.value, maxCharacters);
  return [];
}

function getMetadataValues(metadata: unknown, key: string, maxCharacters: number) {
  if (!metadata || typeof metadata !== "object" || !("get" in metadata) || typeof (metadata as { get?: unknown }).get !== "function") return [];
  try { return stringValues((metadata as { get(name: string): unknown }).get(key), maxCharacters); }
  catch { return []; }
}

function infoValues(info: unknown, key: string, maxCharacters: number) {
  if (!info || typeof info !== "object") return [];
  return stringValues((info as Record<string, unknown>)[key], maxCharacters);
}

function source(kind: PdfMetadataSourceKind, key: string, rawValue: string): PdfMetadataSource {
  return { kind, key, rawValue, pageNumber: null, startOffset: null, endOffset: null };
}

function pageSource(key: string, rawValue: string, pageNumber: number, startOffset: number, endOffset: number, normalizedValue: string | null): PdfMetadataSource {
  return { kind: "page_text", key, rawValue, pageNumber, startOffset, endOffset, normalizedValue };
}

function firstSource(metadata: unknown, info: unknown, xmpKeys: string[], infoKeys: string[], maxCharacters: number, filterLowInformation = true) {
  for (const candidate of xmpKeys) {
    const values = getMetadataValues(metadata, candidate, maxCharacters).filter(filterLowInformation ? usefulMetadataValue : nonblankMetadataValue);
    if (values.length > 0) return { values, provenance: [source("xmp", candidate, values[0])] };
  }
  for (const candidate of infoKeys) {
    const values = infoValues(info, candidate, maxCharacters).filter(filterLowInformation ? usefulMetadataValue : nonblankMetadataValue);
    if (values.length > 0) return { values, provenance: [source("info", candidate, values[0])] };
  }
  return { values: [], provenance: [] as PdfMetadataSource[] };
}

function allSources(metadata: unknown, info: unknown, xmpKeys: string[], infoKeys: string[], maxCharacters: number) {
  for (const candidate of xmpKeys) {
    const values = getMetadataValues(metadata, candidate, maxCharacters).filter(usefulMetadataValue);
    if (values.length > 0) return { values, provenance: values.map((value) => source("xmp", candidate, value)) };
  }
  for (const candidate of infoKeys) {
    const values = infoValues(info, candidate, maxCharacters).filter(usefulMetadataValue);
    if (values.length > 0) return { values, provenance: values.map((value) => source("info", candidate, value)) };
  }
  return { values: [], provenance: [] as PdfMetadataSource[] };
}

/**
 * Extract/clean a DOI token from surrounding prose.  This is deliberately
 * separate from comparison normalization: identity grouping always goes
 * through the shared Slice 27 normalization/plausibility contract.
 */
export function extractPdfDoiCandidate(value: string): string | null {
  const match = value.match(/\b10\.\d{4,9}\/[-._;()/:a-z0-9]+/iu);
  if (!match) return null;
  let candidate = match[0];
  candidate = candidate.replace(/[.,;:!?]+$/u, "");
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    while (candidate.endsWith(closing) && (candidate.match(new RegExp(`\\${closing}`, "gu"))?.length ?? 0) > (candidate.match(new RegExp(`\\${opening}`, "gu"))?.length ?? 0)) {
      candidate = candidate.slice(0, -1);
    }
  }
  return candidate || null;
}

export function normalizePdfDoiCandidate(value: string): string | null {
  const candidate = extractPdfDoiCandidate(value);
  return candidate && isPlausibleDoiForComparison(candidate) ? normalizeDoiForComparison(candidate) : null;
}

function findPageMatches(page: PdfMetadataPage, expression: RegExp, key: string): PdfMetadataSource[] {
  const matches: PdfMetadataSource[] = [];
  const globalExpression = new RegExp(expression.source, expression.flags.includes("g") ? expression.flags : `${expression.flags}g`);
  for (const match of page.text.matchAll(globalExpression)) {
    if (match.index == null) continue;
    const value = match[0];
    const normalizedValue = normalizePdfDoiCandidate(value);
    if (!normalizedValue) continue;
    const start = codePointLength(page.text.slice(0, match.index));
    matches.push(pageSource(key, value, page.pageNumber, start, start + codePointLength(value), normalizedValue));
  }
  return matches;
}

function doiFromValue(value: string) {
  return normalizePdfDoiCandidate(value);
}

type DoiCollection = Readonly<{
  sources: readonly PdfMetadataSource[];
  distinct: readonly string[];
  occurrenceLimitReached: boolean;
  distinctLimitReached: boolean;
}>;

function collectDoiSources(candidates: readonly PdfMetadataSource[], limits: EffectiveLimits): DoiCollection {
  const sources: PdfMetadataSource[] = [];
  const distinct: string[] = [];
  const seen = new Set<string>();
  let occurrenceLimitReached = false;
  let distinctLimitReached = false;
  for (const candidate of candidates) {
    const normalized = candidate.normalizedValue ?? doiFromValue(candidate.rawValue);
    if (!normalized) continue;
    if (sources.length >= limits.maxDoiOccurrences) {
      occurrenceLimitReached = true;
      break;
    }
    if (!seen.has(normalized) && seen.size >= limits.maxDistinctDoiCandidates) {
      distinctLimitReached = true;
      break;
    }
    seen.add(normalized);
    sources.push({ ...candidate, normalizedValue: normalized });
    if (!distinct.includes(normalized)) distinct.push(normalized);
  }
  return { sources, distinct, occurrenceLimitReached, distinctLimitReached };
}

/** Parser-neutral metadata mapping seam used by deterministic unit tests. */
export function mapPdfMetadataFromParsed(info: unknown, xmp: unknown, pages: readonly PdfMetadataPage[], limits: EffectiveLimits): { metadata: PdfIntakeMetadata; fields: Record<PdfMetadataFieldName, PdfMetadataField> } {
  const fields = blankFields();
  const title = firstSource(xmp, info, ["dc:title"], ["Title"], limits.maxMetadataCharacters, false);
  const xmpAuthors = allSources(xmp, info, ["dc:creator"], [], limits.maxMetadataCharacters);
  const infoAuthor = infoValues(info, "Author", limits.maxMetadataCharacters).filter(usefulMetadataValue);
  const authors = xmpAuthors.values.length > 0
    ? xmpAuthors
    : { values: infoAuthor, provenance: infoAuthor.map((value) => ({ ...source("info", "Author", value), ambiguous: true })) };
  const year = firstSource(xmp, info, ["prism:publicationDate", "prism:coverDate"], [], limits.maxMetadataCharacters);
  const venue = firstSource(xmp, info, ["prism:publicationName"], [], limits.maxMetadataCharacters);
  const abstract = firstSource(xmp, info, ["dc:description", "prism:abstract"], [], limits.maxMetadataCharacters);
  // DOI extraction is intentionally narrow. Only these semantically defined
  // XMP fields and the bounded early-page text scan are identity sources.
  const doiCandidates = ["dc:identifier", "prism:doi", "pdfx:doi"];
  const doiSources: PdfMetadataSource[] = [];
  for (const candidate of doiCandidates) {
    for (const value of getMetadataValues(xmp, candidate, limits.maxMetadataCharacters)) {
      const normalizedValue = doiFromValue(value);
      if (normalizedValue) doiSources.push({ ...source("xmp", candidate, value), normalizedValue });
    }
  }
  for (const page of pages) doiSources.push(...findPageMatches(page, /\b10\.\d{4,9}\/[-._;()/:a-z0-9]+/iu, "doi"));
  const titleSource = title.provenance[0] ?? null;
  const titleValue = title.values[0] ?? null;
  fields.title = {
    value: titleValue,
    source: titleSource,
    provenance: titleSource ? [titleSource] : [],
    diagnostic: titleValue && isLowInformationPdfTitle(titleValue) ? "low_information_embedded_title" : null,
  };

  const authorSources = authors.provenance.slice(0, limits.maxAuthors);
  const authorValues = authors.values.slice(0, limits.maxAuthors);
  fields.authors = { value: authorValues, source: authorSources[0] ?? null, provenance: authorSources };

  const yearMatch = year.values[0]?.match(/(?:19|20)\d{2}/u)?.[0];
  const yearSource = year.provenance[0] ?? null;
  const yearValue = yearMatch ? Number(yearMatch) : null;
  fields.publicationYear = { value: yearValue, source: yearSource, provenance: yearSource ? [yearSource] : [] };

  const venueValue = venue.values[0] ?? null;
  fields.venue = { value: venueValue, source: venue.provenance[0] ?? null, provenance: venue.provenance };

  const abstractValue = abstract.values[0] ?? null;
  const abstractSource = abstract.provenance[0] ?? null;
  fields.abstract = { value: abstractValue, source: abstractSource ?? null, provenance: abstractSource ? [abstractSource] : [] };

  const doiCollection = collectDoiSources(doiSources, limits);
  const distinctDois = doiCollection.distinct;
  const doiAmbiguous = distinctDois.length > 1 || doiCollection.occurrenceLimitReached || doiCollection.distinctLimitReached;
  const doiSource = doiCollection.sources[0] ?? null;
  const doiDiagnostics = [
    distinctDois.length > 1 ? "multiple_distinct_doi_candidates" : null,
    doiCollection.occurrenceLimitReached ? "doi_occurrence_limit_exhausted" : null,
    doiCollection.distinctLimitReached ? "doi_distinct_candidate_limit_exhausted" : null,
  ].filter((value): value is string => Boolean(value));
  fields.doi = {
    value: doiAmbiguous ? null : distinctDois[0] ?? null,
    source: doiAmbiguous ? null : doiSource,
    provenance: doiCollection.sources,
    diagnostic: doiDiagnostics.length > 0 ? doiDiagnostics.join(";") : null,
  };

  return {
    metadata: {
      title: titleValue,
      authors: authorValues,
      publicationYear: yearValue,
      venue: venueValue,
      abstract: abstractValue,
      doi: doiAmbiguous ? null : distinctDois[0] ?? null,
    },
    fields,
  };
}

function pageText(items: readonly unknown[]): string {
  const textItems = items.filter((item): item is TextItem => Boolean(item && typeof item === "object" && "str" in item && typeof (item as { str?: unknown }).str === "string"));
  return normalizeLineEndings(textItems.map((item) => `${item.str}${item.hasEOL ? "\n" : ""}`).join(""));
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new PdfMetadataInspectionError("cancelled", "PDF metadata inspection was cancelled or exceeded its deadline"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(new PdfMetadataInspectionError("cancelled", "PDF metadata inspection was cancelled or exceeded its deadline")); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

/**
 * Inspect only bounded local bytes.  The caller may stream an HTTP body into
 * PdfIntakeStorage first; this function never fetches URLs or reads beyond
 * the retained <=50 MiB byte view.
 */
export async function inspectPdfMetadata(data: Uint8Array, options: PdfMetadataInspectionOptions = {}): Promise<PdfMetadataInspectionResult> {
  const limits = effectiveLimits(options);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort(); else options.signal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.deadlineMs ?? PDF_METADATA_LIMITS.deadlineMs);
  let task: ReturnType<typeof getDocument> | undefined;
  let document: Awaited<ReturnType<typeof getDocument>["promise"]> | undefined;
  let pageCount: number | null = null;
  const pages: PdfMetadataPage[] = [];
  try {
    if (data.byteLength > limits.maxInputBytes) return failure(new PdfMetadataInspectionError("input_too_large", "PDF exceeds the 50 MiB metadata inspection limit"), null, [], limits.maxMetadataCharacters);
    const ownedData = new Uint8Array(data);
    task = getDocument({ ...parserDataOptions(), data: ownedData });
    document = await raceAbort(task.promise, controller.signal);
    pageCount = document.numPages;
    if (!Number.isInteger(pageCount) || pageCount <= 0) throw new PdfMetadataInspectionError("invalid_page_count", "PDF did not declare a positive page count");
    const metadataResult = await raceAbort(document.getMetadata(), controller.signal);
    let total = 0;
    let pageFailures = 0;
    for (let pageNumber = 1; pageNumber <= Math.min(pageCount, limits.maxPhysicalPages); pageNumber += 1) {
      if (controller.signal.aborted) throw new PdfMetadataInspectionError("cancelled", "PDF metadata inspection was cancelled or exceeded its deadline");
      let page: PDFPageProxy | undefined;
      try {
        page = await raceAbort(document.getPage(pageNumber), controller.signal);
        const content = await raceAbort(page.getTextContent(), controller.signal);
        const text = pageText(content.items);
        const characterCount = codePointLength(text);
        if (characterCount > limits.maxPageCodePoints) throw new PdfMetadataInspectionError("page_text_limit_exceeded", "PDF metadata page text exceeds the configured bound");
        total += characterCount;
        if (total > limits.maxTotalCodePoints) throw new PdfMetadataInspectionError("text_limit_exceeded", "PDF metadata text exceeds the configured bound");
        pages.push({ pageNumber, text, characterCount, error: null });
      } catch (error) {
        if (error instanceof PdfMetadataInspectionError && ["cancelled", "text_limit_exceeded", "page_text_limit_exceeded"].includes(error.code)) throw error;
        pageFailures += 1;
        pages.push({ pageNumber, text: "", characterCount: 0, error: boundedError(error, limits.maxMetadataCharacters) });
      } finally { page?.cleanup(); }
    }
    const parsed = mapPdfMetadataFromParsed(metadataResult.info, metadataResult.metadata, pages, limits);
    const fieldProvenance = Object.fromEntries(Object.entries(parsed.fields).map(([key, value]) => [key, value.provenance])) as Record<PdfMetadataFieldName, readonly PdfMetadataSource[]>;
    return {
      status: pageFailures > 0 ? "partial" : "succeeded",
      metadata: parsed.metadata,
      fields: parsed.fields,
      fieldProvenance,
      pages,
      pageCount,
      error: pageFailures > 0 ? { code: "page_extraction_issue", message: `${pageFailures} physical page(s) could not be inspected` } : null,
      inspectorKey: PDF_METADATA_INSPECTOR_KEY,
      inspectorVersion: PDF_METADATA_INSPECTOR_VERSION,
      algorithmVersion: PDF_METADATA_ALGORITHM_VERSION,
    };
  } catch (error) {
    return failure(error, pageCount, pages, limits.maxMetadataCharacters);
  } finally {
    options.signal?.removeEventListener("abort", onParentAbort);
    clearTimeout(timer);
    try { await document?.cleanup(); } catch { /* best-effort parser cleanup */ }
    try { await task?.destroy(); } catch { /* PDF.js may already be destroyed */ }
  }
}

/** Parser-neutral factory for application services. */
export function createPdfMetadataInspector() {
  return {
    inspectorKey: PDF_METADATA_INSPECTOR_KEY,
    inspectorVersion: PDF_METADATA_INSPECTOR_VERSION,
    algorithmVersion: PDF_METADATA_ALGORITHM_VERSION,
    inspect: inspectPdfMetadata,
  } as const;
}

/** Class form is convenient for dependency injection and test doubles. */
export class PdfMetadataInspector {
  readonly inspectorKey = PDF_METADATA_INSPECTOR_KEY;
  readonly inspectorVersion = PDF_METADATA_INSPECTOR_VERSION;
  readonly algorithmVersion = PDF_METADATA_ALGORITHM_VERSION;
  inspect(data: Uint8Array, options?: PdfMetadataInspectionOptions) {
    return inspectPdfMetadata(data, options);
  }
}
