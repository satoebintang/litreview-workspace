import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { fullTextDocuments } from "@/db/schema";
import { DomainError, isConstraintError } from "@/domain/errors";
import { recordEvidenceSchema, type RecordEvidenceInput } from "@/domain/validation";
import { createEvidenceReviewHelpers } from "./evidence-helpers";
import { evidenceCurationWarning, evidenceReviewState, isMissingRelationError, validate } from "./shared";
import type { EvidenceRepository } from "../repositories";

export function createEvidenceServices<TProject, TPaper, TEvidence>(deps: {
  db: Database;
  evidenceRepo: EvidenceRepository;
  requireProject: (projectId: string) => Promise<TProject>;
  requirePaper: (projectId: string, paperId: string) => Promise<TPaper>;
  requireEvidence: (projectId: string, evidenceId: string) => Promise<TEvidence>;
}) {
  const { db, evidenceRepo, requireProject, requirePaper, requireEvidence } = deps;
  const { currentEvidenceReviewRows } = createEvidenceReviewHelpers(db);
  return {
    async listEvidence(projectId: string) {
      await requireProject(projectId);
      const [items, reviewRows] = await Promise.all([evidenceRepo.list(projectId), currentEvidenceReviewRows(projectId)]);
      const currentReviewByEvidenceId = new Map(reviewRows.map((row) => [String(row.evidence_id), String(row.decision)]));
      return items.map((item) => {
        const reviewState = evidenceReviewState(currentReviewByEvidenceId.get(item.id));
        return {
          ...item,
          reviewState,
          curationWarning: evidenceCurationWarning(reviewState),
        };
      });
    },

    async recordEvidence(projectId: string, input: RecordEvidenceInput) {
      const values = validate(recordEvidenceSchema, input);
      await requirePaper(projectId, values.paperId);
      if (values.fullTextDocumentId) {
        const document = await db.select({ id: fullTextDocuments.id, paperId: fullTextDocuments.paperId, archivedAt: fullTextDocuments.archivedAt, storageState: fullTextDocuments.storageState })
          .from(fullTextDocuments)
          .where(and(eq(fullTextDocuments.projectId, projectId), eq(fullTextDocuments.id, values.fullTextDocumentId))).limit(1);
        if (!document[0] || document[0].paperId !== values.paperId) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text document does not belong to this Paper");
        if (document[0].storageState !== "ready") throw new DomainError("STORAGE_PENDING", "Evidence cannot reference a document while its bytes are being materialized");
        if (document[0].archivedAt) throw new DomainError("DOCUMENT_ARCHIVED", "New Evidence cannot reference an archived full-text document");
      }
      return evidenceRepo.create({ projectId, ...values, fullTextDocumentId: values.fullTextDocumentId ?? null, note: values.note ?? null });
    },

    async deleteEvidence(projectId: string, evidenceId: string) {
      await requireEvidence(projectId, evidenceId);
      let historyRows: unknown[];
      try {
        historyRows = await db.execute(sql`
          select 1 from claim_revision_evidence_supports where project_id=${projectId} and evidence_id=${evidenceId}
          union all select 1 from extraction_revision_evidence where project_id=${projectId} and evidence_id=${evidenceId}
          union all select 1 from evidence_review_decisions where project_id=${projectId} and evidence_id=${evidenceId}
          union all select 1 from evidence_annotations where project_id=${projectId} and evidence_id=${evidenceId}
          union all select 1 from evidence_label_events where project_id=${projectId} and evidence_id=${evidenceId}
          union all select 1 from evidence_set_memberships where project_id=${projectId} and evidence_id=${evidenceId}
          limit 1
        `) as unknown as unknown[];
      } catch (error) {
        // Preserve the pre-Slice-16 delete behavior for callers operating at
        // the migration boundary before the curation tables exist.
        if (!isMissingRelationError(error, "evidence_review_decisions") && !isMissingRelationError(error, "evidence_set_memberships")) throw error;
        historyRows = await db.execute(sql`
          select 1 from claim_revision_evidence_supports where project_id=${projectId} and evidence_id=${evidenceId}
          union all select 1 from extraction_revision_evidence where project_id=${projectId} and evidence_id=${evidenceId}
          limit 1
        `) as unknown as unknown[];
      }
      if ((historyRows as unknown[]).length) throw new DomainError("PROTECTED_DELETE", "Evidence cannot be deleted after curation or analytical history exists");
      try { return await evidenceRepo.delete(projectId, evidenceId); }
      catch (error) { if (isConstraintError(error)) throw new DomainError("PROTECTED_DELETE", "Evidence cannot be deleted after curation or analytical history exists"); throw error; }
    },
  };
}
