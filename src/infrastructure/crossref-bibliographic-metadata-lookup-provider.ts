import { createHash } from "node:crypto";
import {
  BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS,
  BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION,
  CROSSREF_WORK_MAPPING_VERSION,
  type BibliographicMetadataAuthor,
  type BibliographicMetadataLookupEvidence,
  type BibliographicMetadataLookupFailureCode,
  type BibliographicMetadataLookupInput,
  type BibliographicMetadataLookupOptions,
  type BibliographicMetadataLookupProvider,
  type BibliographicMetadataLookupResult,
  type BibliographicMetadataLookupSuccess,
  type BibliographicMetadataLookupWarning,
  type BibliographicMetadataProposal,
  type BibliographicMetadataSourceSnapshot,
  type BibliographicMetadataLookupAttemptAccounting,
  type BibliographicMetadataLookupAttemptLease,
} from "@/application/bibliographic-metadata-lookup-provider";
import { isPlausibleDoiForComparison, normalizeDoiForComparison } from "@/domain/search-normalization";

export type {
  BibliographicMetadataLookupAttempt,
  BibliographicMetadataLookupAttemptAccounting,
  BibliographicMetadataLookupAttemptLease,
} from "@/application/bibliographic-metadata-lookup-provider";

const CROSSREF_ORIGIN = "https://api.crossref.org";
const CROSSREF_WORKS_ORIGIN = `${CROSSREF_ORIGIN}/v1/works/`;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 5_000;
const MAX_REDIRECTS = 1;
const PROVIDER_NAME = "crossref";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export interface CrossrefMetadataLookupOptions {
  /** Required in production so Crossref can identify the polite client. */
  mailto: string;
  applicationVersion?: string;
  /** A server-only identifying override. It must not contain control chars. */
  userAgent?: string;
  fetch?: CrossrefMetadataLookupFetch;
  clock?: () => Date;
  sleeper?: (milliseconds: number) => Promise<void>;
  /** Return a non-negative bounded jitter value in milliseconds. */
  jitter?: (attempt: number, maximumMilliseconds: number) => number;
  attemptAccounting?: BibliographicMetadataLookupAttemptAccounting;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

/** Narrow fetch seam for deterministic tests and alternate server runtimes. */
export type CrossrefMetadataLookupFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CrossrefMetadataLookupFetchCall {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
}

/** Shape a fake transport can expose without leaking Crossref wire types. */
export interface CrossrefMetadataLookupFakeTransport {
  readonly calls: CrossrefMetadataLookupFetchCall[];
  readonly fetch: CrossrefMetadataLookupFetch;
}

export const CROSSREF_METADATA_LOOKUP_LIMITS = {
  responseBytes: BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxResponseBytes,
  attemptTimeoutMs: BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.attemptTimeoutMs,
  maxAttempts: BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAttempts,
  maxRedirects: MAX_REDIRECTS,
  maxJsonDepth: BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxJsonDepth,
  maxJsonVisitedValues: BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxJsonVisitedValues,
  retryBaseMs: DEFAULT_RETRY_BASE_MS,
  retryMaxMs: DEFAULT_RETRY_MAX_MS,
} as const;

export function normalizeDoiForMetadataLookup(value: string): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  const normalized = normalizeDoiForComparison(value);
  if (!normalized || Array.from(normalized).length > BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxDoiCodePoints || !isPlausibleDoiForComparison(normalized)) return null;
  return normalized;
}

/** Encode DOI segments individually so DOI slash separators remain path separators. */
export function buildCrossrefWorkUrl(doi: string): string | null {
  const normalized = normalizeDoiForMetadataLookup(doi);
  if (!normalized) return null;
  const path = normalized.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return new URL(path, CROSSREF_WORKS_ORIGIN).toString();
}

