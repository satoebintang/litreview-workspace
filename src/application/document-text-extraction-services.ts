import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError, isConstraintError } from "@/domain/errors";
import {
  codePointLength,
  codePointSlice,
  normalizeLineEndings,
  validateCodePointRange,
} from "@/domain/unicode-offsets";
import type {
  DocumentTextExtraction,
  DocumentTextExtractionPage,
  DocumentTextExtractionStatus,
  Evidence,
} from "@/domain/types";
import { fullTextDocuments } from "@/db/schema";
import type { DocumentStorage } from "@/infrastructure/document-storage";
import { idSchema, recordExtractedEvidenceSchema } from "@/domain/validation";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 2_000;
const DEFAULT_MAX_PAGE_CODE_POINTS = 500_000;
const DEFAULT_MAX_RUN_CODE_POINTS = 10_000_000;
const MAX_ERROR_MESSAGE = 1_000;
const DEFAULT_DEADLINE_MS = 60_000;

/**
 * Infrastructure owns PDF.js types. The application sees only this small
 * parser-neutral result contract.
 */
export type DocumentTextExtractionParserPage = {
  pageNumber: number;
  status: "succeeded" | "failed";
  text: string;
  characterCount?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  error?: { code: string; message: string } | null;
};

export type DocumentTextExtractionParserResult = {
  pageCount: number | null;
  pages: readonly DocumentTextExtractionParserPage[];
  status: DocumentTextExtractionStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  error?: { code: string; message: string } | null;
};

export type DocumentTextExtractionParser = {
  extractorKey: string;
  extractorVersion: string;
  algorithmVersion: string;
  extract(
    bytes: Uint8Array,
    options: {
      signal: AbortSignal;
      maxPages: number;
      maxPageCodePoints: number;
      maxRunCodePoints: number;
      deadlineMs: number;
    },
  ): Promise<DocumentTextExtractionParserResult>;
};

export type DocumentTextExtractionServiceOptions = {
  storage?: DocumentStorage;
  parser: DocumentTextExtractionParser;
  maxBytes?: number;
  maxPages?: number;
  maxPageCodePoints?: number;
  maxRunCodePoints?: number;
  deadlineMs?: number;
};

function rows(result: unknown): Record<string, unknown>[] {
  return result as Record<string, unknown>[];
}

function date(value: unknown): Date | null {
  return value == null ? null : value instanceof Date ? value : new Date(String(value));
}

function boundedErrorMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim();
  return normalized ? normalized.slice(0, MAX_ERROR_MESSAGE) : null;
}

function mapPage(row: Record<string, unknown>): DocumentTextExtractionPage {
  return {
    extractionId: String(row.extraction_id),
    pageNumber: Number(row.page_number),
    status: String(row.status) as "succeeded" | "failed",
    text: String(row.text ?? ""),
    characterCount: Number(row.character_count ?? 0),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
  };
}

function mapExtraction(row: Record<string, unknown>, pages?: DocumentTextExtractionPage[]): DocumentTextExtraction {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    paperId: String(row.paper_id),
    fullTextDocumentId: String(row.full_text_document_id),
    sequence: Number(row.sequence),
    extractorKey: String(row.extractor_key),
    extractorVersion: String(row.extractor_version),
    algorithmVersion: String(row.algorithm_version),
    status: String(row.status) as DocumentTextExtractionStatus,
    pageCount: row.page_count == null ? null : Number(row.page_count),
    characterCount: row.character_count == null ? null : Number(row.character_count),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: date(row.created_at) ?? new Date(0),
    completedAt: date(row.completed_at),
    ...(pages ? { pages } : {}),
  };
}

