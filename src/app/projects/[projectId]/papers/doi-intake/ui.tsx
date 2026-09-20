import { doiLookupServices, doiResolutionServices } from "@/app/server";

type UnknownRecord = Record<string, unknown>;

export type DoiLookupRequestSummary = {
  id: string;
  doi: string;
  provider: string;
  status: string;
  outcome: string | null;
  diagnostic: string | null;
  createdAt: string | null;
  finalizedAt: string | null;
};

export type DoiProposalView = {
  doi: string | null;
  title: string | null;
  authors: string[];
  publicationYear: number | null;
  venue: string | null;
  publisher: string | null;
  url: string | null;
  authorsState: string | null;
};

export type DoiSourceDiagnosticsView = {
  outcome: string | null;
  diagnosticCode: string | null;
  diagnosticMessage: string | null;
  responseContentType: string | null;
  responseByteSize: number | null;
  responseSha256: string | null;
  providerDoi: string | null;
  durationMs: number | null;
  observedRateLimitPerSecond: number | null;
  observedConcurrencyLimit: number | null;
};

export type DoiFetchView = {
  id: string;
  provider: string;
  normalizedDoi: string;
  executionIdentity: string | null;
  startedAt: string | null;
  deadlineAt: string | null;
  rateLimitPerSecond: number | null;
  concurrencyLimit: number | null;
};

