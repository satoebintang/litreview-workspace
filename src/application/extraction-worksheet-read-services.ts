import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import type { PaperReviewStatus } from "@/domain/types";
import {
  evidence,
  extractionFields,
  extractionOptions,
  extractionRevisionEvidence,
  extractionValueRevisions,
  extractionValues,
  papers,
  projects,
} from "@/db/schema";
import type { EvidenceRepository, PaperRepository, PaperReviewRepository } from "./repositories";
import { createPaperReviewHelpers } from "./review-services/paper-review-helpers";
import { ensureId, evidenceCurationWarning, evidenceReviewState } from "./review-services/shared";

const WORKSHEET_STATEMENT_TIMEOUT_MS = 15_000;

type EvidenceRepositoryForWorksheet = Pick<EvidenceRepository, "listForPaper">;
type PaperReviewRepositoryForWorksheet = Pick<PaperReviewRepository, "find" | "list">;

export type ExtractionWorksheetProgress = {
  completedRequired: number;
  requiredCount: number;
  status: "not_configured" | "complete" | "partial" | "not_started";
  percentage: number | null;
  writeEligible: boolean;
};

/**
 * Read the full extraction worksheet for one Paper in a single consistent,
 * read-only snapshot. Query count is fixed: no read is issued per field,
 * option, revision, or Evidence link.
 */
export function createExtractionWorksheetReadServices(
  db: Database,
  deps: {
    paperRepo: Pick<PaperRepository, "findForUpdate">;
    paperReviewRepo: PaperReviewRepositoryForWorksheet;
    evidenceRepo: EvidenceRepositoryForWorksheet;
  },
) {
  const { getPaperReviewStatusFor } = createPaperReviewHelpers(db, deps.paperRepo, deps.paperReviewRepo);

  return {
    async getPaperExtractionWorksheet(projectId: string, paperId: string) {
      ensureId(projectId);
      ensureId(paperId);

      return db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '${sql.raw(String(WORKSHEET_STATEMENT_TIMEOUT_MS))}ms'`);

        const [project] = await tx.select({ id: projects.id }).from(projects)
          .where(eq(projects.id, projectId)).limit(1);
        if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");

        const [paper] = await tx.select().from(papers)
          .where(and(eq(papers.projectId, projectId), eq(papers.id, paperId))).limit(1);
        if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");

        const reviewStatus: PaperReviewStatus = await getPaperReviewStatusFor(projectId, paperId, tx);
        const fields = await tx.select().from(extractionFields)
          .where(and(eq(extractionFields.projectId, projectId), sql`${extractionFields.archivedAt} is null`))
          .orderBy(asc(extractionFields.sortOrder), asc(extractionFields.id));
        const fieldIds = fields.map((field) => field.id);

        const options = await tx.select().from(extractionOptions)
          .where(and(eq(extractionOptions.projectId, projectId), inArray(extractionOptions.fieldId, fieldIds)))
          .orderBy(asc(extractionOptions.fieldId), asc(extractionOptions.sortOrder), asc(extractionOptions.id));
        const optionsByFieldId = new Map<string, typeof options>();
        for (const option of options) {
          optionsByFieldId.set(option.fieldId, [...(optionsByFieldId.get(option.fieldId) ?? []), option]);
        }
        const worksheetFields = fields.map((field) => ({ ...field, options: optionsByFieldId.get(field.id) ?? [] }));

        const slots = await tx.select().from(extractionValues)
          .where(and(eq(extractionValues.projectId, projectId), eq(extractionValues.paperId, paperId)));
        const slotByFieldId = new Map(slots.map((slot) => [slot.fieldId, slot]));

        const revisions = await tx.select().from(extractionValueRevisions)
          .where(and(
            eq(extractionValueRevisions.projectId, projectId),
            eq(extractionValueRevisions.paperId, paperId),
            inArray(extractionValueRevisions.fieldId, fieldIds),
            isNotNull(extractionValueRevisions.finalizedAt),
          ))
          .orderBy(asc(extractionValueRevisions.fieldId), asc(extractionValueRevisions.sequence));

        const revisionIds = revisions.map((revision) => revision.id);
        const revisionEvidenceLinks = await tx.select({
          revisionId: extractionRevisionEvidence.revisionId,
          item: evidence,
        }).from(extractionRevisionEvidence)
          .innerJoin(evidence, and(
            eq(evidence.projectId, extractionRevisionEvidence.projectId),
            eq(evidence.paperId, extractionRevisionEvidence.paperId),
            eq(evidence.id, extractionRevisionEvidence.evidenceId),
          ))
          .where(and(
            eq(extractionRevisionEvidence.projectId, projectId),
            eq(extractionRevisionEvidence.paperId, paperId),
            inArray(extractionRevisionEvidence.revisionId, revisionIds),
          ))
          .orderBy(asc(extractionRevisionEvidence.revisionId), asc(evidence.pageNumber), asc(evidence.createdAt));

        const paperEvidenceRows = await deps.evidenceRepo.listForPaper(projectId, paperId, tx);
        const paperEvidence = paperEvidenceRows.map(({ currentReviewDecision, ...item }) => {
          const reviewState = evidenceReviewState(currentReviewDecision ?? undefined);
          return { ...item, reviewState, curationWarning: evidenceCurationWarning(reviewState) };
        });

        const evidenceByRevisionId = new Map<string, Array<(typeof revisionEvidenceLinks)[number]["item"]>>();
        for (const link of revisionEvidenceLinks) {
          evidenceByRevisionId.set(link.revisionId, [...(evidenceByRevisionId.get(link.revisionId) ?? []), link.item]);
        }

        const historyByFieldId = new Map<string, Array<(typeof revisions)[number] & { evidence: Array<(typeof revisionEvidenceLinks)[number]["item"]> }>>();
        for (const revision of revisions) {
          const value = { ...revision, evidence: evidenceByRevisionId.get(revision.id) ?? [] };
          historyByFieldId.set(revision.fieldId, [...(historyByFieldId.get(revision.fieldId) ?? []), value]);
        }

        const values = worksheetFields.map((field) => {
          const slot = slotByFieldId.get(field.id);
          const history = historyByFieldId.get(field.id) ?? [];
          const currentRevision = history.at(-1) ?? null;
          const support = currentRevision?.evidence ?? [];
          return {
            ...(slot ?? { id: "", projectId, paperId, fieldId: field.id, createdAt: null, updatedAt: null }),
            field,
            currentRevision,
            supportStatus: currentRevision && currentRevision.valueState !== "cleared" && support.length > 0 ? "grounded" as const : "ungrounded" as const,
            history,
          };
        });

        const requiredFields = worksheetFields.filter((field) => field.required);
        const completedRequired = values.filter((value) =>
          value.field.required
          && value.currentRevision
          && ["present", "not_reported", "not_applicable"].includes(value.currentRevision.valueState),
        ).length;
        const started = values.some((value) => value.currentRevision && value.currentRevision.valueState !== "cleared");
        const progress: ExtractionWorksheetProgress = {
          completedRequired,
          requiredCount: requiredFields.length,
          status: requiredFields.length === 0 ? "not_configured" : completedRequired === requiredFields.length ? "complete" : started ? "partial" : "not_started",
          percentage: requiredFields.length ? Math.round((completedRequired / requiredFields.length) * 100) : null,
          writeEligible: reviewStatus.finalEligibility === "included",
        };

        return { paper, reviewStatus, fields: worksheetFields, values, evidence: paperEvidence, progress };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
