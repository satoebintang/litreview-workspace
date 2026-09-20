import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { createPaperSchema, idSchema } from "@/domain/validation";
import { findPaperCandidates, writePaper, type PaperWriteInput } from "./paper-writer";

export type DoiResolutionKind = "created_paper" | "matched_paper" | "cleared";

export type DoiResolutionCandidate = {
  /** `id` mirrors the existing candidate-preview contracts. */
  id: string;
  paperId: string;
  rank: number;
  reason: string;
  candidateReason: string;
  candidatePriority: number;
  title: string;
  authors: string[];
  publicationYear: number | null;
  venue: string | null;
  doi: string | null;
  abstract: string | null;
  selected: boolean;
};

export type DoiResolutionPreview = {
  projectId: string;
  requestId: string;
  resultId: string;
  action: DoiResolutionKind;
  expectedPreviousResolutionId: string | null;
  expectedResolutionId: string | null;
  payload: PaperWriteInput | null;
  selectedPaperId: string | null;
  candidates: DoiResolutionCandidate[];
  fingerprint: string;
};

export type DoiResolution = {
  id: string;
  sequence: string;
  projectId: string;
  requestId: string;
  resultId: string;
  resolutionKind: DoiResolutionKind;
  kind: DoiResolutionKind;
  paperId: string | null;
  expectedPreviousResolutionId: string | null;
  creationPayload: PaperWriteInput | null;
  candidateContext: DoiResolutionCandidate[] | null;
  previewFingerprint: string | null;
  note: string | null;
  createdAt: Date;
};

export type DoiResolutionPreviewInput = {
  resultId: string;
  action?: DoiResolutionKind;
  kind?: DoiResolutionKind;
  paperId?: string | null;
  creation?: Partial<PaperWriteInput>;
  payload?: Partial<PaperWriteInput>;
};

export type DoiResolutionInput = DoiResolutionPreviewInput & {
  expectedPreviousResolutionId?: string | null;
  previewFingerprint?: string | null;
  acknowledgedCandidateIds?: string[];
  /** Compatibility with the other explicit-resolution workflows. */
  distinctPaperAcknowledged?: boolean;
  note?: string | null;
};

export type DoiResolutionServices = {
  previewResolution(projectId: string, requestId: string, input: DoiResolutionPreviewInput): Promise<DoiResolutionPreview>;
  resolveResolution(projectId: string, requestId: string, input: DoiResolutionInput): Promise<DoiResolution>;
  currentResolution(projectId: string, requestId: string): Promise<DoiResolution | null>;
};

type Row = Record<string, unknown>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

function rows(value: unknown): Row[] { return value as Row[]; }

