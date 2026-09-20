/** Stable application entry point for Slice 30 DOI lookup lifecycle work.
 *
 * The `db` argument is deliberately a narrow persistence port until the
 * migration/schema worker lands the exact Drizzle mapping.  The adapter must
 * implement each method transactionally; no method is allowed to hold a
 * transaction open while the injected transport performs HTTP.
 */
import {
  createDoiIntakeLifecycleServices,
  type DoiHttpTransport,
  type DoiIntakeLifecycleOptions,
  type DoiIntakeLifecycleServices,
  type DoiIntakeLifecycleStore,
  type DoiMetadataProvider,
} from "@/application/doi-intake-lifecycle-services";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION,
  BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS,
  CROSSREF_WORK_MAPPING_VERSION,
  type BibliographicMetadataLookupAttempt,
  type BibliographicMetadataLookupAttemptAccounting,
  type BibliographicMetadataLookupProvider,
  type BibliographicMetadataLookupResult,
} from "@/application/bibliographic-metadata-lookup-provider";
import { normalizeDoiForMetadataLookup } from "@/infrastructure/crossref-bibliographic-metadata-lookup-provider";
import { DomainError } from "@/domain/errors";
import { findPaperCandidates } from "@/application/paper-writer";

export type DoiLookupDatabase = DoiIntakeLifecycleStore;
export type DoiLookupProvider = DoiMetadataProvider;
export type DoiLookupServices = DoiIntakeLifecycleServices;

export type DoiLookupServiceOptions = DoiIntakeLifecycleOptions & {
  /** Required in tests and injectable in server wiring; never defaults to a
   * live Crossref transport in this slice. */
  transport: DoiHttpTransport;
};

export function createDoiLookupServices(
  db: DoiLookupDatabase,
  provider: DoiLookupProvider,
  options: DoiLookupServiceOptions,
): DoiLookupServices {
  return createDoiIntakeLifecycleServices(db, provider, options.transport, options);
}

export * from "@/application/doi-intake-lifecycle-services";

type DoiLookupExecutor = Pick<Database, "execute">;
type DoiLookupRequestRow = {
  id: string;
  project_id: string;
  submitted_doi: string;
  normalized_doi: string;
  provider: string;
  provider_contract_version: string;
  provider_mapping_version: string;
  idempotency_key: string;
  created_at: Date | string;
};

type DoiLookupResultRow = {
  id: string;
  fetch_id: string;
  outcome: string;
  http_attempt_count: number;
  last_http_status: number | null;
  response_content_type: string | null;
  response_byte_size: number | null;
  response_sha256: string | null;
  source_snapshot: unknown;
  provider_doi: string | null;
  proposed_title: string | null;
  proposed_publication_year: number | null;
  proposed_venue: string | null;
  provider_type: string | null;
  provider_publisher: string | null;
  provider_url: string | null;
  authors_state: string;
  reported_author_count: number | null;
  mapping_warnings: unknown;
  diagnostic_code: string | null;
  diagnostic_message: string | null;
  observed_rate_limit_per_second: number | null;
  observed_concurrency_limit: number | null;
  duration_ms: number | null;
  created_at: Date | string;
  finalized_at: Date | string;
  authors: unknown;
};

export type DoiLookupAuthorView = {
  id: string;
  ordinal: number;
  givenName: string | null;
  familyName: string | null;
  literalName: string | null;
  suffix: string | null;
  orcid: string | null;
  displayName: string;
  providerSequence: string | null;
};

export type DoiLookupResultView = {
  id: string;
  fetchId: string;
  outcome: string;
  httpAttemptCount: number;
  lastHttpStatus: number | null;
  responseContentType: string | null;
  responseByteSize: number | null;
  responseSha256: string | null;
  sourceSnapshot: Record<string, unknown> | null;
  providerDoi: string | null;
  proposedTitle: string | null;
  proposedPublicationYear: number | null;
  proposedVenue: string | null;
  providerType: string | null;
  providerPublisher: string | null;
  providerUrl: string | null;
  authorsState: string;
  reportedAuthorCount: number | null;
  mappingWarnings: unknown[];
  diagnosticCode: string | null;
  diagnosticMessage: string | null;
  observedRateLimitPerSecond: number | null;
  observedConcurrencyLimit: number | null;
  durationMs: number | null;
  createdAt: Date;
  finalizedAt: Date;
  authors: DoiLookupAuthorView[];
};