export type DoiNetworkAttemptView = {
  id: string;
  ordinal: number | null;
  requestUrl: string | null;
  status: string;
  httpStatus: number | null;
  outcomeCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type DoiDispatchView = {
  id: string;
  sequence: number | null;
  kind: string;
  createdAt: string | null;
};

export type DoiCandidateView = {
  id: string;
  title: string;
  authors: string[];
  publicationYear: number | null;
  venue: string | null;
  doi: string | null;
  reason: string | null;
};

export type DoiResolutionView = {
  id: string;
  sequence: number | null;
  kind: string;
  paperId: string | null;
  note: string | null;
  createdAt: string | null;
};

export type DoiLookupDetailView = {
  request: DoiLookupRequestSummary;
  result: { id: string; outcome: string } | null;
  proposal: DoiProposalView | null;
  diagnostics: DoiSourceDiagnosticsView | null;
  fetch: DoiFetchView | null;
  attempts: DoiNetworkAttemptView[];
  dispatches: DoiDispatchView[];
  candidates: DoiCandidateView[];
  resolutions: DoiResolutionView[];
  paperOptions: DoiCandidateView[];
  resolutionPreview: { fingerprint: string; expectedPreviousResolutionId: string | null; payload: Record<string, unknown> | null } | null;
};

export type DoiUiLandingView = {
  configured: boolean;
  requests: DoiLookupRequestSummary[];
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateValue(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function first(recordValue: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) if (recordValue[key] !== undefined) return recordValue[key];
  return undefined;
}

function authorName(value: unknown): string | null {
  if (typeof value === "string") return stringValue(value);
  const author = record(value);
  const literal = stringValue(first(author, "literal", "literalName", "displayName"));
  if (literal) return literal;
  const given = stringValue(first(author, "given", "givenName"));
  const family = stringValue(first(author, "family", "familyName"));
  return [given, family].filter(Boolean).join(" ") || null;
}

function authors(value: unknown): string[] {
  return arrayValue(value).map(authorName).filter((author): author is string => Boolean(author));
}

function requestSummary(value: unknown): DoiLookupRequestSummary {
  const item = record(value);
  const result = record(first(item, "result", "terminalResult"));
  return {
    id: stringValue(first(item, "id", "requestId")) ?? "unknown",
    doi: stringValue(first(item, "normalizedDoi", "doi", "submittedDoi")) ?? "",
    provider: stringValue(item.provider) ?? "unknown",
    status: stringValue(first(item, "status", "state")) ?? "unknown",
    outcome: stringValue(first(item, "outcome", "terminalOutcome", "resultOutcome", "result.outcome")) ?? stringValue(result.outcome),
    diagnostic: stringValue(first(item, "diagnostic", "diagnosticCode", "resultDiagnostic")) ?? stringValue(result.diagnosticCode),
    createdAt: dateValue(first(item, "createdAt", "created_at")),
    finalizedAt: dateValue(first(item, "finalizedAt", "finalized_at")) ?? dateValue(result.finalizedAt),
  };
}

function proposalView(value: unknown): DoiProposalView | null {
  const item = record(value);
  const proposal = record(first(item, "proposal", "metadata", "sourceSnapshot"));
  const title = stringValue(first(proposal, "title", "proposedTitle"));
  const doi = stringValue(first(proposal, "doi", "returnedDoi", "providerDoi"));
  const proposalAuthors = authors(proposal.authors);
  const publicationYear = numberValue(first(proposal, "publicationYear", "proposedPublicationYear"));
  const venue = stringValue(first(proposal, "venue", "proposedVenue"));
  const publisher = stringValue(first(proposal, "publisher", "providerPublisher"));
  const url = stringValue(first(proposal, "url", "providerUrl"));
  const authorsState = stringValue(first(proposal, "authorsState", "authorsProposalState"));
  if (!title && !doi && proposalAuthors.length === 0 && publicationYear == null && !venue && !publisher && !url) return null;
  return { doi, title, authors: proposalAuthors, publicationYear, venue, publisher, url, authorsState };
}

function diagnosticsView(value: unknown): DoiSourceDiagnosticsView | null {
  const item = record(first(record(value), "diagnostics", "sourceDiagnostics", "result", "terminalResult"));
  if (Object.keys(item).length === 0) return null;
  return {
    outcome: stringValue(item.outcome),
    diagnosticCode: stringValue(first(item, "diagnosticCode", "errorCode", "code")),
    diagnosticMessage: stringValue(first(item, "diagnosticMessage", "diagnostic", "message")),
    responseContentType: stringValue(first(item, "responseContentType", "contentType")),
    responseByteSize: numberValue(first(item, "responseByteSize", "responseBytes")),
    responseSha256: stringValue(first(item, "responseSha256", "responseHash")),
    providerDoi: stringValue(first(item, "providerDoi", "returnedDoi")),
    durationMs: numberValue(item.durationMs),
    observedRateLimitPerSecond: numberValue(item.observedRateLimitPerSecond),
    observedConcurrencyLimit: numberValue(item.observedConcurrencyLimit),
  };
}

function fetchView(value: unknown): DoiFetchView | null {
  const item = record(first(record(value), "fetch", "metadataFetch"));
  if (!stringValue(item.id)) return null;
  return {
    id: stringValue(item.id) ?? "unknown",
    provider: stringValue(item.provider) ?? "unknown",
    normalizedDoi: stringValue(first(item, "normalizedDoi", "doi")) ?? "",
    executionIdentity: stringValue(item.executionIdentity),
    startedAt: dateValue(first(item, "startedAt", "started_at")),
    deadlineAt: dateValue(first(item, "deadlineAt", "deadline_at")),
    rateLimitPerSecond: numberValue(first(item, "rateLimitPerSecond", "rate_limit_per_second")),
    concurrencyLimit: numberValue(first(item, "concurrencyLimit", "concurrency_limit")),
  };
}

function attemptView(value: unknown): DoiNetworkAttemptView {
  const item = record(value);
  return {
    id: stringValue(item.id) ?? "unknown",
    ordinal: numberValue(first(item, "attemptOrdinal", "attempt_ordinal", "ordinal", "attempt")),
    requestUrl: stringValue(first(item, "requestUrl", "request_url", "url")),
    status: stringValue(item.status) ?? "unknown",
    httpStatus: numberValue(first(item, "httpStatus", "http_status", "lastHttpStatus")),
    outcomeCode: stringValue(first(item, "outcomeCode", "outcome_code", "errorCode")),
    startedAt: dateValue(first(item, "startedAt", "started_at")),
    completedAt: dateValue(first(item, "completedAt", "completed_at")),
  };
}

function dispatchView(value: unknown): DoiDispatchView {
  const item = record(value);
  return {
    id: stringValue(item.id) ?? "unknown",
    sequence: numberValue(item.sequence),
    kind: stringValue(first(item, "dispatchKind", "dispatch_kind", "kind")) ?? "unknown",
    createdAt: dateValue(first(item, "createdAt", "created_at")),
  };
}

function candidateView(value: unknown): DoiCandidateView {
  const item = record(value);
  return {
    id: stringValue(first(item, "id", "paperId")) ?? "unknown",
    title: stringValue(item.title) ?? "Untitled Paper",
    authors: authors(item.authors),
    publicationYear: numberValue(first(item, "publicationYear", "publication_year")),
    venue: stringValue(item.venue),
    doi: stringValue(item.doi),
    reason: stringValue(first(item, "reason", "candidateReason", "candidate_reason")),
  };
}

function resolutionView(value: unknown): DoiResolutionView {
  const item = record(value);
  return {
    id: stringValue(item.id) ?? "unknown",
    sequence: numberValue(item.sequence),
    kind: stringValue(first(item, "resolutionKind", "resolution_kind", "kind", "eventType")) ?? "unknown",
    paperId: stringValue(first(item, "paperId", "paper_id")),
    note: stringValue(item.note),
    createdAt: dateValue(first(item, "createdAt", "created_at")),
  };
}

function listItems(value: unknown, ...keys: string[]): unknown[] {
  const item = record(value);
  const direct = keys.map((key) => item[key]).find(Array.isArray);
  return arrayValue(direct ?? value);
}

export async function loadDoiIntakeLanding(projectId: string): Promise<DoiUiLandingView> {
  if (!doiLookupServices) return { configured: false, requests: [] };
  const result = await doiLookupServices.listDoiLookupRequests(projectId);
  return { configured: true, requests: listItems(result, "requests", "items").map(requestSummary) };
}

export async function loadDoiLookupDetail(projectId: string, requestId: string): Promise<{ configured: boolean; detail: DoiLookupDetailView | null }> {
  if (!doiLookupServices) return { configured: false, detail: null };
  const raw = await doiLookupServices.getDoiLookupRequest(projectId, requestId);
  if (!raw) return { configured: true, detail: null };
  const item = record(raw);
  const request = requestSummary(first(item, "request") ?? item);
  const candidates = listItems(item, "candidates", "candidatePapers").map(candidateView);
  const paperOptions = listItems(item, "paperOptions", "papers").map(candidateView);
  let resolutionPreview: DoiLookupDetailView["resolutionPreview"] = null;
  const result = record(first(item, "result"));
  if (stringValue(result.id) && String(result.outcome) === "succeeded") {
    try {
      const preview = await doiResolutionServices.previewResolution(projectId, requestId, { action: "created_paper", resultId: String(result.id) });
      resolutionPreview = { fingerprint: preview.fingerprint, expectedPreviousResolutionId: preview.expectedPreviousResolutionId, payload: preview.payload as unknown as Record<string, unknown> | null };
    } catch {
      resolutionPreview = null;
    }
  }
  return {
    configured: true,
    detail: {
      request,
      result: stringValue(result.id) ? { id: String(result.id), outcome: String(result.outcome ?? "") } : null,
      proposal: proposalView(item),
      diagnostics: diagnosticsView(item),
      fetch: fetchView(item),
      attempts: listItems(item, "attempts", "httpAttempts", "networkAttempts").map(attemptView),
      dispatches: listItems(item, "dispatches", "history").map(dispatchView),
      candidates,
      resolutions: listItems(item, "resolutions", "resolutionHistory", "decisions").map(resolutionView),
      paperOptions: paperOptions.length > 0 ? paperOptions : candidates,
      resolutionPreview,
    },
  };
}

export function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

export function displayAuthors(authorsList: string[]): string {
  return authorsList.length ? authorsList.join(", ") : "Not reported";
}