function id(value: string, label: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`, parsed.error.issues);
  return parsed.data;
}

function text(value: unknown): string | null {
  return value == null ? null : String(value);
}

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function proposedPayload(result: Row, request: Row, authors: string[], creation: Partial<PaperWriteInput> | undefined): PaperWriteInput {
  const base: PaperWriteInput = {
    title: text(result.proposed_title) ?? "",
    authors,
    publicationYear: result.proposed_publication_year == null ? null : Number(result.proposed_publication_year),
    venue: text(result.proposed_venue),
    doi: text(result.provider_doi) ?? String(request.normalized_doi),
    abstract: null,
    bibliographicNote: null,
  };
  const merged: PaperWriteInput = {
    title: creation?.title !== undefined ? creation.title : base.title,
    authors: creation?.authors !== undefined ? creation.authors : base.authors,
    publicationYear: creation?.publicationYear !== undefined ? creation.publicationYear : base.publicationYear,
    venue: creation?.venue !== undefined ? creation.venue : base.venue,
    doi: creation?.doi !== undefined ? creation.doi : base.doi,
    abstract: creation?.abstract !== undefined ? creation.abstract : base.abstract,
    bibliographicNote: creation?.bibliographicNote !== undefined ? creation.bibliographicNote : base.bibliographicNote,
  };
  return merged;
}

function canonicalPayload(result: Row, request: Row, authors: string[], creation: Partial<PaperWriteInput> | undefined): PaperWriteInput {
  const parsed = createPaperSchema.safeParse(proposedPayload(result, request, authors, creation));
  if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Canonical Paper payload is invalid", parsed.error.issues);
  return {
    title: parsed.data.title,
    authors: parsed.data.authors,
    publicationYear: parsed.data.publicationYear ?? null,
    venue: parsed.data.venue ?? null,
    doi: parsed.data.doi ?? null,
    abstract: parsed.data.abstract ?? null,
    bibliographicNote: parsed.data.bibliographicNote ?? null,
  };
}

function candidateContext(found: Row[], selectedPaperId: string | null): DoiResolutionCandidate[] {
  return found.map((candidate, index) => ({
    id: String(candidate.id),
    paperId: String(candidate.id),
    rank: index + 1,
    reason: String(candidate.candidate_reason ?? "title"),
    candidateReason: String(candidate.candidate_reason ?? "title"),
    candidatePriority: Number(candidate.candidate_priority ?? 3),
    title: String(candidate.title),
    authors: json<string[]>(candidate.authors, []),
    publicationYear: candidate.publication_year == null ? null : Number(candidate.publication_year),
    venue: text(candidate.venue),
    doi: text(candidate.doi),
    abstract: text(candidate.abstract),
    selected: selectedPaperId != null && String(candidate.id) === selectedPaperId,
  }));
}

function fingerprintPayload(input: {
  requestId: string;
  resultId: string;
  action: DoiResolutionKind;
  expectedPreviousResolutionId: string | null;
  payload: PaperWriteInput | null;
  selectedPaperId: string | null;
  candidates: DoiResolutionCandidate[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    requestId: input.requestId,
    resultId: input.resultId,
    action: input.action,
    expectedPreviousResolutionId: input.expectedPreviousResolutionId,
    payload: input.payload,
    selectedPaperId: input.selectedPaperId,
    candidates: input.candidates,
  }), "utf8").digest("hex");
}

export function computeDoiResolutionFingerprint(input: Parameters<typeof fingerprintPayload>[0]): string {
  return fingerprintPayload(input);
}

function mapResolution(row: Row): DoiResolution {
  const resolutionKind = String(row.resolution_kind) as DoiResolutionKind;
  return {
    id: String(row.id),
    sequence: String(row.sequence),
    projectId: String(row.project_id),
    requestId: String(row.request_id),
    resultId: String(row.result_id),
    resolutionKind,
    kind: resolutionKind,
    paperId: text(row.paper_id),
    expectedPreviousResolutionId: text(row.expected_previous_resolution_id),
    creationPayload: json<PaperWriteInput | null>(row.creation_payload, null),
    candidateContext: json<DoiResolutionCandidate[] | null>(row.candidate_context, null),
    previewFingerprint: text(row.preview_fingerprint),
    note: text(row.note),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

function sameIds(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeExpected(value: string | null | undefined): string | null {
  if (value == null) return null;
  return id(value, "Expected previous resolution");
}

function resolutionAction(input: DoiResolutionPreviewInput): DoiResolutionKind {
  if (input.action != null && input.kind != null && input.action !== input.kind) {
    throw new DomainError("VALIDATION_ERROR", "DOI resolution action and kind disagree");
  }
  const action = input.action ?? input.kind;
  if (!action || !["created_paper", "matched_paper", "cleared"].includes(action)) {
    throw new DomainError("VALIDATION_ERROR", "Unknown DOI resolution action");
  }
  return action;
}

function creationInput(input: DoiResolutionPreviewInput): Partial<PaperWriteInput> | undefined {
  if (input.creation != null && input.payload != null) {
    throw new DomainError("VALIDATION_ERROR", "Provide one DOI Paper creation payload");
  }
  return input.creation ?? input.payload;
}

function validateAction(input: DoiResolutionPreviewInput): DoiResolutionKind {
  const action = resolutionAction(input);
  if (action === "matched_paper") id(String(input.paperId ?? ""), "Paper");
  if (action === "cleared" && (input.paperId != null || input.creation != null || input.payload != null)) {
    throw new DomainError("VALIDATION_ERROR", "A cleared DOI resolution cannot include a Paper or creation payload");
  }
  if (action === "matched_paper" && (input.creation != null || input.payload != null)) {
    throw new DomainError("VALIDATION_ERROR", "Matching a Paper cannot include a creation payload");
  }
  return action;
}

async function lockProjectAndRequest(tx: Tx, projectId: string, requestId: string): Promise<Row> {
  const project = rows(await tx.execute(sql`select id from projects where id=${projectId}::uuid for update`))[0];
  if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
  const request = rows(await tx.execute(sql`select * from doi_lookup_requests where project_id=${projectId}::uuid and id=${requestId}::uuid for update`))[0];
  if (request) return request;
  const foreign = rows(await tx.execute(sql`select project_id from doi_lookup_requests where id=${requestId}::uuid limit 1`))[0];
  if (foreign) throw new DomainError("CROSS_PROJECT_REFERENCE", "DOI lookup request does not belong to this project");
  throw new DomainError("NOT_FOUND", "DOI lookup request was not found");
}

async function exactSucceededResult(tx: Tx, projectId: string, request: Row, resultId: string): Promise<{ result: Row; fetch: Row }> {
  const result = rows(await tx.execute(sql`
    select r.*, f.provider as fetch_provider, f.normalized_doi as fetch_normalized_doi,
      f.provider_contract_version as fetch_contract_version,
      f.provider_mapping_version as fetch_mapping_version
    from bibliographic_metadata_fetch_results r
    join bibliographic_metadata_fetches f on f.id=r.fetch_id
    where r.id=${resultId}::uuid
    limit 1
  `))[0];
  if (!result) throw new DomainError("NOT_FOUND", "DOI metadata result was not found");
  if (String(result.outcome) !== "succeeded") throw new DomainError("VALIDATION_ERROR", "Only a succeeded DOI metadata result can be resolved");
  if (String(result.fetch_normalized_doi) !== String(request.normalized_doi)
    || String(result.fetch_provider) !== String(request.provider)
    || String(result.fetch_contract_version) !== String(request.provider_contract_version)
    || String(result.fetch_mapping_version) !== String(request.provider_mapping_version)) {
    throw new DomainError("CROSS_PROJECT_REFERENCE", "DOI metadata result does not match this lookup request");
  }
  const dispatch = rows(await tx.execute(sql`
    select d.id from doi_lookup_dispatches d
    where d.project_id=${projectId}::uuid and d.request_id=${request.id}::uuid and d.fetch_id=${result.fetch_id}::uuid
    order by d.sequence desc, d.id desc limit 1
  `))[0];
  if (!dispatch) throw new DomainError("CROSS_PROJECT_REFERENCE", "DOI metadata result was not dispatched for this lookup request");
  return { result, fetch: result };
}

async function resultAuthors(tx: Tx, resultId: string): Promise<string[]> {
  const found = rows(await tx.execute(sql`
    select display_name from bibliographic_metadata_result_authors
    where result_id=${resultId}::uuid
    order by ordinal, id
  `));
  return found.map((row) => String(row.display_name));
}

async function currentResolution(tx: Pick<Database, "execute">, projectId: string, requestId: string, lock = false): Promise<Row | null> {
  const suffix = lock ? sql` for update` : sql``;
  return rows(await tx.execute(sql`
    select * from doi_lookup_resolutions
    where project_id=${projectId}::uuid and request_id=${requestId}::uuid
    order by sequence desc, id desc limit 1${suffix}
  `))[0] ?? null;
}

async function buildPreview(tx: Tx, projectId: string, requestId: string, input: DoiResolutionPreviewInput, lock: boolean): Promise<DoiResolutionPreview> {
  const action = validateAction(input);
  const resultId = id(input.resultId, "DOI metadata result");
  const request = await lockProjectAndRequest(tx, projectId, requestId);
  const exact = await exactSucceededResult(tx, projectId, request, resultId);
  const previous = await currentResolution(tx, projectId, requestId, lock);
  const expectedPreviousResolutionId = previous ? String(previous.id) : null;
  const selectedPaperId = action === "matched_paper" ? id(String(input.paperId), "Paper") : null;
  if (selectedPaperId) {
    const target = rows(await tx.execute(sql`select id from papers where project_id=${projectId}::uuid and id=${selectedPaperId}::uuid limit 1`))[0];
    if (!target) {
      const foreign = rows(await tx.execute(sql`select project_id from papers where id=${selectedPaperId}::uuid limit 1`))[0];
      if (foreign) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
      throw new DomainError("NOT_FOUND", "Paper was not found");
    }
  }
  const authors = await resultAuthors(tx, resultId);
  const suppliedCreation = creationInput(input);
  const proposal = action === "cleared" ? null : proposedPayload(exact.result, request, authors, suppliedCreation);
  const payload = action === "created_paper" ? canonicalPayload(exact.result, request, authors, suppliedCreation) : null;
  const foundCandidates = proposal ? await findPaperCandidates(tx, projectId, proposal) : [];
  const candidates = candidateContext(foundCandidates, selectedPaperId);
  if (action === "matched_paper" && !candidates.some((candidate) => candidate.paperId === selectedPaperId)) {
    throw new DomainError("VALIDATION_ERROR", "Selected Paper is not a current DOI candidate");
  }
  return {
    projectId,
    requestId,
    resultId,
    action,
    expectedPreviousResolutionId,
    expectedResolutionId: expectedPreviousResolutionId,
    payload,
    selectedPaperId,
    candidates,
    fingerprint: fingerprintPayload({ requestId, resultId, action, expectedPreviousResolutionId, payload, selectedPaperId, candidates }),
  };
}

function retryableTransactionError(error: unknown): boolean {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; cause?: { code?: unknown } } : {};
  return [candidate.code, candidate.cause?.code].some((code) => code === "40001" || code === "40P01");
}

export function createDoiResolutionServices(db: Database): DoiResolutionServices {
  async function transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level serializable`);
          return operation(tx);
        });
      } catch (error) {
        lastError = error;
        if (!retryableTransactionError(error) || attempt === 2) throw error;
      }
    }
    throw lastError;
  }

  async function previewResolution(projectIdInput: string, requestIdInput: string, input: DoiResolutionPreviewInput): Promise<DoiResolutionPreview> {
    const projectId = id(projectIdInput, "Project");
    const requestId = id(requestIdInput, "DOI lookup request");
    return transaction((tx) => buildPreview(tx, projectId, requestId, input, false));
  }

  async function resolveResolution(projectIdInput: string, requestIdInput: string, input: DoiResolutionInput): Promise<DoiResolution> {
    const projectId = id(projectIdInput, "Project");
    const requestId = id(requestIdInput, "DOI lookup request");
    const action = validateAction(input);
    const expectedPreviousResolutionId = normalizeExpected(input.expectedPreviousResolutionId);
    if (input.previewFingerprint != null && !/^[0-9a-f]{64}$/.test(input.previewFingerprint)) {
      throw new DomainError("VALIDATION_ERROR", "DOI resolution preview fingerprint is invalid");
    }
    if (action === "created_paper" && input.previewFingerprint == null) {
      throw new DomainError("VALIDATION_ERROR", "Creating a Paper requires an exact DOI resolution preview fingerprint");
    }
    return transaction(async (tx) => {
      const preview = await buildPreview(tx, projectId, requestId, input, true);
      if (expectedPreviousResolutionId !== preview.expectedPreviousResolutionId) {
        throw new DomainError("CONCURRENT_MODIFICATION", "DOI resolution changed; refresh before submitting");
      }
      if (action === "created_paper") {
        if (input.previewFingerprint !== preview.fingerprint) {
          throw new DomainError("CONCURRENT_MODIFICATION", "DOI candidate review is stale; refresh before creating a Paper");
        }
        const candidateIds = preview.candidates.map((candidate) => candidate.paperId);
        const acknowledged = input.acknowledgedCandidateIds ?? (input.distinctPaperAcknowledged ? candidateIds : []);
        if (!sameIds(acknowledged, candidateIds)) {
          throw new DomainError("DUPLICATE_REVIEW_REQUIRED", "Acknowledge the exact current Paper candidates before creating a distinct Paper");
        }
      } else if (input.previewFingerprint != null && input.previewFingerprint !== preview.fingerprint) {
        throw new DomainError("CONCURRENT_MODIFICATION", "DOI resolution preview is stale; refresh before submitting");
      }

      let paperId: string | null = null;
      if (action === "created_paper") {
        const paper = await writePaper(tx, projectId, preview.payload!, { source: "manual" });
        paperId = String(paper.id);
      } else if (action === "matched_paper") {
        paperId = id(String(input.paperId), "Paper");
        const target = rows(await tx.execute(sql`select id from papers where project_id=${projectId}::uuid and id=${paperId}::uuid for update`))[0];
        if (!target) {
          const foreign = rows(await tx.execute(sql`select project_id from papers where id=${paperId}::uuid limit 1`))[0];
          if (foreign) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
          throw new DomainError("NOT_FOUND", "Paper was not found");
        }
      }

      const candidateContext = action === "cleared" ? null : preview.candidates;
      const inserted = rows(await tx.execute(sql`
        insert into doi_lookup_resolutions
          (project_id, request_id, result_id, resolution_kind, paper_id,
           expected_previous_resolution_id, creation_payload, candidate_context,
           preview_fingerprint, note)
        values
          (${projectId}::uuid, ${requestId}::uuid, ${preview.resultId}::uuid,
           ${action}, ${paperId ? sql`${paperId}::uuid` : sql`null`},
           ${expectedPreviousResolutionId ? sql`${expectedPreviousResolutionId}::uuid` : sql`null`},
           ${preview.payload ? sql`${JSON.stringify(preview.payload)}::jsonb` : sql`null`},
           ${candidateContext ? sql`${JSON.stringify(candidateContext)}::jsonb` : sql`null`},
           ${input.previewFingerprint ?? null}, ${input.note ?? null})
        returning *
      `))[0];
      if (!inserted) throw new DomainError("DATABASE_CONSTRAINT", "DOI resolution could not be created");
      return mapResolution(inserted);
    });
  }

  async function getCurrent(projectIdInput: string, requestIdInput: string): Promise<DoiResolution | null> {
    const projectId = id(projectIdInput, "Project");
    const requestId = id(requestIdInput, "DOI lookup request");
    return transaction(async (tx) => {
      await lockProjectAndRequest(tx, projectId, requestId);
      const found = await currentResolution(tx, projectId, requestId);
      return found ? mapResolution(found) : null;
    });
  }

  return { previewResolution, resolveResolution, currentResolution: getCurrent };
}

export const createDoiLookupResolutionServices = createDoiResolutionServices;