async function readStoredBytes(storage: DocumentStorage, storageKey: string, maxBytes: number): Promise<Uint8Array> {
  const stream = await storage.open(storageKey);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new DomainError("VALIDATION_ERROR", "PDF exceeds the 50 MiB extraction limit");
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function ensureUuid(value: string, name: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_ERROR", `${name} must be a UUID`);
  return parsed.data;
}

function parserPageRows(result: DocumentTextExtractionParserResult, maxPages: number, maxPageCodePoints: number, maxRunCodePoints: number) {
  if (!Number.isInteger(result.pageCount) || result.pageCount == null || result.pageCount <= 0) {
    throw new DomainError("VALIDATION_ERROR", "Parser did not report a reliable positive page count");
  }
  if (!Array.isArray(result.pages)) {
    throw new DomainError("VALIDATION_ERROR", "Parser did not return a page list");
  }
  const pageCount = result.pageCount;
  if (pageCount > maxPages) {
    throw new DomainError("VALIDATION_ERROR", "PDF page count exceeds the extraction limit");
  }
  const byPage = new Map<number, DocumentTextExtractionParserPage>();
  for (const page of result.pages) {
    if (page.status !== "succeeded" && page.status !== "failed") {
      throw new DomainError("VALIDATION_ERROR", "Parser returned an invalid page status");
    }
    if (typeof page.text !== "string") {
      throw new DomainError("VALIDATION_ERROR", "Parser returned non-text page content");
    }
    if (page.status === "failed" && page.text.length > 0) {
      throw new DomainError("VALIDATION_ERROR", "Failed parser pages must be empty placeholders");
    }
    const nestedError = page.error && typeof page.error === "object" ? page.error : null;
    const errorCode = page.errorCode ?? nestedError?.code ?? null;
    const errorMessage = page.errorMessage ?? nestedError?.message ?? null;
    if (errorCode !== null && typeof errorCode !== "string") {
      throw new DomainError("VALIDATION_ERROR", "Parser returned an invalid page error code");
    }
    if (errorMessage !== null && typeof errorMessage !== "string") {
      throw new DomainError("VALIDATION_ERROR", "Parser returned an invalid page error message");
    }
    if (page.status === "failed" && (!errorCode || errorCode.trim() === "")) {
      throw new DomainError("VALIDATION_ERROR", "Failed parser pages must include an error code");
    }
    if (page.status === "succeeded" && (errorCode !== null || errorMessage !== null)) {
      throw new DomainError("VALIDATION_ERROR", "Succeeded parser pages cannot include an error");
    }
    if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1 || page.pageNumber > pageCount) {
      throw new DomainError("VALIDATION_ERROR", "Parser returned an invalid page number");
    }
    if (byPage.has(page.pageNumber)) throw new DomainError("VALIDATION_ERROR", "Parser returned a duplicate page");
    const text = normalizeLineEndings(page.status === "succeeded" ? page.text : "");
    const characterCount = codePointLength(text);
    if (characterCount > maxPageCodePoints) throw new DomainError("VALIDATION_ERROR", "Page text exceeds the extraction limit");
    if (page.characterCount != null && (!Number.isInteger(page.characterCount) || page.characterCount !== characterCount)) {
      throw new DomainError("VALIDATION_ERROR", "Parser returned an invalid page character count");
    }
    byPage.set(page.pageNumber, {
      ...page,
      text,
      characterCount,
      errorCode,
      errorMessage,
    });
  }
  const pages: DocumentTextExtractionParserPage[] = [];
  let characterCount = 0;
  let succeeded = 0;
  let failed = 0;
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = byPage.get(pageNumber);
    if (!page) throw new DomainError("VALIDATION_ERROR", "Parser did not return every declared page");
    if (page.status === "succeeded") succeeded += 1;
    else failed += 1;
    characterCount += page.characterCount ?? codePointLength(page.text);
    if (characterCount > maxRunCodePoints) throw new DomainError("VALIDATION_ERROR", "Run text exceeds the extraction limit");
    pages.push(page);
  }
  const status: Exclude<DocumentTextExtractionStatus, "failed"> = failed > 0 ? "partial" : "succeeded";
  if (succeeded === 0) throw new DomainError("VALIDATION_ERROR", "Partial extraction requires at least one successful page");
  return { status, pages, characterCount };
}

