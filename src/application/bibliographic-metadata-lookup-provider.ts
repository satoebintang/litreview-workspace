/**
 * Provider-neutral boundary for DOI-backed bibliographic metadata lookup.
 *
 * The contract deliberately contains no provider payload or raw response. A
 * provider may use any external source, but callers only receive bounded
 * researcher-reviewable metadata and bounded transport evidence.
 */

export const BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS = {
  maxDoiCodePoints: 1_000,
  maxTitleCodePoints: 1_000,
  maxVenueCodePoints: 1_000,
  maxAuthorCodePoints: 500,
  maxAuthorCount: 200,
  maxWarnings: 32,
  maxJsonDepth: 32,
  maxJsonVisitedValues: 20_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxAttempts: 3,
  attemptTimeoutMs: 10_000,
} as const;

export const BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION = "bibliographic-metadata-lookup-v1";
export const CROSSREF_WORK_MAPPING_VERSION = "crossref-work-v1";

export type BibliographicMetadataLookupWarningCode =
  | "title_too_long"
  | "venue_too_long"
  | "authors_invalid"
  | "authors_too_many"
  | "publication_year_invalid";

export type BibliographicMetadataLookupWarningField = "title" | "venue" | "authors" | "publicationYear";

export interface BibliographicMetadataLookupWarning {
  code: BibliographicMetadataLookupWarningCode;
  field: BibliographicMetadataLookupWarningField;
}

export interface BibliographicMetadataAuthor {
  given: string | null;
  family: string | null;
  literal: string | null;
  suffix: string | null;
  orcid: string | null;
  displayName: string;
  providerSequence: string | null;
}

export interface BibliographicMetadataSourceSnapshot {
  DOI: string;
  title: string[];
  author: Array<{
    given?: string;
    family?: string;
    name?: string;
    suffix?: string;
    ORCID?: string;
    sequence?: string;
  }> | null;
  authorCount: number | null;
  published: { "date-parts": number[][] } | null;
  "published-print": { "date-parts": number[][] } | null;
  "published-online": { "date-parts": number[][] } | null;
  issued: { "date-parts": number[][] } | null;
  "container-title": string[];
  type: string | null;
  publisher: string | null;
  URL: string | null;
}

/** A bounded proposal; this is not canonical Paper metadata. */
export interface BibliographicMetadataProposal {
  requestedDoi: string;
  returnedDoi: string;
  title: string | null;
  /** null means absent or atomically invalid; contributors are never partial. */
  authors: string[] | null;
  authorDetails: BibliographicMetadataAuthor[] | null;
  publicationYear: number | null;
  venue: string | null;
  providerType: string | null;
  publisher: string | null;
  url: string | null;
  sourceSnapshot: BibliographicMetadataSourceSnapshot;
  warnings: BibliographicMetadataLookupWarning[];
}

export interface BibliographicMetadataLookupEvidence {
  provider: string;
  endpoint: string;
  httpStatus: number | null;
  contentType: string | null;
  responseByteSize: number | null;
  responseSha256: string | null;
  observedRateLimitPerSecond: number | null;
  observedConcurrencyLimit: number | null;
  attemptCount: number;
  startedAt: Date;
  finalizedAt: Date;
}

export type BibliographicMetadataLookupFailureCode =
  | "invalid_doi"
  | "not_found"
  | "doi_mismatch"
  | "invalid_content_type"
  | "invalid_json"
  | "json_depth_exceeded"
  | "json_visited_values_exceeded"
  | "invalid_response_shape"
  | "response_too_large"
  | "redirect_rejected"
  | "redirect_limit_exceeded"
  | "http_error"
  | "rate_limited"
  | "timeout"
  | "tls_error"
  | "network_error"
  | "attempt_accounting_error";

export interface BibliographicMetadataLookupSuccess {
  kind: "success";
  proposal: BibliographicMetadataProposal;
  evidence: BibliographicMetadataLookupEvidence;
}

export interface BibliographicMetadataLookupFailure {
  kind: "failure";
  code: BibliographicMetadataLookupFailureCode;
  evidence: BibliographicMetadataLookupEvidence;
}

export type BibliographicMetadataLookupResult = BibliographicMetadataLookupSuccess | BibliographicMetadataLookupFailure;

export interface BibliographicMetadataLookupInput {
  doi: string;
}

export interface BibliographicMetadataLookupOptions {
  signal?: AbortSignal;
}

/** Every provider GET/retry/redirect is leased through this durable boundary. */
export interface BibliographicMetadataLookupAttempt {
  provider: string;
  doi: string;
  url: string;
  attempt: number;
  redirect: number;
  startedAt: Date;
}

export interface BibliographicMetadataLookupAttemptLease {
  release(outcome?: { status: "succeeded" | "failed"; httpStatus: number | null; outcomeCode: string | null }): Promise<void> | void;
}

export interface BibliographicMetadataLookupAttemptAccounting {
  begin(attempt: BibliographicMetadataLookupAttempt): Promise<BibliographicMetadataLookupAttemptLease>;
}

export interface BibliographicMetadataLookupProvider {
  readonly provider: string;
  readonly contractVersion: string;
  readonly mappingVersion: string;
  lookup(input: BibliographicMetadataLookupInput, options?: BibliographicMetadataLookupOptions): Promise<BibliographicMetadataLookupResult>;
}
