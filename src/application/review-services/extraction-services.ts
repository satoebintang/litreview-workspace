import type { Database } from "@/db/client";
import { DomainError, isConstraintError } from "@/domain/errors";
import type { ExtractionFieldType } from "@/domain/types";
import {
  createExtractionFieldSchema,
  createExtractionOptionSchema,
  extractionComparisonFilterSchema,
  reviseExtractionValueSchema,
  updateExtractionFieldSchema,
  type CreateExtractionFieldInput,
  type CreateExtractionOptionInput,
  type ExtractionComparisonFilter,
  type ReviseExtractionValueInput,
  type UpdateExtractionFieldInput,
} from "@/domain/validation";
import type {
  ExtractionFieldRepository,
  ExtractionOptionRepository,
  ExtractionRevisionEvidenceRepository,
  ExtractionRevisionRepository,
  ExtractionValueRepository,
  PaperRepository,
  PaperReviewRepository,
  ProjectRepository,
  ScreeningDecisionRepository,
  SynthesisRevisionSupportRepository,
} from "../repositories";
import { lockExtractionEvidenceRowsForUpdate } from "../repositories/extraction";
import { requireEvidenceUsableForNewDirectSupport } from "../evidence-curation-services";
import { writeExtractedExtractionRevision } from "../extraction-value-writer";
import { createEvidenceReviewHelpers } from "./evidence-helpers";
import { mapEvidence, mapExtractionRevision, mapPaper } from "./mappers";
import { createPaperReviewHelpers } from "./paper-review-helpers";
import { ensureId, typedRevisionPayload, validate } from "./shared";