type NormalizedPageRows = {
  status: Exclude<DocumentTextExtractionStatus, "failed">;
  pages: DocumentTextExtractionParserPage[];
  characterCount: number;
};

export interface DocumentTextExtractionServices {
  extractDocumentText(projectId: string, documentId: string): Promise<DocumentTextExtraction>;
  listDocumentTextExtractions(projectId: string, documentId: string): Promise<DocumentTextExtraction[]>;
  getDocumentTextExtraction(projectId: string, documentId: string, extractionId: string): Promise<DocumentTextExtraction>;
  getLatestDocumentTextExtraction(projectId: string, documentId: string): Promise<DocumentTextExtraction | null>;
  recordEvidenceFromExtractedPage(projectId: string, input: {
    paperId: string;
    fullTextDocumentId: string;
    documentTextExtractionId: string;
    pageNumber: number;
    startOffset: number;
    endOffset: number;
    note?: string | null;
  }): Promise<Evidence>;
}

export function createDocumentTextExtractionServices(
  db: Database,
  options: DocumentTextExtractionServiceOptions,
): DocumentTextExtractionServices {
  const maxBytes = Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES);
  const maxPages = Math.min(options.maxPages ?? DEFAULT_MAX_PAGES, DEFAULT_MAX_PAGES);
  const maxPageCodePoints = Math.min(options.maxPageCodePoints ?? DEFAULT_MAX_PAGE_CODE_POINTS, DEFAULT_MAX_PAGE_CODE_POINTS);
  const maxRunCodePoints = Math.min(options.maxRunCodePoints ?? DEFAULT_MAX_RUN_CODE_POINTS, DEFAULT_MAX_RUN_CODE_POINTS);
  const deadlineMs = Math.min(options.deadlineMs ?? DEFAULT_DEADLINE_MS, DEFAULT_DEADLINE_MS);

  async function requireDocument(projectId: string, documentId: string, includeArchived = true) {
    ensureUuid(projectId, "Project");
    ensureUuid(documentId, "Document");
    const document = await db.select().from(fullTextDocuments).where(sql`${fullTextDocuments.projectId} = ${projectId} and ${fullTextDocuments.id} = ${documentId}`).limit(1);
    if (!document[0]) throw new DomainError("DOCUMENT_NOT_FOUND", "Full-text document was not found");
    if (!includeArchived && document[0].archivedAt) throw new DomainError("DOCUMENT_ARCHIVED", "Archived full-text documents cannot be extracted");
    return document[0];
  }

  async function loadPages(projectId: string, extractionId: string) {
    return rows(await db.execute(sql`
      select document_text_extraction_id as extraction_id, page_number, status, text, character_count, error_code, error_message
      from document_text_extraction_pages
      where project_id=${projectId} and document_text_extraction_id=${extractionId}
      order by page_number
    `)).map(mapPage);
  }

  async function loadExtraction(projectId: string, documentId: string, extractionId: string, withPages = true) {
    const result = rows(await db.execute(sql`
      select id, project_id, paper_id, full_text_document_id, sequence, extractor_key,
        extractor_version, algorithm_version, status, page_count, character_count,
        error_code, error_message, created_at, completed_at
      from document_text_extractions
      where project_id=${projectId} and full_text_document_id=${documentId} and id=${extractionId}
      limit 1
    `));
    if (!result[0]) throw new DomainError("NOT_FOUND", "Document text extraction was not found");
    return mapExtraction(result[0], withPages ? await loadPages(projectId, extractionId) : undefined);
  }

  async function persistRun(input: {
    projectId: string;
    paperId: string;
    documentId: string;
    result: DocumentTextExtractionParserResult | null;
    error?: unknown;
  }): Promise<DocumentTextExtraction> {
    const extractionId = randomUUID();
    const parserFailed = input.result?.status === "failed";
    const parserStatusValid = input.result == null || input.result.status === "succeeded" || input.result.status === "partial" || input.result.status === "failed";
    let normalized: NormalizedPageRows | null = null;
    let normalizationError: unknown;
    if (input.result && !parserStatusValid) {
      normalizationError = new DomainError("VALIDATION_ERROR", "Parser returned an invalid extraction status");
    } else if (input.result && !parserFailed) {
      try {
        normalized = parserPageRows(input.result, maxPages, maxPageCodePoints, maxRunCodePoints);
      } catch (error) {
        // A malformed parser result is itself a failed extraction attempt. Keep
        // the immutable failure history rather than leaking transient rows or
        // returning without a terminal run.
        normalizationError = error;
      }
    }
    const status = normalized?.status ?? "failed";
    const candidatePageCount = input.result?.pageCount ?? (input.error && typeof input.error === "object" && Number.isInteger((input.error as { pageCount?: unknown }).pageCount)
      ? Number((input.error as { pageCount: number }).pageCount)
      : null);
    const pageCount = candidatePageCount != null && candidatePageCount > 0 && candidatePageCount <= maxPages ? candidatePageCount : null;
    const characterCount = normalized ? normalized.characterCount : null;
    const parserError = input.result?.error ?? (input.result?.errorCode
      ? { code: input.result.errorCode, message: input.result.errorMessage ?? input.result.errorCode }
      : null);
    const normalizationErrorValue = normalizationError && typeof normalizationError === "object" && "code" in normalizationError
      ? { code: String((normalizationError as { code?: unknown }).code), message: normalizationError instanceof Error ? normalizationError.message : String(normalizationError) }
      : normalizationError ? { code: "parser_failure", message: String(normalizationError) } : null;
    const errorCode = parserError?.code ?? normalizationErrorValue?.code ?? (input.error && typeof input.error === "object" && "code" in input.error
      ? String((input.error as { code?: unknown }).code)
      : input.error || parserFailed ? "parser_failure" : null);
    const errorMessage = boundedErrorMessage(parserError?.message ?? normalizationErrorValue?.message ?? input.error ?? (parserFailed ? "Text extraction failed" : null));
    // Raw postgres-js SQL parameters use ISO strings for timestamptz values;
    // passing a Date object through this template can be interpreted as a
    // binary string parameter by postgres-js on Windows.
    const now = new Date().toISOString();
    return db.transaction(async (tx) => {
      const locked = rows(await tx.execute(sql`
        select id, project_id, paper_id, archived_at from full_text_documents
        where project_id=${input.projectId} and id=${input.documentId}
        for update
      `));
      if (!locked[0]) throw new DomainError("DOCUMENT_NOT_FOUND", "Full-text document was not found");
      if (locked[0].archived_at) throw new DomainError("DOCUMENT_ARCHIVED", "Archived full-text documents cannot receive new extraction runs");
      const extractionRows = rows(await tx.execute(sql`
        insert into document_text_extractions
          (id, project_id, paper_id, full_text_document_id, extractor_key, extractor_version,
           algorithm_version, status, page_count, character_count, error_code, error_message,
           created_at, completed_at)
        values (${extractionId}::uuid, ${input.projectId}::uuid, ${input.paperId}::uuid,
          ${input.documentId}::uuid, ${options.parser.extractorKey}, ${options.parser.extractorVersion},
          ${options.parser.algorithmVersion}, ${status}, ${pageCount}, ${characterCount},
          ${errorCode}, ${errorMessage}, ${now}, ${now})
        returning id, project_id, paper_id, full_text_document_id, sequence, extractor_key,
          extractor_version, algorithm_version, status, page_count, character_count,
          error_code, error_message, created_at, completed_at
      `));
      if (!extractionRows[0]) throw new DomainError("DATABASE_CONSTRAINT", "Extraction could not be recorded");
      if (normalized) {
        for (const page of normalized.pages) {
          await tx.execute(sql`
            insert into document_text_extraction_pages
              (project_id, paper_id, document_text_extraction_id, page_number, status, text, character_count, error_code, error_message)
            values (${input.projectId}::uuid, ${input.paperId}::uuid, ${extractionId}::uuid, ${page.pageNumber}, ${page.status},
              ${page.status === "succeeded" ? page.text : ""}, ${page.status === "succeeded" ? page.characterCount : 0},
              ${page.status === "failed" ? page.errorCode ?? "page_extraction_issue" : null},
              ${page.status === "failed" ? boundedErrorMessage(page.errorMessage) : null})
          `);
        }
      }
      return mapExtraction(extractionRows[0], normalized ? normalized.pages.map((page) => ({
        extractionId,
        pageNumber: page.pageNumber,
        status: page.status,
        text: page.status === "succeeded" ? page.text : "",
        characterCount: page.status === "succeeded" ? page.characterCount ?? codePointLength(page.text) : 0,
        errorCode: page.status === "failed" ? page.errorCode ?? "page_extraction_issue" : null,
        errorMessage: page.status === "failed" ? boundedErrorMessage(page.errorMessage) : null,
      })) : []);
    });
  }

  return {
    async extractDocumentText(projectId, documentId) {
      const document = await requireDocument(projectId, documentId, false);
      if (!options.storage) throw new DomainError("STORAGE_ERROR", "Document storage is not configured");
      if (Number(document.byteSize) > maxBytes) {
        return persistRun({ projectId, paperId: String(document.paperId), documentId, result: null, error: new DomainError("VALIDATION_ERROR", "PDF exceeds the 50 MiB extraction limit") });
      }
      let bytes: Uint8Array;
      try {
        bytes = await readStoredBytes(options.storage, document.storageKey, maxBytes);
        if (bytes.byteLength !== Number(document.byteSize)) throw new DomainError("STORAGE_ERROR", "Stored document size does not match immutable metadata");
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== document.sha256) throw new DomainError("STORAGE_ERROR", "Stored document hash does not match immutable metadata");
      } catch (error) {
        return persistRun({ projectId, paperId: String(document.paperId), documentId, result: null, error });
      }
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), deadlineMs);
      try {
        let result: DocumentTextExtractionParserResult;
        try {
          result = await options.parser.extract(bytes, { signal: abort.signal, maxPages, maxPageCodePoints, maxRunCodePoints, deadlineMs });
        } catch (error) {
          return await persistRun({ projectId, paperId: String(document.paperId), documentId, result: null, error: abort.signal.aborted ? new DomainError("STORAGE_ERROR", "Text extraction deadline exceeded") : error });
        }
        return await persistRun({ projectId, paperId: String(document.paperId), documentId, result });
      } finally {
        clearTimeout(timeout);
      }
    },

    async listDocumentTextExtractions(projectId, documentId) {
      await requireDocument(projectId, documentId);
      return rows(await db.execute(sql`
        select id, project_id, paper_id, full_text_document_id, sequence, extractor_key,
          extractor_version, algorithm_version, status, page_count, character_count,
          error_code, error_message, created_at, completed_at
        from document_text_extractions
        where project_id=${projectId} and full_text_document_id=${documentId}
        order by sequence
      `)).map((row) => mapExtraction(row));
    },

    async getDocumentTextExtraction(projectId, documentId, extractionId) {
      await requireDocument(projectId, documentId);
      return loadExtraction(projectId, documentId, ensureUuid(extractionId, "Extraction"));
    },

    async getLatestDocumentTextExtraction(projectId, documentId) {
      await requireDocument(projectId, documentId);
      const result = rows(await db.execute(sql`
        select id, project_id, paper_id, full_text_document_id, sequence, extractor_key,
          extractor_version, algorithm_version, status, page_count, character_count,
          error_code, error_message, created_at, completed_at
        from document_text_extractions
        where project_id=${projectId} and full_text_document_id=${documentId} and status <> 'failed'
        order by sequence desc limit 1
      `));
      return result[0] ? mapExtraction(result[0], await loadPages(projectId, String(result[0].id))) : null;
    },

    async recordEvidenceFromExtractedPage(projectId, input) {
      const parsed = recordExtractedEvidenceSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Input failed validation", parsed.error.issues);
      input = parsed.data;
      ensureUuid(projectId, "Project");
      ensureUuid(input.paperId, "Paper");
      ensureUuid(input.fullTextDocumentId, "Document");
      ensureUuid(input.documentTextExtractionId, "Extraction");
      if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1) throw new DomainError("VALIDATION_ERROR", "Page number must be positive");
      const result = rows(await db.execute(sql`
        select e.id as extraction_id, e.project_id, e.paper_id, e.full_text_document_id,
          e.status as extraction_status, e.sequence,
          p.page_number, p.status as page_status, p.text
        from document_text_extractions e
        join document_text_extraction_pages p on p.project_id=e.project_id and p.document_text_extraction_id=e.id and p.page_number=${input.pageNumber}
        join full_text_documents d on d.project_id=e.project_id and d.paper_id=e.paper_id and d.id=e.full_text_document_id
        where e.project_id=${projectId} and e.id=${input.documentTextExtractionId}
          and e.full_text_document_id=${input.fullTextDocumentId} and e.paper_id=${input.paperId}
        limit 1
      `));
      if (!result[0]) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction does not belong to this Paper and document");
      if (result[0].page_status !== "succeeded") throw new DomainError("VALIDATION_ERROR", "Evidence requires a successful extracted page");
      await requireDocument(projectId, input.fullTextDocumentId, false);
      const pageText = normalizeLineEndings(String(result[0].text ?? ""));
      try {
        validateCodePointRange(pageText, input.startOffset, input.endOffset, { allowEmpty: false });
      } catch (error) {
        if (error instanceof Error) throw new DomainError("VALIDATION_ERROR", error.message);
        throw error;
      }
      const sourceText = codePointSlice(pageText, input.startOffset, input.endOffset);
      try {
        const inserted = rows(await db.execute(sql`
          insert into evidence
            (project_id, paper_id, full_text_document_id, document_text_extraction_id,
             source_text, page_number, extraction_start_offset, extraction_end_offset, note)
          values (${projectId}::uuid, ${input.paperId}::uuid, ${input.fullTextDocumentId}::uuid,
            ${input.documentTextExtractionId}::uuid, ${sourceText}, ${input.pageNumber},
            ${input.startOffset}, ${input.endOffset}, ${input.note ?? null})
          returning id, project_id, paper_id, full_text_document_id, document_text_extraction_id,
            source_text, page_number, extraction_start_offset, extraction_end_offset, note,
            created_at, updated_at
        `));
        if (!inserted[0]) throw new DomainError("DATABASE_CONSTRAINT", "Evidence could not be recorded");
        const row = inserted[0];
        return {
          id: String(row.id), projectId: String(row.project_id), paperId: String(row.paper_id),
          fullTextDocumentId: row.full_text_document_id == null ? null : String(row.full_text_document_id),
          documentTextExtractionId: row.document_text_extraction_id == null ? null : String(row.document_text_extraction_id),
          sourceText: String(row.source_text), pageNumber: Number(row.page_number),
          extractionStartOffset: row.extraction_start_offset == null ? null : Number(row.extraction_start_offset),
          extractionEndOffset: row.extraction_end_offset == null ? null : Number(row.extraction_end_offset),
          note: row.note == null ? null : String(row.note), createdAt: date(row.created_at) ?? new Date(0), updatedAt: date(row.updated_at) ?? new Date(0),
        };
      } catch (error) {
        if (isConstraintError(error)) throw new DomainError("VALIDATION_ERROR", "Extracted Evidence did not satisfy provenance constraints");
        throw error;
      }
    },
  };
}
