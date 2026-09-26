import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { fullTextDocuments } from "@/db/schema";
import { DomainError, isConstraintError } from "@/domain/errors";
import { documentStorageKey, isDocumentStorageKey, validateDocumentFilename, validatePdfMetadata } from "@/domain/full-text-documents";
import type { Evidence, FullTextDocument } from "@/domain/types";
import { FullTextDocumentRepository, PaperRepository, ProjectRepository } from "./repositories";
import { DocumentStorageError, type DocumentByteSource, type DocumentStorage, type StagedDocument } from "@/infrastructure/document-storage";
import { materializePendingStorageRecord, type StorageCheckpoint, type StorageMaterializationAccess, type StorageMaterializationRecord } from "./storage-materialization";

type FullTextDocumentTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type CanonicalFullTextAttachmentResult =
  | { kind: "created" | "pending"; document: FullTextDocument; stagedStorageKey: string | null }
  | { kind: "duplicate"; document: FullTextDocument };

/**
 * Reserve one already-staged PDF under its immutable Paper/SHA identity.
 * Materialization happens only after the caller's transaction commits.
 */
export async function attachStagedFullTextDocumentInTransaction(
  tx: FullTextDocumentTransaction,
  projectId: string,
  paperId: string,
  metadata: FullTextDocumentUploadMetadata,
  staged: StagedDocument,
): Promise<CanonicalFullTextAttachmentResult> {
  const parsed = validatePdfMetadata(metadata);
  const originalFilename = validateDocumentFilename(parsed.originalFilename);
  const paperRows = await tx.execute(sql`
    select id
    from papers
    where project_id=${projectId} and id=${paperId}
    for update
  `) as unknown as Record<string, unknown>[];
  if (!paperRows[0]) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");

  const duplicateRows = await tx.execute(sql`
    select id, project_id, paper_id, storage_key, original_filename, media_type,
      byte_size, sha256, note, created_at, archived_at, storage_state, staged_storage_key
    from full_text_documents
    where project_id=${projectId}
      and paper_id=${paperId}
      and sha256=${staged.sha256}
      and archived_at is null
    order by created_at, id
    limit 1
  `) as unknown as Record<string, unknown>[];
  const duplicate = duplicateRows[0];
  if (duplicate) {
    if (String(duplicate.storage_state) === "ready") {
      return { kind: "duplicate", document: mapDocument(duplicate as typeof fullTextDocuments.$inferSelect) };
    }
    return {
      kind: "pending",
      document: mapDocument(duplicate as typeof fullTextDocuments.$inferSelect),
      stagedStorageKey: duplicate.staged_storage_key == null ? null : String(duplicate.staged_storage_key),
    };
  }

  const id = randomUUID();
  const storageKey = documentStorageKey(projectId, paperId, id);
  const rows = await tx.execute(sql`
    insert into full_text_documents
      (id, project_id, paper_id, storage_key, original_filename, media_type, byte_size, sha256, storage_state, staged_storage_key, note)
    values
      (${id}::uuid, ${projectId}::uuid, ${paperId}::uuid, ${storageKey}, ${originalFilename}, 'application/pdf', ${staged.byteSize}, ${staged.sha256}, 'pending', ${staged.temporaryKey}, ${parsed.note ?? null})
    returning id, project_id, paper_id, storage_key, original_filename, media_type,
      byte_size, sha256, note, created_at, archived_at, storage_state, staged_storage_key
  `) as unknown as Record<string, unknown>[];
  const row = rows[0];
  if (!row) throw new DomainError("DATABASE_CONSTRAINT", "Full-text document could not be created");
  return {
    kind: "created",
    document: mapDocument(row as typeof fullTextDocuments.$inferSelect),
    stagedStorageKey: String(row.staged_storage_key),
  };
}

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

function asStorageRecord(row: typeof fullTextDocuments.$inferSelect | null | undefined): StorageMaterializationRecord | null {
  if (!row) return null;
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    storageKey: row.storageKey,
    stagedStorageKey: row.stagedStorageKey,
    byteSize: Number(row.byteSize),
    sha256: row.sha256,
    storageState: row.storageState,
  };
}

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

