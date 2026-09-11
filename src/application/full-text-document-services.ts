import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { fullTextDocuments } from "@/db/schema";
import { DomainError, isConstraintError } from "@/domain/errors";
import { documentStorageKey, validateDocumentFilename, validatePdfMetadata } from "@/domain/full-text-documents";
import type { Evidence, FullTextDocument } from "@/domain/types";
import { FullTextDocumentRepository, PaperRepository, ProjectRepository } from "./repositories";
import type { DocumentByteSource, DocumentStorage, StagedDocument } from "@/infrastructure/document-storage";

function mapDocument(row: typeof fullTextDocuments.$inferSelect): FullTextDocument {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    paperId: String(row.paperId),
    storageKey: row.storageKey,
    originalFilename: row.originalFilename,
    mediaType: "application/pdf",
    byteSize: Number(row.byteSize),
    sha256: row.sha256,
    note: row.note,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

export type FullTextDocumentUploadMetadata = {
  originalFilename: string;
  mediaType: "application/pdf";
  note?: string | null;
};

export interface FullTextDocumentServices {
  stageFullTextDocument(source: DocumentByteSource, signal?: AbortSignal): Promise<StagedDocument>;
  discardStagedFullTextDocument(staged: StagedDocument): Promise<void>;
  attachStagedFullTextDocument(projectId: string, paperId: string, metadata: FullTextDocumentUploadMetadata, staged: StagedDocument): Promise<{ kind: "created" | "duplicate"; document: FullTextDocument }>;
  uploadFullTextDocument(projectId: string, paperId: string, metadata: FullTextDocumentUploadMetadata, source: DocumentByteSource): Promise<{ kind: "created" | "duplicate"; document: FullTextDocument }>;
  listFullTextDocuments(projectId: string, paperId: string): Promise<FullTextDocument[]>;
  getFullTextDocument(projectId: string, documentId: string): Promise<FullTextDocument>;
  setPreferredFullTextDocument(projectId: string, paperId: string, documentId: string): Promise<FullTextDocument>;
  clearPreferredFullTextDocument(projectId: string, paperId: string): Promise<void>;
  getPreferredFullTextDocument(projectId: string, paperId: string): Promise<FullTextDocument | null>;
  archiveFullTextDocument(projectId: string, documentId: string): Promise<FullTextDocument>;
  openFullTextDocumentDownload(projectId: string, documentId: string): Promise<{ document: FullTextDocument; stream: Readable }>;
  listEvidenceForFullTextDocument(projectId: string, documentId: string): Promise<Evidence[]>;
  auditFullTextDocumentStorage(projectId?: string): Promise<{ missingFiles: string[]; orphanFiles: string[]; stagedFiles: string[] }>;
}

export function createFullTextDocumentServices(db: Database, storage?: DocumentStorage, maxBytes = 50 * 1024 * 1024): FullTextDocumentServices {
  const projectRepo = new ProjectRepository(db);
  const paperRepo = new PaperRepository(db);
  const documentRepo = new FullTextDocumentRepository(db);

  async function requireProject(projectId: string) {
    const project = await projectRepo.findById(projectId);
    if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
    return project;
  }

  async function requirePaper(projectId: string, paperId: string) {
    await requireProject(projectId);
    const paper = await paperRepo.findById(projectId, paperId);
    if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
    return paper;
  }

  function requireStorage() {
    if (!storage) throw new DomainError("STORAGE_ERROR", "Document storage is not configured");
    return storage;
  }

  async function getDocument(projectId: string, documentId: string) {
    await requireProject(projectId);
    const document = await documentRepo.findById(projectId, documentId);
    if (!document) throw new DomainError("DOCUMENT_NOT_FOUND", "Full-text document was not found");
    return mapDocument(document);
  }

  async function stageFullTextDocument(source: DocumentByteSource, signal?: AbortSignal) {
    const documentStorage = requireStorage();
    try {
      return await documentStorage.stage(source, { maxBytes, signal });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("STORAGE_ERROR", error instanceof Error ? error.message : "Document upload failed");
    }
  }

  async function attachStagedFullTextDocument(projectId: string, paperId: string, metadata: FullTextDocumentUploadMetadata, staged: StagedDocument) {
    let promotedKey: string | undefined;
    try {
      const documentStorage = requireStorage();
      const paper = await requirePaper(projectId, paperId);
      const parsed = validatePdfMetadata(metadata);
      const originalFilename = validateDocumentFilename(parsed.originalFilename);
      const result = await db.transaction(async (tx) => {
        const lockedPaper = await paperRepo.findForUpdate(tx, projectId, paper.id);
        if (!lockedPaper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
        const duplicate = await documentRepo.activeBySha(tx, projectId, paperId, staged.sha256);
        if (duplicate) return { kind: "duplicate" as const, document: mapDocument(duplicate) };
        const id = randomUUID();
        const storageKey = documentStorageKey(projectId, paperId, id);
        const row = await documentRepo.create(tx, {
          id,
          projectId,
          paperId,
          storageKey,
          originalFilename,
          mediaType: "application/pdf",
          byteSize: staged.byteSize,
          sha256: staged.sha256,
          note: parsed.note ?? null,
        });
        promotedKey = storageKey;
        await documentStorage.promote(staged.temporaryKey, storageKey);
        return { kind: "created" as const, document: mapDocument(row) };
      });
      if (result.kind === "duplicate") {
        await documentStorage.remove(staged.temporaryKey);
        return result;
      }
      return result;
    } catch (error) {
      if (storage) {
        await storage.remove(staged.temporaryKey).catch(() => undefined);
        if (promotedKey) await storage.remove(promotedKey).catch(() => undefined);
      }
      if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "Document could not be attached");
      if (error instanceof DomainError) throw error;
      throw new DomainError("STORAGE_ERROR", error instanceof Error ? error.message : "Document upload failed");
    }
  }

  return {
    stageFullTextDocument,

    async discardStagedFullTextDocument(staged: StagedDocument) {
      await requireStorage().remove(staged.temporaryKey).catch(() => undefined);
    },

    attachStagedFullTextDocument,

    async uploadFullTextDocument(projectId: string, paperId: string, metadata: FullTextDocumentUploadMetadata, source: DocumentByteSource) {
      const staged = await stageFullTextDocument(source);
      return attachStagedFullTextDocument(projectId, paperId, metadata, staged);
    },

    async listFullTextDocuments(projectId: string, paperId: string) {
      await requirePaper(projectId, paperId);
      return (await documentRepo.listForPaper(projectId, paperId)).map(mapDocument);
    },

    async getFullTextDocument(projectId: string, documentId: string) {
      return getDocument(projectId, documentId);
    },

    async setPreferredFullTextDocument(projectId: string, paperId: string, documentId: string) {
      const paper = await requirePaper(projectId, paperId);
      const document = await documentRepo.findById(projectId, documentId);
      if (!document || String(document.paperId) !== String(paper.id)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text document does not belong to this Paper");
      if (document.archivedAt) throw new DomainError("DOCUMENT_ARCHIVED", "Archived full-text documents cannot become preferred");
      await documentRepo.setPreference(projectId, paperId, documentId);
      return mapDocument(document);
    },

    async clearPreferredFullTextDocument(projectId: string, paperId: string) {
      await requirePaper(projectId, paperId);
      await documentRepo.clearPreference(projectId, paperId);
    },

    async getPreferredFullTextDocument(projectId: string, paperId: string) {
      await requirePaper(projectId, paperId);
      const preference = await documentRepo.getPreference(projectId, paperId);
      if (!preference) return null;
      const document = await documentRepo.findById(projectId, preference.fullTextDocumentId);
      return document ? mapDocument(document) : null;
    },

    async archiveFullTextDocument(projectId: string, documentId: string) {
      const document = await getDocument(projectId, documentId);
      if (document.archivedAt) return document;
      try {
        const [archived] = await documentRepo.archive(projectId, documentId);
        return archived ? mapDocument(archived) : document;
      } catch (error) {
        if (isConstraintError(error)) throw new DomainError("DOCUMENT_ARCHIVED", "Change or clear the preferred document before archiving");
        throw error;
      }
    },

    async openFullTextDocumentDownload(projectId: string, documentId: string) {
      const document = await getDocument(projectId, documentId);
      const documentStorage = requireStorage();
      if (!(await documentStorage.exists(document.storageKey))) throw new DomainError("STORAGE_ERROR", "Stored document bytes are missing");
      try {
        return { document, stream: await documentStorage.open(document.storageKey) };
      } catch (error) {
        throw new DomainError("STORAGE_ERROR", error instanceof Error ? error.message : "Stored document could not be opened");
      }
    },

    async listEvidenceForFullTextDocument(projectId: string, documentId: string) {
      const document = await getDocument(projectId, documentId);
      const rows = await db.execute(sql`
        select e.id, e.project_id, e.paper_id, e.full_text_document_id, e.document_text_extraction_id,
          e.source_text, e.page_number, e.extraction_start_offset, e.extraction_end_offset,
          e.note, e.created_at, e.updated_at, current_review.decision as review_decision
        from evidence e
        left join lateral (
          select decision from evidence_review_decisions r
          where r.project_id=e.project_id and r.evidence_id=e.id
          order by r.sequence desc limit 1
        ) current_review on true
        where e.project_id=${projectId} and e.paper_id=${document.paperId} and e.full_text_document_id=${document.id}
        order by e.page_number, e.created_at
      `) as unknown as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row.id), projectId: String(row.project_id), paperId: String(row.paper_id), fullTextDocumentId: String(row.full_text_document_id),
        documentTextExtractionId: row.document_text_extraction_id == null ? null : String(row.document_text_extraction_id),
        sourceText: String(row.source_text), pageNumber: Number(row.page_number), note: row.note == null ? null : String(row.note),
        extractionStartOffset: row.extraction_start_offset == null ? null : Number(row.extraction_start_offset),
        extractionEndOffset: row.extraction_end_offset == null ? null : Number(row.extraction_end_offset),
        reviewState: row.review_decision == null ? "unreviewed" as const : String(row.review_decision) as "needs_review" | "accepted" | "rejected",
        curationWarning: row.review_decision == null ? "never_reviewed" as const : row.review_decision === "needs_review" ? "needs_review" as const : row.review_decision === "rejected" ? "currently_rejected" as const : null,
        createdAt: row.created_at as Date, updatedAt: row.updated_at as Date,
      }));
    },

    async auditFullTextDocumentStorage(projectId?: string) {
      const documentStorage = requireStorage();
      const rows = await db.execute(sql`
        select id, project_id, paper_id, storage_key, archived_at
        from full_text_documents
        ${projectId ? sql`where project_id=${projectId}` : sql``}
      `) as unknown as Record<string, unknown>[];
      const keys = new Set(await documentStorage.listKeys());
      const referenced = new Set(rows.map((row) => String(row.storage_key)));
      const projectPrefix = projectId ? `projects/${projectId}/` : null;
      const finalKeys = [...keys].filter((key) => key.startsWith("projects/") && (!projectPrefix || key.startsWith(projectPrefix)));
      return {
        missingFiles: rows.filter((row) => !keys.has(String(row.storage_key))).map((row) => String(row.id)),
        orphanFiles: finalKeys.filter((key) => !referenced.has(key)),
        stagedFiles: [...keys].filter((key) => key.startsWith(".tmp/")),
      };
    },
  };
}
