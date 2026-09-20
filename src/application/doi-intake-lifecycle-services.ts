import { createHash } from "node:crypto";
import { normalizeDoiForComparison, isPlausibleDoiForComparison } from "@/domain/search-normalization";

/**
 * Application-side contract for DOI metadata lookup.  Persistence owns the
 * exact Slice 30 table mapping; this service deliberately does not import the
 * shared schema so that the lifecycle can be integrated independently of the
 * migration/schema worker.
 */

export const DOI_METADATA_CONTRACT_VERSION = "doi-metadata-v1";
export const DOI_METADATA_MAPPING_VERSION = "bounded-provider-snapshot-v1";
export const DOI_POLITE_RATE_PER_SECOND = 10;
export const DOI_MAX_CONCURRENT_GETS = 3;
export const DOI_MAX_HTTP_ATTEMPTS = 3;
export const DOI_MAX_AUTHOR_COUNT = 200;
export const DOI_MAX_AUTHOR_TEXT_BYTES = 256;
export const DOI_MAX_EVIDENCE_COUNT = 32;
export const DOI_MAX_EVIDENCE_TEXT_BYTES = 2_000;
export const DOI_MAX_RESPONSE_BYTES = 2_000_000;

export type DoiIntakeTerminalOutcome =
  | "succeeded"
  | "cache_reused"
  | "not_found"
  | "failed"
  | "outcome_unknown"
  | "deadline_exceeded";

export type DoiIntakeRequestStatus = "created" | "running" | "terminal";

export type DoiIntakeRequest = {
  id: string;
  projectId: string;
  idempotencyKey: string;
  provider: string;
  normalizedDoi: string;
  contractVersion: string;
  mappingVersion: string;
  createdAt: Date;
  deadlineAt: Date;
  status: DoiIntakeRequestStatus;
};

export type DoiMetadataEvidence = {
  field: "title" | "authors" | "publicationYear" | "venue" | "publisher" | "doi" | "url";
  source: string;
  value: string;
};

export type DoiMetadataContributor = {
  given: string | null;
  family: string | null;
  literal: string | null;
  sequence: number | null;
  orcid: string | null;
};

export type DoiMetadataSnapshot = {
  doi: string;
  title: string | null;
  authors: DoiMetadataContributor[] | null;
  authorsProposalState: "valid" | "invalid" | "absent";
  publicationYear: number | null;
  venue: string | null;
  publisher: string | null;
  url: string | null;
  evidence: DoiMetadataEvidence[];
  providerResponseSha256: string | null;
  providerResponseByteLength: number | null;
  providerResponseContentType: string | null;
};

export type DoiProviderSuccessInput = {
  doi?: string | null;
  title?: unknown;
  authors?: unknown;
  publicationYear?: unknown;
  venue?: unknown;
  publisher?: unknown;
  url?: unknown;
  evidence?: unknown;
};

export type DoiProviderResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
  url: string;
};

export type DoiProviderParseResult =
  | { kind: "success"; metadata: DoiProviderSuccessInput }
  | { kind: "not_found"; code?: string }
  | { kind: "retryable"; code?: string; retryAfterMs?: number }
  | { kind: "failed"; code?: string };

export interface DoiMetadataProvider {
  readonly provider: string;
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
  parse(response: DoiProviderResponse, context: { normalizedDoi: string }): DoiProviderParseResult;
}

export interface DoiHttpTransport {
  get(input: { url: string; headers: Record<string, string>; attempt: number }): Promise<DoiProviderResponse>;
}

export type DoiHttpAttempt = {
  id: string;
  requestId: string;
  dispatchId: string;
  attempt: number;
  url: string;
  startedAt: Date;
  completedAt: Date | null;
  status: "started" | "succeeded" | "failed";
  httpStatus: number | null;
  errorCode: string | null;
};

export type DoiDispatchClaim = {
  kind: "claimed" | "busy" | "terminal";
  dispatchId: string;
  leaseToken: string | null;
  recoveredExpiredLease: boolean;
};

export type DoiRateSlot =
  | { kind: "acquired"; leaseId: string }
  | { kind: "wait"; retryAt: Date };

export type DoiCacheEntry = {
  id: string;
  provider: string;
  normalizedDoi: string;
  contractVersion: string;
  mappingVersion: string;
  finalizedAt: Date;
  resultId: string;
  metadata: DoiMetadataSnapshot;
};