export type DoiLookupRequestView = {
  id: string;
  projectId: string;
  submittedDoi: string;
  normalizedDoi: string;
  provider: string;
  providerContractVersion: string;
  providerMappingVersion: string;
  idempotencyKey: string;
  createdAt: Date;
  state: "pending" | "in_progress" | "succeeded" | "not_found" | "provider_unavailable" | "rate_limited" | "invalid_response" | "provider_mismatch" | "failed";
  result: DoiLookupResultView | null;
};

type DoiLookupClaim =
  | { kind: "cache"; dispatchId: string; result: DoiLookupResultView }
  | { kind: "shared"; dispatchId: string; fetchId: string }
  | { kind: "owner"; dispatchId: string; fetchId: string };

export type PostgresDoiLookupOptions = {
  requestDeadlineMs?: number;
  staticRateLimitPerSecond?: number;
  staticConcurrencyLimit?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type DoiLookupProviderFactory = (attemptAccounting: BibliographicMetadataLookupAttemptAccounting) => BibliographicMetadataLookupProvider;

const DOI_PROVIDER = "crossref";
const DOI_STATIC_RATE_LIMIT_PER_SECOND = 10;
const DOI_STATIC_CONCURRENCY_LIMIT = 3;

function asRows<T>(value: unknown): T[] {
  return Array.from(value as Iterable<T>);
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function mapResult(row: DoiLookupResultRow): DoiLookupResultView {
  return {
    id: String(row.id),
    fetchId: String(row.fetch_id),
    outcome: String(row.outcome),
    httpAttemptCount: Number(row.http_attempt_count),
    lastHttpStatus: row.last_http_status == null ? null : Number(row.last_http_status),
    responseContentType: row.response_content_type == null ? null : String(row.response_content_type),
    responseByteSize: row.response_byte_size == null ? null : Number(row.response_byte_size),
    responseSha256: row.response_sha256 == null ? null : String(row.response_sha256),
    sourceSnapshot: asJsonObject(row.source_snapshot),
    providerDoi: row.provider_doi == null ? null : String(row.provider_doi),
    proposedTitle: row.proposed_title == null ? null : String(row.proposed_title),
    proposedPublicationYear: row.proposed_publication_year == null ? null : Number(row.proposed_publication_year),
    proposedVenue: row.proposed_venue == null ? null : String(row.proposed_venue),
    providerType: row.provider_type == null ? null : String(row.provider_type),
    providerPublisher: row.provider_publisher == null ? null : String(row.provider_publisher),
    providerUrl: row.provider_url == null ? null : String(row.provider_url),
    authorsState: String(row.authors_state),
    reportedAuthorCount: row.reported_author_count == null ? null : Number(row.reported_author_count),
    mappingWarnings: asArray(row.mapping_warnings),
    diagnosticCode: row.diagnostic_code == null ? null : String(row.diagnostic_code),
    diagnosticMessage: row.diagnostic_message == null ? null : String(row.diagnostic_message),
    observedRateLimitPerSecond: row.observed_rate_limit_per_second == null ? null : Number(row.observed_rate_limit_per_second),
    observedConcurrencyLimit: row.observed_concurrency_limit == null ? null : Number(row.observed_concurrency_limit),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    createdAt: asDate(row.created_at),
    finalizedAt: asDate(row.finalized_at),
    authors: asArray(row.authors).flatMap((value) => {
      const candidate = asJsonObject(value);
      if (!candidate || !candidate.id || candidate.displayName == null) return [];
      return [{
        id: String(candidate.id),
        ordinal: Number(candidate.ordinal),
        givenName: candidate.givenName == null ? null : String(candidate.givenName),
        familyName: candidate.familyName == null ? null : String(candidate.familyName),
        literalName: candidate.literalName == null ? null : String(candidate.literalName),
        suffix: candidate.suffix == null ? null : String(candidate.suffix),
        orcid: candidate.orcid == null ? null : String(candidate.orcid),
        displayName: String(candidate.displayName),
        providerSequence: candidate.providerSequence == null ? null : String(candidate.providerSequence),
      } satisfies DoiLookupAuthorView];
    }),
  };
}

async function resultQuery(executor: DoiLookupExecutor, where: ReturnType<typeof sql>): Promise<DoiLookupResultView | null> {
  const rows = asRows<DoiLookupResultRow>(await executor.execute(sql`
    select r.*, coalesce((select jsonb_agg(jsonb_build_object(
      'id', a.id, 'ordinal', a.ordinal, 'givenName', a.given_name,
      'familyName', a.family_name, 'literalName', a.literal_name,
      'suffix', a.suffix, 'orcid', a.orcid, 'displayName', a.display_name,
      'providerSequence', a.provider_sequence
    ) order by a.ordinal) from bibliographic_metadata_result_authors a where a.result_id = r.id), '[]'::jsonb) as authors
    from bibliographic_metadata_fetch_results r
    ${where}
    limit 1
  `));
  return rows[0] ? mapResult(rows[0]) : null;
}

function cacheKey(provider: string, doi: string, contractVersion: string, mappingVersion: string): string {
  return [provider, doi, contractVersion, mappingVersion].join("|");
}

function sanitizeAttemptUrl(value: string): string {
  const url = new URL(value);
  url.search = "";
  return url.toString();
}

function outcomeForProviderResult(result: BibliographicMetadataLookupResult): string {
  if (result.kind === "success") return "succeeded";
  if (result.code === "not_found") return "not_found";
  if (result.code === "rate_limited") return "rate_limited";
  if (result.code === "doi_mismatch") return "provider_mismatch";
  if (["invalid_content_type", "invalid_json", "json_depth_exceeded", "json_visited_values_exceeded", "invalid_response_shape", "response_too_large", "redirect_rejected", "redirect_limit_exceeded"].includes(result.code)) return "invalid_response";
  if (["network_error", "timeout", "tls_error", "attempt_accounting_error"].includes(result.code)) return "provider_unavailable";
  return "failed";
}

function diagnosticForProviderResult(result: BibliographicMetadataLookupResult): string {
  return result.kind === "success" ? "provider_success" : result.code;
}

export function createPostgresDoiLookupServices(
  db: Database,
  providerFactory: DoiLookupProviderFactory,
  options: PostgresDoiLookupOptions = {},
) {
  const requestDeadlineMs = options.requestDeadlineMs ?? 90_000;
  const staticRate = options.staticRateLimitPerSecond ?? DOI_STATIC_RATE_LIMIT_PER_SECOND;
  const staticConcurrency = options.staticConcurrencyLimit ?? DOI_STATIC_CONCURRENCY_LIMIT;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  async function readRequest(requestId: string, projectId?: string, executor: DoiLookupExecutor = db): Promise<DoiLookupRequestView> {
    const requestRows = asRows<DoiLookupRequestRow>(await executor.execute(sql`select * from doi_lookup_requests where id=${requestId}::uuid ${projectId ? sql`and project_id=${projectId}::uuid` : sql``} limit 1`));
    const request = requestRows[0];
    if (!request) throw new DomainError("NOT_FOUND", "DOI lookup request was not found");
    const result = await resultQuery(executor, sql`where r.fetch_id = (select d.fetch_id from doi_lookup_dispatches d where d.request_id=${request.id}::uuid order by d.sequence desc limit 1)`);
    const latestDispatchRows = asRows<{ dispatch_kind: string }>(await executor.execute(sql`select dispatch_kind from doi_lookup_dispatches where request_id=${request.id}::uuid order by sequence desc limit 1`));
    const dispatchKind = latestDispatchRows[0]?.dispatch_kind;
    const state = result ? result.outcome as DoiLookupRequestView["state"] : dispatchKind ? "in_progress" : "pending";
    return {
      id: String(request.id),
      projectId: String(request.project_id),
      submittedDoi: String(request.submitted_doi),
      normalizedDoi: String(request.normalized_doi),
      provider: String(request.provider),
      providerContractVersion: String(request.provider_contract_version),
      providerMappingVersion: String(request.provider_mapping_version),
      idempotencyKey: String(request.idempotency_key),
      createdAt: asDate(request.created_at),
      state,
      result,
    };
  }

  async function beginDoiLookup(input: { projectId: string; submittedDoi: string; idempotencyKey: string }) {
    const normalizedDoi = normalizeDoiForMetadataLookup(input.submittedDoi);
    if (!normalizedDoi) throw new DomainError("VALIDATION_ERROR", "A plausible DOI is required");
    if (Array.from(input.submittedDoi).length > BIBLIOGRAPHIC_METADATA_LOOKUP_LIMITS.maxDoiCodePoints) throw new DomainError("VALIDATION_ERROR", "The DOI is too long");
    const key = input.idempotencyKey.trim();
    if (!key || key.length > 200) throw new DomainError("VALIDATION_ERROR", "An idempotency key is required");
    return db.transaction(async (tx) => {
      const project = asRows<{ id: string }>(await tx.execute(sql`select id from projects where id=${input.projectId}::uuid limit 1`))[0];
      if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
      await tx.execute(sql`insert into doi_lookup_requests (project_id,submitted_doi,normalized_doi,provider,provider_contract_version,provider_mapping_version,idempotency_key) values (${input.projectId}::uuid,${input.submittedDoi},${normalizedDoi},${DOI_PROVIDER},${BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION},${CROSSREF_WORK_MAPPING_VERSION},${key}) on conflict (project_id,idempotency_key) do nothing`);
      const request = await readRequestByIdempotency(tx, input.projectId, key);
      if (!request) throw new DomainError("DATABASE_CONSTRAINT", "DOI lookup request could not be created");
      if (request.normalized_doi !== normalizedDoi || request.provider !== DOI_PROVIDER || request.provider_contract_version !== BIBLIOGRAPHIC_METADATA_LOOKUP_CONTRACT_VERSION || request.provider_mapping_version !== CROSSREF_WORK_MAPPING_VERSION) throw new DomainError("VALIDATION_ERROR", "The idempotency key is already bound to a different DOI lookup");
      return { request: await readRequest(request.id, input.projectId, tx), reused: request.submitted_doi !== input.submittedDoi };
    });
  }

  async function readRequestByIdempotency(executor: DoiLookupExecutor, projectId: string, key: string) {
    return asRows<DoiLookupRequestRow>(await executor.execute(sql`select * from doi_lookup_requests where project_id=${projectId}::uuid and idempotency_key=${key} limit 1`))[0] ?? null;
  }

  async function claim(input: DoiLookupRequestView): Promise<DoiLookupClaim> {
    const key = cacheKey(input.provider, input.normalizedDoi, input.providerContractVersion, input.providerMappingVersion);
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      const cached = asRows<{ id: string; fetch_id: string }>(await tx.execute(sql`select r.id, r.fetch_id from bibliographic_metadata_fetch_results r join bibliographic_metadata_fetches f on f.id=r.fetch_id where r.outcome='succeeded' and f.provider=${input.provider} and f.normalized_doi=${input.normalizedDoi} and f.provider_contract_version=${input.providerContractVersion} and f.provider_mapping_version=${input.providerMappingVersion} order by r.finalized_at asc, r.id asc limit 1`))[0];
      if (cached) {
        const dispatch = asRows<{ id: string }>(await tx.execute(sql`insert into doi_lookup_dispatches (project_id,request_id,fetch_id,dispatch_kind) values (${input.projectId}::uuid,${input.id}::uuid,${cached.fetch_id}::uuid,'cache_reuse') returning id`))[0];
        const result = await resultQuery(tx, sql`where r.id=${cached.id}::uuid`);
        if (!dispatch || !result) throw new DomainError("DATABASE_CONSTRAINT", "Cache result could not be linked");
        return { kind: "cache", dispatchId: String(dispatch.id), result };
      }
      const inflight = asRows<{ id: string }>(await tx.execute(sql`select f.id from bibliographic_metadata_fetches f where f.provider=${input.provider} and f.normalized_doi=${input.normalizedDoi} and f.provider_contract_version=${input.providerContractVersion} and f.provider_mapping_version=${input.providerMappingVersion} and f.deadline_at > now() and not exists (select 1 from bibliographic_metadata_fetch_results r where r.fetch_id=f.id) order by f.started_at asc, f.id asc limit 1`))[0];
      if (inflight) {
        const dispatch = asRows<{ id: string }>(await tx.execute(sql`insert into doi_lookup_dispatches (project_id,request_id,fetch_id,dispatch_kind) values (${input.projectId}::uuid,${input.id}::uuid,${inflight.id}::uuid,'network_shared') returning id`))[0];
        if (!dispatch) throw new DomainError("DATABASE_CONSTRAINT", "DOI lookup dispatch could not be created");
        return { kind: "shared", dispatchId: String(dispatch.id), fetchId: String(inflight.id) };
      }
      const observed = asRows<{ rate_limit: number | null; concurrency_limit: number | null }>(await tx.execute(sql`select min(r.observed_rate_limit_per_second) as rate_limit, min(r.observed_concurrency_limit) as concurrency_limit from bibliographic_metadata_fetch_results r join bibliographic_metadata_fetches f on f.id=r.fetch_id where f.provider=${input.provider} and (r.observed_rate_limit_per_second is not null or r.observed_concurrency_limit is not null)`))[0];
      const effectiveRate = Math.max(1, Math.min(staticRate, observed?.rate_limit == null ? staticRate : Number(observed.rate_limit)));
      const effectiveConcurrency = Math.max(1, Math.min(staticConcurrency, observed?.concurrency_limit == null ? staticConcurrency : Number(observed.concurrency_limit)));
      const fetch = asRows<{ id: string }>(await tx.execute(sql`insert into bibliographic_metadata_fetches (provider,normalized_doi,provider_contract_version,provider_mapping_version,cache_key,started_at,deadline_at,execution_identity,rate_limit_per_second,concurrency_limit) values (${input.provider},${input.normalizedDoi},${input.providerContractVersion},${input.providerMappingVersion},${key},now(),now()+(${requestDeadlineMs} || ' milliseconds')::interval,${randomUUID()},${effectiveRate},${effectiveConcurrency}) returning id`))[0];
      if (!fetch) throw new DomainError("DATABASE_CONSTRAINT", "DOI metadata fetch could not be created");
      const dispatch = asRows<{ id: string }>(await tx.execute(sql`insert into doi_lookup_dispatches (project_id,request_id,fetch_id,dispatch_kind) values (${input.projectId}::uuid,${input.id}::uuid,${fetch.id}::uuid,'network_owner') returning id`))[0];
      if (!dispatch) throw new DomainError("DATABASE_CONSTRAINT", "DOI lookup dispatch could not be created");
      return { kind: "owner", dispatchId: String(dispatch.id), fetchId: String(fetch.id) };
    });
  }

  function accountingFor(fetchId: string): BibliographicMetadataLookupAttemptAccounting {
    return {
      begin: async (attempt: BibliographicMetadataLookupAttempt) => {
        const sanitizedUrl = sanitizeAttemptUrl(attempt.url);
        while (true) {
          const acquired = await db.transaction(async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${attempt.provider}, 0))`);
            const fetch = asRows<{ deadline_at: Date | string; rate_limit_per_second: number; concurrency_limit: number }>(await tx.execute(sql`select deadline_at, rate_limit_per_second, concurrency_limit from bibliographic_metadata_fetches where id=${fetchId}::uuid limit 1`))[0];
            if (!fetch || new Date(fetch.deadline_at).getTime() <= Date.now()) throw new DomainError("TIMEOUT", "DOI fetch deadline exceeded");
            const rate = Math.max(1, Number(fetch.rate_limit_per_second));
            const concurrency = Math.max(1, Number(fetch.concurrency_limit));
            const recent = asRows<{ count: string }>(await tx.execute(sql`select count(*)::text as count from bibliographic_metadata_http_attempts where started_at >= now() - interval '1 second'`))[0];
            const active = asRows<{ count: string }>(await tx.execute(sql`select count(*)::text as count from bibliographic_metadata_http_attempts where status='started' and started_at >= now() - interval '10 seconds'`))[0];
            if (Number(recent?.count ?? 0) >= rate || Number(active?.count ?? 0) >= concurrency) return false;
            await tx.execute(sql`insert into bibliographic_metadata_http_attempts (fetch_id,attempt_ordinal,request_url,started_at,status) values (${fetchId}::uuid,${attempt.attempt},${sanitizedUrl},now(),'started')`);
            return true;
          });
          if (acquired) {
            let released = false;
            return {
              release: async (outcome?: { status: "succeeded" | "failed"; httpStatus: number | null; outcomeCode: string | null }) => {
                if (released) return;
                released = true;
                await db.execute(sql`update bibliographic_metadata_http_attempts set completed_at=now(), status=${outcome?.status ?? "succeeded"}, http_status=${outcome?.httpStatus ?? null}, outcome_code=${outcome?.outcomeCode ?? null} where fetch_id=${fetchId}::uuid and attempt_ordinal=${attempt.attempt} and status='started'`);
              },
            };
          }
          await sleep(50);
        }
      },
    };
  }

  async function persist(fetchId: string, providerResult: BibliographicMetadataLookupResult): Promise<DoiLookupResultView> {
    const outcome = outcomeForProviderResult(providerResult);
    const evidence = providerResult.evidence;
    const proposal = providerResult.kind === "success" ? providerResult.proposal : null;
    const authorsState = proposal ? (proposal.authors === null ? (proposal.warnings.some((item) => item.field === "authors") ? "invalid" : "absent") : "valid") : "absent";
    const finalResult = await db.transaction(async (tx) => {
      const existing = await resultQuery(tx, sql`where r.fetch_id=${fetchId}::uuid`);
      if (existing) return existing;
      const inserted = asRows<{ id: string }>(await tx.execute(sql`insert into bibliographic_metadata_fetch_results (fetch_id,outcome,http_attempt_count,last_http_status,response_content_type,response_byte_size,response_sha256,source_snapshot,provider_doi,proposed_title,proposed_publication_year,proposed_venue,provider_type,provider_publisher,provider_url,authors_state,reported_author_count,mapping_warnings,diagnostic_code,diagnostic_message,observed_rate_limit_per_second,observed_concurrency_limit,duration_ms,created_at,finalized_at) values (${fetchId}::uuid,${outcome},${evidence.attemptCount},${evidence.httpStatus},${evidence.contentType},${evidence.responseByteSize},${evidence.responseSha256},${proposal ? JSON.stringify(proposal.sourceSnapshot) : null}::jsonb,${proposal?.returnedDoi ?? null},${proposal?.title ?? null},${proposal?.publicationYear ?? null},${proposal?.venue ?? null},${proposal?.providerType ?? null},${proposal?.publisher ?? null},${proposal?.url ?? null},${authorsState},${proposal?.sourceSnapshot.authorCount ?? null},${JSON.stringify(proposal?.warnings ?? [])}::jsonb,${providerResult.kind === "failure" ? providerResult.code : null},${diagnosticForProviderResult(providerResult)},${evidence.observedRateLimitPerSecond},${evidence.observedConcurrencyLimit},${Math.max(0, evidence.finalizedAt.getTime() - evidence.startedAt.getTime())},${evidence.finalizedAt.toISOString()}::timestamptz,${evidence.finalizedAt.toISOString()}::timestamptz) returning id`))[0];
      if (!inserted) throw new DomainError("DATABASE_CONSTRAINT", "DOI metadata result could not be persisted");
      if (proposal?.authorDetails && proposal.authorDetails.length > 0) {
        for (let index = 0; index < proposal.authorDetails.length; index += 1) {
          const author = proposal.authorDetails[index];
          await tx.execute(sql`insert into bibliographic_metadata_result_authors (result_id,ordinal,given_name,family_name,literal_name,suffix,orcid,display_name,provider_sequence) values (${inserted.id}::uuid,${index + 1},${author.given},${author.family},${author.literal},${author.suffix},${author.orcid},${author.displayName},${author.providerSequence})`);
        }
      }
      const result = await resultQuery(tx, sql`where r.id=${inserted.id}::uuid`);
      if (!result) throw new DomainError("DATABASE_CONSTRAINT", "Persisted DOI metadata result could not be read");
      return result;
    });
    return finalResult;
  }

  async function executeDoiLookup(requestId: string, projectId?: string) {
    const request = await readRequest(requestId, projectId);
    if (request.result) return request;
    const claimed = await claim(request);
    if (claimed.kind === "cache") return readRequest(request.id, request.projectId);
    if (claimed.kind === "shared") return readRequest(request.id, request.projectId);
    const provider = providerFactory(accountingFor(claimed.fetchId));
    const providerResult = await provider.lookup({ doi: request.normalizedDoi });
    await persist(claimed.fetchId, providerResult);
    return readRequest(request.id, request.projectId);
  }

  async function listDoiLookupRequests(projectId: string) {
    const rows = asRows<Record<string, unknown>>(await db.execute(sql`
      select q.*, latest.outcome, latest.diagnostic_code, latest.finalized_at
      from doi_lookup_requests q
      left join lateral (
        select r.outcome, r.diagnostic_code, r.finalized_at
        from doi_lookup_dispatches d
        left join bibliographic_metadata_fetch_results r on r.fetch_id=d.fetch_id
        where d.request_id=q.id
        order by d.sequence desc
        limit 1
      ) latest on true
      where q.project_id=${projectId}::uuid
      order by q.created_at desc, q.id desc
    `));
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      submittedDoi: String(row.submitted_doi),
      normalizedDoi: String(row.normalized_doi),
      provider: String(row.provider),
      providerContractVersion: String(row.provider_contract_version),
      providerMappingVersion: String(row.provider_mapping_version),
      idempotencyKey: String(row.idempotency_key),
      createdAt: asDate(row.created_at as Date | string),
      status: row.outcome == null ? "pending" : "terminal",
      outcome: row.outcome == null ? null : String(row.outcome),
      diagnosticCode: row.diagnostic_code == null ? null : String(row.diagnostic_code),
      finalizedAt: row.finalized_at == null ? null : asDate(row.finalized_at as Date | string),
    }));
  }

  async function getDoiLookupRequest(projectId: string, requestId: string) {
    const request = await readRequest(requestId, projectId);
    const dispatches = asRows<Record<string, unknown>>(await db.execute(sql`select id, sequence, dispatch_kind, created_at, fetch_id from doi_lookup_dispatches where project_id=${projectId}::uuid and request_id=${requestId}::uuid order by sequence`));
    const latestFetchId = dispatches.at(-1)?.fetch_id;
    const fetch = latestFetchId
      ? asRows<Record<string, unknown>>(await db.execute(sql`select * from bibliographic_metadata_fetches where id=${String(latestFetchId)}::uuid limit 1`))[0] ?? null
      : null;
    const attempts = latestFetchId
      ? asRows<Record<string, unknown>>(await db.execute(sql`select * from bibliographic_metadata_http_attempts where fetch_id=${String(latestFetchId)}::uuid order by attempt_ordinal`))
      : [];
    const result = request.result;
    const candidates = result?.outcome === "succeeded" && (result.proposedTitle || result.providerDoi)
      ? await findPaperCandidates(db, projectId, { title: result.proposedTitle ?? "", doi: result.providerDoi, publicationYear: result.proposedPublicationYear })
      : [];
    const resolutions = asRows<Record<string, unknown>>(await db.execute(sql`select * from doi_lookup_resolutions where project_id=${projectId}::uuid and request_id=${requestId}::uuid order by sequence`));
    return {
      request,
      proposal: result ? {
        doi: result.providerDoi,
        title: result.proposedTitle,
        authors: result.authors.map((author) => author.displayName),
        publicationYear: result.proposedPublicationYear,
        venue: result.proposedVenue,
        publisher: result.providerPublisher,
        url: result.providerUrl,
        authorsState: result.authorsState,
      } : null,
      diagnostics: result,
      result,
      fetch,
      attempts,
      dispatches,
      candidates,
      paperOptions: candidates,
      resolutions,
    };
  }

  return {
    beginDoiLookup,
    executeDoiLookup,
    getDoiLookup: (requestId: string, projectId?: string) => readRequest(requestId, projectId),
    getDoiLookupResult: async (requestId: string, projectId?: string) => (await readRequest(requestId, projectId)).result,
    listDoiLookupRequests,
    listDoiIntakeRequests: listDoiLookupRequests,
    getDoiLookupRequest,
    getDoiIntakeRequest: getDoiLookupRequest,
  };
}
