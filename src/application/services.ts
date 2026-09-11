import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { extractionRevisionEvidence, extractionValues, extractionValueRevisions, synthesisStatements, synthesisRevisions, retrievedRecordMatches, fullTextDocuments } from "@/db/schema";
import { DomainError, isConstraintError } from "@/domain/errors";
import {
  claimEvidenceInputSchema,
  createClaimRevisionSchema,
  withdrawClaimSchema,
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
  type CreateClaimRevisionInput,
  type WithdrawClaimInput,
  type CreatePaperInput,
  type CreateProjectInput,
  type RecordEvidenceInput,
  type CreateScreeningCriterionInput,
  type RecordScreeningDecisionInput,
  type CreateExtractionFieldInput,
  type UpdateExtractionFieldInput,
  type CreateExtractionOptionInput,
  type ReviseExtractionValueInput,
  synthesisWithdrawalSchema,
  extractionComparisonFilterSchema,
  type SynthesisRevisionInput,
  type SynthesisWithdrawalInput,
  type ExtractionComparisonFilter,
  createFullTextScreeningCriterionSchema,
  recordFullTextScreeningDecisionSchema,
  recordFullTextRetrievalAttemptSchema,
  type CreateFullTextScreeningCriterionInput,
  type RecordFullTextScreeningDecisionInput,
  type RecordFullTextRetrievalAttemptInput,
} from "@/domain/validation";
import type { EvidenceReviewState, ExtractionFieldType, PaperReviewStatus, ScreeningDecisionValue } from "@/domain/types";
import type { DocumentStorage } from "@/infrastructure/document-storage";
import { derivePaperReviewStatus, isFinallyIncluded } from "@/domain/paper-review";
import {
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
  ClaimRevisionRepository,
  ClaimRevisionSupportRepository,
  FullTextScreeningCriterionRepository,
  FullTextScreeningDecisionRepository,
  FullTextRetrievalAttemptRepository,
  PaperReviewRepository,
} from "./repositories";
import { createManuscriptServices } from "./manuscript-services";
import { createAcquisitionServices } from "./acquisition-services";
import { createDeduplicationServices } from "./deduplication-services";
import { createReviewReportingServices } from "./review-reporting";
import { createFullTextDocumentServices, type FullTextDocumentServices } from "./full-text-document-services";
import {
  createDocumentTextExtractionServices,
  type DocumentTextExtractionParser,
  type DocumentTextExtractionServices,
} from "./document-text-extraction-services";
import { createEvidenceCurationServices, requireEvidenceUsableForNewDirectSupport } from "./evidence-curation-services";
import { createEvidenceSetServices } from "./evidence-set-services";
import { createSynthesisPreparationServices } from "./synthesis-preparation-services";
import {
  writeActiveSynthesisRevision,
  lockExtractionRevisionPapers,
} from "./synthesis-writer";

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

type EvidenceCurationWarning = "never_reviewed" | "needs_review" | "currently_rejected" | null;

function evidenceReviewState(value: string | undefined): EvidenceReviewState {
  return value === "needs_review" || value === "accepted" || value === "rejected" ? value : "unreviewed";
}

function evidenceCurationWarning(state: EvidenceReviewState): EvidenceCurationWarning {
  return state === "unreviewed" ? "never_reviewed" : state === "needs_review" ? "needs_review" : state === "rejected" ? "currently_rejected" : null;
}

function isMissingRelationError(error: unknown, relation: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; relation?: unknown; cause?: unknown; message?: unknown };
    if (String(candidate.code ?? "") === "42P01" && (!candidate.relation || String(candidate.relation) === relation)) return true;
    if (typeof candidate.message === "string" && candidate.message.includes(`relation \"${relation}\" does not exist`)) return true;
    current = candidate.cause;
  }
  return false;
}

type SqlExecutor = Pick<Database, "execute">;
type ReviewTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ClaimSupportSnapshot = {
  kind: "evidence" | "extractionRevision" | "synthesisRevision";
  evidenceId?: string;
  extractionRevisionId?: string;
  synthesisRevisionId?: string;
};

