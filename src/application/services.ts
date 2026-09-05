import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { claimEvidence, claims, extractionRevisionEvidence, extractionValues, extractionValueRevisions } from "@/db/schema";
import { DomainError, isConstraintError } from "@/domain/errors";
import {
  claimEvidenceInputSchema,
  createClaimSchema,
  createPaperSchema,
  createProjectSchema,
  idSchema,
  recordEvidenceSchema,
  createScreeningCriterionSchema,
  recordScreeningDecisionSchema,
  createExtractionFieldSchema,
  updateExtractionFieldSchema,
  createExtractionOptionSchema,
  reviseExtractionValueSchema,
  type CreateClaimInput,
  type CreatePaperInput,
  type CreateProjectInput,
  type RecordEvidenceInput,
  type CreateScreeningCriterionInput,
  type RecordScreeningDecisionInput,
  type CreateExtractionFieldInput,
  type UpdateExtractionFieldInput,
  type CreateExtractionOptionInput,
  type ReviseExtractionValueInput,
} from "@/domain/validation";
import type { ExtractionFieldType } from "@/domain/types";
import {
  ClaimEvidenceRepository,
  ClaimRepository,
  EvidenceRepository,
  PaperRepository,
  ProjectRepository,
  ScreeningCriterionRepository,
  ScreeningDecisionRepository,
  ExtractionFieldRepository,
  ExtractionOptionRepository,
  ExtractionValueRepository,
  ExtractionRevisionRepository,
  ExtractionRevisionEvidenceRepository,
} from "./repositories";

function validate<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError("VALIDATION_ERROR", "Input failed validation", result.error.issues);
  return result.data;
}

function ensureId(id: string): string {
  const result = idSchema.safeParse(id);
  if (!result.success) throw new DomainError("VALIDATION_ERROR", "Identifier must be a UUID", result.error.issues);
  return result.data;
}

