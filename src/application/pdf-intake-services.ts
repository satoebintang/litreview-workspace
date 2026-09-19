import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
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
import { isPdfIntakeStorageKey, type DocumentByteSource, type DocumentStorage, type StagedDocument } from "@/infrastructure/document-storage";

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

export type PdfIntakeStorage = {
  stage(source: DocumentByteSource, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<StagedDocument>;
  promote(temporaryKey: string, storageKey: string): Promise<void>;
  open(storageKey: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  listKeys(): Promise<string[]>;
};

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

async function readBytes(storage: PdfIntakeStorage, storageKey: string, maxBytes: number): Promise<Uint8Array> {
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
  return new Uint8Array(Buffer.concat(chunks, size));
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
} = {}) {
  const maxBytes = options.maxBytes ?? PDF_INTAKE_MAX_BYTES;

  async function requireProject(projectId: string) {
    parseId(projectId, "Project");
    const found = rows(await db.execute(sql`select id from projects where id=${projectId}::uuid limit 1`))[0];
    if (!found) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
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
        i.sha256, i.storage_key, i.created_at,
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
      where d.project_id=${projectId}::uuid and d.sha256=${sha256}
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
      inspection = await options.metadataInspector.inspect(await readBytes(storage, intake.storageKey, maxBytes));
    } catch (error) {
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
    let promotedKey: string | undefined;
    let intakeId: string | undefined;
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${projectId}:${staged.sha256}`}, 0))`);
        const existing = rows(await tx.execute(sql`
          select id from pdf_intakes
          where project_id=${projectId}::uuid and sha256=${staged.sha256}
          limit 1
        `))[0];
        if (existing) return { id: String(existing.id), created: false };
        intakeId = randomUUID();
        promotedKey = intakeKey(projectId, intakeId);
        const inserted = rows(await tx.execute(sql`
          insert into pdf_intakes
            (id, project_id, original_filename, media_type, byte_size, sha256, storage_key)
          values
            (${intakeId}::uuid, ${projectId}::uuid, ${validatedMetadata.originalFilename}, ${validatedMetadata.mediaType},
             ${staged.byteSize}, ${staged.sha256}, ${promotedKey})
          returning id
        `))[0];
        if (!inserted) throw new DomainError("DATABASE_CONSTRAINT", "PDF intake could not be created");
        await storage.promote(staged.temporaryKey, promotedKey);
        return { id: String(inserted.id), created: true };
      });
      if (!result.created) {
        await storage.remove(staged.temporaryKey).catch(() => undefined);
      }
      const created = await detail(projectId, result.id);
      if (!created) throw new DomainError("DATABASE_CONSTRAINT", "Created PDF intake could not be read");
      if (result.created && !created.metadataResult) {
        // Completion is deliberately outside the staging transaction. If the
        // process dies here, the detail-page Inspect metadata action resumes it.
        try { await ensureInitialPdfMetadataResult(projectId, result.id); } catch { /* durable intake remains recoverable */ }
      }
      return await detail(projectId, result.id);
    } catch (error) {
      await storage.remove(staged.temporaryKey).catch(() => undefined);
      if (promotedKey) await storage.remove(promotedKey).catch(() => undefined);
      if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "PDF intake could not be created");
      if (error instanceof DomainError) throw error;
      throw new DomainError("STORAGE_ERROR", error instanceof Error ? error.message : "PDF intake upload failed");
    }
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
    const attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await detail(projectId, intakeId);
      if (!current) throw new DomainError("NOT_FOUND", "PDF intake was not found");
      const existing = await db.execute(sql`select id, paper_id, full_text_document_id, resolution_kind, materialization_kind, created_at, request_fingerprint from pdf_intake_resolutions where project_id=${projectId}::uuid and intake_id=${intakeId}::uuid limit 1`);
      const existingRow = rows(existing)[0];
      if (existingRow) {
        const requestFingerprint = jsonHash({ intakeId, kind: requested.kind, paperId: requested.paperId ?? null, payload: requested.payload ?? null, previewFingerprint: requested.previewFingerprint });
        if (String(existingRow.request_fingerprint) === requestFingerprint) return {
          id: String(existingRow.id), intakeId, kind: String(existingRow.resolution_kind) as PdfResolutionInput["kind"], paperId: String(existingRow.paper_id), fullTextDocumentId: String(existingRow.full_text_document_id), materializationKind: String(existingRow.materialization_kind) as PdfResolution["materializationKind"], createdAt: dateValue(existingRow.created_at),
        };
        throw new DomainError("CONCURRENT_MODIFICATION", "This PDF intake has already been resolved");
      }
      const source = await intakeStorage.open(current.storageKey);
      let staged: StagedDocument | undefined;
      let promotedKeyForAttempt: string | undefined;
      try {
        staged = await documentStorage.stage(source as unknown as DocumentByteSource, { maxBytes });
        if (staged.sha256 !== current.sha256 || staged.byteSize !== current.byteSize) throw new DomainError("STORAGE_ERROR", "Retained PDF bytes changed unexpectedly");
        const requestFingerprint = jsonHash({ intakeId, kind: requested.kind, paperId: requested.paperId ?? null, payload: requested.payload ?? null, previewFingerprint: requested.previewFingerprint });
        const result = await db.transaction(async (tx) => {
          await tx.execute(sql`select id from projects where id=${projectId}::uuid for update`);
          const lockedIntake = rows(await tx.execute(sql`select id, storage_key, sha256, byte_size from pdf_intakes where project_id=${projectId}::uuid and id=${intakeId}::uuid for update`))[0];
          if (!lockedIntake) throw new DomainError("NOT_FOUND", "PDF intake was not found");
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
          const attached = await attachStagedFullTextDocumentInTransaction(tx, documentStorage, projectId, paperId, { originalFilename: current.originalFilename, mediaType: "application/pdf" }, staged!);
          if (attached.kind === "created") promotedKeyForAttempt = attached.promotedKey;
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
          return { id: String(resolutionRows.id), intakeId, kind: String(resolutionRows.resolution_kind) as PdfResolutionInput["kind"], paperId: String(resolutionRows.paper_id), fullTextDocumentId: String(resolutionRows.full_text_document_id), materializationKind: String(resolutionRows.materialization_kind) as PdfResolution["materializationKind"], createdAt: dateValue(resolutionRows.created_at), promotedKey: attached.kind === "created" ? attached.promotedKey : null };
        }, { isolationLevel: "serializable" });
        if (result.materializationKind === "reused_document") await documentStorage.remove(staged.temporaryKey).catch(() => undefined);
        return result;
      } catch (error) {
        if (staged) {
          await documentStorage.remove(staged.temporaryKey).catch(() => undefined);
          if (promotedKeyForAttempt) await documentStorage.remove(promotedKeyForAttempt).catch(() => undefined);
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
        if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "PDF intake resolution could not be recorded");
        if (error instanceof DomainError) throw error;
        throw new DomainError("STORAGE_ERROR", error instanceof Error ? error.message : "PDF intake resolution failed");
      }
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
          i.sha256, i.storage_key, i.created_at,
          mr.status as metadata_status, r.paper_id as resolution_paper_id,
          r.full_text_document_id as resolution_document_id
        from pdf_intakes i
        left join lateral (select status from pdf_intake_metadata_results m where m.project_id=i.project_id and m.intake_id=i.id order by m.sequence_no desc, m.id desc limit 1) mr on true
        left join pdf_intake_resolutions r on r.project_id=i.project_id and r.intake_id=i.id
        where i.project_id=${projectId}::uuid
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