export type DoiTerminalResult = {
  id: string;
  requestId: string;
  dispatchId: string;
  outcome: DoiIntakeTerminalOutcome;
  diagnostic: string;
  errorCode: string | null;
  metadata: DoiMetadataSnapshot | null;
  finalizedAt: Date;
  cacheEntryId: string | null;
  canonicalCacheResultId: string | null;
};

export type DoiTerminalPersistenceInput = {
  request: DoiIntakeRequest;
  dispatchId: string;
  outcome: DoiIntakeTerminalOutcome;
  diagnostic: string;
  errorCode: string | null;
  metadata: DoiMetadataSnapshot | null;
  finalizedAt: Date;
  cacheEligible: boolean;
};

export interface DoiIntakeLifecycleStore {
  findRequestByIdempotency(projectId: string, idempotencyKey: string): Promise<DoiIntakeRequest | null>;
  insertRequest(input: Omit<DoiIntakeRequest, "id" | "status">): Promise<DoiIntakeRequest>;
  findRequest(requestId: string, projectId?: string): Promise<DoiIntakeRequest | null>;

  /** Exact global identity; implementations must exclude non-success results. */
  findReusableCache(identity: Pick<DoiIntakeRequest, "provider" | "normalizedDoi" | "contractVersion" | "mappingVersion">, now: Date): Promise<DoiCacheEntry | null>;
  /** Network dispatch creation is idempotent for one request; a retry after a
   * worker crash must reclaim the same dispatch lease rather than bypass it. */
  createDispatch(input: { requestId: string; cacheEntryId: string | null; mode: "network" | "cache_reuse" }): Promise<{ id: string }>;
  /** Must use a short transaction/advisory lock and recover only expired leases. */
  claimDispatch(input: { requestId: string; dispatchId: string; now: Date; leaseMs: number }): Promise<DoiDispatchClaim>;

  claimGlobalHttpSlot(input: { provider: string; now: Date; ratePerSecond: number; maxConcurrency: number }): Promise<DoiRateSlot>;
  releaseGlobalHttpSlot(input: { provider: string; leaseId: string; now: Date }): Promise<void>;
  observeRateLimitHeaders(input: { provider: string; headers: Record<string, string | undefined>; now: Date }): Promise<void>;

  startHttpAttempt(input: { requestId: string; dispatchId: string; attempt: number; url: string; startedAt: Date }): Promise<{ id: string }>;
  finishHttpAttempt(input: { attemptId: string; completedAt: Date; status: "succeeded" | "failed"; httpStatus: number | null; errorCode: string | null }): Promise<void>;

  /** One transaction: immutable terminal result, optional cache result/authors,
   * request terminal state, dispatch link, and canonical-cache selection. */
  persistTerminal(input: DoiTerminalPersistenceInput): Promise<DoiTerminalResult>;
}

export type DoiIntakeClock = () => Date;
export type DoiIntakeSleep = (milliseconds: number) => Promise<void>;

export interface DoiIntakeLifecycleOptions {
  clock?: DoiIntakeClock;
  sleep?: DoiIntakeSleep;
  requestDeadlineMs?: number;
  dispatchLeaseMs?: number;
  persistenceRetries?: number;
  maxResponseBytes?: number;
}

export interface DoiIntakeLifecycleServices {
  begin(input: { projectId: string; idempotencyKey: string; doi: string; provider?: string; deadlineMs?: number }): Promise<{ request: DoiIntakeRequest; reused: boolean }>;
  execute(requestId: string, projectId?: string): Promise<DoiTerminalResult | { state: "in_progress"; request: DoiIntakeRequest }>;
  get(requestId: string, projectId?: string): Promise<DoiIntakeRequest>;
}

function nowDate(clock: DoiIntakeClock): Date { return new Date(clock().getTime()); }
function bytes(value: string): number { return Buffer.byteLength(value, "utf8"); }
function text(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || bytes(trimmed) > maxBytes || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  return trimmed;
}
function boundedInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