export function createFullTextDocumentServices(db: Database, storage?: DocumentStorage, maxBytes = 50 * 1024 * 1024, checkpoint?: StorageCheckpoint): FullTextDocumentServices {
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
    if (!document) {
      const anyState = await documentRepo.findAnyById(projectId, documentId);
      if (anyState?.storageState === "pending") throw new DomainError("STORAGE_PENDING", "Full-text document bytes are still being materialized");
      throw new DomainError("DOCUMENT_NOT_FOUND", "Full-text document was not found");
    }
    return mapDocument(document);
  }

  async function stageFullTextDocument(source: DocumentByteSource, signal?: AbortSignal) {
    const documentStorage = requireStorage();
    let staged: StagedDocument;
    try {
      staged = await documentStorage.stage(source, { maxBytes, signal });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("STORAGE_ERROR", error instanceof Error ? error.message : "Document upload failed");
    }
    await checkpoint?.("after_staging", { flow: "full_text_document", storageKey: staged.temporaryKey });
    return staged;
  }

  async function attachStagedFullTextDocument(projectId: string, paperId: string, metadata: FullTextDocumentUploadMetadata, staged: StagedDocument) {
    const documentStorage = requireStorage();
    try {
      const parsed = validatePdfMetadata(metadata);
      validateDocumentFilename(parsed.originalFilename);
    } catch (error) {
      // Validate before opening a transaction, so this is a proven
      // pre-commit failure and its unowned stage can be removed safely.
      await documentStorage.remove(staged.temporaryKey).catch(() => undefined);
      throw error;
    }
    let attached: CanonicalFullTextAttachmentResult;
    try {
      attached = await db.transaction((tx) => attachStagedFullTextDocumentInTransaction(tx, projectId, paperId, metadata, staged));
    } catch (error) {
      // Callback validation and PostgreSQL constraint failures establish a
      // rollback. Other transport errors may race a commit still resolving.
      if (error instanceof DomainError || isConstraintError(error)) {
        await documentStorage.remove(staged.temporaryKey).catch(() => undefined);
      }
      if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "Document could not be attached");
      if (error instanceof DomainError) throw error;
      throw new DomainError("STORAGE_ERROR", error instanceof Error ? error.message : "Document upload failed");
    }

    if (attached.kind === "duplicate") {
      await documentStorage.remove(staged.temporaryKey).catch(() => undefined);
      return attached;
    }

    await checkpoint?.("after_pending_commit", { flow: "full_text_document", projectId, id: attached.document.id, storageKey: attached.document.storageKey });

    const access: StorageMaterializationAccess = {
      load: async (id) => asStorageRecord(await documentRepo.findAnyById(projectId, id)),
      replaceStage: async (id, expected, replacement) => asStorageRecord(await documentRepo.replacePendingStage(projectId, id, expected, replacement)),
      markReady: async (id, expected) => asStorageRecord(await documentRepo.markPendingReady(projectId, id, expected)),
    };
    try {
      await materializePendingStorageRecord({
        access,
        storage: documentStorage,
        id: attached.document.id,
        projectId,
        flow: "full_text_document",
        checkpoint,
        replacementStage: async () => staged,
      });
    } catch (error) {
      if (error instanceof DocumentStorageError) {
        throw new DomainError(error.code === "STORAGE_INTEGRITY" ? "STORAGE_INTEGRITY" : "STORAGE_ERROR", error.message);
      }
      throw error;
    }
    await documentStorage.remove(staged.temporaryKey).catch(() => undefined);
    return { kind: attached.kind === "created" ? "created" as const : "duplicate" as const, document: await getDocument(projectId, attached.document.id) };
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
      if (!document) {
        const anyState = await documentRepo.findAnyById(projectId, documentId);
        if (anyState?.storageState === "pending") throw new DomainError("STORAGE_PENDING", "Full-text document bytes are still being materialized");
        throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text document does not belong to this Paper");
      }
      if (String(document.paperId) !== String(paper.id)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text document does not belong to this Paper");
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
      const finalKeys = [...keys].filter((key) => isDocumentStorageKey(key) && (!projectPrefix || key.startsWith(projectPrefix)));
      return {
        missingFiles: rows.filter((row) => !keys.has(String(row.storage_key))).map((row) => String(row.id)),
        orphanFiles: finalKeys.filter((key) => !referenced.has(key)),
        stagedFiles: [...keys].filter((key) => key.startsWith(".tmp/")),
      };
    },
  };
}
