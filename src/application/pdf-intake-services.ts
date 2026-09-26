import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError, isConstraintError } from "@/domain/errors";
import { idSchema, createPaperSchema } from "@/domain/validation";
import { validateDocumentFilename, validatePdfMetadata } from "@/domain/full-text-documents";
import { findPaperCandidates, writePaper, type PaperWriteInput } from "./paper-writer";
import {
  attachStagedFullTextDocumentInTransaction,
  type FullTextDocumentUploadMetadata,
} from "./full-text-document-services";
import { DocumentStorageError, isPdfIntakeStorageKey, type DocumentByteSource, type DocumentStorage, type PdfIntakeStorage, type StagedDocument } from "@/infrastructure/document-storage";
import { materializePendingStorageRecord, type StorageCheckpoint, type StorageMaterializationAccess, type StorageMaterializationRecord } from "./storage-materialization";

export const PDF_INTAKE_EXTRACTOR_KEY = "pdf-intake-metadata" as const;
export const PDF_INTAKE_EXTRACTOR_VERSION = "1" as const;
export const PDF_INTAKE_MAPPING_VERSION = "paper-metadata-map-v2" as const;
export const PDF_INTAKE_TEXT_SCAN_VERSION = "pdf-intake-early-text-v1" as const;
export const PDF_INTAKE_DOI_VERSION = "pdf-intake-doi-v2" as const;
export const PDF_INTAKE_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_INTAKE_DIAGNOSTIC_CHARS = 2_000;

export function boundPdfIntakeDiagnostic(value: string | null | undefined): string | null {
  if (value == null) return null;
  return String(value).slice(0, MAX_PDF_INTAKE_DIAGNOSTIC_CHARS);
}

function sanitizePdfMetadataInspection(inspection: PdfMetadataInspection): PdfMetadataInspection {
  return {
    ...inspection,
    diagnostics: inspection.diagnostics.map((diagnostic) => String(diagnostic).slice(0, MAX_PDF_INTAKE_DIAGNOSTIC_CHARS)),
    errorCode: inspection.errorCode == null ? null : String(inspection.errorCode).slice(0, 100),
    errorMessage: boundPdfIntakeDiagnostic(inspection.errorMessage),
    fields: inspection.fields.map((field) => ({ ...field, diagnostic: boundPdfIntakeDiagnostic(field.diagnostic) })),
  };
}

export type PdfMetadataProposal = {
  field: "title" | "authors" | "publicationYear" | "venue" | "doi" | "abstract";
  value: unknown;
  sourceKind: "pdf_info" | "xmp" | "page_text_match" | null;
  sourceLocator: string | null;
  classification: "exact_embedded_metadata" | "exact_text_identifier" | "ambiguous" | "unavailable";
  diagnostic: string | null;
  normalizedValue?: string | null;
  pageNumber?: number | null;
  startOffset?: number | null;
  endOffset?: number | null;
  exactMatch?: string | null;
  pageTextSha256?: string | null;
};

export type PdfMetadataInspection = {
  status: "succeeded" | "partial" | "failed";
  pageCount: number | null;
  attemptedPageCount: number;
  succeededPageCount: number;
  scannedCodePoints: number;
  diagnostics: string[];
  errorCode: string | null;
  errorMessage: string | null;
  extractorKey?: string;
  extractorVersion?: string;
  pdfjsVersion?: string;
  mappingVersion?: string;
  textScanVersion?: string;
  doiAlgorithmVersion?: string;
  fields: PdfMetadataProposal[];
};

export type PdfMetadataInspector = {
  inspect(bytes: Uint8Array, options?: { signal?: AbortSignal }): Promise<PdfMetadataInspection>;
};

export type PdfIntakeSummary = {
  id: string;
  projectId: string;
  originalFilename: string;
  mediaType: "application/pdf";
  byteSize: number;
  sha256: string;
  storageKey: string;
  createdAt: Date;
  state: "staged" | "metadata_succeeded" | "metadata_partial" | "metadata_failed" | "resolved";
  resolutionPaperId: string | null;
  resolutionDocumentId: string | null;
};

export type PdfIntakeDetail = PdfIntakeSummary & {
  metadataResult: PdfMetadataResult | null;
  fields: PdfMetadataProposal[];
  proposal: PaperWriteInput;
  candidates: PdfPaperCandidate[];
  exactDocumentMatches: PdfDocumentMatch[];
};

export type PdfMetadataResult = {
  id: string;
  sequenceNo: number;
  status: PdfMetadataInspection["status"];
  extractorKey: string;
  extractorVersion: string;
  pdfjsVersion: string | null;
  mappingVersion: string;
  textScanVersion: string;
  doiAlgorithmVersion: string;
  pageCount: number | null;
  attemptedPageCount: number;
  succeededPageCount: number;
  scannedCodePoints: number;
  diagnostics: string[];
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export type PdfPaperCandidate = {
  id: string;
  title: string;
  authors: string[];
  publicationYear: number | null;
  venue: string | null;
  doi: string | null;
  abstract: string | null;
  candidateReason: string;
  candidatePriority: number;
};

export type PdfDocumentMatch = {
  id: string;
  paperId: string;
  paperTitle: string;
  sha256: string;
  active: boolean;
  archivedAt: Date | null;
};

export type PdfResolutionInput = {
  kind: "create_paper" | "match_paper";
  paperId?: string | null;
  payload?: PaperWriteInput;
  previewFingerprint: string;
  acknowledgedCandidateIds?: string[];
  distinctPaperAcknowledged?: boolean;
  metadataResultId?: string | null;
};

export type PdfResolution = {
  id: string;
  intakeId: string;
  kind: PdfResolutionInput["kind"];
  paperId: string;
  fullTextDocumentId: string;
  materializationKind: "created_document" | "reused_document";
  createdAt: Date;
};

function rows(value: unknown): Record<string, unknown>[] {
  return value as Record<string, unknown>[];
}

function asIntakeStorageRecord(row: Record<string, unknown>): StorageMaterializationRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    storageKey: String(row.storage_key),
    stagedStorageKey: row.staged_storage_key == null ? null : String(row.staged_storage_key),
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    storageState: String(row.storage_state) as "pending" | "ready",
  };
}