export function createExtractionServices<TProject, TPaper, TField extends { id: string; fieldType: string; archivedAt: Date | null }>(deps: {
  db: Database;
  projectRepo: ProjectRepository;
  paperRepo: PaperRepository;
  paperReviewRepo: PaperReviewRepository;
  decisionRepo: ScreeningDecisionRepository;
  extractionFieldRepo: ExtractionFieldRepository;
  extractionOptionRepo: ExtractionOptionRepository;
  extractionValueRepo: ExtractionValueRepository;
  extractionRevisionRepo: ExtractionRevisionRepository;
  extractionEvidenceRepo: ExtractionRevisionEvidenceRepository;
  synthesisSupportRepo: SynthesisRevisionSupportRepository;
  requireProject: (projectId: string) => Promise<TProject>;
  requirePaper: (projectId: string, paperId: string) => Promise<TPaper>;
  requireExtractionField: (projectId: string, fieldId: string, includeArchived?: boolean) => Promise<TField>;
}) {
  const { db, projectRepo, paperRepo, paperReviewRepo, decisionRepo, extractionFieldRepo, extractionOptionRepo, extractionValueRepo, extractionRevisionRepo, extractionEvidenceRepo, synthesisSupportRepo, requireProject, requirePaper, requireExtractionField } = deps;
  const { requireFinallyIncludedPaperLocked, getPaperReviewStatusFor, listPaperReviewStatusesFor } = createPaperReviewHelpers(db, paperRepo, paperReviewRepo);
  const { enrichEvidenceDocuments } = createEvidenceReviewHelpers(db);
  return {
    async listExtractionFields(projectId: string, includeArchived = false) {
      await requireProject(projectId);
      return extractionFieldRepo.list(projectId, includeArchived);
    },

    async createExtractionField(projectId: string, input: CreateExtractionFieldInput) {
      ensureId(projectId);
      const values = validate(createExtractionFieldSchema, input);
      try {
        return await db.transaction(async (tx) => {
          const project = await projectRepo.findForUpdate(tx, projectId);
          if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
          const sortOrder = await extractionFieldRepo.nextSortOrder(tx, projectId);
          return extractionFieldRepo.create(tx, { projectId, name: values.name, description: values.description ?? null, fieldType: values.fieldType, required: values.required, sortOrder });
        });
      } catch (error) { if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "Extraction field could not be created"); throw error; }
    },

    async updateExtractionField(projectId: string, fieldId: string, input: UpdateExtractionFieldInput) {
      await requireProject(projectId);
      ensureId(fieldId);
      return db.transaction(async (tx) => {
        const field = await extractionFieldRepo.findForUpdate(tx, projectId, fieldId);
        if (!field) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction field does not belong to this project");
        const values = validate(updateExtractionFieldSchema, input);
        if (values.name === undefined && values.description === undefined && values.required === undefined && values.sortOrder === undefined) return field;
        if (values.name !== undefined || values.description !== undefined) {
          if (await extractionFieldRepo.countValues(tx, projectId, fieldId)) throw new DomainError("VALIDATION_ERROR", "A used extraction field cannot change its definition");
        }
        const updated = await extractionFieldRepo.update(tx, projectId, fieldId, { ...values, description: values.description === undefined ? undefined : values.description ?? null });
        return updated[0] ?? field;
      });
    },

    async archiveExtractionField(projectId: string, fieldId: string) {
      await requireProject(projectId);
      ensureId(fieldId);
      return db.transaction(async (tx) => {
        const field = await extractionFieldRepo.findForUpdate(tx, projectId, fieldId);
        if (!field) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction field does not belong to this project");
        if (field.archivedAt) return field;
        const updated = await extractionFieldRepo.archive(tx, projectId, fieldId);
        return updated[0] ?? field;
      });
    },

    async createExtractionOption(projectId: string, input: CreateExtractionOptionInput) {
      ensureId(projectId);
      const values = validate(createExtractionOptionSchema, input);
      try { return await db.transaction(async (tx) => {
        const field = await extractionFieldRepo.findForUpdate(tx, projectId, values.fieldId);
        if (!field) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction field does not belong to this project");
        if (field.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived extraction fields cannot be used");
        if (field.fieldType !== "single_select") throw new DomainError("VALIDATION_ERROR", "Options are only valid for single-select fields");
        const sortOrder = await extractionOptionRepo.nextSortOrder(tx, projectId, field.id);
        return extractionOptionRepo.create(tx, { projectId, fieldId: field.id, label: values.label, sortOrder });
      }); }
      catch (error) { if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "Extraction option could not be created"); throw error; }
    },

    async listExtractionOptions(projectId: string, fieldId: string, includeArchived = false) {
      await requireExtractionField(projectId, fieldId);
      return extractionOptionRepo.listForField(projectId, fieldId, includeArchived);
    },

    async archiveExtractionOption(projectId: string, optionId: string) {
      await requireProject(projectId);
      ensureId(optionId);
      return db.transaction(async (tx) => {
        const option = await extractionOptionRepo.findForUpdate(tx, projectId, optionId);
        if (!option) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction option does not belong to this project");
        if (option.archivedAt) return option;
        const updated = await extractionOptionRepo.archive(tx, projectId, optionId);
        return updated[0] ?? option;
      });
    },

    async reviseExtractionValue(projectId: string, paperId: string, fieldId: string, input: ReviseExtractionValueInput) {
      await requireProject(projectId);
      return db.transaction(async (tx) => {
        await requireFinallyIncludedPaperLocked(tx, projectId, paperId);
        const field = await extractionFieldRepo.findForUpdate(tx, projectId, fieldId);
        if (!field) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction field does not belong to this project");
        if (field.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived extraction fields cannot be used");
        const values = validate(reviseExtractionValueSchema, input);
        const payload = typedRevisionPayload(field.fieldType as ExtractionFieldType, values);
        const submittedEvidenceIds = values.evidenceIds ?? [];
        const normalizedEvidenceIds = submittedEvidenceIds.map((evidenceId) => evidenceId.toLowerCase());
        const evidenceIds = [...new Set(normalizedEvidenceIds)];
        if (evidenceIds.length !== submittedEvidenceIds.length) throw new DomainError("VALIDATION_ERROR", "Evidence cannot be repeated in one revision");
        if (payload.optionId) {
          const option = await extractionOptionRepo.findForUpdate(tx, projectId, payload.optionId);
          if (!option || option.fieldId !== field.id || option.archivedAt) throw new DomainError("CROSS_PROJECT_REFERENCE", "Option does not belong to this active extraction field");
        }
        const evidenceItems = await lockExtractionEvidenceRowsForUpdate(tx, projectId, evidenceIds);
        if (evidenceItems.length !== evidenceIds.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence does not belong to this project");
        if (evidenceItems.some((item) => item.paperId !== paperId)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence must belong to the same paper as the extraction value");
        for (const evidenceId of [...evidenceIds].sort()) {
          await requireEvidenceUsableForNewDirectSupport(tx, projectId, evidenceId);
        }
        return writeExtractedExtractionRevision(tx, {
          projectId,
          paperId,
          fieldId: field.id,
          fieldType: field.fieldType as ExtractionFieldType,
          ...payload,
          evidenceIds,
        });
      });
    },

    async setExtractionValue(projectId: string, paperId: string, fieldId: string, input: ReviseExtractionValueInput) {
      return this.reviseExtractionValue(projectId, paperId, fieldId, input);
    },

    async clearExtractionValue(projectId: string, paperId: string, fieldId: string, researcherNote?: string) {
      return this.reviseExtractionValue(projectId, paperId, fieldId, { state: "cleared", researcherNote, evidenceIds: [] });
    },

    async linkEvidenceToExtractionValue(projectId: string, input: { paperId: string; fieldId: string; evidenceId: string }) {
      const extraction = await this.getPaperExtraction(projectId, input.paperId);
      const current = extraction.values.find((value) => value.field.id === input.fieldId)?.currentRevision;
      if (!current) throw new DomainError("NOT_FOUND", "There is no current extraction revision to support");
      const evidenceIds = [...current.evidence.map((evidence) => evidence.id), input.evidenceId];
      return this.reviseExtractionValue(projectId, input.paperId, input.fieldId, { state: current.valueState as "present" | "not_reported" | "not_applicable" | "cleared", value: current.optionId ?? current.textValue ?? current.numberValue ?? current.booleanValue ?? undefined, researcherNote: current.researcherNote ?? undefined, evidenceIds });
    },

    async unlinkEvidenceFromExtractionValue(projectId: string, input: { paperId: string; fieldId: string; evidenceId: string }) {
      const extraction = await this.getPaperExtraction(projectId, input.paperId);
      const current = extraction.values.find((value) => value.field.id === input.fieldId)?.currentRevision;
      if (!current) throw new DomainError("NOT_FOUND", "There is no current extraction revision");
      const evidenceIds = current.evidence.filter((evidence) => evidence.id !== input.evidenceId).map((evidence) => evidence.id);
      return this.reviseExtractionValue(projectId, input.paperId, input.fieldId, { state: current.valueState as "present" | "not_reported" | "not_applicable" | "cleared", value: current.optionId ?? current.textValue ?? current.numberValue ?? current.booleanValue ?? undefined, researcherNote: current.researcherNote ?? undefined, evidenceIds });
    },

    async getPaperExtraction(projectId: string, paperId: string) {
      const paper = await requirePaper(projectId, paperId);
      const fields = await extractionFieldRepo.list(projectId);
      const slots = await extractionValueRepo.listForPaper(projectId, paperId);
      const slotByField = new Map(slots.map((slot) => [slot.fieldId, slot]));
      const values = await Promise.all(fields.map(async (field) => {
        const slot = slotByField.get(field.id);
        const current = slot ? await extractionRevisionRepo.current(projectId, slot.id) : null;
        const support = current ? await extractionEvidenceRepo.listForRevision(projectId, paperId, current.id) : [];
        return { ...(slot ?? { id: "", projectId, paperId, fieldId: field.id, createdAt: null, updatedAt: null }), field, currentRevision: current ? { ...current, evidence: support.map((row) => row.item) } : null, supportStatus: current && current.valueState !== "cleared" && support.length > 0 ? "grounded" as const : "ungrounded" as const };
      }));
      return { paper, fields, values, reviewStatus: await getPaperReviewStatusFor(projectId, paperId) };
    },

    async getExtractionValueHistory(projectId: string, paperId: string, fieldId: string) {
      await requirePaper(projectId, paperId);
      const field = await requireExtractionField(projectId, fieldId);
      const slot = await extractionValueRepo.findSlot(projectId, paperId, field.id);
      if (!slot) return [];
      const revisions = await extractionRevisionRepo.list(projectId, slot.id);
      return Promise.all(revisions.map(async (revision) => ({ ...revision, evidence: (await extractionEvidenceRepo.listForRevision(projectId, paperId, revision.id)).map((row) => row.item) })));
    },

    async getProjectExtractionProgress(projectId: string) {
      await requireProject(projectId);
      const [papersWithState, fields, reviewStatuses] = await Promise.all([decisionRepo.listPapersWithCurrentState(projectId), extractionFieldRepo.list(projectId), listPaperReviewStatusesFor(projectId)]);
      const reviewStatusByPaperId = new Map(reviewStatuses.map((item) => [item.paperId, item.status]));
      const included = papersWithState.filter((paper) => reviewStatusByPaperId.get(paper.id)?.finalEligibility === "included");
      const historical = papersWithState.filter((paper) => {
        const status = reviewStatusByPaperId.get(paper.id);
        return status?.finalEligibility !== "included" && status?.warnings.includes("legacy_analysis_precedes_full_text_screening");
      });
      const required = fields.filter((field) => field.required);
      const progress = await Promise.all([...included, ...historical].map(async (paper) => {
        const extraction = await this.getPaperExtraction(projectId, paper.id);
        const completed = extraction.values.filter((value) => value.field.required && value.currentRevision && ["present", "not_reported", "not_applicable"].includes(value.currentRevision.valueState)).length;
        const started = extraction.values.some((value) => value.currentRevision && value.currentRevision.valueState !== "cleared");
        const status = required.length === 0 ? "not_configured" : completed === required.length ? "complete" : started ? "partial" : "not_started";
        const reviewStatus = reviewStatusByPaperId.get(paper.id)!;
        return { paper, completedRequired: completed, requiredCount: required.length, status, percentage: required.length ? Math.round((completed / required.length) * 100) : null, reviewStatus, writeEligible: reviewStatus.finalEligibility === "included" };
      }));
      return { includedPaperCount: included.length, historicalPaperCount: historical.length, requiredFieldCount: required.length, papers: progress };
    },

    async listExtractionComparison(projectId: string, fieldId: string, input?: ExtractionComparisonFilter) {
      const field = await requireExtractionField(projectId, fieldId, false);
      const filters = validate(extractionComparisonFilterSchema, input ?? {});
      const rawRows = (await synthesisSupportRepo.listComparison(projectId, field.id)) as unknown as Record<string, unknown>[];
      const paperIds = filters.paperIds ? new Set(filters.paperIds) : null;
      const rows = rawRows.filter((row) => {
        const state = row.revision_id == null ? "not_extracted" : String(row.value_state);
        if (paperIds && !paperIds.has(String(row.paper_id))) return false;
        if (filters.valueState && state !== filters.valueState) return false;
        if (filters.optionId && String(row.option_id) !== filters.optionId) return false;
        if (filters.booleanValue !== undefined && row.boolean_value !== filters.booleanValue) return false;
        const displayedValue = row.revision_id == null ? "" : String(row.text_value ?? row.number_value ?? (row.boolean_value == null ? (row.option_label ?? "") : row.boolean_value));
        if (filters.search && !String(row.paper_title).toLowerCase().includes(filters.search.toLowerCase()) && !displayedValue.toLowerCase().includes(filters.search.toLowerCase())) return false;
        return true;
      });
      const revisions = rows.filter((row) => row.revision_id != null);
      const evidenceRows = (await synthesisSupportRepo.listEvidenceForRevisions(projectId, revisions.map((row) => String(row.revision_id)))) as unknown as Record<string, unknown>[];
      const mappedEvidenceRows = await enrichEvidenceDocuments(evidenceRows.map(mapEvidence));
      const evidenceByRevision = new Map<string, ReturnType<typeof mapEvidence>[]>();
      for (let i = 0; i < evidenceRows.length; i += 1) {
        const evidenceRow = evidenceRows[i];
        const id = String(evidenceRow.revision_id); evidenceByRevision.set(id, [...(evidenceByRevision.get(id) ?? []), mappedEvidenceRows[i]]);
      }
      return rows.map((row) => {
        const revision = row.revision_id == null ? null : mapExtractionRevision(row, evidenceByRevision.get(String(row.revision_id)) ?? []);
        const state = revision?.valueState ?? "not_extracted";
        const displayValue = revision ? (revision.textValue ?? revision.numberValue ?? (revision.booleanValue == null ? (row.option_label as string | null) : String(revision.booleanValue))) : null;
        return { paper: mapPaper(row), field, extractionRevision: revision, valueState: state, displayValue, supportStatus: revision && revision.valueState !== "cleared" && revision.evidence.length > 0 ? "grounded" as const : "ungrounded" as const, isSelectable: Boolean(revision && revision.valueState !== "cleared") };
      });
    },

    async getExtractionFieldSummary(projectId: string, fieldId: string) {
      const field = await requireExtractionField(projectId, fieldId, false);
      const rows = await this.listExtractionComparison(projectId, field.id);
      const counts: Record<string, number> = {};
      for (const row of rows) counts[row.valueState] = (counts[row.valueState] ?? 0) + 1;
      return { field, totalIncludedPapers: rows.length, counts };
    },
  };
}
