import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import type { Evidence, ExtractionFieldType, ExtractionValueState, PaperReviewStatus } from "@/domain/types";
import {
  evidence,
  extractionFields,
  extractionOptions,
  extractionRevisionEvidence,
  papers,
  projects,
} from "@/db/schema";
import type { EvidenceRepository, PaperRepository, PaperReviewRepository } from "./repositories";
import { createPaperReviewHelpers } from "./review-services/paper-review-helpers";
import { ensureId, evidenceCurationWarning, evidenceReviewState } from "./review-services/shared";

const WORKSHEET_STATEMENT_TIMEOUT_MS = 15_000;

type EvidenceRepositoryForWorksheet = Pick<EvidenceRepository, "listForPaper">;
type PaperReviewRepositoryForWorksheet = Pick<PaperReviewRepository, "find" | "list">;
type RawRow = Record<string, unknown>;

export type ExtractionWorksheetProgress = {
  completedRequired: number;
  requiredCount: number;
  status: "not_configured" | "complete" | "partial" | "not_started";
  percentage: number | null;
  writeEligible: boolean;
};

function rows(value: unknown): RawRow[] {
  return value as unknown as RawRow[];
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : date(value);
}

/**
 * Current worksheet projection. Historical revision rows are deliberately
 * absent; only one greatest-sequence finalized revision per active Field is
 * selected, and only those selected revision IDs are used to hydrate Evidence.
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

        const [scope] = await tx.select({ project: projects, paper: papers }).from(projects)
          .leftJoin(papers, and(eq(papers.projectId, projects.id), eq(papers.id, paperId)))
          .where(eq(projects.id, projectId)).limit(1);
        if (!scope) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        if (!scope.paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
        const paper = scope.paper;

        const reviewStatus: PaperReviewStatus = await getPaperReviewStatusFor(projectId, paperId, tx);
        const fields = await tx.select().from(extractionFields)
          .where(and(eq(extractionFields.projectId, projectId), sql`${extractionFields.archivedAt} is null`))
          .orderBy(asc(extractionFields.sortOrder), asc(extractionFields.id));
        const fieldIds = fields.map((field) => field.id);

        const options = fieldIds.length === 0 ? [] : await tx.select().from(extractionOptions)
          .where(and(eq(extractionOptions.projectId, projectId), inArray(extractionOptions.fieldId, fieldIds)))
          .orderBy(asc(extractionOptions.fieldId), asc(extractionOptions.sortOrder), asc(extractionOptions.id));
        const optionsByFieldId = new Map<string, typeof options>();
        for (const option of options) {
          optionsByFieldId.set(option.fieldId, [...(optionsByFieldId.get(option.fieldId) ?? []), option]);
        }
        const worksheetFields = fields.map((field) => ({ ...field, options: optionsByFieldId.get(field.id) ?? [] }));

        // One lateral top-row probe per active Field keeps current identity set-wise.
        // The current selector intentionally has no UUID tie-breaker.
        const currentRows = rows(await tx.execute(sql`
          select f.id as field_id,
            slot.id as slot_id, slot.project_id as slot_project_id, slot.paper_id as slot_paper_id,
            slot.field_id as slot_field_id, slot.created_at as slot_created_at, slot.updated_at as slot_updated_at,
            current_r.id as revision_id, current_r.sequence::text as sequence,
            current_r.project_id as revision_project_id, current_r.paper_id as revision_paper_id,
            current_r.field_id as revision_field_id, current_r.extraction_value_id,
            current_r.field_type, current_r.value_state, current_r.text_value,
            current_r.number_value::text as number_value, current_r.boolean_value, current_r.option_id,
            current_r.researcher_note, current_r.created_at as revision_created_at,
            current_r.finalized_at, selected_option.label as option_label,
            selected_option.archived_at as option_archived_at
          from extraction_fields f
          left join extraction_values slot
            on slot.project_id=f.project_id and slot.paper_id=${paperId}::uuid and slot.field_id=f.id
          left join lateral (
            select r.*
            from extraction_value_revisions r
            where r.project_id=f.project_id and r.paper_id=${paperId}::uuid
              and r.field_id=f.id and r.extraction_value_id=slot.id and r.finalized_at is not null
            order by r.sequence desc
            limit 1
          ) current_r on true
          left join extraction_options selected_option
            on selected_option.project_id=current_r.project_id
              and selected_option.field_id=current_r.field_id and selected_option.id=current_r.option_id
          where f.project_id=${projectId}::uuid and f.archived_at is null
          order by f.sort_order, f.id
        `));

        const currentRevisionIds = currentRows.filter((row) => row.revision_id != null).map((row) => String(row.revision_id));
        const currentEvidenceLinks = currentRevisionIds.length === 0 ? [] : await tx.select({
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
            inArray(extractionRevisionEvidence.revisionId, currentRevisionIds),
          ))
          // Preserve the released exact support order: pageNumber ASC, createdAt ASC.
          .orderBy(asc(evidence.pageNumber), asc(evidence.createdAt));

        // The complete Paper Evidence picker is intentionally retained as deferred debt.
        const paperEvidenceRows = await deps.evidenceRepo.listForPaper(projectId, paperId, tx);
        const paperEvidence = paperEvidenceRows.map(({ currentReviewDecision, ...item }) => {
          const reviewState = evidenceReviewState(currentReviewDecision ?? undefined);
          return { ...item, reviewState, curationWarning: evidenceCurationWarning(reviewState) };
        });

        const evidenceByRevisionId = new Map<string, Evidence[]>();
        for (const link of currentEvidenceLinks) {
          evidenceByRevisionId.set(link.revisionId, [...(evidenceByRevisionId.get(link.revisionId) ?? []), link.item]);
        }
        const currentByFieldId = new Map(currentRows.map((row) => [String(row.field_id), row]));

        const values = worksheetFields.map((field) => {
          const row = currentByFieldId.get(field.id);
          const hasSlot = row?.slot_id != null;
          const slot = hasSlot ? {
            id: String(row.slot_id),
            projectId: String(row.slot_project_id),
            paperId: String(row.slot_paper_id),
            fieldId: String(row.slot_field_id),
            createdAt: date(row.slot_created_at),
            updatedAt: date(row.slot_updated_at),
          } : { id: "", projectId, paperId, fieldId: field.id, createdAt: null, updatedAt: null };
          const currentRevision = row?.revision_id == null ? null : {
            id: String(row.revision_id),
            sequence: String(row.sequence),
            projectId: String(row.revision_project_id),
            paperId: String(row.revision_paper_id),
            fieldId: String(row.revision_field_id),
            extractionValueId: String(row.extraction_value_id),
            fieldType: String(row.field_type) as ExtractionFieldType,
            valueState: String(row.value_state) as ExtractionValueState,
            textValue: row.text_value == null ? null : String(row.text_value),
            numberValue: row.number_value == null ? null : String(row.number_value),
            booleanValue: row.boolean_value == null ? null : row.boolean_value === true,
            optionId: row.option_id == null ? null : String(row.option_id),
            optionLabel: row.option_label == null ? null : String(row.option_label),
            optionArchivedAt: nullableDate(row.option_archived_at),
            researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
            createdAt: date(row.revision_created_at),
            finalizedAt: nullableDate(row.finalized_at),
            evidence: evidenceByRevisionId.get(String(row.revision_id)) ?? [],
          };
          const support = currentRevision?.evidence ?? [];
          const hasHistory = currentRevision !== null;
          return {
            ...slot,
            field,
            currentRevision,
            supportStatus: currentRevision && currentRevision.valueState !== "cleared" && support.length > 0 ? "grounded" as const : "ungrounded" as const,
            hasHistory,
            historyHref: hasHistory
              ? `/projects/${projectId}/extraction/${paperId}/fields/${field.id}/history`
              : null,
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