function stringValue(value: unknown): string | null {
  return value == null ? null : String(value);
}

function numberValue(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function parseId(value: string, label: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`, parsed.error.issues);
  return parsed.data;
}

function intakeKey(projectId: string, intakeId: string) {
  return `projects/${projectId}/pdf-intakes/${intakeId}/source.pdf`;
}

function asProposal(row: Record<string, unknown>): PdfMetadataProposal {
  let value = row.value_jsonb;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { /* leave the bounded raw value */ }
  }
  return {
    field: (String(row.paper_field) === "publication_year" ? "publicationYear" : String(row.paper_field)) as PdfMetadataProposal["field"],
    value,
    sourceKind: (row.source_kind == null ? null : String(row.source_kind)) as PdfMetadataProposal["sourceKind"],
    sourceLocator: stringValue(row.source_locator),
    classification: String(row.classification) as PdfMetadataProposal["classification"],
    diagnostic: stringValue(row.diagnostic),
    normalizedValue: stringValue(row.normalized_value),
    pageNumber: numberValue(row.page_number),
    startOffset: numberValue(row.start_offset),
    endOffset: numberValue(row.end_offset),
    exactMatch: stringValue(row.exact_match),
    pageTextSha256: stringValue(row.page_text_sha256),
  };
}

function asMetadataResult(row: Record<string, unknown>): PdfMetadataResult {
  let diagnostics: string[] = [];
  if (Array.isArray(row.diagnostics)) diagnostics = row.diagnostics.map(String);
  else if (typeof row.diagnostics === "string") {
    try { const parsed = JSON.parse(row.diagnostics); if (Array.isArray(parsed)) diagnostics = parsed.map(String); } catch { diagnostics = [row.diagnostics]; }
  }
  return {
    id: String(row.id),
    sequenceNo: Number(row.sequence_no),
    status: String(row.status) as PdfMetadataInspection["status"],
    extractorKey: String(row.extractor_key),
    extractorVersion: String(row.extractor_version),
    pdfjsVersion: stringValue(row.pdfjs_version),
    mappingVersion: String(row.mapping_version),
    textScanVersion: String(row.text_scan_version),
    doiAlgorithmVersion: String(row.doi_algorithm_version),
    pageCount: numberValue(row.page_count),
    attemptedPageCount: Number(row.attempted_page_count ?? 0),
    succeededPageCount: Number(row.succeeded_page_count ?? 0),
    scannedCodePoints: Number(row.scanned_code_points ?? 0),
    diagnostics,
    errorCode: stringValue(row.error_code),
    errorMessage: stringValue(row.error_message),
    createdAt: dateValue(row.created_at),
    completedAt: row.completed_at == null ? null : dateValue(row.completed_at),
  };
}

function asSummary(row: Record<string, unknown>): PdfIntakeSummary {
  const status = stringValue(row.metadata_status);
  const resolutionPaperId = stringValue(row.resolution_paper_id);
  const resolutionDocumentId = stringValue(row.resolution_document_id);
  const state = resolutionPaperId
    ? "resolved"
    : status === "succeeded" ? "metadata_succeeded"
      : status === "partial" ? "metadata_partial"
        : status === "failed" ? "metadata_failed" : "staged";
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    originalFilename: String(row.original_filename),
    mediaType: "application/pdf",
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    storageKey: String(row.storage_key),
    createdAt: dateValue(row.created_at),
    state,
    resolutionPaperId,
    resolutionDocumentId,
  };
}

function asCandidate(row: Record<string, unknown>): PdfPaperCandidate {
  return {
    id: String(row.id),
    title: String(row.title),
    authors: Array.isArray(row.authors) ? row.authors.map(String) : [],
    publicationYear: numberValue(row.publication_year),
    venue: stringValue(row.venue),
    doi: stringValue(row.doi),
    abstract: stringValue(row.abstract),
    candidateReason: String(row.candidate_reason ?? "title"),
    candidatePriority: Number(row.candidate_priority ?? 3),
  };
}

function asDocumentMatch(row: Record<string, unknown>): PdfDocumentMatch {
  return {
    id: String(row.id),
    paperId: String(row.paper_id),
    paperTitle: String(row.paper_title),
    sha256: String(row.sha256),
    active: row.archived_at == null,
    archivedAt: row.archived_at == null ? null : dateValue(row.archived_at),
  };
}

function asPaperPayload(fields: PdfMetadataProposal[]): PaperWriteInput {
  const first = (field: PdfMetadataProposal["field"]) => fields.find((item) => item.field === field && item.classification !== "unavailable" && !(field === "doi" && item.classification === "ambiguous"));
  const title = fields.find((item) => item.field === "title" && item.classification !== "unavailable" && item.diagnostic !== "low_information_embedded_title");
  const authors = first("authors");
  const year = first("publicationYear");
  const venue = first("venue");
  const doi = first("doi");
  const abstract = first("abstract");
  const authorValue = authors?.value;
  const authorList = Array.isArray(authorValue) ? authorValue.map(String) : typeof authorValue === "string" && authorValue.trim() ? [authorValue] : [];
  return {
    title: typeof title?.value === "string" ? title.value : "",
    authors: authorList,
    publicationYear: typeof year?.value === "number" ? year.value : Number.isInteger(Number(year?.value)) ? Number(year?.value) : null,
    venue: typeof venue?.value === "string" ? venue.value : null,
    doi: typeof doi?.value === "string" ? doi.value : null,
    abstract: typeof abstract?.value === "string" ? abstract.value : null,
    bibliographicNote: null,
  };
}

function storedFieldName(field: PdfMetadataProposal["field"]): string {
  return field === "publicationYear" ? "publication_year" : field;
}

async function readBytes(storage: PdfIntakeStorage, storageKey: string, maxBytes: number, expected?: { byteSize: number; sha256: string }): Promise<Uint8Array> {
  const stream = await storage.open(storageKey);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.byteLength;
      if (size > maxBytes) throw new DomainError("STORAGE_ERROR", "Stored PDF exceeds the 50 MiB inspection limit");
      chunks.push(bytes);
    }
  } finally {
    stream.destroy();
  }
  const result = Buffer.concat(chunks, size);
  if (expected && (size !== expected.byteSize || createHash("sha256").update(result).digest("hex") !== expected.sha256)) {
    throw new DomainError("STORAGE_INTEGRITY", "Retained PDF bytes do not match immutable intake metadata");
  }
  return new Uint8Array(result);
}

function jsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mapInspectionError(error: unknown): PdfMetadataInspection {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; message?: unknown; name?: unknown } : {};
  return {
    status: "failed",
    pageCount: null,
    attemptedPageCount: 0,
    succeededPageCount: 0,
    scannedCodePoints: 0,
    diagnostics: ["Metadata inspection raised an unexpected parser error."],
    errorCode: String(candidate.code ?? candidate.name ?? "parser_failure").slice(0, 100),
    errorMessage: boundPdfIntakeDiagnostic(String(candidate.message ?? "PDF metadata inspection failed")),
    extractorKey: PDF_INTAKE_EXTRACTOR_KEY,
    extractorVersion: PDF_INTAKE_EXTRACTOR_VERSION,
    mappingVersion: PDF_INTAKE_MAPPING_VERSION,
    textScanVersion: PDF_INTAKE_TEXT_SCAN_VERSION,
    doiAlgorithmVersion: PDF_INTAKE_DOI_VERSION,
    fields: (["title", "authors", "publicationYear", "venue", "doi", "abstract"] as const).map((field) => ({
      field,
      value: null,
      sourceKind: null,
      sourceLocator: null,
      classification: "unavailable" as const,
      diagnostic: "metadata_inspection_failed",
    })),
  };
}

export function createPdfIntakeServices(db: Database, options: {
  intakeStorage?: PdfIntakeStorage;
  documentStorage?: DocumentStorage;
  metadataInspector?: PdfMetadataInspector;
  maxBytes?: number;
  onCheckpoint?: StorageCheckpoint;
} = {}) {
  const maxBytes = options.maxBytes ?? PDF_INTAKE_MAX_BYTES;

  async function requireProject(projectId: string) {
    parseId(projectId, "Project");
    const found = rows(await db.execute(sql`select id from projects where id=${projectId}::uuid limit 1`))[0];
    if (!found) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
  }

  async function loadIntakeStorageRecord(projectId: string, intakeId: string) {
    const found = rows(await db.execute(sql`
      select id, project_id, storage_key, staged_storage_key, byte_size, sha256, storage_state
      from pdf_intakes where project_id=${projectId}::uuid and id=${intakeId}::uuid limit 1
    `))[0];
    return found ? asIntakeStorageRecord(found) : null;
  }

  function intakeMaterializationAccess(projectId: string): StorageMaterializationAccess {
    return {
      load: (id) => loadIntakeStorageRecord(projectId, id),
      replaceStage: async (id, expectedStageKey, replacementStageKey) => {
        const updated = rows(await db.execute(sql`
          update pdf_intakes set staged_storage_key=${replacementStageKey}
          where project_id=${projectId}::uuid and id=${id}::uuid
            and storage_state='pending' and staged_storage_key=${expectedStageKey}
          returning id, project_id, storage_key, staged_storage_key, byte_size, sha256, storage_state
        `))[0];
        return updated ? asIntakeStorageRecord(updated) : null;
      },
      markReady: async (id, expectedStageKey) => {
        const updated = rows(await db.execute(sql`
          update pdf_intakes set storage_state='ready', staged_storage_key=null
          where project_id=${projectId}::uuid and id=${id}::uuid
            and storage_state='pending' and staged_storage_key=${expectedStageKey}
          returning id, project_id, storage_key, staged_storage_key, byte_size, sha256, storage_state
        `))[0];
        return updated ? asIntakeStorageRecord(updated) : null;
      },
    };
  }

  function requireIntakeStorage() {
    if (!options.intakeStorage) throw new DomainError("STORAGE_ERROR", "PDF intake storage is not configured");
    return options.intakeStorage;
  }

  function requireDocumentStorage() {
    if (!options.documentStorage) throw new DomainError("STORAGE_ERROR", "Document storage is not configured");
    return options.documentStorage;
  }

  async function loadIntake(projectId: string, intakeId: string, executor: Pick<Database, "execute"> = db) {
    const result = rows(await executor.execute(sql`
      select i.id, i.project_id, i.original_filename, i.media_type, i.byte_size,
        i.sha256, i.storage_key, i.storage_state, i.created_at,
        mr.status as metadata_status,
        r.paper_id as resolution_paper_id,
        r.full_text_document_id as resolution_document_id
      from pdf_intakes i
      left join lateral (
        select status from pdf_intake_metadata_results m
        where m.project_id=i.project_id and m.intake_id=i.id
        order by m.sequence_no desc, m.id desc limit 1
      ) mr on true
      left join pdf_intake_resolutions r on r.project_id=i.project_id and r.intake_id=i.id
      where i.project_id=${projectId}::uuid and i.id=${intakeId}::uuid
      limit 1
    `))[0];
    if (result?.storage_state === "pending") throw new DomainError("STORAGE_PENDING", "PDF intake bytes are still being materialized");
    return result ? asSummary(result) : null;
  }

  async function getResult(projectId: string, intakeId: string, executor: Pick<Database, "execute"> = db) {
    const result = rows(await executor.execute(sql`
      select * from pdf_intake_metadata_results
      where project_id=${projectId}::uuid and intake_id=${intakeId}::uuid
      order by sequence_no desc, id desc limit 1
    `))[0];
    return result ? asMetadataResult(result) : null;
  }

  async function listFields(projectId: string, resultId: string, executor: Pick<Database, "execute"> = db) {
    const result = await executor.execute(sql`
      select paper_field, candidate_ordinal, value_jsonb, source_kind, source_locator,
        classification, diagnostic, normalized_value, page_number, start_offset,
        end_offset, exact_match, page_text_sha256
      from pdf_intake_metadata_fields
      where project_id=${projectId}::uuid and result_id=${resultId}::uuid
      order by paper_field, candidate_ordinal, id
    `);
    return rows(result).map(asProposal);
  }

  async function findCandidates(executor: Pick<Database, "execute">, projectId: string, payload: PaperWriteInput) {
    const found = await findPaperCandidates(executor, projectId, payload);
    return found.map(asCandidate);
  }

  async function findDocumentMatches(executor: Pick<Database, "execute">, projectId: string, sha256: string) {
    const found = await executor.execute(sql`
      select d.id, d.paper_id, p.title as paper_title, d.sha256, d.archived_at
      from full_text_documents d
      join papers p on p.project_id=d.project_id and p.id=d.paper_id
      where d.project_id=${projectId}::uuid and d.sha256=${sha256} and d.storage_state='ready'
      order by d.archived_at nulls first, d.created_at, d.id
    `);
    return rows(found).map(asDocumentMatch);
  }

  async function detail(projectId: string, intakeId: string, executor: Pick<Database, "execute"> = db): Promise<PdfIntakeDetail | null> {
    const summary = await loadIntake(projectId, intakeId, executor);
    if (!summary) return null;
    const metadataResult = await getResult(projectId, intakeId, executor);
    const fields = metadataResult ? await listFields(projectId, metadataResult.id, executor) : [];
    const proposal = asPaperPayload(fields);
    const candidates = proposal.title.trim() || proposal.doi?.trim() ? await findCandidates(executor, projectId, proposal) : [];
    const exactDocumentMatches = await findDocumentMatches(executor, projectId, summary.sha256);
    return { ...summary, metadataResult, fields, proposal, candidates, exactDocumentMatches };
  }

  async function ensureInitialPdfMetadataResult(projectId: string, intakeId: string) {
    parseId(projectId, "Project");
    parseId(intakeId, "PDF intake");
    await requireProject(projectId);
    const storage = requireIntakeStorage();
    const intake = await loadIntake(projectId, intakeId);
    if (!intake) throw new DomainError("NOT_FOUND", "PDF intake was not found");
    const existing = await getResult(projectId, intakeId);
    if (existing) return existing;

    let inspection: PdfMetadataInspection;
    try {
      if (!options.metadataInspector) throw new DomainError("STORAGE_ERROR", "PDF metadata inspection is not configured");
      const stored = await storage.inspect(intake.storageKey);
      if (!stored || stored.byteSize !== intake.byteSize || stored.sha256 !== intake.sha256) {
        throw new DomainError("STORAGE_INTEGRITY", "Retained PDF bytes do not match immutable intake metadata");
      }
      inspection = await options.metadataInspector.inspect(await readBytes(storage, intake.storageKey, maxBytes, intake));
    } catch (error) {
      if (error instanceof DomainError && ["STORAGE_PENDING", "STORAGE_INTEGRITY"].includes(error.code)) throw error;
      if (error instanceof DocumentStorageError) {
        throw new DomainError(error.code === "STORAGE_INTEGRITY" ? "STORAGE_INTEGRITY" : "STORAGE_ERROR", error.message);
      }
      inspection = mapInspectionError(error);
    }
    inspection = sanitizePdfMetadataInspection(inspection);

    try {
      const inserted = await db.transaction(async (tx) => {
        await tx.execute(sql`select id from pdf_intakes where project_id=${projectId}::uuid and id=${intakeId}::uuid for update`);
        const current = rows(await tx.execute(sql`
          select * from pdf_intake_metadata_results
          where project_id=${projectId}::uuid and intake_id=${intakeId}::uuid
          order by sequence_no desc, id desc limit 1
        `))[0];
        if (current) return asMetadataResult(current);
        const [nextSequence] = rows(await tx.execute(sql`
          select coalesce(max(sequence_no), 0) + 1 as sequence_no
          from pdf_intake_metadata_results
          where project_id=${projectId}::uuid and intake_id=${intakeId}::uuid
        `));
        const sequenceNo = Number(nextSequence?.sequence_no ?? 1);
        const resultId = randomUUID();
        const resultRows = rows(await tx.execute(sql`
          insert into pdf_intake_metadata_results
            (id, sequence_no, project_id, intake_id, status, extractor_key,
             extractor_version, pdfjs_version, mapping_version, text_scan_version,
             doi_algorithm_version, page_count, attempted_page_count,
             succeeded_page_count, scanned_code_points, diagnostics, error_code,
             error_message, completed_at)
          values
            (${resultId}::uuid, ${sequenceNo}, ${projectId}::uuid, ${intakeId}::uuid,
             ${inspection.status}, ${inspection.extractorKey ?? PDF_INTAKE_EXTRACTOR_KEY},
             ${inspection.extractorVersion ?? PDF_INTAKE_EXTRACTOR_VERSION},
             ${inspection.pdfjsVersion ?? null}, ${inspection.mappingVersion ?? PDF_INTAKE_MAPPING_VERSION},
             ${inspection.textScanVersion ?? PDF_INTAKE_TEXT_SCAN_VERSION},
             ${inspection.doiAlgorithmVersion ?? PDF_INTAKE_DOI_VERSION},
             ${inspection.pageCount}, ${inspection.attemptedPageCount},
             ${inspection.succeededPageCount}, ${inspection.scannedCodePoints},
             ${JSON.stringify(inspection.diagnostics)}::jsonb,
             ${inspection.status === "failed" ? inspection.errorCode ?? "metadata_failed" : null},
             ${inspection.errorMessage}, now())
          returning *
        `))[0];
        if (!resultRows) throw new DomainError("DATABASE_CONSTRAINT", "PDF metadata result could not be created");
        for (const [index, field] of inspection.fields.entries()) {
          const valueJson = field.value == null ? sql`null` : sql`${JSON.stringify(field.value)}::jsonb`;
          await tx.execute(sql`
            insert into pdf_intake_metadata_fields
              (id, project_id, intake_id, result_id, paper_field,
               candidate_ordinal, value_jsonb, source_kind, source_locator,
               classification, diagnostic, normalized_value, page_number,
               start_offset, end_offset, exact_match, page_text_sha256)
            values
              (${randomUUID()}::uuid, ${projectId}::uuid, ${intakeId}::uuid,
               ${resultId}::uuid, ${storedFieldName(field.field)}, ${index + 1},
               ${valueJson},
               ${field.sourceKind}, ${field.sourceLocator}, ${field.classification},
               ${field.diagnostic}, ${field.normalizedValue ?? null}, ${field.pageNumber ?? null},
               ${field.startOffset ?? null}, ${field.endOffset ?? null}, ${field.exactMatch ?? null},
               ${field.pageTextSha256 ?? null})
          `);
        }
        return asMetadataResult(resultRows);
      });
      return inserted;
    } catch (error) {
      if (isConstraintError(error)) {
        const winner = await getResult(projectId, intakeId);
        if (winner) return winner;
      }
      throw error;
    }
  }

  async function uploadPdfIntake(projectId: string, metadata: FullTextDocumentUploadMetadata, source: DocumentByteSource) {
    parseId(projectId, "Project");
    await requireProject(projectId);
    let validatedMetadata: FullTextDocumentUploadMetadata;
    try {
      validatedMetadata = validatePdfMetadata(metadata);
      validateDocumentFilename(validatedMetadata.originalFilename);
    } catch (error) {
      throw new DomainError("VALIDATION_ERROR", error instanceof Error ? error.message : "PDF metadata is invalid");
    }
    const storage = requireIntakeStorage();
    const staged = await storage.stage(source, { maxBytes });
    await options.onCheckpoint?.("after_staging", { flow: "pdf_intake", projectId, storageKey: staged.temporaryKey });
    const newIntakeId = randomUUID();
    const newStorageKey = intakeKey(projectId, newIntakeId);
    let reservation: { id: string; created: boolean; storageState: "pending" | "ready"; stagedStorageKey: string | null };
    try {
      reservation = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${projectId}:${staged.sha256}`}, 0))`);
        const existing = rows(await tx.execute(sql`
          select id, byte_size, storage_state, staged_storage_key from pdf_intakes
          where project_id=${projectId}::uuid and sha256=${staged.sha256}
          limit 1
        `))[0];
        if (existing) {
          if (Number(existing.byte_size) !== staged.byteSize) throw new DomainError("STORAGE_INTEGRITY", "A PDF SHA-256 owner has a conflicting expected byte size");
          return {
            id: String(existing.id),
            created: false,
            storageState: String(existing.storage_state) as "pending" | "ready",
            stagedStorageKey: existing.staged_storage_key == null ? null : String(existing.staged_storage_key),
          };
        }
        const inserted = rows(await tx.execute(sql`
          insert into pdf_intakes
            (id, project_id, original_filename, media_type, byte_size, sha256, storage_key, storage_state, staged_storage_key)
          values
            (${newIntakeId}::uuid, ${projectId}::uuid, ${validatedMetadata.originalFilename}, ${validatedMetadata.mediaType},
             ${staged.byteSize}, ${staged.sha256}, ${newStorageKey}, 'pending', ${staged.temporaryKey})
          returning id, storage_state, staged_storage_key
        `))[0];
        if (!inserted) throw new DomainError("DATABASE_CONSTRAINT", "PDF intake could not be created");
        return { id: String(inserted.id), created: true, storageState: "pending" as const, stagedStorageKey: String(inserted.staged_storage_key) };
      });
    } catch (error) {
      // Unexpected transaction errors can race a commit still being resolved;
      // keep those stages for audit instead of risking recovery bytes.
      if (error instanceof DomainError || isConstraintError(error)) {
        await storage.remove(staged.temporaryKey).catch(() => undefined);
      }
      if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "PDF intake could not be created");
      if (error instanceof DomainError) throw error;
      throw new DomainError("STORAGE_ERROR", error instanceof Error ? error.message : "PDF intake upload failed");
    }

    if (reservation.storageState === "ready") {
      await storage.remove(staged.temporaryKey).catch(() => undefined);
    } else {
      await options.onCheckpoint?.("after_pending_commit", { flow: "pdf_intake", projectId, id: reservation.id, storageKey: intakeKey(projectId, reservation.id) });
      try {
        await materializePendingStorageRecord({
          access: intakeMaterializationAccess(projectId),
          storage,
          id: reservation.id,
          projectId,
          flow: "pdf_intake",
          checkpoint: options.onCheckpoint,
          replacementStage: async () => staged,
        });
        await storage.remove(staged.temporaryKey).catch(() => undefined);
      } catch (error) {
        if (error instanceof DocumentStorageError) {
          throw new DomainError(error.code === "STORAGE_INTEGRITY" ? "STORAGE_INTEGRITY" : "STORAGE_ERROR", error.message);
        }
        throw error;
      }
    }

    const created = await detail(projectId, reservation.id);
    if (!created) throw new DomainError("DATABASE_CONSTRAINT", "Created PDF intake could not be read");
    if (!created.metadataResult && options.metadataInspector) {
      // Metadata inspection is a separate, resumable operation after the
      // retained source has reached ready state.
      await ensureInitialPdfMetadataResult(projectId, reservation.id);
    }
    return await detail(projectId, reservation.id);
  }

  async function previewPdfIntakeResolution(projectId: string, intakeId: string, input: Omit<PdfResolutionInput, "previewFingerprint">) {
    const current = await detail(projectId, intakeId);
    if (!current) throw new DomainError("NOT_FOUND", "PDF intake was not found");
    if (!current.metadataResult) throw new DomainError("VALIDATION_ERROR", "Inspect metadata before resolving this PDF intake");
    const selectedPaperId = input.kind === "match_paper" ? parseId(String(input.paperId ?? ""), "Paper") : null;
    const payload = input.kind === "create_paper" ? input.payload ?? current.proposal : current.proposal;
    const candidateContext = current.candidates.map((candidate) => ({ id: candidate.id, reason: candidate.candidateReason, priority: candidate.candidatePriority }));
    const documentContext = current.exactDocumentMatches.map((document) => ({ id: document.id, paperId: document.paperId, active: document.active, archivedAt: document.archivedAt?.toISOString() ?? null }));
    const fingerprint = jsonHash({ intakeId, metadataResultId: current.metadataResult.id, kind: input.kind, paperId: selectedPaperId, payload, candidateContext, documentContext });
    return { fingerprint, metadataResultId: current.metadataResult.id, payload, candidates: current.candidates, exactDocumentMatches: current.exactDocumentMatches, selectedPaperId };
  }

  async function resolvePdfIntake(projectId: string, intakeId: string, input: PdfResolutionInput): Promise<PdfResolution> {
    parseId(projectId, "Project");
    parseId(intakeId, "PDF intake");
    await requireProject(projectId);
    const intakeStorage = requireIntakeStorage();
    const documentStorage = requireDocumentStorage();
    const requested = (() => {
      if (input.kind !== "create_paper") return input;
      const parsed = createPaperSchema.safeParse(input.payload ?? {});
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Canonical Paper payload is invalid", parsed.error.issues);
      return { ...input, payload: parsed.data };
    })();
    const requestFingerprint = jsonHash({ intakeId, kind: requested.kind, paperId: requested.paperId ?? null, payload: requested.payload ?? null, previewFingerprint: requested.previewFingerprint });

    const toResolution = (row: Record<string, unknown>): PdfResolution => ({
      id: String(row.id),
      intakeId,
      kind: String(row.resolution_kind) as PdfResolutionInput["kind"],
      paperId: String(row.paper_id),
      fullTextDocumentId: String(row.full_text_document_id),
      materializationKind: String(row.materialization_kind) as PdfResolution["materializationKind"],
      createdAt: dateValue(row.created_at),
    });

    const documentAccess = (ownerProjectId: string): StorageMaterializationAccess => ({
      load: async (id) => {
        const row = rows(await db.execute(sql`
          select id, project_id, storage_key, staged_storage_key, byte_size, sha256, storage_state
          from full_text_documents where project_id=${ownerProjectId}::uuid and id=${id}::uuid limit 1
        `))[0];
        return row ? asIntakeStorageRecord(row) : null;
      },
      replaceStage: async (id, expectedStageKey, replacementStageKey) => {
        const row = rows(await db.execute(sql`
          update full_text_documents set staged_storage_key=${replacementStageKey}
          where project_id=${ownerProjectId}::uuid and id=${id}::uuid
            and storage_state='pending' and staged_storage_key=${expectedStageKey}
          returning id, project_id, storage_key, staged_storage_key, byte_size, sha256, storage_state
        `))[0];
        return row ? asIntakeStorageRecord(row) : null;
      },
      markReady: async (id, expectedStageKey) => {
        const row = rows(await db.execute(sql`
          update full_text_documents set storage_state='ready', staged_storage_key=null
          where project_id=${ownerProjectId}::uuid and id=${id}::uuid
            and storage_state='pending' and staged_storage_key=${expectedStageKey}
          returning id, project_id, storage_key, staged_storage_key, byte_size, sha256, storage_state
        `))[0];
        return row ? asIntakeStorageRecord(row) : null;
      },
    });

    const findResolution = async () => rows(await db.execute(sql`
      select r.id, r.paper_id, r.full_text_document_id, r.resolution_kind,
        r.materialization_kind, r.created_at, r.request_fingerprint
      from pdf_intake_resolutions r
      where r.project_id=${projectId}::uuid and r.intake_id=${intakeId}::uuid limit 1
    `))[0] ?? null;

    const finishExistingResolution = async (row: Record<string, unknown>): Promise<PdfResolution> => {
      const resolution = toResolution(row);
      const intake = await loadIntakeStorageRecord(projectId, intakeId);
      if (!intake) throw new DomainError("NOT_FOUND", "PDF intake was not found");
      if (intake.storageState !== "ready") throw new DomainError("STORAGE_PENDING", "PDF intake bytes are still being materialized");
      const storedIntake = await intakeStorage.inspect(intake.storageKey);
      if (!storedIntake || storedIntake.byteSize !== intake.byteSize || storedIntake.sha256 !== intake.sha256) {
        throw new DomainError("STORAGE_INTEGRITY", "Ready PDF intake bytes do not match immutable metadata");
      }

      if (resolution.materializationKind === "reused_document") {
        const document = await documentAccess(projectId).load(resolution.fullTextDocumentId);
        if (!document || document.storageState !== "ready") throw new DomainError("STORAGE_INTEGRITY", "A reused PDF resolution must reference a ready document");
        const final = await documentStorage.inspect(document.storageKey);
        if (!final || final.byteSize !== document.byteSize || final.sha256 !== document.sha256) {
          throw new DomainError("STORAGE_INTEGRITY", "A reused document has missing or mismatched final bytes");
        }
        await documentStorage.ensureDurable(document.storageKey);
      } else {
        await materializePendingStorageRecord({
          access: documentAccess(projectId),
          storage: documentStorage,
          id: resolution.fullTextDocumentId,
          projectId,
          flow: "pdf_intake_resolution",
          checkpoint: options.onCheckpoint,
          replacementStage: async () => {
            const source = await intakeStorage.open(intake.storageKey);
            const replacement = await documentStorage.stage(source as unknown as DocumentByteSource, { maxBytes });
            await options.onCheckpoint?.("after_staging", { flow: "pdf_intake_resolution", projectId, id: resolution.fullTextDocumentId, storageKey: replacement.temporaryKey });
            if (replacement.sha256 !== intake.sha256 || replacement.byteSize !== intake.byteSize) {
              await documentStorage.remove(replacement.temporaryKey).catch(() => undefined);
              throw new DomainError("STORAGE_INTEGRITY", "Retained intake bytes changed while repairing canonical staging");
            }
            return replacement;
          },
        });
      }
      return resolution;
    };

    // A matching retry resumes the exact stored decision before loading any
    // candidate preview. Recovery never replays researcher intent.
    const committedResolution = await findResolution();
    if (committedResolution) {
      if (String(committedResolution.request_fingerprint) !== requestFingerprint) {
        throw new DomainError("CONCURRENT_MODIFICATION", "This PDF intake has already been resolved");
      }
      return finishExistingResolution(committedResolution);
    }

    const attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await detail(projectId, intakeId);
      if (!current) throw new DomainError("NOT_FOUND", "PDF intake was not found");

      if (requested.kind === "match_paper") {
        const targetPaperId = parseId(String(requested.paperId ?? ""), "Paper");
        const pending = rows(await db.execute(sql`
          select id from full_text_documents
          where project_id=${projectId}::uuid and paper_id=${targetPaperId}::uuid
            and sha256=${current.sha256} and archived_at is null and storage_state='pending'
          limit 1
        `))[0];
        if (pending) {
          await materializePendingStorageRecord({
            access: documentAccess(projectId), storage: documentStorage, id: String(pending.id),
            projectId, flow: "pdf_intake_resolution", checkpoint: options.onCheckpoint,
          });
          throw new DomainError("CONCURRENT_MODIFICATION", "An exact-document candidate changed; refresh the PDF intake preview before resolving it");
        }
      }

      const source = await intakeStorage.open(current.storageKey);
      let staged: StagedDocument;
      try {
        staged = await documentStorage.stage(source as unknown as DocumentByteSource, { maxBytes });
      } catch (error) {
        if (error instanceof DocumentStorageError) throw new DomainError(error.code === "STORAGE_INTEGRITY" ? "STORAGE_INTEGRITY" : "STORAGE_ERROR", error.message);
        throw error;
      }
      await options.onCheckpoint?.("after_staging", { flow: "pdf_intake_resolution", projectId, storageKey: staged.temporaryKey });
      if (staged.sha256 !== current.sha256 || staged.byteSize !== current.byteSize) {
        await documentStorage.remove(staged.temporaryKey).catch(() => undefined);
        throw new DomainError("STORAGE_INTEGRITY", "Retained PDF bytes changed unexpectedly");
      }

      let result: PdfResolution;
      try {
        result = await db.transaction(async (tx) => {
          await tx.execute(sql`select id from projects where id=${projectId}::uuid for update`);
          const lockedIntake = rows(await tx.execute(sql`select id, storage_key, sha256, byte_size, storage_state from pdf_intakes where project_id=${projectId}::uuid and id=${intakeId}::uuid for update`))[0];
          if (!lockedIntake) throw new DomainError("NOT_FOUND", "PDF intake was not found");
          if (lockedIntake.storage_state !== "ready") throw new DomainError("STORAGE_PENDING", "PDF intake bytes are still being materialized");
          if (String(lockedIntake.sha256) !== current.sha256 || Number(lockedIntake.byte_size) !== current.byteSize) throw new DomainError("STORAGE_INTEGRITY", "PDF intake identity changed before resolution");
          const prior = rows(await tx.execute(sql`select id from pdf_intake_resolutions where project_id=${projectId}::uuid and intake_id=${intakeId}::uuid limit 1`))[0];
          if (prior) throw new DomainError("CONCURRENT_MODIFICATION", "This PDF intake has already been resolved");
          const resultRow = rows(await tx.execute(sql`select * from pdf_intake_metadata_results where project_id=${projectId}::uuid and intake_id=${intakeId}::uuid order by sequence_no desc, id desc limit 1`))[0];
          if (!resultRow) throw new DomainError("VALIDATION_ERROR", "Inspect metadata before resolving this PDF intake");
          if (requested.metadataResultId && String(resultRow.id) !== requested.metadataResultId) throw new DomainError("CONCURRENT_MODIFICATION", "Metadata proposal is stale; refresh the intake before resolving it");
          const payload = requested.kind === "create_paper" ? requested.payload! : current.proposal;
          const candidates = await findCandidates(tx, projectId, payload);
          const matches = await findDocumentMatches(tx, projectId, current.sha256);
          const context = { candidates: candidates.map((candidate) => ({ id: candidate.id, reason: candidate.candidateReason, priority: candidate.candidatePriority })), documents: matches.map((document) => ({ id: document.id, paperId: document.paperId, active: document.active, archivedAt: document.archivedAt?.toISOString() ?? null })) };
          const actualPreview = jsonHash({ intakeId, metadataResultId: String(resultRow.id), kind: requested.kind, paperId: requested.paperId ?? null, payload, candidateContext: context.candidates, documentContext: context.documents });
          if (actualPreview !== requested.previewFingerprint) throw new DomainError("CONCURRENT_MODIFICATION", "Candidate review is stale; refresh the intake before resolving it");
          if (requested.kind === "create_paper" && (candidates.length > 0 || matches.length > 0) && !requested.distinctPaperAcknowledged) throw new DomainError("DUPLICATE_REVIEW_REQUIRED", "Acknowledge the candidate and exact-document signals before creating a distinct Paper");
          let paperId: string;
          if (requested.kind === "create_paper") {
            const paper = await writePaper(tx, projectId, payload, { source: "pdf_intake" });
            paperId = String(paper.id);
          } else {
            paperId = parseId(String(requested.paperId ?? ""), "Paper");
            const target = rows(await tx.execute(sql`select id from papers where project_id=${projectId}::uuid and id=${paperId}::uuid for update`))[0];
            if (!target) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
          }
          const attached = await attachStagedFullTextDocumentInTransaction(tx, projectId, paperId, { originalFilename: current.originalFilename, mediaType: "application/pdf" }, staged);
          if (attached.kind === "pending") throw new DomainError("CONCURRENT_MODIFICATION", "A pending exact-document owner must be recovered before resolving this PDF intake");
          const resolutionId = randomUUID();
          const resolutionRows = rows(await tx.execute(sql`
            insert into pdf_intake_resolutions
              (id, project_id, intake_id, metadata_result_id, resolution_kind,
               paper_id, full_text_document_id, materialization_kind, creation_payload,
               candidate_context, preview_fingerprint, request_fingerprint)
            values
              (${resolutionId}::uuid, ${projectId}::uuid, ${intakeId}::uuid,
               ${String(resultRow.id)}::uuid, ${requested.kind}, ${paperId}::uuid,
               ${attached.document.id}::uuid, ${attached.kind === "created" ? "created_document" : "reused_document"},
               ${requested.kind === "create_paper" ? JSON.stringify(payload) : null}::jsonb,
               ${JSON.stringify(context)}::jsonb, ${requested.previewFingerprint}, ${requestFingerprint})
            returning id, paper_id, full_text_document_id, resolution_kind, materialization_kind, created_at
          `))[0];
          if (!resolutionRows) throw new DomainError("DATABASE_CONSTRAINT", "PDF intake resolution could not be recorded");
          return toResolution(resolutionRows);
        }, { isolationLevel: "serializable" });
      } catch (error) {
        // A failed serializable transaction may still commit after a lost
        // response; retain the source until ownership is unambiguous.
        if (error instanceof DomainError || isConstraintError(error)) {
          await documentStorage.remove(staged.temporaryKey).catch(() => undefined);
        }
        const concurrentResolution = await findResolution().catch(() => null);
        if (concurrentResolution) {
          if (String(concurrentResolution.request_fingerprint) === requestFingerprint) return finishExistingResolution(concurrentResolution);
          throw new DomainError("CONCURRENT_MODIFICATION", "This PDF intake has already been resolved");
        }
        let code = "";
        let currentError: unknown = error;
        for (let depth = 0; depth < 4 && currentError; depth += 1) {
          if (typeof currentError === "object" && currentError !== null && "code" in currentError) {
            code = String((currentError as { code?: unknown }).code ?? code);
            if (code === "40001" || code === "40P01") break;
          }
          currentError = typeof currentError === "object" && currentError !== null && "cause" in currentError
            ? (currentError as { cause?: unknown }).cause
            : undefined;
        }
        if ((code === "40001" || code === "40P01") && attempt + 1 < attempts) continue;
        if (error instanceof DomainError && error.code === "CONCURRENT_MODIFICATION" && requested.kind === "match_paper") {
          const targetPaperId = parseId(String(requested.paperId ?? ""), "Paper");
          const pending = rows(await db.execute(sql`
            select id from full_text_documents
            where project_id=${projectId}::uuid and paper_id=${targetPaperId}::uuid
              and sha256=${current.sha256} and archived_at is null and storage_state='pending'
            limit 1
          `))[0];
          if (pending) await materializePendingStorageRecord({
            access: documentAccess(projectId), storage: documentStorage, id: String(pending.id),
            projectId, flow: "pdf_intake_resolution", checkpoint: options.onCheckpoint,
          });
        }
        if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "PDF intake resolution could not be recorded");
        if (error instanceof DomainError) throw error;
        throw new DomainError("STORAGE_ERROR", error instanceof Error ? error.message : "PDF intake resolution failed");
      }

      if (result.materializationKind === "reused_document") {
        await documentStorage.remove(staged.temporaryKey).catch(() => undefined);
        return result;
      }
      await options.onCheckpoint?.("after_resolution_commit", { flow: "pdf_intake_resolution", projectId, id: result.fullTextDocumentId, storageKey: result.fullTextDocumentId });
      try {
        await materializePendingStorageRecord({
          access: documentAccess(projectId), storage: documentStorage, id: result.fullTextDocumentId,
          projectId, flow: "pdf_intake_resolution", checkpoint: options.onCheckpoint,
        });
      } catch (error) {
        if (error instanceof DocumentStorageError) throw new DomainError(error.code === "STORAGE_INTEGRITY" ? "STORAGE_INTEGRITY" : "STORAGE_ERROR", error.message);
        throw error;
      }
      return result;
    }
    throw new DomainError("CONCURRENT_MODIFICATION", "PDF intake resolution could not complete after retries");
  }

  return {
    uploadPdfIntake,
    ensureInitialPdfMetadataResult,
    listPdfIntakes: async (projectId: string) => {
      parseId(projectId, "Project");
      await requireProject(projectId);
      const result = await db.execute(sql`
        select i.id, i.project_id, i.original_filename, i.media_type, i.byte_size,
          i.sha256, i.storage_key, i.storage_state, i.created_at,
          mr.status as metadata_status, r.paper_id as resolution_paper_id,
          r.full_text_document_id as resolution_document_id
        from pdf_intakes i
        left join lateral (select status from pdf_intake_metadata_results m where m.project_id=i.project_id and m.intake_id=i.id order by m.sequence_no desc, m.id desc limit 1) mr on true
        left join pdf_intake_resolutions r on r.project_id=i.project_id and r.intake_id=i.id
        where i.project_id=${projectId}::uuid and i.storage_state='ready'
        order by i.created_at desc, i.id desc
      `);
      return rows(result).map(asSummary);
    },
    getPdfIntake: async (projectId: string, intakeId: string) => {
      parseId(projectId, "Project");
      parseId(intakeId, "PDF intake");
      await requireProject(projectId);
      return detail(projectId, intakeId);
    },
    previewPdfIntakeResolution,
    resolvePdfIntake,
    auditPdfIntakeStorage: async (projectId?: string) => {
      const storage = requireIntakeStorage();
      const rowsFound = rows(await db.execute(sql`select id, project_id, storage_key from pdf_intakes ${projectId ? sql`where project_id=${projectId}::uuid` : sql``}`));
      const keys = new Set(await storage.listKeys());
      const referenced = new Set(rowsFound.map((row) => String(row.storage_key)));
      const prefix = projectId ? `projects/${projectId}/pdf-intakes/` : "projects/";
      return {
        missingFiles: rowsFound.filter((row) => !keys.has(String(row.storage_key))).map((row) => String(row.id)),
        orphanFiles: [...keys].filter((key) => isPdfIntakeStorageKey(key) && key.startsWith(prefix) && !referenced.has(key)),
        stagedFiles: [...keys].filter((key) => key.startsWith(".pdf-intake/.tmp/")),
      };
    },
  };
}
