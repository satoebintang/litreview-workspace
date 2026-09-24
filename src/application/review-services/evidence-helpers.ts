import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { fullTextDocuments } from "@/db/schema";
import { evidenceCurationWarning, evidenceReviewState, isMissingRelationError } from "./shared";
import { mapEvidence } from "./mappers";

export function createEvidenceReviewHelpers(db: Database) {
  async function currentEvidenceReviewRows(projectId: string, evidenceIds?: string[]) {
    if (evidenceIds && evidenceIds.length === 0) return [] as Record<string, unknown>[];
    const evidenceFilter = evidenceIds ? sql`and evidence_id in (${sql.join(evidenceIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
    try {
      return await db.execute(sql`
        select distinct on (project_id, evidence_id) evidence_id, decision
        from evidence_review_decisions
        where project_id=${projectId} ${evidenceFilter}
        order by project_id, evidence_id, sequence desc
      `) as unknown as Record<string, unknown>[];
    } catch (error) {
      // A service facade can be constructed against a pre-Slice-16 schema by
      // migration-boundary tests. Such Evidence has no curation history yet.
      if (isMissingRelationError(error, "evidence_review_decisions")) return [];
      throw error;
    }
  }

  async function enrichEvidenceDocuments(items: ReturnType<typeof mapEvidence>[]) {
    const ids = [...new Set(items.flatMap((item) => item.fullTextDocumentId ? [item.fullTextDocumentId] : []))];
    const reviewRowsPromise = items.length ? currentEvidenceReviewRows(items[0].projectId, items.map((item) => item.id)) : Promise.resolve([] as Record<string, unknown>[]);
    const [documentRows, reviewRows] = await Promise.all([
      ids.length ? db.select({
        id: fullTextDocuments.id,
        originalFilename: fullTextDocuments.originalFilename,
        mediaType: fullTextDocuments.mediaType,
        byteSize: fullTextDocuments.byteSize,
        sha256: fullTextDocuments.sha256,
        createdAt: fullTextDocuments.createdAt,
        archivedAt: fullTextDocuments.archivedAt,
      }).from(fullTextDocuments).where(and(eq(fullTextDocuments.projectId, items[0].projectId), inArray(fullTextDocuments.id, ids))) : Promise.resolve([]),
      reviewRowsPromise,
    ]);
    const byId = new Map(documentRows.map((row) => [String(row.id), {
      id: String(row.id), originalFilename: row.originalFilename, mediaType: "application/pdf" as const,
      byteSize: Number(row.byteSize), sha256: row.sha256, createdAt: row.createdAt, archivedAt: row.archivedAt,
    }]));
    const byEvidence = new Map(reviewRows.map((row) => [String(row.evidence_id), String(row.decision)]));
    return items.map((item) => {
      const reviewState = evidenceReviewState(byEvidence.get(item.id));
      return {
        ...item,
        ...(item.fullTextDocumentId ? { document: byId.get(item.fullTextDocumentId) ?? null } : {}),
        reviewState,
        curationWarning: evidenceCurationWarning(reviewState),
      };
    });
  }

  return { currentEvidenceReviewRows, enrichEvidenceDocuments };
}