export function encodeDoiPath(doi: string): string {
  const normalized = normalizeDoiForComparison(doi);
  if (!normalized || !isPlausibleDoiForComparison(normalized)) throw new Error("A plausible DOI is required");
  // A DOI slash is a path separator.  Encode each component, never the whole
  // DOI, so 10.x/foo/bar remains /10.x/foo/bar rather than /10.x%2Ffoo%2Fbar.
  return normalized.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function buildProviderDoiUrl(baseUrl: string, doi: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  return `${base}/${encodeDoiPath(doi)}`;
}

function normalizeContributor(value: unknown): DoiMetadataContributor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const given = input.given == null ? null : text(input.given, DOI_MAX_AUTHOR_TEXT_BYTES);
  const family = input.family == null ? null : text(input.family, DOI_MAX_AUTHOR_TEXT_BYTES);
  const literal = input.literal == null ? null : text(input.literal, DOI_MAX_AUTHOR_TEXT_BYTES);
  const orcid = input.orcid == null ? null : text(input.orcid, DOI_MAX_AUTHOR_TEXT_BYTES);
  const sequence = input.sequence == null ? null : boundedInteger(input.sequence, 0, DOI_MAX_AUTHOR_COUNT);
  const suppliedName = input.given != null || input.family != null || input.literal != null;
  if ((input.given != null && given == null) || (input.family != null && family == null) || (input.literal != null && literal == null) || (input.orcid != null && orcid == null) || (input.sequence != null && sequence == null)) return null;
  if (!suppliedName || (!literal && !given && !family)) return null;
  return { given, family, literal, sequence, orcid };
}

function normalizeAuthors(value: unknown): { state: DoiMetadataSnapshot["authorsProposalState"]; authors: DoiMetadataContributor[] | null } {
  if (value == null) return { state: "absent", authors: null };
  if (!Array.isArray(value) || value.length > DOI_MAX_AUTHOR_COUNT) return { state: "invalid", authors: null };
  const authors = value.map(normalizeContributor);
  // One unsafe/oversized contributor invalidates the entire proposal.  Never
  // persist a partial author list.
  if (authors.some((author) => author == null)) return { state: "invalid", authors: null };
  return { state: "valid", authors: authors as DoiMetadataContributor[] };
}

function normalizeEvidence(value: unknown): DoiMetadataEvidence[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<DoiMetadataEvidence["field"]>(["title", "authors", "publicationYear", "venue", "publisher", "doi", "url"]);
  return value.slice(0, DOI_MAX_EVIDENCE_COUNT).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const input = candidate as Record<string, unknown>;
    const field = input.field;
    const source = text(input.source, DOI_MAX_EVIDENCE_TEXT_BYTES);
    const evidenceValue = text(input.value, DOI_MAX_EVIDENCE_TEXT_BYTES);
    if (typeof field !== "string" || !allowed.has(field as DoiMetadataEvidence["field"]) || !source || !evidenceValue) return [];
    return [{ field: field as DoiMetadataEvidence["field"], source, value: evidenceValue }];
  });
}

/** Whitelist-only provider mapping.  Raw provider payloads, abstract,
 * references, and unknown fields never cross this boundary. */
export function boundedDoiMetadataSnapshot(input: DoiProviderSuccessInput, context: {
  normalizedDoi: string;
  response?: Pick<DoiProviderResponse, "body" | "headers" | "status">;
  maxResponseBytes?: number;
}): DoiMetadataSnapshot {
  const normalized = normalizeDoiForComparison(input.doi ?? context.normalizedDoi) ?? context.normalizedDoi;
  const authors = normalizeAuthors(input.authors);
  const responseBody = context.response?.body;
  const responseByteLength = responseBody == null ? null : bytes(responseBody);
  const boundedResponse = responseByteLength != null && responseByteLength <= (context.maxResponseBytes ?? DOI_MAX_RESPONSE_BYTES);
  return {
    doi: normalized,
    title: text(input.title, 4_000),
    authors: authors.authors,
    authorsProposalState: authors.state,
    publicationYear: boundedInteger(input.publicationYear, 1000, 3000),
    venue: text(input.venue, 2_000),
    publisher: text(input.publisher, 2_000),
    url: text(input.url, 4_000),
    evidence: normalizeEvidence(input.evidence),
    providerResponseSha256: responseBody != null && boundedResponse ? createHash("sha256").update(Buffer.from(responseBody, "utf8")).digest("hex") : null,
    providerResponseByteLength: responseByteLength,
    providerResponseContentType: text(context.response?.headers["content-type"] ?? context.response?.headers["Content-Type"], 256),
  };
}

function parseRetryAfter(headers: Record<string, string | undefined>, now: Date): number | null {
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? null : Math.max(0, Math.min(timestamp - now.getTime(), 60_000));
}

function isRetryableStatus(status: number): boolean { return status === 408 || status === 425 || status === 429 || status >= 500; }

