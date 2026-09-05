import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { claimEvidence, claims, extractionRevisionEvidence, extractionValues, extractionValueRevisions, synthesisStatements, synthesisRevisions } from "@/db/schema";
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
  synthesisRevisionInputSchema,
  synthesisWithdrawalSchema,
  extractionComparisonFilterSchema,
  type SynthesisRevisionInput,
  type SynthesisWithdrawalInput,
  type ExtractionComparisonFilter,
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
  SynthesisStatementRepository,
  SynthesisRevisionRepository,
  SynthesisRevisionSupportRepository,
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

type SqlExecutor = Pick<Database, "execute">;

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
  const synthesisStatementRepo = new SynthesisStatementRepository(db);
  const synthesisRevisionRepo = new SynthesisRevisionRepository(db);
  const synthesisSupportRepo = new SynthesisRevisionSupportRepository(db);

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

  function mapEvidence(row: Record<string, unknown>) {
    return {
      id: String(row.id), projectId: String(row.project_id), paperId: String(row.paper_id),
      sourceText: String(row.source_text), pageNumber: Number(row.page_number), note: row.note == null ? null : String(row.note),
      createdAt: row.created_at as Date, updatedAt: row.updated_at as Date,
    };
  }

  function mapPaper(row: Record<string, unknown>) {
    return {
      id: String(row.paper_id_value ?? row.paper_id ?? row.id), projectId: String(row.project_id), title: String(row.paper_title ?? row.title),
      authors: (row.authors as string[]) ?? [], publicationYear: row.publication_year as number | null,
      venue: row.venue as string | null, doi: row.doi as string | null, abstract: row.abstract as string | null,
      bibliographicNote: row.bibliographic_note as string | null, createdAt: row.paper_created_at as Date ?? row.created_at as Date,
      updatedAt: row.paper_updated_at as Date ?? row.updated_at as Date,
    };
  }

  function mapField(row: Record<string, unknown>) {
    return {
      id: String(row.field_id_value ?? row.field_id), projectId: String(row.project_id), name: String(row.field_name ?? row.name),
      description: row.field_description as string | null, fieldType: row.field_type_value ?? row.field_type as ExtractionFieldType,
      required: Boolean(row.required), sortOrder: Number(row.sort_order), createdAt: row.field_created_at as Date,
      updatedAt: row.field_updated_at as Date, archivedAt: row.field_archived_at as Date | null,
    };
  }

  function mapExtractionRevision(row: Record<string, unknown>, evidence: ReturnType<typeof mapEvidence>[] = []) {
    return {
      id: String(row.revision_id ?? row.id), sequence: Number(row.revision_sequence ?? row.sequence), projectId: String(row.project_id),
      paperId: String(row.paper_id), fieldId: String(row.field_id), extractionValueId: String(row.extraction_value_id),
      fieldType: String(row.field_type) as ExtractionFieldType, valueState: String(row.value_state) as "present" | "not_reported" | "not_applicable" | "cleared",
      textValue: row.text_value as string | null, numberValue: row.number_value as string | null, booleanValue: row.boolean_value as boolean | null,
      optionId: row.option_id as string | null, researcherNote: (row.revision_note ?? row.researcher_note) as string | null,
      createdAt: (row.revision_created_at ?? row.created_at) as Date, finalizedAt: row.revision_finalized_at ?? row.finalized_at as Date | null,
      evidence,
    };
  }

  function mapSynthesisRow(row: Record<string, unknown>) {
    const statement = {
      id: String(row.statement_id), projectId: String(row.project_id), createdAt: row.statement_created_at as Date,
    };
    const revision = {
      id: String(row.revision_id), sequence: Number(row.sequence), projectId: String(row.project_id),
      synthesisStatementId: String(row.synthesis_statement_id), state: String(row.state) as "active" | "withdrawn",
      title: row.title as string | null, statementText: row.statement_text as string | null, researcherNote: row.researcher_note as string | null,
      createdAt: row.created_at as Date, finalizedAt: row.finalized_at as Date | null,
    };
    return { statement, revision };
  }

  async function validateSynthesisSupports(projectId: string, extractionRevisionIds: string[], executor: SqlExecutor = db) {
    extractionRevisionIds.forEach(ensureId);
    if (!extractionRevisionIds.length) return [] as Record<string, unknown>[];
    const rows = (await executor.execute(sql`
      select r.id, r.project_id, r.paper_id, r.field_id, r.extraction_value_id, r.field_type, r.value_state,
        r.text_value, r.number_value, r.boolean_value, r.option_id, r.researcher_note, r.created_at, r.finalized_at,
        p.id as paper_id_value,
        coalesce((select sd.decision from screening_decisions sd where sd.project_id=r.project_id and sd.paper_id=r.paper_id and sd.stage='title_abstract' order by sd.sequence desc limit 1), 'unscreened') as screening_state
      from extraction_value_revisions r join papers p on p.project_id=r.project_id and p.id=r.paper_id
      where r.project_id=${projectId} and r.id in (${sql.join(extractionRevisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `)) as unknown as Record<string, unknown>[];
    if (rows.length !== extractionRevisionIds.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "One or more extraction revisions do not belong to this project");
    for (const row of rows) {
      if (row.finalized_at == null) throw new DomainError("VALIDATION_ERROR", "Synthesis support must use finalized extraction revisions");
      if (String(row.value_state) === "cleared") throw new DomainError("VALIDATION_ERROR", "Cleared extraction revisions cannot support new synthesis");
      if (String(row.screening_state) !== "include") throw new DomainError("VALIDATION_ERROR", "New synthesis support is limited to currently included papers");
    }
    return rows;
  }

  function synthesisViewFromRows(projectId: string, statement: typeof synthesisStatements.$inferSelect, revision: typeof synthesisRevisions.$inferSelect, rawRows: Record<string, unknown>[], evidenceByRevision: Map<string, ReturnType<typeof mapEvidence>[]>) {
    const supports = rawRows.map((row) => ({
      projectId, synthesisRevisionId: revision.id, extractionRevisionId: String(row.extraction_revision_id), createdAt: row.support_created_at as Date,
      extractionRevision: mapExtractionRevision(row, evidenceByRevision.get(String(row.revision_id)) ?? []), paper: mapPaper(row), field: mapField(row),
      isCurrentExtractionRevision: !Boolean(row.has_newer_revision),
    }));
    return {
      ...revision, statement, supports,
      supportStatus: supports.length ? "supported" as const : "unsupported" as const,
      supportingRevisionCount: supports.length,
      supportingPaperCount: new Set(supports.map((support) => support.paper.id)).size,
      supportingFieldCount: new Set(supports.map((support) => support.field.id)).size,
    };
  }

  async function synthesisViewsForRevisions(projectId: string, statements: Map<string, typeof synthesisStatements.$inferSelect>, revisions: (typeof synthesisRevisions.$inferSelect)[]) {
    const rawRows = (await synthesisSupportRepo.listWithProvenanceForRevisions(projectId, revisions.map((revision) => revision.id))) as unknown as Record<string, unknown>[];
    const evidenceRows = (await synthesisSupportRepo.listEvidenceForRevisions(projectId, rawRows.map((row) => String(row.revision_id)))) as unknown as Record<string, unknown>[];
    const evidenceByRevision = new Map<string, ReturnType<typeof mapEvidence>[]>();
    for (const row of evidenceRows) {
      const id = String(row.revision_id);
      const list = evidenceByRevision.get(id) ?? [];
      list.push(mapEvidence(row)); evidenceByRevision.set(id, list);
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

    async createSynthesisStatement(projectId: string, input: SynthesisRevisionInput) {
      await requireProject(projectId);
      const values = validate(synthesisRevisionInputSchema, input);
      const ids = values.extractionRevisionIds ?? [];
      return db.transaction(async (tx) => {
        const statementRows = await tx.insert(synthesisStatements).values({ projectId }).returning();
        const statement = statementRows[0];
        await synthesisStatementRepo.findForUpdate(tx, projectId, statement.id);
        await validateSynthesisSupports(projectId, ids, tx);
        const draft = await synthesisRevisionRepo.createDraft(tx, {
          projectId, synthesisStatementId: statement.id, state: "active", title: values.title ?? null,
          statementText: values.statementText, researcherNote: values.researcherNote ?? null,
        });
        await synthesisSupportRepo.createMany(tx, projectId, draft.id, ids);
        const finalized = await synthesisRevisionRepo.finalize(tx, projectId, draft.id);
        if (!finalized) throw new DomainError("DATABASE_CONSTRAINT", "Synthesis revision could not be finalized");
        return { statement, revision: finalized };
      });
    },

    async reviseSynthesisStatement(projectId: string, statementId: string, input: SynthesisRevisionInput) {
      await requireProject(projectId); ensureId(statementId);
      const values = validate(synthesisRevisionInputSchema, input);
      const ids = values.extractionRevisionIds ?? [];
      const result = await db.transaction(async (tx) => {
        const statement = await synthesisStatementRepo.findForUpdate(tx, projectId, statementId);
        if (!statement) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
        await validateSynthesisSupports(projectId, ids, tx);
        const draft = await synthesisRevisionRepo.createDraft(tx, {
          projectId, synthesisStatementId: statementId, state: "active", title: values.title ?? null,
          statementText: values.statementText, researcherNote: values.researcherNote ?? null,
        });
        await synthesisSupportRepo.createMany(tx, projectId, draft.id, ids);
        const finalized = await synthesisRevisionRepo.finalize(tx, projectId, draft.id);
        if (!finalized) throw new DomainError("DATABASE_CONSTRAINT", "Synthesis revision could not be finalized");
        return { statement, revision: finalized };
      });
      return result;
    },

    async withdrawSynthesisStatement(projectId: string, statementId: string, input?: SynthesisWithdrawalInput) {
      await requireProject(projectId); ensureId(statementId);
      const values = validate(synthesisWithdrawalSchema, input ?? {});
      const result = await db.transaction(async (tx) => {
        const statement = await synthesisStatementRepo.findForUpdate(tx, projectId, statementId);
        if (!statement) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
        const currentRows = await tx.select().from(synthesisRevisions).where(and(eq(synthesisRevisions.projectId, projectId), eq(synthesisRevisions.synthesisStatementId, statementId), sql`${synthesisRevisions.finalizedAt} is not null`)).orderBy(sql`${synthesisRevisions.sequence} desc`).limit(1);
        const current = currentRows[0];
        if (current?.state === "withdrawn") return { statement, revision: current, idempotent: true };
        const draft = await synthesisRevisionRepo.createDraft(tx, {
          projectId, synthesisStatementId: statementId, state: "withdrawn", title: current?.title ?? null,
          statementText: null, researcherNote: values.researcherNote ?? null,
        });
        const finalized = await synthesisRevisionRepo.finalize(tx, projectId, draft.id);
        if (!finalized) throw new DomainError("DATABASE_CONSTRAINT", "Synthesis withdrawal could not be finalized");
        return { statement, revision: finalized, idempotent: false };
      });
      return result;
    },

    async getCurrentSynthesis(projectId: string, statementId: string) {
      await requireProject(projectId); ensureId(statementId);
      const statement = await synthesisStatementRepo.findById(projectId, statementId);
      if (!statement) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
      const revision = await synthesisRevisionRepo.current(projectId, statementId);
      return revision ? synthesisView(projectId, statement, revision) : null;
    },

    async getSynthesisHistory(projectId: string, statementId: string) {
      await requireProject(projectId); ensureId(statementId);
      const statement = await synthesisStatementRepo.findById(projectId, statementId);
      if (!statement) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
      const revisions = await synthesisRevisionRepo.history(projectId, statementId);
      return synthesisViewsForRevisions(projectId, new Map([[statement.id, statement]]), revisions);
    },

    async getSynthesisProvenance(projectId: string, statementId: string, revisionId?: string) {
      await requireProject(projectId); ensureId(statementId);
      const statement = await synthesisStatementRepo.findById(projectId, statementId);
      if (!statement) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
      const revision = revisionId ? (ensureId(revisionId), (await synthesisRevisionRepo.history(projectId, statementId)).find((item) => item.id === revisionId) ?? null) : await synthesisRevisionRepo.current(projectId, statementId);
      if (!revision) throw new DomainError("NOT_FOUND", "Synthesis revision was not found");
      return synthesisView(projectId, statement, revision);
    },

    async listProjectSynthesis(projectId: string) {
      await requireProject(projectId);
      const rows = (await synthesisRevisionRepo.listCurrentWithStatements(projectId)) as unknown as Record<string, unknown>[];
      const mapped = rows.map(mapSynthesisRow);
      const statements = new Map(mapped.map(({ statement }) => [statement.id, statement]));
      return synthesisViewsForRevisions(projectId, statements, mapped.map(({ revision }) => revision));
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
      const evidenceByRevision = new Map<string, ReturnType<typeof mapEvidence>[]>();
      for (const evidenceRow of evidenceRows) {
        const id = String(evidenceRow.revision_id); evidenceByRevision.set(id, [...(evidenceByRevision.get(id) ?? []), mapEvidence(evidenceRow)]);
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
