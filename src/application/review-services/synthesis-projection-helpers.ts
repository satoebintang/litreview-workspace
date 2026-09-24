import type { synthesisRevisions, synthesisStatements } from "@/db/schema";
import type { SynthesisState } from "@/domain/types";
import type { SynthesisRevisionSupportRepository } from "../repositories";
import type { MappedEvidence } from "./mappers";
import { mapEvidence, mapExtractionRevision, mapField, mapPaper } from "./mappers";

type EnrichedEvidence = MappedEvidence & {
  reviewState: "unreviewed" | "needs_review" | "accepted" | "rejected";
  curationWarning: "never_reviewed" | "needs_review" | "currently_rejected" | null;
};

export function createSynthesisProjectionHelpers(
  synthesisSupportRepo: SynthesisRevisionSupportRepository,
  enrichEvidenceDocuments: (items: MappedEvidence[]) => Promise<EnrichedEvidence[]>,
) {
  function synthesisViewFromRows(projectId: string, statement: typeof synthesisStatements.$inferSelect, revision: typeof synthesisRevisions.$inferSelect, rawRows: Record<string, unknown>[], evidenceByRevision: Map<string, ReturnType<typeof mapEvidence>[]>) {
    const supports = rawRows.map((row) => ({
      projectId, synthesisRevisionId: revision.id, extractionRevisionId: String(row.extraction_revision_id), createdAt: row.support_created_at as Date,
      extractionRevision: mapExtractionRevision(row, evidenceByRevision.get(String(row.revision_id)) ?? []), paper: mapPaper(row), field: mapField(row),
      isCurrentExtractionRevision: !Boolean(row.has_newer_revision),
    }));
    return {
      ...revision,
      state: revision.state as SynthesisState,
      statement,
      supports,
      supportStatus: supports.length ? "supported" as const : "unsupported" as const,
      supportingRevisionCount: supports.length,
      supportingPaperCount: new Set(supports.map((support) => support.paper.id)).size,
      supportingFieldCount: new Set(supports.map((support) => support.field.id)).size,
    };
  }

  async function synthesisViewsForRevisions(projectId: string, statements: Map<string, typeof synthesisStatements.$inferSelect>, revisions: (typeof synthesisRevisions.$inferSelect)[]) {
    const rawRows = (await synthesisSupportRepo.listWithProvenanceForRevisions(projectId, revisions.map((revision) => revision.id))) as unknown as Record<string, unknown>[];
    const evidenceRows = (await synthesisSupportRepo.listEvidenceForRevisions(projectId, rawRows.map((row) => String(row.revision_id)))) as unknown as Record<string, unknown>[];
    const mappedEvidenceRows = await enrichEvidenceDocuments(evidenceRows.map(mapEvidence));
    const evidenceByRevision = new Map<string, ReturnType<typeof mapEvidence>[] >();
    for (let i = 0; i < evidenceRows.length; i += 1) {
      const row = evidenceRows[i];
      const id = String(row.revision_id);
      const list = evidenceByRevision.get(id) ?? [];
      list.push(mappedEvidenceRows[i]); evidenceByRevision.set(id, list);
    }
    const rowsByRevision = new Map<string, Record<string, unknown>[]>();
    for (const row of rawRows) {
      const id = String(row.synthesis_revision_id);
      rowsByRevision.set(id, [...(rowsByRevision.get(id) ?? []), row]);
    }
    return revisions.map((revision) => synthesisViewFromRows(projectId, statements.get(revision.synthesisStatementId)!, revision, rowsByRevision.get(revision.id) ?? [], evidenceByRevision));
  }

  async function synthesisView(projectId: string, statement: typeof synthesisStatements.$inferSelect, revision: typeof synthesisRevisions.$inferSelect) {
    return (await synthesisViewsForRevisions(projectId, new Map([[statement.id, statement]]), [revision]))[0];
  }

  return { synthesisViewFromRows, synthesisViewsForRevisions, synthesisView };
}