export function createDoiIntakeLifecycleServices(
  store: DoiIntakeLifecycleStore,
  provider: DoiMetadataProvider,
  transport: DoiHttpTransport,
  options: DoiIntakeLifecycleOptions = {},
): DoiIntakeLifecycleServices {
  const clock = options.clock ?? (() => new Date());
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const requestDeadlineMs = options.requestDeadlineMs ?? 90_000;
  const dispatchLeaseMs = options.dispatchLeaseMs ?? 15_000;
  const persistenceRetries = Math.max(0, options.persistenceRetries ?? 2);
  const pendingPersistence = new Map<string, DoiTerminalPersistenceInput>();

  async function get(requestId: string, projectId?: string) {
    const request = await store.findRequest(requestId, projectId);
    if (!request) throw new Error("DOI intake request was not found");
    return request;
  }

  async function begin(input: { projectId: string; idempotencyKey: string; doi: string; provider?: string; deadlineMs?: number }) {
    const normalizedDoi = normalizeDoiForComparison(input.doi);
    if (!normalizedDoi || !isPlausibleDoiForComparison(normalizedDoi)) throw new Error("A plausible DOI is required");
    const key = input.idempotencyKey.trim();
    if (!key) throw new Error("An idempotency key is required");
    const providerName = input.provider?.trim() || provider.provider;
    const existing = await store.findRequestByIdempotency(input.projectId, key);
    if (existing) {
      if (existing.normalizedDoi !== normalizedDoi || existing.provider !== providerName || existing.contractVersion !== DOI_METADATA_CONTRACT_VERSION || existing.mappingVersion !== DOI_METADATA_MAPPING_VERSION) {
        throw new Error("The idempotency key is already bound to a different DOI lookup");
      }
      return { request: existing, reused: true };
    }
    const createdAt = nowDate(clock);
    const request = await store.insertRequest({
      projectId: input.projectId,
      idempotencyKey: key,
      provider: providerName,
      normalizedDoi,
      contractVersion: DOI_METADATA_CONTRACT_VERSION,
      mappingVersion: DOI_METADATA_MAPPING_VERSION,
      createdAt,
      deadlineAt: new Date(createdAt.getTime() + (input.deadlineMs ?? requestDeadlineMs)),
    });
    return { request, reused: false };
  }

  async function persist(input: DoiTerminalPersistenceInput): Promise<DoiTerminalResult> {
    pendingPersistence.set(input.request.id, input);
    let lastError: unknown;
    for (let attempt = 0; attempt <= persistenceRetries; attempt += 1) {
      try {
        const result = await store.persistTerminal(input);
        pendingPersistence.delete(input.request.id);
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < persistenceRetries) await sleep(Math.min(250 * (attempt + 1), 1_000));
      }
    }
    throw lastError;
  }

  async function execute(requestId: string, projectId?: string): Promise<DoiTerminalResult | { state: "in_progress"; request: DoiIntakeRequest }> {
    const request = await get(requestId, projectId);
    const pending = pendingPersistence.get(request.id);
    if (pending) return persist(pending);
    const reusable = await store.findReusableCache(request, nowDate(clock));
    if (reusable) {
      const dispatch = await store.createDispatch({ requestId: request.id, cacheEntryId: reusable.id, mode: "cache_reuse" });
      return persist({ request, dispatchId: dispatch.id, outcome: "cache_reused", diagnostic: "exact_cache_hit", errorCode: null, metadata: reusable.metadata, finalizedAt: nowDate(clock), cacheEligible: false });
    }
    const dispatch = await store.createDispatch({ requestId: request.id, cacheEntryId: null, mode: "network" });
    const claim = await store.claimDispatch({ requestId: request.id, dispatchId: dispatch.id, now: nowDate(clock), leaseMs: dispatchLeaseMs });
    if (claim.kind === "terminal") return { state: "in_progress", request };
    if (claim.kind === "busy") return { state: "in_progress", request };

    let url = buildProviderDoiUrl(provider.baseUrl, request.normalizedDoi);
    let terminal: Omit<DoiTerminalPersistenceInput, "request" | "dispatchId" | "finalizedAt">;
    for (let attempt = 1; attempt <= DOI_MAX_HTTP_ATTEMPTS; attempt += 1) {
      const now = nowDate(clock);
      if (now >= request.deadlineAt) {
        terminal = { outcome: "deadline_exceeded", diagnostic: "deadline_exceeded", errorCode: "deadline_exceeded", metadata: null, cacheEligible: false };
        break;
      }
      const slot = await store.claimGlobalHttpSlot({ provider: request.provider, now, ratePerSecond: DOI_POLITE_RATE_PER_SECOND, maxConcurrency: DOI_MAX_CONCURRENT_GETS });
      if (slot.kind === "wait") {
        const waitMs = Math.max(1, Math.min(slot.retryAt.getTime() - now.getTime(), request.deadlineAt.getTime() - now.getTime()));
        if (waitMs <= 0) {
          terminal = { outcome: "deadline_exceeded", diagnostic: "deadline_exceeded", errorCode: "deadline_exceeded", metadata: null, cacheEligible: false };
          break;
        }
        await sleep(waitMs);
        attempt -= 1;
        continue;
      }
      const attemptRow = await store.startHttpAttempt({ requestId: request.id, dispatchId: claim.dispatchId, attempt, url, startedAt: now });
      let response: DoiProviderResponse | null = null;
      try {
        response = await transport.get({ url, headers: provider.headers ?? {}, attempt });
        await store.observeRateLimitHeaders({ provider: request.provider, headers: response.headers, now: nowDate(clock) });
        await store.finishHttpAttempt({ attemptId: attemptRow.id, completedAt: nowDate(clock), status: "succeeded", httpStatus: response.status, errorCode: null });
      } catch {
        await store.finishHttpAttempt({ attemptId: attemptRow.id, completedAt: nowDate(clock), status: "failed", httpStatus: null, errorCode: "transport_error" });
        if (attempt === DOI_MAX_HTTP_ATTEMPTS) terminal = { outcome: "outcome_unknown", diagnostic: "transport_error", errorCode: "transport_error", metadata: null, cacheEligible: false };
        else { await store.releaseGlobalHttpSlot({ provider: request.provider, leaseId: slot.leaseId, now: nowDate(clock) }); await sleep(Math.min(1_000 * attempt, 5_000)); continue; }
      }
      await store.releaseGlobalHttpSlot({ provider: request.provider, leaseId: slot.leaseId, now: nowDate(clock) });
      if (!response) break;
      const location = response.headers.location ?? response.headers.Location;
      if (response.status >= 300 && response.status < 400 && location && attempt < DOI_MAX_HTTP_ATTEMPTS) {
        url = new URL(location, url).toString();
        continue;
      }
      if (isRetryableStatus(response.status) && attempt < DOI_MAX_HTTP_ATTEMPTS) {
        const parsedRetry = provider.parse(response, { normalizedDoi: request.normalizedDoi });
        const retryAfter = parsedRetry.kind === "retryable" ? parsedRetry.retryAfterMs : parseRetryAfter(response.headers, nowDate(clock));
        if (retryAfter != null) await sleep(Math.min(retryAfter, Math.max(0, request.deadlineAt.getTime() - nowDate(clock).getTime())));
        else await sleep(Math.min(1_000 * attempt, 5_000));
        continue;
      }
      const parsed = provider.parse(response, { normalizedDoi: request.normalizedDoi });
      if (parsed.kind === "success") terminal = { outcome: "succeeded", diagnostic: "provider_success", errorCode: null, metadata: boundedDoiMetadataSnapshot(parsed.metadata, { normalizedDoi: request.normalizedDoi, response, maxResponseBytes: options.maxResponseBytes }), cacheEligible: true };
      else if (parsed.kind === "not_found") terminal = { outcome: "not_found", diagnostic: "provider_not_found", errorCode: parsed.code ?? "not_found", metadata: null, cacheEligible: false };
      else if (parsed.kind === "retryable") terminal = { outcome: "outcome_unknown", diagnostic: "retry_exhausted", errorCode: parsed.code ?? "retry_exhausted", metadata: null, cacheEligible: false };
      else terminal = { outcome: "failed", diagnostic: "provider_error", errorCode: parsed.code ?? "provider_error", metadata: null, cacheEligible: false };
      break;
    }
    if (!terminal!) terminal = { outcome: "deadline_exceeded", diagnostic: "deadline_exceeded", errorCode: "deadline_exceeded", metadata: null, cacheEligible: false };
    return persist({ request, dispatchId: claim.dispatchId, ...terminal, finalizedAt: nowDate(clock) });
  }

  return { begin, execute, get };
}

// Table names are kept here as the reconciliation seam for the migration and
// schema worker.  This worker intentionally does not edit either shared file.
export const DOI_INTAKE_PERSISTENCE_TABLES = {
  requests: "doi_intake_requests",
  dispatches: "doi_intake_dispatches",
  httpAttempts: "doi_intake_http_attempts",
  cacheResults: "doi_metadata_cache_results",
  cacheAuthors: "doi_metadata_cache_authors",
} as const;