function mailtoForUserAgent(value: string): string {
  if (/[\r\n\u0000]/.test(value)) throw new TypeError("mailto must not contain control characters");
  const candidate = value.trim().toLowerCase().startsWith("mailto:") ? value.trim() : `mailto:${value.trim()}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "mailto:" || !parsed.pathname || parsed.search || parsed.hash || /[\u0000-\u001f\u007f-\u009f]/.test(parsed.pathname)) {
    throw new TypeError("mailto must be a URL with a single safe address");
  }
  return parsed.href;
}

function requestEndpointWithMailto(endpoint: string, mailto: string): string {
  const url = new URL(endpoint);
  const address = mailto.slice("mailto:".length);
  url.searchParams.set("mailto", address);
  return url.toString();
}

function safeUserAgent(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /[\r\n\u0000]/.test(trimmed)) throw new TypeError("user-agent must be a bounded identifying value");
  return trimmed;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function safeText(value: unknown, maxCodePoints: number): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  const text = value.trim();
  return text && codePointLength(text) <= maxCodePoints ? text : null;
}

function warning(code: BibliographicMetadataLookupWarning["code"], field: BibliographicMetadataLookupWarning["field"]): BibliographicMetadataLookupWarning {
  return { code, field };
}

function boundedWarnings(warnings: BibliographicMetadataLookupWarning[]): BibliographicMetadataLookupWarning[] {
  return warnings.slice(0, BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxWarnings);
}

function mapSingleTextField(message: Record<string, unknown>, key: string, field: "title" | "venue", warnings: BibliographicMetadataLookupWarning[]): string | null {
  const value = message[key];
  if (!Array.isArray(value) || value.length === 0) return null;
  const max = field === "title" ? BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxTitleCodePoints : BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxVenueCodePoints;
  for (const candidate of value) {
    if (typeof candidate !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(candidate)) continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (codePointLength(trimmed) > max) {
      warnings.push(warning(field === "title" ? "title_too_long" : "venue_too_long", field));
      return null;
    }
    return trimmed;
  }
  return null;
}

type MappedAuthors = {
  names: string[] | null;
  details: BibliographicMetadataAuthor[] | null;
  source: BibliographicMetadataSourceSnapshot["author"];
  count: number | null;
};

function mapAuthors(message: Record<string, unknown>, warnings: BibliographicMetadataLookupWarning[]): MappedAuthors {
  if (!hasOwn(message, "author")) return { names: null, details: null, source: null, count: null };
  const authors = message.author;
  if (!Array.isArray(authors)) {
    warnings.push(warning("authors_invalid", "authors"));
    return { names: null, details: null, source: null, count: null };
  }
  if (authors.length > BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAuthorCount) {
    warnings.push(warning("authors_too_many", "authors"));
    return { names: null, details: null, source: null, count: authors.length };
  }
  const mapped: string[] = [];
  const details: BibliographicMetadataAuthor[] = [];
  const source: NonNullable<BibliographicMetadataSourceSnapshot["author"]> = [];
  for (const contributor of authors) {
    if (!isRecord(contributor)) {
      warnings.push(warning("authors_invalid", "authors"));
      return { names: null, details: null, source: null, count: authors.length };
    }
    for (const key of ["given", "family", "suffix", "name", "ORCID", "sequence"]) {
      if (hasOwn(contributor, key) && contributor[key] !== null && typeof contributor[key] !== "string") {
        warnings.push(warning("authors_invalid", "authors"));
        return { names: null, details: null, source: null, count: authors.length };
      }
      if (typeof contributor[key] === "string" && (/[\u0000-\u001f\u007f-\u009f]/.test(contributor[key] as string) || codePointLength((contributor[key] as string).trim()) > BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAuthorCodePoints)) {
        warnings.push(warning("authors_invalid", "authors"));
        return { names: null, details: null, source: null, count: authors.length };
      }
    }
    const literal = safeText(contributor.name, BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAuthorCodePoints);
    const given = safeText(contributor.given, BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAuthorCodePoints);
    const family = safeText(contributor.family, BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAuthorCodePoints);
    const suffix = safeText(contributor.suffix, BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAuthorCodePoints);
    const orcid = safeText(contributor.ORCID, 200);
    const providerSequence = safeText(contributor.sequence, 32);
    const parts = literal ? [literal] : [given, family, suffix].filter((part): part is string => Boolean(part));
    const candidate = parts.join(" ").trim();
    if (!candidate || codePointLength(candidate) > BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAuthorCodePoints) {
      warnings.push(warning("authors_invalid", "authors"));
      return { names: null, details: null, source: null, count: authors.length };
    }
    mapped.push(candidate);
    details.push({ given, family, literal, suffix, orcid, displayName: candidate, providerSequence });
    const boundedSource: NonNullable<BibliographicMetadataSourceSnapshot["author"]>[number] = {};
    if (given) boundedSource.given = given;
    if (family) boundedSource.family = family;
    if (literal) boundedSource.name = literal;
    if (suffix) boundedSource.suffix = suffix;
    if (orcid) boundedSource.ORCID = orcid;
    if (providerSequence) boundedSource.sequence = providerSequence;
    source.push(boundedSource);
  }
  return { names: mapped, details, source, count: authors.length };
}

const YEAR_FIELDS = ["published", "published-print", "published-online", "issued"] as const;

function publicationYear(message: Record<string, unknown>, warnings: BibliographicMetadataLookupWarning[]): number | null {
  let sawCandidate = false;
  for (const field of YEAR_FIELDS) {
    const date = message[field];
    if (date === undefined) continue;
    sawCandidate = true;
    if (!isRecord(date) || !Array.isArray(date["date-parts"])) continue;
    const firstParts = date["date-parts"][0];
    const year = Array.isArray(firstParts) ? firstParts[0] : null;
    if (typeof year === "number" && Number.isInteger(year) && year >= 1000 && year <= 3000) return year;
  }
  if (sawCandidate) warnings.push(warning("publication_year_invalid", "publicationYear"));
  return null;
}

function boundedStringArray(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > 32) return [];
  const mapped = value.map((item) => safeText(item, maximum));
  return mapped.every((item): item is string => item !== null) ? mapped : [];
}

function boundedDate(value: unknown): { "date-parts": number[][] } | null {
  if (!isRecord(value) || !Array.isArray(value["date-parts"]) || value["date-parts"].length > 4) return null;
  const parts = value["date-parts"].map((part) => Array.isArray(part) && part.length <= 4 && part.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 9999) ? part : null);
  if (!parts.every((part): part is number[] => part !== null)) return null;
  return { "date-parts": parts };
}

function mapSourceSnapshot(message: Record<string, unknown>, authors: MappedAuthors): BibliographicMetadataSourceSnapshot {
  return {
    DOI: String(message.DOI).trim().toLowerCase(),
    title: boundedStringArray(message.title, BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxTitleCodePoints),
    author: authors.source,
    authorCount: authors.count,
    published: boundedDate(message.published),
    "published-print": boundedDate(message["published-print"]),
    "published-online": boundedDate(message["published-online"]),
    issued: boundedDate(message.issued),
    "container-title": boundedStringArray(message["container-title"], BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxVenueCodePoints),
    type: safeText(message.type, 200),
    publisher: safeText(message.publisher, BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxVenueCodePoints),
    URL: safeText(message.URL, 2048),
  };
}

function mapProposal(requestedDoi: string, message: Record<string, unknown>, warnings: BibliographicMetadataLookupWarning[]): BibliographicMetadataProposal {
  const authors = mapAuthors(message, warnings);
  return {
    requestedDoi,
    returnedDoi: String(message.DOI).trim().toLowerCase(),
    title: mapSingleTextField(message, "title", "title", warnings),
    authors: authors.names,
    authorDetails: authors.details,
    publicationYear: publicationYear(message, warnings),
    venue: mapSingleTextField(message, "container-title", "venue", warnings),
    providerType: safeText(message.type, 200),
    publisher: safeText(message.publisher, BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxVenueCodePoints),
    url: safeText(message.URL, 2048),
    sourceSnapshot: mapSourceSnapshot(message, authors),
    warnings: boundedWarnings(warnings),
  };
}

function jsonBounds(value: unknown): "json_depth_exceeded" | "json_visited_values_exceeded" | null {
  let visited = 0;
  const visit = (current: unknown, depth: number): "json_depth_exceeded" | "json_visited_values_exceeded" | null => {
    visited += 1;
    if (visited > BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxJsonVisitedValues) return "json_visited_values_exceeded";
    if (depth > BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxJsonDepth) return "json_depth_exceeded";
    if (Array.isArray(current)) {
      for (const child of current) {
        const result = visit(child, depth + 1);
        if (result) return result;
      }
    } else if (isRecord(current)) {
      for (const child of Object.values(current)) {
        const result = visit(child, depth + 1);
        if (result) return result;
      }
    } else if (typeof current === "number" && !Number.isFinite(current)) {
      return "json_visited_values_exceeded";
    }
    return null;
  };
  return visit(value, 0);
}

function parseRetryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.max(0, Number(trimmed) * 1_000);
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now.getTime()) : null;
}

function observedRateLimit(headers: Headers): { rateLimitPerSecond: number | null; concurrencyLimit: number | null } {
  const rate = Number(headers.get("x-rate-limit-limit") ?? "");
  const interval = (headers.get("x-rate-limit-interval") ?? "1s").trim().toLowerCase();
  const concurrency = Number(headers.get("x-concurrency-limit") ?? "");
  const intervalSeconds = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(interval)?.[1];
  const ratePerSecond = Number.isFinite(rate) && rate > 0
    ? Math.max(1, Math.floor(rate / (intervalSeconds ? Number(intervalSeconds) : 1)))
    : null;
  return {
    rateLimitPerSecond: ratePerSecond,
    concurrencyLimit: Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : null,
  };
}

function retryDelay(attempt: number, retryAfter: number | null, baseMs: number, maxMs: number, jitter: (attempt: number, maximumMilliseconds: number) => number): number {
  if (retryAfter != null) return Math.min(maxMs, retryAfter);
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  const extra = Math.max(0, Math.min(maxMs - exponential, jitter(attempt, exponential)));
  return Math.min(maxMs, exponential + extra);
}

function classifyTransportError(error: unknown): "timeout" | "tls_error" | "network_error" {
  if (isRecord(error) && error.name === "AbortError") return "timeout";
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  const message = isRecord(error) && typeof error.message === "string" ? error.message : "";
  if (TLS_ERROR_CODES.has(code) || /\b(?:tls|certificate|cert|secure connection)\b/i.test(message)) return "tls_error";
  return "network_error";
}

function isRetryableFailure(code: string): boolean {
  return code === "timeout" || code === "network_error";
}

function evidence(startedAt: Date, finalizedAt: Date, endpoint: string, attemptCount: number, overrides: Partial<BibliographicMetadataLookupEvidence> = {}): BibliographicMetadataLookupEvidence {
  return {
    provider: PROVIDER_NAME,
    endpoint,
    httpStatus: null,
    contentType: null,
    responseByteSize: null,
    responseSha256: null,
    observedRateLimitPerSecond: null,
    observedConcurrencyLimit: null,
    attemptCount,
    startedAt,
    finalizedAt,
    ...overrides,
  };
}

function failure(code: BibliographicMetadataLookupFailureCode, base: BibliographicMetadataLookupEvidence): BibliographicMetadataLookupResult {
  return { kind: "failure", code, evidence: base };
}

function combineSignals(parent: AbortSignal | undefined, child: AbortController): (() => void) {
  if (!parent) return () => undefined;
  const abort = () => child.abort();
  if (parent.aborted) child.abort();
  else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

async function readResponseBytes(response: Response): Promise<{ bytes: Uint8Array } | { code: "response_too_large" | "network_error" }> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxResponseBytes) return { code: "response_too_large" };
  if (!response.body) return { bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxResponseBytes) {
        await reader.cancel();
        return { code: "response_too_large" };
      }
      chunks.push(item.value);
    }
  } catch {
    return { code: "network_error" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

function contentTypeIsJson(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json" || contentType?.endsWith("+json") === true;
}

function redirectUrl(current: string, response: Response): string | null {
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    const next = new URL(location, current);
    if (next.protocol !== "https:" || next.origin !== CROSSREF_ORIGIN || (!next.pathname.startsWith("/v1/works/") && !next.pathname.startsWith("/works/"))) return null;
    return next.toString();
  } catch {
    return null;
  }
}

export class CrossrefBibliographicMetadataLookupProvider implements BibliographicMetadataLookupProvider {
  readonly provider = PROVIDER_NAME;
  readonly contractVersion = BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION;
  readonly mappingVersion = CROSSREF_WORK_MAPPING_VERSION;
  private readonly mailto: string;
  private readonly userAgent: string;
  private readonly fetchImpl: CrossrefMetadataLookupFetch;
  private readonly clock: () => Date;
  private readonly sleeper: (milliseconds: number) => Promise<void>;
  private readonly jitter: (attempt: number, maximumMilliseconds: number) => number;
  private readonly accounting: BibliographicMetadataLookupAttemptAccounting;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(options: CrossrefMetadataLookupOptions) {
    this.mailto = mailtoForUserAgent(options.mailto);
    this.userAgent = safeUserAgent(options.userAgent ?? `Tracework/0.30.0 (${this.mailto})`);
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? (() => new Date());
    this.sleeper = options.sleeper ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.jitter = options.jitter ?? ((_attempt, maximumMilliseconds) => Math.random() * Math.max(0, Math.min(100, maximumMilliseconds)));
    this.accounting = options.attemptAccounting ?? { begin: async () => ({ release: () => undefined }) };
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS);
  }

  async lookup(input: BibliographicMetadataLookupInput, options: BibliographicMetadataLookupOptions = {}): Promise<BibliographicMetadataLookupResult> {
    const startedAt = this.clock();
    const doi = normalizeDoiForMetadataLookup(input.doi);
    const baseEndpoint = doi ? buildCrossrefWorkUrl(doi) : null;
    const initialEndpoint = baseEndpoint ? requestEndpointWithMailto(baseEndpoint, this.mailto) : null;
    const recordedEndpoint = baseEndpoint ?? CROSSREF_WORKS_ORIGIN;
    if (!doi || !initialEndpoint) return failure("invalid_doi", evidence(startedAt, this.clock(), recordedEndpoint, 0));

    let attemptCount = 0;
    let retryNumber = 0;
    let url = initialEndpoint;
    while (attemptCount < BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAttempts) {
      retryNumber += 1;
      let redirectCount = 0;
      while (attemptCount < BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAttempts) {
        const attemptOrdinal = attemptCount + 1;
        attemptCount = attemptOrdinal;
        const attemptStartedAt = this.clock();
        let lease: BibliographicMetadataLookupAttemptLease;
        try {
          lease = await this.accounting.begin({ provider: PROVIDER_NAME, doi, url, attempt: attemptOrdinal, redirect: redirectCount, startedAt: attemptStartedAt });
        } catch {
          return failure("attempt_accounting_error", evidence(startedAt, this.clock(), recordedEndpoint, attemptCount));
        }
        const controller = new AbortController();
        const detach = combineSignals(options.signal, controller);
        const timeout = setTimeout(() => controller.abort(), BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.attemptTimeoutMs);
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: "GET",
            headers: {
              Accept: "application/vnd.crossref-api-message+json, application/json",
              "User-Agent": this.userAgent,
            },
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          clearTimeout(timeout);
          detach();
          const code = classifyTransportError(error);
          await lease.release({ status: "failed", httpStatus: null, outcomeCode: code });
          if (isRetryableFailure(code) && attemptCount < BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAttempts) {
            await this.sleeper(retryDelay(retryNumber, null, this.retryBaseMs, this.retryMaxMs, this.jitter));
            break;
          }
          return failure(code, evidence(startedAt, this.clock(), recordedEndpoint, attemptCount));
        }
        const observed = observedRateLimit(response.headers);
        const responseContentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
        const responseEvidence = {
          httpStatus: response.status,
          contentType: responseContentType,
          observedRateLimitPerSecond: observed.rateLimitPerSecond,
          observedConcurrencyLimit: observed.concurrencyLimit,
        };
        if (REDIRECT_STATUSES.has(response.status)) {
          const next = redirectUrl(url, response);
          await response.body?.cancel();
          clearTimeout(timeout);
          detach();
          await lease.release({ status: "succeeded", httpStatus: response.status, outcomeCode: "redirect" });
          if (!next) return failure("redirect_rejected", evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, responseEvidence));
          redirectCount += 1;
          if (redirectCount > MAX_REDIRECTS || attemptCount >= BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAttempts) return failure("redirect_limit_exceeded", evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, responseEvidence));
          url = requestEndpointWithMailto(next, this.mailto);
          continue;
        }

        if (response.status === 404) {
          await response.body?.cancel();
          clearTimeout(timeout);
          detach();
          await lease.release({ status: "succeeded", httpStatus: response.status, outcomeCode: "not_found" });
          return failure("not_found", evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, responseEvidence));
        }
        if (response.status < 200 || response.status >= 300) {
          const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.clock());
          await response.body?.cancel();
          clearTimeout(timeout);
          detach();
          await lease.release({ status: "succeeded", httpStatus: response.status, outcomeCode: response.status === 429 ? "rate_limited" : "http_error" });
          if (response.status === 429 && (retryAfter == null || retryAfter > 2_000)) return failure("rate_limited", evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, responseEvidence));
          if (RETRYABLE_STATUSES.has(response.status) && attemptCount < BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxAttempts) {
            await this.sleeper(retryDelay(retryNumber, retryAfter, this.retryBaseMs, this.retryMaxMs, this.jitter));
            break;
          }
          const code: BibliographicMetadataLookupFailureCode = response.status === 429 ? "rate_limited" : "http_error";
          return failure(code, evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, responseEvidence));
        }
        if (!contentTypeIsJson(response)) {
          await response.body?.cancel();
          clearTimeout(timeout);
          detach();
          await lease.release({ status: "succeeded", httpStatus: response.status, outcomeCode: "invalid_content_type" });
          return failure("invalid_content_type", evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, responseEvidence));
        }

        const bounded = await readResponseBytes(response);
        clearTimeout(timeout);
        detach();
        if ("code" in bounded) {
          await lease.release({ status: "failed", httpStatus: response.status, outcomeCode: bounded.code });
          return failure(bounded.code, evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, responseEvidence));
        }
        await lease.release({ status: "succeeded", httpStatus: response.status, outcomeCode: "response_received" });
        const bodySha256 = createHash("sha256").update(bounded.bytes).digest("hex");
        const bodyEvidence = { ...responseEvidence, responseByteSize: bounded.bytes.byteLength, responseSha256: bodySha256 };
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes)) as unknown;
        } catch {
          return failure("invalid_json", evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, bodyEvidence));
        }
        const boundsFailure = jsonBounds(parsed);
        if (boundsFailure) return failure(boundsFailure, evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, bodyEvidence));
        if (!isRecord(parsed) || !isRecord(parsed.message)) return failure("invalid_response_shape", evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, bodyEvidence));
        const returnedDoi = typeof parsed.message.DOI === "string" ? normalizeDoiForMetadataLookup(parsed.message.DOI) : null;
        if (!returnedDoi || returnedDoi !== doi) return failure("doi_mismatch", evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, bodyEvidence));
        const proposal = mapProposal(doi, parsed.message, []);
        const success: BibliographicMetadataLookupSuccess = { kind: "success", proposal, evidence: evidence(startedAt, this.clock(), recordedEndpoint, attemptCount, bodyEvidence) };
        return success;
      }
    }
    return failure("network_error", evidence(startedAt, this.clock(), recordedEndpoint, attemptCount));
  }
}

export function createCrossrefBibliographicMetadataLookupProvider(options: CrossrefMetadataLookupOptions): BibliographicMetadataLookupProvider {
  return new CrossrefBibliographicMetadataLookupProvider(options);
}