export function createReviewServices(db: Database, options: {
  documentStorage?: DocumentStorage;
  maxDocumentBytes?: number;
  documentTextExtractor?: DocumentTextExtractionParser;
} = {}) {
  const projectRepo = new ProjectRepository(db);
  const paperRepo = new PaperRepository(db);
  const evidenceRepo = new EvidenceRepository(db);
  const claimRepo = new ClaimRepository(db);
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
  const claimRevisionRepo = new ClaimRevisionRepository(db);
  const claimRevisionSupportRepo = new ClaimRevisionSupportRepository(db);
  const fullTextCriterionRepo = new FullTextScreeningCriterionRepository(db);
  const fullTextDecisionRepo = new FullTextScreeningDecisionRepository(db);
  const paperReviewRepo = new PaperReviewRepository(db);
  const fullTextRetrievalRepo = new FullTextRetrievalAttemptRepository(db);

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

  function rowDecision(row: Record<string, unknown> | null | undefined, key: string): ScreeningDecisionValue | null {
    const value = row?.[key];
    return value === "include" || value === "exclude" || value === "maybe" ? value : null;
  }

  function statusFromRow(row: Record<string, unknown> | null | undefined): PaperReviewStatus {
    const retrievalState = row?.full_text_retrieval_state;
    return derivePaperReviewStatus({
      titleAbstractDecision: rowDecision(row, "title_abstract_decision"),
      fullTextDecision: rowDecision(row, "full_text_decision"),
      fullTextRetrievalState: retrievalState === "pending" || retrievalState === "unavailable" || retrievalState === "retrieved" ? retrievalState : "not_sought",
      everRetrieved: Boolean(row?.ever_retrieved),
      hasFullTextRetrievalAttempts: Boolean(row?.has_full_text_retrieval_attempts),
      hasAnalyticalHistory: Boolean(row?.has_analytical_history),
    });
  }

  async function requireFinallyIncludedPaperLocked(tx: ReviewTransaction, projectId: string, paperId: string) {
    const paper = await paperRepo.findForUpdate(tx, projectId, paperId);
    if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
    const status = statusFromRow(await paperReviewRepo.find(projectId, paperId, tx) as Record<string, unknown>);
    if (!isFinallyIncluded(status)) throw new DomainError("VALIDATION_ERROR", "New analytical work is available only for finally included papers");
    return { paper, status };
  }

  async function getPaperReviewStatusFor(projectId: string, paperId: string, tx: ReviewTransaction | Database = db) {
    const row = await paperReviewRepo.find(projectId, paperId, tx);
    if (!row) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
    return statusFromRow(row as unknown as Record<string, unknown>);
  }

  async function listPaperReviewStatusesFor(projectId: string, tx: ReviewTransaction | Database = db) {
    const rows = await paperReviewRepo.list(projectId, tx);
    return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({ paperId: String(row.paper_id), status: statusFromRow(row) }));
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
    const documentId = row.full_text_document_id == null ? null : String(row.full_text_document_id);
    const document = documentId && row.document_original_filename != null ? {
      id: documentId,
      originalFilename: String(row.document_original_filename),
      mediaType: "application/pdf" as const,
      byteSize: Number(row.document_byte_size),
      sha256: String(row.document_sha256),
      createdAt: row.document_created_at as Date,
      archivedAt: row.document_archived_at as Date | null,
    } : null;
    return {
      id: String(row.id), projectId: String(row.project_id), paperId: String(row.paper_id),
      fullTextDocumentId: documentId, document,
      documentTextExtractionId: row.document_text_extraction_id == null ? null : String(row.document_text_extraction_id),
      sourceText: String(row.source_text), pageNumber: Number(row.page_number), note: row.note == null ? null : String(row.note),
      extractionStartOffset: row.extraction_start_offset == null ? null : Number(row.extraction_start_offset),
      extractionEndOffset: row.extraction_end_offset == null ? null : Number(row.extraction_end_offset),
      reviewState: undefined as "unreviewed" | "needs_review" | "accepted" | "rejected" | undefined,
      curationWarning: undefined as "never_reviewed" | "needs_review" | "currently_rejected" | null | undefined,
      createdAt: row.created_at as Date, updatedAt: row.updated_at as Date,
    };
  }

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

  function mapScreeningState(value: unknown) {
    const state = String(value);
    return state === "include" ? "included" : state === "exclude" ? "excluded" : state === "maybe" ? "maybe" : "unscreened";
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
    const mappedEvidenceRows = await enrichEvidenceDocuments(evidenceRows.map(mapEvidence));
    const evidenceByRevision = new Map<string, ReturnType<typeof mapEvidence>[]>();
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

  async function currentClaimRevision(executor: SqlExecutor | ReviewTransaction, projectId: string, claimId: string) {
    const rows = await executor.execute(sql`select id, sequence, project_id, claim_id, state, claim_text, researcher_note, created_at, finalized_at from claim_revisions where project_id=${projectId} and claim_id=${claimId} and finalized_at is not null order by sequence desc limit 1`);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  function mapClaimRevision(row: Record<string, unknown>) {
    return { id: String(row.id ?? row.revision_id), sequence: Number(row.sequence), projectId: String(row.project_id), claimId: String(row.claim_id), lifecycle: String(row.state) as "active" | "withdrawn", claimText: row.claim_text == null ? null : String(row.claim_text), researcherNote: row.researcher_note == null ? null : String(row.researcher_note), createdAt: row.created_at as Date, finalizedAt: row.finalized_at as Date | null };
  }

  async function validateClaimSupports(projectId: string, supports: ClaimSupportSnapshot[], executor: SqlExecutor | ReviewTransaction) {
    const directEvidenceIds = supports
      .filter((support) => support.kind === "evidence")
      .map((support) => String(support.evidenceId))
      .sort();
    for (const evidenceId of directEvidenceIds) {
      await requireEvidenceUsableForNewDirectSupport(executor, projectId, evidenceId);
    }
    for (const support of supports) {
      const id = support.kind === "evidence" ? support.evidenceId : support.kind === "extractionRevision" ? support.extractionRevisionId : support.synthesisRevisionId;
      if (!id) throw new DomainError("VALIDATION_ERROR", "A support target is required");
      ensureId(id);
      if (support.kind === "evidence") {
        const rows = await executor.execute(sql`select id from evidence where project_id=${projectId} and id=${id}`);
        if (!(rows as unknown[]).length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence does not belong to this project");
      } else if (support.kind === "extractionRevision") {
        const rows = await executor.execute(sql`select r.finalized_at, r.value_state,
          coalesce((select sd.decision from screening_decisions sd where sd.project_id=r.project_id and sd.paper_id=r.paper_id and sd.stage='title_abstract' order by sd.sequence desc limit 1), 'unscreened') as screening_state,
          (select fd.decision from full_text_screening_decisions fd where fd.project_id=r.project_id and fd.paper_id=r.paper_id order by fd.sequence desc limit 1) as full_text_state
          from extraction_value_revisions r where r.project_id=${projectId} and r.id=${id}`) as unknown as Record<string, unknown>[];
        if (!rows.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction revision does not belong to this project");
        if (!rows[0].finalized_at) throw new DomainError("VALIDATION_ERROR", "Claim support must use a finalized extraction revision");
        if (String(rows[0].value_state) === "cleared") throw new DomainError("VALIDATION_ERROR", "Cleared extraction revisions cannot support a new claim");
        if (String(rows[0].screening_state) !== "include" || String(rows[0].full_text_state) !== "include") throw new DomainError("VALIDATION_ERROR", "New extraction support is limited to currently finally included papers");
      } else {
        const rows = await executor.execute(sql`select r.finalized_at, r.state, (select current_r.state from synthesis_revisions current_r where current_r.project_id=r.project_id and current_r.synthesis_statement_id=r.synthesis_statement_id and current_r.finalized_at is not null order by current_r.sequence desc limit 1) as current_statement_state from synthesis_revisions r where r.project_id=${projectId} and r.id=${id}`) as unknown as Record<string, unknown>[];
        if (!rows.length) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis revision does not belong to this project");
        if (!rows[0].finalized_at || String(rows[0].state) !== "active") throw new DomainError("VALIDATION_ERROR", "New synthesis support must use a finalized active revision");
        if (String(rows[0].current_statement_state) !== "active") throw new DomainError("VALIDATION_ERROR", "Withdrawn synthesis statements cannot support a new claim");
      }
    }
  }

  async function createClaimRevisionSnapshot(projectId: string, claimId: string, input: CreateClaimRevisionInput, tx: ReviewTransaction) {
    const values = validate(createClaimRevisionSchema, input);
    const supports = (values.supports ?? []) as ClaimSupportSnapshot[];
    await lockExtractionRevisionPapers(tx, projectId, supports.filter((support) => support.kind === "extractionRevision").map((support) => String(support.extractionRevisionId)), paperRepo);
    const locked = await claimRevisionRepo.findForUpdate(tx, projectId, claimId);
    if (!locked) throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim does not belong to this project");
    const current = await currentClaimRevision(tx, projectId, claimId);
    if (values.expectedCurrentRevisionId !== undefined && (values.expectedCurrentRevisionId ?? null) !== (current ? String(current.id) : null)) throw new DomainError("VALIDATION_ERROR", "Claim changed while this revision was being prepared");
    await validateClaimSupports(projectId, supports, tx);
    const draft = await claimRevisionRepo.createDraft(tx, { projectId, claimId, state: values.lifecycle ?? "active", claimText: values.claimText ?? null, researcherNote: values.researcherNote ?? null });
    if (!draft) throw new DomainError("DATABASE_CONSTRAINT", "Claim revision could not be created");
    for (const support of supports) {
      if (support.kind === "evidence") await claimRevisionSupportRepo.createEvidence(tx, { projectId, claimRevisionId: String(draft.id), evidenceId: String(support.evidenceId) });
      else if (support.kind === "extractionRevision") await claimRevisionSupportRepo.createExtraction(tx, { projectId, claimRevisionId: String(draft.id), extractionRevisionId: String(support.extractionRevisionId) });
      else await claimRevisionSupportRepo.createSynthesis(tx, { projectId, claimRevisionId: String(draft.id), synthesisRevisionId: String(support.synthesisRevisionId) });
    }
    const finalized = await claimRevisionRepo.finalize(tx, projectId, String(draft.id));
    if (!finalized) throw new DomainError("DATABASE_CONSTRAINT", "Claim revision could not be finalized");
    return mapClaimRevision(finalized);
  }

  async function claimRevisionView(projectId: string, revisionRow: Record<string, unknown>) {
    const revision = mapClaimRevision(revisionRow);
    const raw = await claimRevisionSupportRepo.listForRevision(projectId, revision.id);
    const directEvidence = await enrichEvidenceDocuments(raw.evidence.map((row) => mapEvidence(row)));
    const direct = raw.evidence.map((row, index) => ({
      projectId, claimRevisionId: revision.id, evidenceId: String(row.evidence_id), createdAt: row.support_created_at as Date,
      evidence: { evidence: directEvidence[index], paper: mapPaper(row) },
    }));
    const extractionIds = raw.extraction.map((row) => String(row.revision_id));
    const extractionEvidenceRows = extractionIds.length ? await db.execute(sql`
      select x.revision_id, e.*
      from extraction_revision_evidence x join evidence e on e.project_id=x.project_id and e.paper_id=x.paper_id and e.id=x.evidence_id
      where x.project_id=${projectId} and x.revision_id in (${sql.join(extractionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by x.revision_id, e.page_number, e.created_at
    `) as unknown as Record<string, unknown>[] : [];
    const mappedExtractionEvidence = await enrichEvidenceDocuments(extractionEvidenceRows.map(mapEvidence));
    const evidenceByRevision = new Map<string, ReturnType<typeof mapEvidence>[]>();
    for (let i = 0; i < extractionEvidenceRows.length; i += 1) {
      const row = extractionEvidenceRows[i];
      evidenceByRevision.set(String(row.revision_id), [...(evidenceByRevision.get(String(row.revision_id)) ?? []), mappedExtractionEvidence[i]]);
    }
    const extraction = raw.extraction.map((row) => ({
      projectId, claimRevisionId: revision.id, extractionRevisionId: String(row.revision_id), createdAt: row.support_created_at as Date,
      extractionRevision: mapExtractionRevision(row, evidenceByRevision.get(String(row.revision_id)) ?? []), paper: mapPaper(row), field: mapField(row),
      isCurrentExtractionRevision: Boolean(row.is_current_extraction_revision), paperScreeningState: mapScreeningState(row.screening_state) as "unscreened" | "included" | "excluded" | "maybe",
    }));
    const synthesisIds = raw.synthesis.map((row) => String(row.revision_id));
    const synthesisRows = synthesisIds.length ? await db.execute(sql`
      select r.id, r.sequence, r.project_id, r.synthesis_statement_id, r.state, r.title, r.statement_text, r.researcher_note, r.created_at, r.finalized_at,
        s.created_at as statement_created_at,
        (select current_r.state from synthesis_revisions current_r where current_r.project_id=r.project_id and current_r.synthesis_statement_id=r.synthesis_statement_id and current_r.finalized_at is not null order by current_r.sequence desc limit 1) as current_statement_state
      from synthesis_revisions r join synthesis_statements s on s.project_id=r.project_id and s.id=r.synthesis_statement_id
      where r.project_id=${projectId} and r.id in (${sql.join(synthesisIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `) as unknown as Record<string, unknown>[] : [];
    const synthesisById = new Map(synthesisRows.map((row) => [String(row.id), row]));
    const statementMap = new Map(synthesisRows.map((row) => [String(row.synthesis_statement_id), { id: String(row.synthesis_statement_id), projectId, createdAt: row.statement_created_at as Date } as typeof synthesisStatements.$inferSelect]));
    const synthesisViews = await synthesisViewsForRevisions(projectId, statementMap, synthesisRows.map((row) => ({ id: String(row.id), sequence: Number(row.sequence), projectId, synthesisStatementId: String(row.synthesis_statement_id), state: String(row.state) as "active" | "withdrawn", title: row.title as string | null, statementText: row.statement_text as string | null, researcherNote: row.researcher_note as string | null, createdAt: row.created_at as Date, finalizedAt: row.finalized_at as Date | null })));
    const synthesisViewById = new Map(synthesisViews.map((view) => [view.id, view]));
    const synthesis = raw.synthesis.map((row) => {
      const item = synthesisById.get(String(row.revision_id));
      const view = synthesisViewById.get(String(row.revision_id));
      if (!item || !view) throw new DomainError("DATABASE_CONSTRAINT", "Synthesis provenance is inconsistent");
      return { projectId, claimRevisionId: revision.id, synthesisRevisionId: String(row.revision_id), createdAt: row.support_created_at as Date, synthesisRevision: view, statement: statementMap.get(String(item.synthesis_statement_id)), isCurrentSynthesisRevision: Boolean(row.is_current_synthesis_revision), statementLifecycle: String(row.current_statement_state ?? item.state) as "active" | "withdrawn" };
    });
    const paperPaths = new Map<string, { paper: ReturnType<typeof mapPaper>; pathCount: number; kinds: Set<"evidence" | "extractionRevision" | "synthesisRevision">; paths: string[] }>();
    const addPath = (paper: ReturnType<typeof mapPaper>, kind: "evidence" | "extractionRevision" | "synthesisRevision", targetId: string) => {
      const existing = paperPaths.get(paper.id);
      if (existing) { existing.pathCount += 1; existing.kinds.add(kind); existing.paths.push(`${kind}:${targetId}`); } else paperPaths.set(paper.id, { paper, pathCount: 1, kinds: new Set([kind]), paths: [`${kind}:${targetId}`] });
    };
    for (const item of direct) addPath(item.evidence.paper, "evidence", item.evidenceId);
    for (const item of extraction) {
      const paper = item.paper;
      for (let i = 0; i < item.extractionRevision.evidence.length; i += 1) addPath(paper, "extractionRevision", item.extractionRevisionId);
    }
    for (const item of synthesis) {
      for (const support of item.synthesisRevision.supports) {
        for (let i = 0; i < support.extractionRevision.evidence.length; i += 1) addPath(support.paper, "synthesisRevision", item.synthesisRevisionId);
      }
    }
    const citationCandidates = [...paperPaths.values()].map((item) => ({ paper: item.paper, pathCount: item.pathCount, supportKinds: [...item.kinds], paths: item.paths }));
    return {
      ...revision, supportStatus: revision.lifecycle === "active" && (direct.length + extraction.length + synthesis.length) > 0 ? "supported" as const : "unsupported" as const,
      supports: { evidence: direct, extractionRevisions: extraction, synthesisRevisions: synthesis },
      totalSupportCount: direct.length + extraction.length + synthesis.length, directEvidenceCount: direct.length,
      extractionRevisionCount: extraction.length, synthesisRevisionCount: synthesis.length,
      distinctPaperCount: new Set([...direct.map((item) => item.evidence.paper.id), ...extraction.map((item) => item.paper.id), ...synthesis.flatMap((item) => item.synthesisRevision.supports.map((support) => support.paper.id))]).size,
      citationCandidateCount: citationCandidates.length, citationCandidates,
    };
  }

  async function synthesisView(projectId: string, statement: typeof synthesisStatements.$inferSelect, revision: typeof synthesisRevisions.$inferSelect) {
    return (await synthesisViewsForRevisions(projectId, new Map([[statement.id, statement]]), [revision]))[0];
  }

  const services = {
    async createProject(input: CreateProjectInput) {
      const values = validate(createProjectSchema, input);
      return projectRepo.create({ title: values.title, description: values.description ?? null });
    },

    getProject(projectId: string) { return requireProject(projectId); },
    listPapers(projectId: string) { return requireProject(projectId).then(() => paperRepo.list(projectId)); },
    getPaper(projectId: string, paperId: string) { return requirePaper(projectId, paperId); },
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
    async listClaims(projectId: string) {
      await requireProject(projectId);
      const rows = await claimRevisionRepo.listCurrent(projectId);
      return Promise.all(rows.map(async (row) => {
        const revision = await claimRevisionView(projectId, { id: row.revision_id, sequence: row.sequence, project_id: row.project_id, claim_id: row.claim_id, state: row.state, claim_text: row.claim_text, researcher_note: row.researcher_note, created_at: row.created_at, finalized_at: row.finalized_at });
        const claim = { id: String(row.claim_id), projectId, claimText: revision.claimText ?? "", createdAt: row.claim_created_at as Date, updatedAt: row.claim_created_at as Date };
        return { ...claim, claim, currentRevision: revision, lifecycle: revision.lifecycle, supportStatus: revision.supportStatus, citationCandidateCount: revision.citationCandidateCount, distinctPaperCount: revision.distinctPaperCount };
      }));
    },
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
        reviewStatus: await getPaperReviewStatusFor(projectId, paperId),
      };
    },

    async listScreeningPapers(projectId: string, state?: "unscreened" | "included" | "excluded" | "maybe") {
      await requireProject(projectId);
      const papersWithState = await decisionRepo.listPapersWithCurrentState(projectId);
      return state ? papersWithState.filter((paper) => paper.screeningState === state) : papersWithState;
    },

    async recordScreeningDecision(projectId: string, paperId: string, input: RecordScreeningDecisionInput) {
      await requireProject(projectId);
      const values = validate(recordScreeningDecisionSchema, input);
      return db.transaction(async (tx) => {
        const paper = await paperRepo.findForUpdate(tx, projectId, paperId);
        if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
        let exclusionCriterionId: string | null = null;
        let exclusionCriterionType: "exclusion" | null = null;
        if (values.decision === "exclude") {
          const criterion = await criterionRepo.findById(projectId, values.exclusionCriterionId, tx);
          if (!criterion) throw new DomainError("CROSS_PROJECT_REFERENCE", "Criterion does not belong to this project");
          if (criterion.type !== "exclusion") throw new DomainError("VALIDATION_ERROR", "Exclude decisions require an exclusion criterion");
          if (criterion.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived criteria cannot be used for new decisions");
          exclusionCriterionId = criterion.id;
          exclusionCriterionType = "exclusion";
        }
        try {
          return await decisionRepo.create({
            projectId, paperId, stage: "title_abstract", decision: values.decision,
            exclusionCriterionId, exclusionCriterionType, note: values.note ?? null,
          }, tx);
        } catch (error) {
          if (isConstraintError(error)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Screening references an invalid project record");
          throw error;
        }
      });
    },

    async listFullTextScreeningCriteria(projectId: string, includeArchived = false) {
      await requireProject(projectId);
      return fullTextCriterionRepo.list(projectId, includeArchived);
    },

    async createFullTextScreeningCriterion(projectId: string, input: CreateFullTextScreeningCriterionInput) {
      await requireProject(projectId);
      const values = validate(createFullTextScreeningCriterionSchema, input);
      return fullTextCriterionRepo.create({ projectId, text: values.text });
    },

    async archiveFullTextScreeningCriterion(projectId: string, criterionId: string) {
      await requireProject(projectId);
      ensureId(criterionId);
      const criterion = await fullTextCriterionRepo.findById(projectId, criterionId);
      if (!criterion) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text criterion does not belong to this project");
      if (criterion.archivedAt) return criterion;
      const archived = await fullTextCriterionRepo.archive(projectId, criterionId);
      return archived[0] ?? criterion;
    },

    async getPaperReviewStatus(projectId: string, paperId: string) {
      await requirePaper(projectId, paperId);
      return getPaperReviewStatusFor(projectId, paperId);
    },

    async listPaperReviewStatuses(projectId: string) {
      await requireProject(projectId);
      return listPaperReviewStatusesFor(projectId);
    },

    async getPaperFullTextRetrieval(projectId: string, paperId: string) {
      const paper = await requirePaper(projectId, paperId);
      const [currentAttempt, history, reviewStatus] = await Promise.all([
        fullTextRetrievalRepo.currentForPaper(projectId, paperId),
        fullTextRetrievalRepo.listForPaper(projectId, paperId),
        getPaperReviewStatusFor(projectId, paperId),
      ]);
      return { paper, currentState: reviewStatus.fullTextRetrievalState, everRetrieved: reviewStatus.everRetrieved, currentAttempt, history, reviewStatus };
    },

    async listFullTextRetrievalHistory(projectId: string, paperId: string) {
      await requirePaper(projectId, paperId);
      return fullTextRetrievalRepo.listForPaper(projectId, paperId);
    },

    async listFullTextRetrievalQueue(projectId: string, state?: "not_sought" | "pending" | "unavailable" | "retrieved" | "conflict") {
      await requireProject(projectId);
      const [papers, statuses] = await Promise.all([paperRepo.list(projectId), listPaperReviewStatusesFor(projectId)]);
      const statusByPaperId = new Map(statuses.map((item) => [item.paperId, item.status]));
      return papers.map((paper) => ({ paper, reviewStatus: statusByPaperId.get(paper.id)! })).filter(({ reviewStatus }) => {
        if (state === "conflict") return reviewStatus.warnings.includes("retrieval_history_without_current_title_abstract_inclusion");
        if (reviewStatus.titleAbstractState !== "included") return false;
        return state ? reviewStatus.fullTextRetrievalState === state : true;
      });
    },

    async recordFullTextRetrievalAttempt(projectId: string, paperId: string, input: RecordFullTextRetrievalAttemptInput) {
      await requireProject(projectId);
      const values = validate(recordFullTextRetrievalAttemptSchema, input);
      return db.transaction(async (tx) => {
        const paper = await paperRepo.findForUpdate(tx, projectId, paperId);
        if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
        const currentTa = await decisionRepo.currentForPaper(projectId, paperId, tx);
        if (!currentTa || currentTa.decision !== "include") throw new DomainError("VALIDATION_ERROR", "Full-text retrieval requires a current title/abstract include decision");
        try {
          return await fullTextRetrievalRepo.create({
            projectId,
            paperId,
            outcome: values.outcome,
            method: values.method ?? null,
            sourceReference: values.sourceReference ?? null,
            note: values.note ?? null,
            attemptedAt: values.attemptedAt,
          }, tx);
        } catch (error) {
          if (isConstraintError(error)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text retrieval references an invalid project record");
          throw error;
        }
      });
    },

    async getPaperFullTextScreening(projectId: string, paperId: string) {
      const paper = await requirePaper(projectId, paperId);
      const [criteria, currentDecision, decisions, reviewStatus, retrievalCurrent, retrievalHistory] = await Promise.all([
        fullTextCriterionRepo.list(projectId), fullTextDecisionRepo.currentForPaper(projectId, paperId), fullTextDecisionRepo.listForPaper(projectId, paperId), getPaperReviewStatusFor(projectId, paperId), fullTextRetrievalRepo.currentForPaper(projectId, paperId), fullTextRetrievalRepo.listForPaper(projectId, paperId),
      ]);
      const history = await Promise.all(decisions.map(async (decision) => ({
        ...decision,
        exclusionCriterion: decision.exclusionCriterionId ? await fullTextCriterionRepo.findById(projectId, decision.exclusionCriterionId) : null,
      })));
      return { paper, criteria, currentState: reviewStatus.fullTextState, currentDecision, history, reviewStatus, retrievalCurrent, retrievalHistory };
    },

    async listFullTextScreeningQueue(projectId: string, state?: "awaiting" | "included" | "excluded" | "maybe" | "conflict") {
      await requireProject(projectId);
      const [papers, statuses] = await Promise.all([paperRepo.list(projectId), listPaperReviewStatusesFor(projectId)]);
      const statusByPaperId = new Map(statuses.map((item) => [item.paperId, item.status]));
      const queue = papers.map((paper) => ({ paper, reviewStatus: statusByPaperId.get(paper.id)! })).filter((item) => {
        const { reviewStatus } = item;
        const retrievalHistoryConflict = reviewStatus.warnings.includes("retrieval_history_without_current_title_abstract_inclusion");
        if (state === "conflict") return reviewStatus.crossStageConflict || retrievalHistoryConflict;
        if (state === "awaiting") return reviewStatus.finalEligibility === "pending_full_text";
        if (state === "included") return reviewStatus.finalEligibility === "included";
        if (state === "excluded") return reviewStatus.finalEligibility === "excluded";
        if (state === "maybe") return reviewStatus.finalEligibility === "unresolved_full_text";
        return reviewStatus.titleAbstractState === "included" || reviewStatus.crossStageConflict || retrievalHistoryConflict;
      });
      return queue;
    },

    async recordFullTextScreeningDecision(projectId: string, paperId: string, input: RecordFullTextScreeningDecisionInput) {
      await requireProject(projectId);
      const values = validate(recordFullTextScreeningDecisionSchema, input);
      return db.transaction(async (tx) => {
        const paper = await paperRepo.findForUpdate(tx, projectId, paperId);
        if (!paper) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
        const currentTa = await decisionRepo.currentForPaper(projectId, paperId, tx);
        if (!currentTa || currentTa.decision !== "include") throw new DomainError("VALIDATION_ERROR", "Full-text screening requires a current title/abstract include decision");
        const currentRetrieval = await fullTextRetrievalRepo.currentForPaper(projectId, paperId, tx);
        if (!currentRetrieval || currentRetrieval.outcome !== "retrieved") throw new DomainError("VALIDATION_ERROR", "Full-text screening requires a current retrieved full-text retrieval attempt");
        let exclusionCriterionId: string | null = null;
        if (values.decision === "exclude") {
          const criterion = await fullTextCriterionRepo.findById(projectId, values.exclusionCriterionId, tx);
          if (!criterion) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text criterion does not belong to this project");
          if (criterion.archivedAt) throw new DomainError("VALIDATION_ERROR", "Archived full-text criteria cannot be used for new decisions");
          exclusionCriterionId = criterion.id;
        }
        try {
          return await fullTextDecisionRepo.create({ projectId, paperId, decision: values.decision, exclusionCriterionId, note: values.note ?? null }, tx);
        } catch (error) {
          if (isConstraintError(error)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text screening references an invalid project record");
          throw error;
        }
      });
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
      await requireProject(projectId);
      return db.transaction(async (tx) => {
        await requireFinallyIncludedPaperLocked(tx, projectId, paperId);
        const field = await requireExtractionField(projectId, fieldId, false);
        const values = validate(reviseExtractionValueSchema, input);
        const payload = typedRevisionPayload(field.fieldType as ExtractionFieldType, values);
        const evidenceIds = [...new Set(values.evidenceIds ?? [])];
        if (evidenceIds.length !== (values.evidenceIds ?? []).length) throw new DomainError("VALIDATION_ERROR", "Evidence cannot be repeated in one revision");
        for (const evidenceId of [...evidenceIds].sort()) {
          await requireEvidenceUsableForNewDirectSupport(tx, projectId, evidenceId);
        }
        if (payload.optionId) {
          const option = await extractionOptionRepo.findById(projectId, payload.optionId);
          if (!option || option.fieldId !== field.id || option.archivedAt) throw new DomainError("CROSS_PROJECT_REFERENCE", "Option does not belong to this active extraction field");
        }
        const evidenceItems = await Promise.all(evidenceIds.map((id) => requireEvidence(projectId, id)));
        if (evidenceItems.some((item) => item.paperId !== paperId)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence must belong to the same paper as the extraction value");
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

    async createSynthesisStatement(projectId: string, input: SynthesisRevisionInput) {
      await requireProject(projectId);
      return db.transaction(async (tx) => {
        const { statement, revision } = await writeActiveSynthesisRevision(
          tx,
          projectId,
          { kind: "new" },
          input,
          { paperRepo, synthesisStatementRepo, synthesisRevisionRepo, synthesisSupportRepo },
        );
        return { statement, revision };
      });
    },

    async reviseSynthesisStatement(projectId: string, statementId: string, input: SynthesisRevisionInput) {
      await requireProject(projectId);
      ensureId(statementId);
      return db.transaction(async (tx) => {
        const { statement, revision } = await writeActiveSynthesisRevision(
          tx,
          projectId,
          { kind: "existing", statementId },
          input,
          { paperRepo, synthesisStatementRepo, synthesisRevisionRepo, synthesisSupportRepo },
        );
        return { statement, revision };
      });
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

    async listClaimSupportOptions(projectId: string) {
      await requireProject(projectId);
      const [papers, evidence, extractionRows, synthesisRows] = await Promise.all([
        paperRepo.list(projectId), evidenceRepo.list(projectId),
        db.execute(sql`
          select r.id as revision_id, r.sequence as revision_sequence, r.project_id, r.paper_id, r.field_id, r.extraction_value_id,
            r.field_type, r.value_state, r.text_value, r.number_value, r.boolean_value, r.option_id, r.researcher_note as revision_note,
            r.created_at as revision_created_at, r.finalized_at as revision_finalized_at,
            p.id as paper_id_value, p.title as paper_title, p.authors, p.publication_year, p.venue, p.doi, p.abstract, p.bibliographic_note,
            p.created_at as paper_created_at, p.updated_at as paper_updated_at,
            f.id as field_id_value, f.name as field_name, f.description as field_description, f.field_type as field_type_value,
            f.required, f.sort_order, f.created_at as field_created_at, f.updated_at as field_updated_at, f.archived_at as field_archived_at,
            coalesce((select sd.decision from screening_decisions sd where sd.project_id=r.project_id and sd.paper_id=r.paper_id and sd.stage='title_abstract' order by sd.sequence desc limit 1), 'unscreened') as screening_state,
            (select fd.decision from full_text_screening_decisions fd where fd.project_id=r.project_id and fd.paper_id=r.paper_id order by fd.sequence desc limit 1) as full_text_state
          from extraction_value_revisions r join papers p on p.project_id=r.project_id and p.id=r.paper_id
          join extraction_fields f on f.project_id=r.project_id and f.id=r.field_id
          where r.project_id=${projectId} and r.finalized_at is not null and r.value_state <> 'cleared'
            and coalesce((select sd.decision from screening_decisions sd where sd.project_id=r.project_id and sd.paper_id=r.paper_id and sd.stage='title_abstract' order by sd.sequence desc limit 1), 'unscreened')='include'
            and (select fd.decision from full_text_screening_decisions fd where fd.project_id=r.project_id and fd.paper_id=r.paper_id order by fd.sequence desc limit 1)='include'
          order by r.sequence desc
        `) as unknown as Record<string, unknown>[],
        synthesisRevisionRepo.list(projectId),
      ]);
      const paperById = new Map(papers.map((paper) => [paper.id, paper]));
      const currentReviewRows = await currentEvidenceReviewRows(projectId);
      const currentReviewByEvidenceId = new Map(currentReviewRows.map((row) => [String(row.evidence_id), String(row.decision)]));
      const evidenceOptions = evidence
        .filter((item) => currentReviewByEvidenceId.get(item.id) !== "rejected")
        .map((item) => ({
          ...item,
          paper: paperById.get(item.paperId) ?? null,
          reviewState: evidenceReviewState(currentReviewByEvidenceId.get(item.id)),
          curationWarning: evidenceCurationWarning(evidenceReviewState(currentReviewByEvidenceId.get(item.id))),
        }));
      const extractionIds = extractionRows.map((row) => String(row.revision_id));
      const extractionEvidenceRows = extractionIds.length ? await db.execute(sql`select l.revision_id, e.*
        from extraction_revision_evidence l join evidence e on e.project_id=l.project_id and e.id=l.evidence_id
        where l.project_id=${projectId} and l.revision_id in (${sql.join(extractionIds.map((id) => sql`${id}::uuid`), sql`, `)}) order by l.revision_id, e.page_number`) as unknown as Record<string, unknown>[] : [];
      const mappedExtractionEvidence = await enrichEvidenceDocuments(extractionEvidenceRows.map(mapEvidence));
      const extractionEvidenceById = new Map<string, ReturnType<typeof mapEvidence>[]>();
      for (let i = 0; i < extractionEvidenceRows.length; i += 1) {
        const row = extractionEvidenceRows[i];
        extractionEvidenceById.set(String(row.revision_id), [...(extractionEvidenceById.get(String(row.revision_id)) ?? []), mappedExtractionEvidence[i]]);
      }
      const extractionOptions = extractionRows.map((row) => ({ ...mapExtractionRevision(row, extractionEvidenceById.get(String(row.revision_id)) ?? []), paper: mapPaper(row), field: mapField(row), paperScreeningState: mapScreeningState(row.screening_state) }));
      const statementRows = synthesisRows.length ? await db.execute(sql`select id, project_id, created_at from synthesis_statements where project_id=${projectId} and id in (${sql.join(synthesisRows.map((row) => sql`${row.synthesisStatementId}::uuid`), sql`, `)})`) as unknown as typeof synthesisStatements.$inferSelect[] : [];
      const statementMap = new Map(statementRows.map((statement) => [statement.id, statement]));
      const activeStatementRows = await db.execute(sql`select distinct on (synthesis_statement_id) synthesis_statement_id, state from synthesis_revisions where project_id=${projectId} and finalized_at is not null order by synthesis_statement_id, sequence desc`) as unknown as Record<string, unknown>[];
      const activeStatementIds = new Set(activeStatementRows.filter((row) => String(row.state) === "active").map((row) => String(row.synthesis_statement_id)));
      const syntheses = (await synthesisViewsForRevisions(projectId, statementMap, synthesisRows)).filter((view) => view.state === "active" && activeStatementIds.has(view.synthesisStatementId));
      return { evidence: evidenceOptions, extraction: extractionOptions, synthesis: syntheses };
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

    async addPaper(projectId: string, input: CreatePaperInput) {
      await requireProject(projectId);
      const values = validate(createPaperSchema, input);
      return paperRepo.create({ projectId, ...values, publicationYear: values.publicationYear ?? null, venue: values.venue ?? null, doi: values.doi ?? null, abstract: values.abstract ?? null, bibliographicNote: values.bibliographicNote ?? null });
    },

    async recordEvidence(projectId: string, input: RecordEvidenceInput) {
      const values = validate(recordEvidenceSchema, input);
      await requirePaper(projectId, values.paperId);
      if (values.fullTextDocumentId) {
        const document = await db.select({ id: fullTextDocuments.id, paperId: fullTextDocuments.paperId, archivedAt: fullTextDocuments.archivedAt })
          .from(fullTextDocuments)
          .where(and(eq(fullTextDocuments.projectId, projectId), eq(fullTextDocuments.id, values.fullTextDocumentId))).limit(1);
        if (!document[0] || document[0].paperId !== values.paperId) throw new DomainError("CROSS_PROJECT_REFERENCE", "Full-text document does not belong to this Paper");
        if (document[0].archivedAt) throw new DomainError("DOCUMENT_ARCHIVED", "New Evidence cannot reference an archived full-text document");
      }
      return evidenceRepo.create({ projectId, ...values, fullTextDocumentId: values.fullTextDocumentId ?? null, note: values.note ?? null });
    },

    async createClaim(projectId: string, input: CreateClaimInput) {
      await requireProject(projectId);
      const values = validate(createClaimSchema, input);
      const result = await db.transaction(async (tx) => {
        const claim = await claimRevisionRepo.createClaim(tx, projectId);
        if (!claim) throw new DomainError("DATABASE_CONSTRAINT", "Claim could not be created");
        const revision = await createClaimRevisionSnapshot(projectId, String(claim.id), { lifecycle: "active", claimText: values.claimText, researcherNote: values.researcherNote ?? null, supports: [] }, tx);
        return { claim, revision };
      });
      return { id: String(result.claim.id), projectId, claimText: values.claimText, createdAt: result.claim.created_at as Date, updatedAt: result.claim.created_at as Date, claim: { id: String(result.claim.id), projectId, claimText: values.claimText, createdAt: result.claim.created_at as Date, updatedAt: result.claim.created_at as Date }, revision: result.revision };
    },

    async createClaimRevision(projectId: string, claimId: string, input: CreateClaimRevisionInput) {
      await requireProject(projectId); ensureId(claimId);
      const revision = await db.transaction((tx) => createClaimRevisionSnapshot(projectId, claimId, input, tx));
      return this.getClaimRevision(projectId, claimId, revision.id);
    },

    async withdrawClaim(projectId: string, claimId: string, input?: WithdrawClaimInput) {
      await requireProject(projectId); ensureId(claimId);
      const values = validate(withdrawClaimSchema, input ?? {});
      const result = await db.transaction(async (tx) => {
        const locked = await claimRevisionRepo.findForUpdate(tx, projectId, claimId);
        if (!locked) throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim does not belong to this project");
        const current = await currentClaimRevision(tx, projectId, claimId);
        if (values.expectedCurrentRevisionId !== undefined && (values.expectedCurrentRevisionId ?? null) !== (current ? String(current.id) : null)) throw new DomainError("VALIDATION_ERROR", "Claim changed while withdrawal was being prepared");
        if (current && String(current.state) === "withdrawn" && (current.researcher_note ?? null) === (values.researcherNote ?? null)) return mapClaimRevision(current);
        return createClaimRevisionSnapshot(projectId, claimId, { lifecycle: "withdrawn", claimText: null, researcherNote: values.researcherNote ?? null, supports: [], expectedCurrentRevisionId: current ? String(current.id) : null }, tx);
      });
      return this.getClaimRevision(projectId, claimId, result.id);
    },

    async reactivateClaim(projectId: string, claimId: string, input: CreateClaimRevisionInput) {
      const values = { ...input, lifecycle: "active" as const };
      return this.createClaimRevision(projectId, claimId, values);
    },

    async getCurrentClaim(projectId: string, claimId: string) {
      await requireProject(projectId); ensureId(claimId);
      const claim = await requireClaim(projectId, claimId);
      const revision = await currentClaimRevision(db, projectId, claimId);
      if (!revision) throw new DomainError("NOT_FOUND", "Claim has no finalized revision");
      return { claim: { ...claim, claimText: revision.claim_text == null ? "" : String(revision.claim_text) }, currentRevision: await claimRevisionView(projectId, revision) };
    },

    async getClaimRevision(projectId: string, claimId: string, revisionId: string) {
      await requireProject(projectId); ensureId(claimId); ensureId(revisionId);
      const claim = await requireClaim(projectId, claimId);
      const rows = await db.execute(sql`select id, sequence, project_id, claim_id, state, claim_text, researcher_note, created_at, finalized_at from claim_revisions where project_id=${projectId} and claim_id=${claimId} and id=${revisionId} and finalized_at is not null`) as unknown as Record<string, unknown>[];
      if (!rows.length) throw new DomainError("NOT_FOUND", "Claim revision was not found");
      return { claim: { ...claim, claimText: rows[0].claim_text == null ? "" : String(rows[0].claim_text) }, revision: await claimRevisionView(projectId, rows[0]) };
    },

    async getClaimHistory(projectId: string, claimId: string) {
      await requireProject(projectId); ensureId(claimId);
      const claim = await requireClaim(projectId, claimId);
      const rows = await claimRevisionRepo.history(projectId, claimId);
      return { claim, revisions: await Promise.all(rows.map((row) => claimRevisionView(projectId, row))) };
    },

    async linkEvidenceToClaim(projectId: string, input: { claimId: string; evidenceId: string }) {
      const values = validate(claimEvidenceInputSchema, input);
      await requireEvidence(projectId, values.evidenceId);
      try {
        const current = await this.getCurrentClaim(projectId, values.claimId);
        if (current.currentRevision.supports.evidence.some((item) => item.evidenceId === values.evidenceId)) {
          throw new DomainError("DUPLICATE_LINK", "Evidence is already linked to this claim");
        }
        const supports = [
          ...current.currentRevision.supports.evidence.map((item) => ({ kind: "evidence" as const, evidenceId: item.evidenceId })),
          ...current.currentRevision.supports.extractionRevisions.map((item) => ({ kind: "extractionRevision" as const, extractionRevisionId: item.extractionRevisionId })),
          ...current.currentRevision.supports.synthesisRevisions.map((item) => ({ kind: "synthesisRevision" as const, synthesisRevisionId: item.synthesisRevisionId })),
          { kind: "evidence" as const, evidenceId: values.evidenceId },
        ];
        return await this.createClaimRevision(projectId, values.claimId, { lifecycle: "active", claimText: current.currentRevision.claimText, researcherNote: current.currentRevision.researcherNote, supports, expectedCurrentRevisionId: current.currentRevision.id });
      } catch (error) {
        if (isConstraintError(error)) throw new DomainError("DUPLICATE_LINK", "Evidence is already linked to this claim");
        throw error;
      }
    },

    async unlinkEvidenceFromClaim(projectId: string, input: { claimId: string; evidenceId: string }) {
      const values = validate(claimEvidenceInputSchema, input);
      await requireEvidence(projectId, values.evidenceId);
      const current = await this.getCurrentClaim(projectId, values.claimId);
      const existing = current.currentRevision.supports.evidence.some((item) => item.evidenceId === values.evidenceId);
      if (!existing) throw new DomainError("NOT_FOUND", "Evidence link was not found");
      const supports = [
        ...current.currentRevision.supports.evidence.filter((item) => item.evidenceId !== values.evidenceId).map((item) => ({ kind: "evidence" as const, evidenceId: item.evidenceId })),
        ...current.currentRevision.supports.extractionRevisions.map((item) => ({ kind: "extractionRevision" as const, extractionRevisionId: item.extractionRevisionId })),
        ...current.currentRevision.supports.synthesisRevisions.map((item) => ({ kind: "synthesisRevision" as const, synthesisRevisionId: item.synthesisRevisionId })),
      ];
      return this.createClaimRevision(projectId, values.claimId, { lifecycle: current.currentRevision.lifecycle, claimText: current.currentRevision.claimText, researcherNote: current.currentRevision.researcherNote, supports, expectedCurrentRevisionId: current.currentRevision.id });
    },

    async deletePaper(projectId: string, paperId: string) {
      await requirePaper(projectId, paperId);
      if (await evidenceRepo.countForPaper(projectId, paperId)) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted while evidence exists");
      if (await decisionRepo.countForPaper(projectId, paperId)) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted after screening decisions exist");
      const acquisitionLinks = await db.select({ id: retrievedRecordMatches.id }).from(retrievedRecordMatches).where(and(eq(retrievedRecordMatches.projectId, projectId), eq(retrievedRecordMatches.paperId, paperId))).limit(1);
      if (acquisitionLinks.length) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted after acquisition history exists");
      try { return await paperRepo.delete(projectId, paperId); }
      catch (error) { if (isConstraintError(error)) throw new DomainError("PROTECTED_DELETE", "Paper cannot be deleted after evidence or screening history exists"); throw error; }
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

    async deleteClaim(projectId: string, claimId: string) {
      await requireClaim(projectId, claimId);
      throw new DomainError("PROTECTED_DELETE", "Claims with revision history cannot be deleted; withdraw the claim instead");
    },

    async getClaimProvenance(projectId: string, claimId: string) {
      const result = await this.getCurrentClaim(projectId, claimId);
      return { claim: result.claim, supportStatus: result.currentRevision.supportStatus, evidence: result.currentRevision.supports.evidence.map((item) => item.evidence) };
    },
  };
  const deduplicationServices = createDeduplicationServices(db);
  const manuscriptServices = createManuscriptServices(db);
  const acquisitionServices = createAcquisitionServices(db);
  const documentServices: FullTextDocumentServices = createFullTextDocumentServices(db, options.documentStorage, options.maxDocumentBytes);
  const baseServices = Object.assign(services, manuscriptServices, acquisitionServices, deduplicationServices, documentServices as unknown as Record<string, unknown>) as typeof services & typeof manuscriptServices & typeof acquisitionServices & typeof deduplicationServices & FullTextDocumentServices;
  const textExtractionParser: DocumentTextExtractionParser = options.documentTextExtractor ?? {
    extractorKey: "unconfigured",
    extractorVersion: "unconfigured",
    algorithmVersion: "unconfigured",
    async extract() {
      throw new DomainError("STORAGE_ERROR", "PDF text extraction is not configured");
    },
  };
  const textExtractionServices: DocumentTextExtractionServices = createDocumentTextExtractionServices(db, {
    storage: options.documentStorage,
    parser: textExtractionParser,
    maxBytes: options.maxDocumentBytes,
  });
  const reportingServices = createReviewReportingServices(db, deduplicationServices);
  const curationServices = createEvidenceCurationServices(db, { requireProject, requireEvidence });
  const evidenceSetServices = createEvidenceSetServices(db, { requireProject, requireEvidence });
  const synthesisPreparationServices = createSynthesisPreparationServices(db, {
    requireProject,
    paperRepo,
    synthesisStatementRepo,
    synthesisRevisionRepo,
    synthesisSupportRepo,
    extractionFieldRepo,
  });
  return Object.assign(
    baseServices,
    textExtractionServices,
    reportingServices,
    curationServices,
    evidenceSetServices,
    synthesisPreparationServices,
  ) as typeof baseServices &
    typeof reportingServices &
    DocumentTextExtractionServices &
    typeof curationServices &
    typeof evidenceSetServices &
    typeof synthesisPreparationServices;
}