export function createReviewServices(db: Database) {
  const projectRepo = new ProjectRepository(db);
  const paperRepo = new PaperRepository(db);
  const evidenceRepo = new EvidenceRepository(db);
  const claimRepo = new ClaimRepository(db);
  const linkRepo = new ClaimEvidenceRepository(db);
  const criterionRepo = new ScreeningCriterionRepository(db);
  const decisionRepo = new ScreeningDecisionRepository(db);
  const extractionFieldRepo = new ExtractionFieldRepository(db);
  const extractionOptionRepo = new ExtractionOptionRepository(db);
  const extractionValueRepo = new ExtractionValueRepository(db);
  const extractionRevisionRepo = new ExtractionRevisionRepository(db);
  const extractionEvidenceRepo = new ExtractionRevisionEvidenceRepository(db);

  async function requireProject(projectId: string) {
    ensureId(projectId);
    const project = await projectRepo.findById(projectId);
    if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
    return project;
  }

  async function requirePaper(projectId: string, paperId: string) {
    await requireProject(projectId);
    ensureId(paperId);
    const paper = await paperRepo.findById(projectId, paperId);
    if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
    return paper;
  }

  async function requireEvidence(projectId: string, evidenceId: string) {
    await requireProject(projectId);
    ensureId(evidenceId);
    const item = await evidenceRepo.findById(projectId, evidenceId);
    if (!item) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence does not belong to this project");
    return item;
  }

  async function requireClaim(projectId: string, claimId: string) {
    await requireProject(projectId);
    ensureId(claimId);
    const claim = await claimRepo.findById(projectId, claimId);
    if (!claim) throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim does not belong to this project");
    return claim;
  }

  async function requireCriterion(projectId: string, criterionId: string) {
    await requireProject(projectId);
    ensureId(criterionId);
    const criterion = await criterionRepo.findById(projectId, criterionId);
    if (!criterion) throw new DomainError("CROSS_PROJECT_REFERENCE", "Criterion does not belong to this project");
    return criterion;
  }

  async function requireExtractionField(projectId: string, fieldId: string, includeArchived = true) {
    await requireProject(projectId);
    ensureId(fieldId);
    const field = await extractionFieldRepo.findById(projectId, fieldId);
    if (!field) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction field does not belong to this project");
    if (!includeArchived && field.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived extraction fields cannot be used");
    return field;
  }

  async function requireIncludedPaper(projectId: string, paperId: string) {
    const paper = await requirePaper(projectId, paperId);
    const decision = await decisionRepo.currentForPaper(projectId, paperId);
    if (!decision || decision.decision !== "include") throw new DomainError("VALIDATION_ERROR", "Extraction is available only for included papers");
    return paper;
  }

  function typedRevisionPayload(fieldType: ExtractionFieldType, input: ReviseExtractionValueInput) {
    const state = input.state ?? "present";
    const note = input.researcherNote ?? null;
    if (state !== "present") return { valueState: state, textValue: null, numberValue: null, booleanValue: null, optionId: null, researcherNote: note };
    if (fieldType === "short_text" || fieldType === "long_text") {
      if (typeof input.value !== "string" || !input.value.trim()) throw new DomainError("VALIDATION_ERROR", "Text extraction values must be nonblank");
      const max = fieldType === "short_text" ? 500 : 10000;
      if (input.value.length > max) throw new DomainError("VALIDATION_ERROR", `Text extraction values cannot exceed ${max} characters`);
      return { valueState: state, textValue: input.value, numberValue: null, booleanValue: null, optionId: null, researcherNote: note };
    }
    if (fieldType === "number") {
      if ((typeof input.value !== "number" && typeof input.value !== "string") || input.value === "" || !Number.isFinite(Number(input.value))) throw new DomainError("VALIDATION_ERROR", "Number extraction values must be finite numbers");
      return { valueState: state, textValue: null, numberValue: String(input.value), booleanValue: null, optionId: null, researcherNote: note };
    }
    if (fieldType === "boolean") {
      if (typeof input.value !== "boolean") throw new DomainError("VALIDATION_ERROR", "Boolean extraction values must be true or false");
      return { valueState: state, textValue: null, numberValue: null, booleanValue: input.value, optionId: null, researcherNote: note };
    }
    if (typeof input.value !== "string") throw new DomainError("VALIDATION_ERROR", "Single-select extraction values must reference an option");
    return { valueState: state, textValue: null, numberValue: null, booleanValue: null, optionId: input.value, researcherNote: note };
  }

  return {
    async createProject(input: CreateProjectInput) {
      const values = validate(createProjectSchema, input);
      return projectRepo.create({ title: values.title, description: values.description ?? null, researchQuestion: values.researchQuestion ?? null });
    },

    getProject(projectId: string) { return requireProject(projectId); },
    listPapers(projectId: string) { return requireProject(projectId).then(() => paperRepo.list(projectId)); },
    listEvidence(projectId: string) { return requireProject(projectId).then(() => evidenceRepo.list(projectId)); },
    listClaims(projectId: string) { return requireProject(projectId).then(() => claimRepo.list(projectId)); },
    async listScreeningCriteria(projectId: string, includeArchived = false) {
      await requireProject(projectId);
      return criterionRepo.list(projectId, includeArchived);
    },

    async createScreeningCriterion(projectId: string, input: CreateScreeningCriterionInput) {
      await requireProject(projectId);
      const values = validate(createScreeningCriterionSchema, input);
      return criterionRepo.create({ projectId, type: values.type, text: values.text });
    },

    async archiveScreeningCriterion(projectId: string, criterionId: string) {
      const criterion = await requireCriterion(projectId, criterionId);
      if (criterion.archivedAt) return criterion;
      const archived = await criterionRepo.archive(projectId, criterionId);
      if (archived.length === 0) throw new DomainError("NOT_FOUND", "Criterion was not found");
      return archived[0];
    },

    async getPaperScreening(projectId: string, paperId: string) {
      const paper = await requirePaper(projectId, paperId);
      const [criteria, currentDecision, decisions] = await Promise.all([
        criterionRepo.list(projectId), decisionRepo.currentForPaper(projectId, paperId), decisionRepo.listForPaper(projectId, paperId),
      ]);
      const history = await Promise.all(decisions.map(async (decision) => ({
        ...decision,
        exclusionCriterion: decision.exclusionCriterionId ? await criterionRepo.findById(projectId, decision.exclusionCriterionId) : null,
      })));
      return {
        paper,
        criteria,
        currentState: currentDecision ? ({ include: "included", exclude: "excluded", maybe: "maybe" }[currentDecision.decision]) : "unscreened" as const,
        currentDecision,
        history,
      };
    },

    async listScreeningPapers(projectId: string, state?: "unscreened" | "included" | "excluded" | "maybe") {
      await requireProject(projectId);
      const papersWithState = await decisionRepo.listPapersWithCurrentState(projectId);
      return state ? papersWithState.filter((paper) => paper.screeningState === state) : papersWithState;
    },

    async recordScreeningDecision(projectId: string, paperId: string, input: RecordScreeningDecisionInput) {
      await requirePaper(projectId, paperId);
      const values = validate(recordScreeningDecisionSchema, input);
      let exclusionCriterionId: string | null = null;
      let exclusionCriterionType: "exclusion" | null = null;
      if (values.decision === "exclude") {
        const criterion = await requireCriterion(projectId, values.exclusionCriterionId);
        if (criterion.type !== "exclusion") throw new DomainError("VALIDATION_ERROR", "Exclude decisions require an exclusion criterion");
        if (criterion.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived criteria cannot be used for new decisions");
        exclusionCriterionId = criterion.id;
        exclusionCriterionType = "exclusion";
      }
      try {
        return await decisionRepo.create({
          projectId, paperId, stage: "title_abstract", decision: values.decision,
          exclusionCriterionId, exclusionCriterionType, note: values.note ?? null,
        });
      } catch (error) {
        if (isConstraintError(error)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Screening references an invalid project record");
        throw error;
      }
    },

    async listExtractionFields(projectId: string, includeArchived = false) {
      await requireProject(projectId);
      return extractionFieldRepo.list(projectId, includeArchived);
    },

    async createExtractionField(projectId: string, input: CreateExtractionFieldInput) {
      await requireProject(projectId);
      const values = validate(createExtractionFieldSchema, input);
      const fields = await extractionFieldRepo.list(projectId, true);
      const sortOrder = fields.reduce((max, field) => Math.max(max, field.sortOrder), -1) + 1;
      try {
        return await extractionFieldRepo.create({ projectId, name: values.name, description: values.description ?? null, fieldType: values.fieldType, required: values.required, sortOrder });
      } catch (error) { if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "Extraction field could not be created"); throw error; }
    },

    async updateExtractionField(projectId: string, fieldId: string, input: UpdateExtractionFieldInput) {
      const field = await requireExtractionField(projectId, fieldId);
      const values = validate(updateExtractionFieldSchema, input);
      if (values.name === undefined && values.description === undefined && values.required === undefined && values.sortOrder === undefined) return field;
      if (values.name !== undefined || values.description !== undefined) {
        if (await extractionFieldRepo.countValues(projectId, fieldId)) throw new DomainError("VALIDATION_ERROR", "A used extraction field cannot change its definition");
      }
      const updated = await extractionFieldRepo.update(projectId, fieldId, { ...values, description: values.description === undefined ? undefined : values.description ?? null });
      return updated[0] ?? field;
    },

    async archiveExtractionField(projectId: string, fieldId: string) {
      const field = await requireExtractionField(projectId, fieldId);
      if (field.archivedAt) return field;
      const updated = await extractionFieldRepo.archive(projectId, fieldId);
      return updated[0] ?? field;
    },

    async createExtractionOption(projectId: string, input: CreateExtractionOptionInput) {
      await requireProject(projectId);
      const values = validate(createExtractionOptionSchema, input);
      const field = await requireExtractionField(projectId, values.fieldId, false);
      if (field.fieldType !== "single_select") throw new DomainError("VALIDATION_ERROR", "Options are only valid for single-select fields");
      const options = await extractionOptionRepo.listForField(projectId, field.id, true);
      const sortOrder = options.reduce((max, option) => Math.max(max, option.sortOrder), -1) + 1;
      try { return await extractionOptionRepo.create({ projectId, fieldId: field.id, label: values.label, sortOrder }); }
      catch (error) { if (isConstraintError(error)) throw new DomainError("DATABASE_CONSTRAINT", "Extraction option could not be created"); throw error; }
    },

    async listExtractionOptions(projectId: string, fieldId: string, includeArchived = false) {
      await requireExtractionField(projectId, fieldId);
      return extractionOptionRepo.listForField(projectId, fieldId, includeArchived);
    },

    async archiveExtractionOption(projectId: string, optionId: string) {
      await requireProject(projectId);
      ensureId(optionId);
      const option = await extractionOptionRepo.findById(projectId, optionId);
      if (!option) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction option does not belong to this project");
      if (option.archivedAt) return option;
      const updated = await extractionOptionRepo.archive(projectId, optionId);
      return updated[0] ?? option;
    },

    async reviseExtractionValue(projectId: string, paperId: string, fieldId: string, input: ReviseExtractionValueInput) {
      await requireIncludedPaper(projectId, paperId);
      const field = await requireExtractionField(projectId, fieldId, false);
      const values = validate(reviseExtractionValueSchema, input);
      const payload = typedRevisionPayload(field.fieldType as ExtractionFieldType, values);
      const evidenceIds = [...new Set(values.evidenceIds ?? [])];
      if (evidenceIds.length !== (values.evidenceIds ?? []).length) throw new DomainError("VALIDATION_ERROR", "Evidence cannot be repeated in one revision");
      if (payload.optionId) {
        const option = await extractionOptionRepo.findById(projectId, payload.optionId);
        if (!option || option.fieldId !== field.id || option.archivedAt) throw new DomainError("CROSS_PROJECT_REFERENCE", "Option does not belong to this active extraction field");
      }
      const evidenceItems = await Promise.all(evidenceIds.map((id) => requireEvidence(projectId, id)));
      if (evidenceItems.some((item) => item.paperId !== paperId)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence must belong to the same paper as the extraction value");
      return db.transaction(async (tx) => {
        let slot = await tx.select().from(extractionValues).where(and(eq(extractionValues.projectId, projectId), eq(extractionValues.paperId, paperId), eq(extractionValues.fieldId, field.id))).limit(1).then((rows) => rows[0]);
        if (!slot) {
          const rows = await tx.insert(extractionValues).values({ projectId, paperId, fieldId: field.id }).returning();
          slot = rows[0];
        }
        const inserted = await tx.insert(extractionValueRevisions).values({ projectId, paperId, fieldId: field.id, extractionValueId: slot.id, fieldType: field.fieldType, ...payload }).returning();
        const revision = inserted[0];
        for (const evidenceId of evidenceIds) await tx.insert(extractionRevisionEvidence).values({ projectId, paperId, revisionId: revision.id, evidenceId });
        const finalized = await tx.update(extractionValueRevisions).set({ finalizedAt: new Date() }).where(and(eq(extractionValueRevisions.projectId, projectId), eq(extractionValueRevisions.id, revision.id))).returning();
        await tx.update(extractionValues).set({ updatedAt: new Date() }).where(and(eq(extractionValues.projectId, projectId), eq(extractionValues.id, slot.id)));
        return finalized[0];
      });
    },

    async setExtractionValue(projectId: string, paperId: string, fieldId: string, input: ReviseExtractionValueInput) {
      return this.reviseExtractionValue(projectId, paperId, fieldId, input);
    },

    async clearExtractionValue(projectId: string, paperId: string, fieldId: string, researcherNote?: string) {
      return this.reviseExtractionValue(projectId, paperId, fieldId, { state: "cleared", researcherNote, evidenceIds: [] });
    },

    async linkEvidenceToExtractionValue(projectId: string, input: { paperId: string; fieldId: string; evidenceId: string }) {
      const current = await this.getPaperExtraction(projectId, input.paperId);
      const item = current.values.find((value) => value.field.id === input.fieldId);
      if (!item?.currentRevision) throw new DomainError("NOT_FOUND", "There is no current extraction revision to support");
      const evidenceIds = [...item.currentRevision.evidence.map((evidence) => evidence.id), input.evidenceId];
      return this.reviseExtractionValue(projectId, input.paperId, input.fieldId, { state: item.currentRevision.valueState as "present" | "not_reported" | "not_applicable" | "cleared", value: item.currentRevision.optionId ?? item.currentRevision.textValue ?? item.currentRevision.numberValue ?? item.currentRevision.booleanValue ?? undefined, researcherNote: item.currentRevision.researcherNote ?? undefined, evidenceIds });
    },

    async unlinkEvidenceFromExtractionValue(projectId: string, input: { paperId: string; fieldId: string; evidenceId: string }) {
      const current = await this.getPaperExtraction(projectId, input.paperId);
      const item = current.values.find((value) => value.field.id === input.fieldId);
      if (!item?.currentRevision) throw new DomainError("NOT_FOUND", "There is no current extraction revision");
      const evidenceIds = item.currentRevision.evidence.filter((evidence) => evidence.id !== input.evidenceId).map((evidence) => evidence.id);
      return this.reviseExtractionValue(projectId, input.paperId, input.fieldId, { state: item.currentRevision.valueState as "present" | "not_reported" | "not_applicable" | "cleared", value: item.currentRevision.optionId ?? item.currentRevision.textValue ?? item.currentRevision.numberValue ?? item.currentRevision.booleanValue ?? undefined, researcherNote: item.currentRevision.researcherNote ?? undefined, evidenceIds });
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
      return { paper, fields, values };
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
      const [papersWithState, fields] = await Promise.all([decisionRepo.listPapersWithCurrentState(projectId), extractionFieldRepo.list(projectId)]);
      const included = papersWithState.filter((paper) => paper.screeningState === "included");
      const required = fields.filter((field) => field.required);
      const progress = await Promise.all(included.map(async (paper) => {
        const extraction = await this.getPaperExtraction(projectId, paper.id);
        const completed = extraction.values.filter((value) => value.field.required && value.currentRevision && ["present", "not_reported", "not_applicable"].includes(value.currentRevision.valueState)).length;
        const started = extraction.values.some((value) => value.currentRevision && value.currentRevision.valueState !== "cleared");
        const status = required.length === 0 ? "not_configured" : completed === required.length ? "complete" : started ? "partial" : "not_started";
        return { paper, completedRequired: completed, requiredCount: required.length, status, percentage: required.length ? Math.round((completed / required.length) * 100) : null };
      }));
      return { includedPaperCount: included.length, requiredFieldCount: required.length, papers: progress };
    },

    async addPaper(projectId: string, input: CreatePaperInput) {
      await requireProject(projectId);
      const values = validate(createPaperSchema, input);
      return paperRepo.create({ projectId, ...values, publicationYear: values.publicationYear ?? null, venue: values.venue ?? null, doi: values.doi ?? null, abstract: values.abstract ?? null, bibliographicNote: values.bibliographicNote ?? null });
    },

    async recordEvidence(projectId: string, input: RecordEvidenceInput) {
      const values = validate(recordEvidenceSchema, input);
      await requirePaper(projectId, values.paperId);
      return evidenceRepo.create({ projectId, ...values, note: values.note ?? null });
    },

    async createClaim(projectId: string, input: CreateClaimInput) {
      await requireProject(projectId);
      const values = validate(createClaimSchema, input);
      return claimRepo.create({ projectId, claimText: values.claimText });
    },

    async linkEvidenceToClaim(projectId: string, input: { claimId: string; evidenceId: string }) {
      const values = validate(claimEvidenceInputSchema, input);
      await requireClaim(projectId, values.claimId);
      await requireEvidence(projectId, values.evidenceId);
      try {
        return await linkRepo.create({ projectId, claimId: values.claimId, evidenceId: values.evidenceId });
      } catch (error) {
        if (isConstraintError(error)) throw new DomainError("DUPLICATE_LINK", "Evidence is already linked to this claim");
        throw error;
      }
    },

    async unlinkEvidenceFromClaim(projectId: string, input: { claimId: string; evidenceId: string }) {
      const values = validate(claimEvidenceInputSchema, input);
      await requireClaim(projectId, values.claimId);
      await requireEvidence(projectId, values.evidenceId);
      const deleted = await linkRepo.delete(projectId, values.claimId, values.evidenceId);
      if (deleted.length === 0) throw new DomainError("NOT_FOUND", "Evidence link was not found");
      return deleted[0];
    },

    async deletePaper(projectId: string, paperId: string) {
      await requirePaper(projectId, paperId);
      if (await evidenceRepo.countForPaper(projectId, paperId)) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted while evidence exists");
      if (await decisionRepo.countForPaper(projectId, paperId)) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted after screening decisions exist");
      try { return await paperRepo.delete(projectId, paperId); }
      catch (error) { if (isConstraintError(error)) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted after evidence or screening history exists"); throw error; }
    },

    async deleteEvidence(projectId: string, evidenceId: string) {
      await requireEvidence(projectId, evidenceId);
      if (await linkRepo.countForEvidence(projectId, evidenceId)) throw new DomainError("PROTECTED_DELETE", "Evidence cannot be deleted while linked to a claim");
      try { return await evidenceRepo.delete(projectId, evidenceId); }
      catch (error) { if (isConstraintError(error)) throw new DomainError("PROTECTED_DELETE", "Evidence cannot be deleted while linked to a claim"); throw error; }
    },

    async deleteClaim(projectId: string, claimId: string) {
      await requireClaim(projectId, claimId);
      return db.transaction(async (tx) => {
        await tx.delete(claimEvidence).where(and(eq(claimEvidence.projectId, projectId), eq(claimEvidence.claimId, claimId)));
        const deleted = await tx.delete(claims).where(and(eq(claims.projectId, projectId), eq(claims.id, claimId))).returning({ id: claims.id });
        return deleted[0];
      });
    },

    async getClaimProvenance(projectId: string, claimId: string) {
      const claim = await requireClaim(projectId, claimId);
      const links = await linkRepo.listForClaim(projectId, claimId);
      const linked = await Promise.all(links.map(async (link) => {
        const item = await evidenceRepo.findById(projectId, link.evidenceId);
        if (!item) throw new DomainError("DATABASE_CONSTRAINT", "Evidence provenance is inconsistent");
        const paper = await paperRepo.findById(projectId, item.paperId);
        if (!paper) throw new DomainError("DATABASE_CONSTRAINT", "Paper provenance is inconsistent");
        return { evidence: item, paper };
      }));
      return { claim, supportStatus: linked.length > 0 ? "supported" as const : "unsupported" as const, evidence: linked };
    },
  };
}
