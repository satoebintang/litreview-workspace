import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  synthesisPreparations,
  synthesisPreparationSelections,
  evidenceSets,
  evidenceSetCompositionRevisions,
  synthesisRevisions,
} from "@/db/schema";
import { DomainError } from "@/domain/errors";
import { derivePaperReviewStatus, isFinallyIncluded } from "@/domain/paper-review";
import type {
  SynthesisPreparation,
  SynthesisPreparationSummary,
  SynthesisPreparationWorkspace,
  SynthesisPreparationContext,
  SynthesisCandidate,
  SynthesisCandidateConnectingEvidence,
  SynthesisCandidateWarning,
  ExtractionField,
  SynthesisStatement,
  SynthesisRevision,
  EvidenceReviewState,
  Paper,
  ExtractionRevisionWithEvidence,
  Evidence,
} from "@/domain/types";
import {
  createSynthesisPreparationSchema,
  updateSynthesisPreparationSchema,
  replaceSynthesisPreparationSelectionsSchema,
  finalizeSynthesisPreparationSchema,
  type CreateSynthesisPreparationSchemaInput,
  type UpdateSynthesisPreparationSchemaInput,
  type ReplaceSynthesisPreparationSelectionsSchemaInput,
  type FinalizeSynthesisPreparationSchemaInput,
  idSchema,
} from "@/domain/validation";
import { writeActiveSynthesisRevision } from "./synthesis-writer";
import type {
  PaperRepository,
  SynthesisStatementRepository,
  SynthesisRevisionRepository,
  SynthesisRevisionSupportRepository,
  ExtractionFieldRepository,
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

function evidenceReviewState(value: string | undefined): EvidenceReviewState {
  return value === "needs_review" || value === "accepted" || value === "rejected" ? value : "unreviewed";
}

function mapScreeningState(value: unknown) {
  const state = String(value);
  return state === "include" ? "included" : state === "exclude" ? "excluded" : state === "maybe" ? "maybe" : "unscreened";
}

function mapPreparation(row: typeof synthesisPreparations.$inferSelect): SynthesisPreparation {
  return {
    id: row.id,
    projectId: row.projectId,
    evidenceSetId: row.evidenceSetId,
    evidenceSetCompositionRevisionId: row.evidenceSetCompositionRevisionId,
    extractionFieldId: row.extractionFieldId,
    workingTitle: row.workingTitle,
    workingNote: row.workingNote,
    targetSynthesisStatementId: row.targetSynthesisStatementId,
    status: row.status as SynthesisPreparation["status"],
    finalizedSynthesisRevisionId: row.finalizedSynthesisRevisionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finalizedAt: row.finalizedAt,
    abandonedAt: row.abandonedAt,
  };
}

function mapSynthesisRevision(row: typeof synthesisRevisions.$inferSelect): SynthesisRevision {
  return {
    id: row.id,
    sequence: row.sequence,
    projectId: row.projectId,
    synthesisStatementId: row.synthesisStatementId,
    state: row.state as SynthesisRevision["state"],
    title: row.title,
    statementText: row.statementText,
    researcherNote: row.researcherNote,
    createdAt: row.createdAt,
    finalizedAt: row.finalizedAt,
  };
}

export interface SynthesisPreparationServiceDependencies {
  requireProject: (projectId: string) => Promise<unknown>;
  paperRepo: PaperRepository;
  synthesisStatementRepo: SynthesisStatementRepository;
  synthesisRevisionRepo: SynthesisRevisionRepository;
  synthesisSupportRepo: SynthesisRevisionSupportRepository;
  extractionFieldRepo: ExtractionFieldRepository;
}

export function createSynthesisPreparationServices(
  db: Database,
  deps: SynthesisPreparationServiceDependencies,
) {
  return {
    async listEvidenceSetSynthesisFields(projectId: string, evidenceSetId: string) {
      await deps.requireProject(projectId);
      ensureId(evidenceSetId);

      const latestRevRows = await db
        .select({ id: evidenceSetCompositionRevisions.id })
        .from(evidenceSetCompositionRevisions)
        .where(
          and(
            eq(evidenceSetCompositionRevisions.projectId, projectId),
            eq(evidenceSetCompositionRevisions.evidenceSetId, evidenceSetId),
          ),
        )
        .orderBy(desc(evidenceSetCompositionRevisions.sequence))
        .limit(1);

      if (!latestRevRows[0]) {
        throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set does not exist in this project");
      }
      const latestCompositionRevisionId = latestRevRows[0].id;

      const rows = (await db.execute(sql`
        select
          f.id as field_id,
          f.project_id,
          f.name as field_name,
          f.description as field_description,
          f.field_type as field_type,
          f.required,
          f.sort_order,
          f.created_at as field_created_at,
          f.updated_at as field_updated_at,
          f.archived_at as field_archived_at,
          count(distinct r.id)::int as candidate_revision_count,
          count(distinct r.paper_id)::int as candidate_paper_count
        from evidence_set_composition_members cm
        join evidence_set_memberships m
          on m.project_id = cm.project_id
         and m.evidence_set_id = cm.evidence_set_id
         and m.id = cm.membership_id
        join extraction_revision_evidence ere
          on ere.project_id = m.project_id
         and ere.evidence_id = m.evidence_id
        join extraction_value_revisions r
          on r.project_id = ere.project_id
         and r.id = ere.revision_id
        join extraction_fields f
          on f.project_id = r.project_id
         and f.id = r.field_id
        where cm.project_id = ${projectId}
          and cm.evidence_set_id = ${evidenceSetId}
          and cm.composition_revision_id = ${latestCompositionRevisionId}
          and r.finalized_at is not null
          and f.archived_at is null
        group by f.id
        order by f.sort_order asc, lower(f.name) asc
      `)) as unknown as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        field: {
          id: String(row.field_id),
          projectId: String(row.project_id),
          name: String(row.field_name),
          description: row.field_description as string | null,
          fieldType: row.field_type as ExtractionField["fieldType"],
          required: Boolean(row.required),
          sortOrder: Number(row.sort_order),
          createdAt: row.field_created_at as Date,
          updatedAt: row.field_updated_at as Date,
          archivedAt: row.field_archived_at as Date | null,
        },
        candidateRevisionCount: Number(row.candidate_revision_count),
        candidatePaperCount: Number(row.candidate_paper_count),
      }));
    },

    async createSynthesisPreparation(
      projectId: string,
      input: CreateSynthesisPreparationSchemaInput,
    ): Promise<SynthesisPreparation> {
      await deps.requireProject(projectId);
      const values = validate(createSynthesisPreparationSchema, input);

      const [evidenceSet] = await db
        .select()
        .from(evidenceSets)
        .where(and(eq(evidenceSets.projectId, projectId), eq(evidenceSets.id, values.evidenceSetId)))
        .limit(1);

      if (!evidenceSet) {
        throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set does not belong to this project");
      }
      if (evidenceSet.archivedAt) {
        throw new DomainError("VALIDATION_ERROR", "Cannot create synthesis preparation from an archived Evidence Set");
      }

      const [latestRev] = await db
        .select()
        .from(evidenceSetCompositionRevisions)
        .where(
          and(
            eq(evidenceSetCompositionRevisions.projectId, projectId),
            eq(evidenceSetCompositionRevisions.evidenceSetId, values.evidenceSetId),
          ),
        )
        .orderBy(desc(evidenceSetCompositionRevisions.sequence))
        .limit(1);

      if (!latestRev) {
        throw new DomainError("DATABASE_CONSTRAINT", "Evidence Set has no composition");
      }

      const field = await deps.extractionFieldRepo.findById(projectId, values.extractionFieldId);
      if (!field) {
        throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction Field does not belong to this project");
      }
      if (field.archivedAt) {
        throw new DomainError("VALIDATION_ERROR", "Cannot create synthesis preparation from an archived Extraction Field");
      }

      const [prep] = await db
        .insert(synthesisPreparations)
        .values({
          projectId,
          evidenceSetId: values.evidenceSetId,
          evidenceSetCompositionRevisionId: latestRev.id,
          extractionFieldId: values.extractionFieldId,
          workingTitle: values.workingTitle ?? null,
          workingNote: values.workingNote ?? null,
          status: "active",
        })
        .returning();

      return mapPreparation(prep);
    },

    async listSynthesisPreparations(projectId: string): Promise<SynthesisPreparationSummary[]> {
      await deps.requireProject(projectId);

      const rows = (await db.execute(sql`
        select
          p.id,
          p.project_id,
          p.evidence_set_id,
          es.name as evidence_set_name,
          es.archived_at as evidence_set_archived_at,
          p.evidence_set_composition_revision_id,
          cr.sequence as pinned_composition_sequence,
          (
            select max(sequence)
            from evidence_set_composition_revisions
            where project_id = p.project_id and evidence_set_id = p.evidence_set_id
          ) as latest_composition_sequence,
          p.extraction_field_id,
          f.name as extraction_field_name,
          f.field_type as extraction_field_type,
          p.working_title,
          p.working_note,
          p.target_synthesis_statement_id,
          p.status,
          p.finalized_synthesis_revision_id,
          p.created_at,
          p.updated_at,
          p.finalized_at,
          p.abandoned_at,
          (
            select count(*)::int
            from synthesis_preparation_selections s
            where s.project_id = p.project_id and s.preparation_id = p.id
          ) as selected_count,
          (
            select count(distinct r.id)::int
            from evidence_set_composition_members cm
            join evidence_set_memberships m
              on m.project_id = cm.project_id and m.evidence_set_id = cm.evidence_set_id and m.id = cm.membership_id
            join extraction_revision_evidence ere
              on ere.project_id = m.project_id and ere.evidence_id = m.evidence_id
            join extraction_value_revisions r
              on r.project_id = ere.project_id and r.id = ere.revision_id
            where cm.project_id = p.project_id
              and cm.evidence_set_id = p.evidence_set_id
              and cm.composition_revision_id = p.evidence_set_composition_revision_id
              and r.field_id = p.extraction_field_id
              and r.finalized_at is not null
          ) as candidate_count
        from synthesis_preparations p
        join evidence_sets es on es.project_id = p.project_id and es.id = p.evidence_set_id
        join evidence_set_composition_revisions cr on cr.project_id = p.project_id and cr.evidence_set_id = p.evidence_set_id and cr.id = p.evidence_set_composition_revision_id
        join extraction_fields f on f.project_id = p.project_id and f.id = p.extraction_field_id
        where p.project_id = ${projectId}
        order by p.created_at desc
      `)) as unknown as Array<Record<string, unknown>>;

      return rows.map((row) => {
        const pinnedSeq = Number(row.pinned_composition_sequence);
        const latestSeq = Number(row.latest_composition_sequence);
        return {
          id: String(row.id),
          projectId: String(row.project_id),
          evidenceSetId: String(row.evidence_set_id),
          evidenceSetName: String(row.evidence_set_name),
          evidenceSetArchivedAt: (row.evidence_set_archived_at as Date | null) ?? null,
          evidenceSetCompositionRevisionId: String(row.evidence_set_composition_revision_id),
          pinnedCompositionSequence: pinnedSeq,
          extractionFieldId: String(row.extraction_field_id),
          extractionFieldName: String(row.extraction_field_name),
          extractionFieldType: row.extraction_field_type as ExtractionField["fieldType"],
          workingTitle: row.working_title as string | null,
          workingNote: row.working_note as string | null,
          targetSynthesisStatementId: row.target_synthesis_statement_id as string | null,
          status: row.status as SynthesisPreparation["status"],
          finalizedSynthesisRevisionId: row.finalized_synthesis_revision_id as string | null,
          sourceSetChanged: latestSeq > pinnedSeq,
          candidateCount: Number(row.candidate_count),
          selectedCount: Number(row.selected_count),
          createdAt: row.created_at as Date,
          updatedAt: row.updated_at as Date,
          finalizedAt: (row.finalized_at as Date | null) ?? null,
          abandonedAt: (row.abandoned_at as Date | null) ?? null,
        };
      });
    },

    async getSynthesisPreparationWorkspace(
      projectId: string,
      preparationId: string,
    ): Promise<SynthesisPreparationWorkspace> {
      await deps.requireProject(projectId);
      ensureId(preparationId);

      const [prepRow] = await db
        .select()
        .from(synthesisPreparations)
        .where(and(eq(synthesisPreparations.projectId, projectId), eq(synthesisPreparations.id, preparationId)))
        .limit(1);

      if (!prepRow) {
        throw new DomainError("NOT_FOUND", "Synthesis preparation was not found");
      }

      const preparation = mapPreparation(prepRow);

      const [evidenceSetRow] = await db
        .select()
        .from(evidenceSets)
        .where(and(eq(evidenceSets.projectId, projectId), eq(evidenceSets.id, preparation.evidenceSetId)))
        .limit(1);

      if (!evidenceSetRow) {
        throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set does not belong to this project");
      }

      const [pinnedCompRow] = await db
        .select({ sequence: evidenceSetCompositionRevisions.sequence })
        .from(evidenceSetCompositionRevisions)
        .where(
          and(
            eq(evidenceSetCompositionRevisions.projectId, projectId),
            eq(evidenceSetCompositionRevisions.evidenceSetId, preparation.evidenceSetId),
            eq(evidenceSetCompositionRevisions.id, preparation.evidenceSetCompositionRevisionId),
          ),
        )
        .limit(1);

      const [latestCompRow] = await db
        .select({ sequence: evidenceSetCompositionRevisions.sequence })
        .from(evidenceSetCompositionRevisions)
        .where(
          and(
            eq(evidenceSetCompositionRevisions.projectId, projectId),
            eq(evidenceSetCompositionRevisions.evidenceSetId, preparation.evidenceSetId),
          ),
        )
        .orderBy(desc(evidenceSetCompositionRevisions.sequence))
        .limit(1);

      const pinnedSeq = Number(pinnedCompRow?.sequence ?? 0);
      const latestSeq = Number(latestCompRow?.sequence ?? 0);

      const fieldRow = await deps.extractionFieldRepo.findById(projectId, preparation.extractionFieldId);
      if (!fieldRow) {
        throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction field does not belong to this project");
      }
      const field: ExtractionField = {
        ...fieldRow,
        fieldType: fieldRow.fieldType as ExtractionField["fieldType"],
      };

      // Load statements/revisions if referenced
      let targetStatement: SynthesisStatement | null = null;
      let currentTargetRevision: SynthesisRevision | null = null;
      let finalizedRevision: SynthesisRevision | null = null;

      if (preparation.targetSynthesisStatementId) {
        const stmt = await deps.synthesisStatementRepo.findById(projectId, preparation.targetSynthesisStatementId);
        if (stmt) {
          targetStatement = stmt;
          const currentRevRow = await deps.synthesisRevisionRepo.current(projectId, stmt.id);
          currentTargetRevision = currentRevRow ? mapSynthesisRevision(currentRevRow) : null;
        }
      }

      if (preparation.finalizedSynthesisRevisionId) {
        const [fin] = await db
          .select()
          .from(synthesisRevisions)
          .where(and(eq(synthesisRevisions.projectId, projectId), eq(synthesisRevisions.id, preparation.finalizedSynthesisRevisionId)))
          .limit(1);
        finalizedRevision = fin ? mapSynthesisRevision(fin) : null;
      }

      // Query current selections
      const selectionRows = await db
        .select({ extractionRevisionId: synthesisPreparationSelections.extractionRevisionId })
        .from(synthesisPreparationSelections)
        .where(
          and(
            eq(synthesisPreparationSelections.projectId, projectId),
            eq(synthesisPreparationSelections.preparationId, preparationId),
          ),
        );
      const selectedSet = new Set(selectionRows.map((r) => r.extractionRevisionId));

      // Query candidates with connecting evidence, ordered deterministically
      const candidateRows = (await db.execute(sql`
        with connecting as (
          select
            cm.membership_id,
            cm.sort_order as membership_order,
            m.evidence_id,
            e.source_text,
            e.page_number,
            e.full_text_document_id,
            d.original_filename as document_original_filename,
            d.byte_size as document_byte_size,
            d.sha256 as document_sha256,
            d.created_at as document_created_at,
            d.archived_at as document_archived_at,
            coalesce(erd.decision, 'unreviewed') as evidence_curation_decision,
            ere.revision_id
          from evidence_set_composition_members cm
          join evidence_set_memberships m
            on m.project_id = cm.project_id
           and m.evidence_set_id = cm.evidence_set_id
           and m.id = cm.membership_id
          join evidence e
            on e.project_id = m.project_id
           and e.id = m.evidence_id
          left join full_text_documents d
            on d.project_id = e.project_id
           and d.id = e.full_text_document_id
          left join lateral (
            select rd.decision
            from evidence_review_decisions rd
            where rd.project_id = e.project_id
              and rd.evidence_id = e.id
            order by rd.sequence desc
            limit 1
          ) erd on true
          join extraction_revision_evidence ere
            on ere.project_id = e.project_id
           and ere.evidence_id = e.id
          where cm.project_id = ${projectId}
            and cm.evidence_set_id = ${preparation.evidenceSetId}
            and cm.composition_revision_id = ${preparation.evidenceSetCompositionRevisionId}
        )
        select
          r.id as revision_id,
          r.sequence as revision_sequence,
          r.project_id,
          r.paper_id,
          r.field_id,
          r.extraction_value_id,
          r.field_type,
          r.value_state,
          r.text_value,
          r.number_value,
          r.boolean_value,
          r.option_id,
          r.researcher_note as revision_note,
          r.created_at as revision_created_at,
          r.finalized_at as revision_finalized_at,
          p.id as paper_id_value,
          p.title as paper_title,
          p.authors as paper_authors,
          p.publication_year as paper_publication_year,
          p.venue as paper_venue,
          p.doi as paper_doi,
          p.abstract as paper_abstract,
          p.bibliographic_note as paper_bibliographic_note,
          p.created_at as paper_created_at,
          p.updated_at as paper_updated_at,
          coalesce(sd.decision, 'unscreened') as title_abstract_decision,
          coalesce(fd.decision, 'not_started') as full_text_decision,
          coalesce(ra.outcome, 'not_sought') as full_text_retrieval_state,
          coalesce(ra_success.ever_retrieved, false) as ever_retrieved,
          coalesce(ra_any.has_attempts, false) as has_full_text_retrieval_attempts,
          true as has_analytical_history,
          not exists (
            select 1 from extraction_value_revisions newer
            where newer.project_id = r.project_id
              and newer.extraction_value_id = r.extraction_value_id
              and newer.finalized_at is not null
              and newer.sequence > r.sequence
          ) as is_current_extraction_revision,
          (
            select json_agg(json_build_object(
              'membershipId', c.membership_id,
              'membershipOrder', c.membership_order,
              'evidenceId', c.evidence_id,
              'sourceText', c.source_text,
              'pageNumber', c.page_number,
              'fullTextDocumentId', c.full_text_document_id,
              'documentOriginalFilename', c.document_original_filename,
              'documentByteSize', c.document_byte_size,
              'documentSha256', c.document_sha256,
              'documentCreatedAt', c.document_created_at,
              'documentArchivedAt', c.document_archived_at,
              'curationState', c.evidence_curation_decision
            ) order by c.membership_order)
            from connecting c
            where c.revision_id = r.id
          ) as connecting_evidence,
          (
            select min(c.membership_order)
            from connecting c
            where c.revision_id = r.id
          ) as min_membership_order
        from extraction_value_revisions r
        join papers p on p.project_id = r.project_id and p.id = r.paper_id
        join extraction_values v on v.project_id = r.project_id and v.id = r.extraction_value_id and v.field_id = r.field_id
        left join lateral (
          select decision from screening_decisions
          where project_id = r.project_id and paper_id = r.paper_id and stage = 'title_abstract'
          order by sequence desc limit 1
        ) sd on true
        left join lateral (
          select decision from full_text_screening_decisions
          where project_id = r.project_id and paper_id = r.paper_id
          order by sequence desc limit 1
        ) fd on true
        left join lateral (
          select outcome from full_text_retrieval_attempts
          where project_id = r.project_id and paper_id = r.paper_id
          order by sequence desc limit 1
        ) ra on true
        left join lateral (
          select exists(
            select 1 from full_text_retrieval_attempts
            where project_id = r.project_id and paper_id = r.paper_id and outcome = 'retrieved'
          ) as ever_retrieved
        ) ra_success on true
        left join lateral (
          select exists(
            select 1 from full_text_retrieval_attempts
            where project_id = r.project_id and paper_id = r.paper_id
          ) as has_attempts
        ) ra_any on true
        where r.project_id = ${projectId}
          and r.field_id = ${preparation.extractionFieldId}
          and r.finalized_at is not null
          and r.id in (select distinct revision_id from connecting)
        order by
          min_membership_order asc,
          lower(trim(p.title)) asc,
          p.id asc,
          r.extraction_value_id asc,
          r.sequence asc,
          r.id asc
      `)) as unknown as Array<Record<string, unknown>>;

      // Also retrieve direct attached evidence for each candidate revision
      const revisionIds = candidateRows.map((r) => String(r.revision_id));
      const directEvidenceRows = revisionIds.length
        ? ((await db.execute(sql`
            select ere.revision_id, e.*,
              d.original_filename as document_original_filename,
              d.byte_size as document_byte_size,
              d.sha256 as document_sha256,
              d.created_at as document_created_at,
              d.archived_at as document_archived_at,
              coalesce(erd.decision, 'unreviewed') as curation_decision
            from extraction_revision_evidence ere
            join evidence e on e.project_id = ere.project_id and e.id = ere.evidence_id
            left join full_text_documents d on d.project_id = e.project_id and d.id = e.full_text_document_id
            left join lateral (
              select rd.decision
              from evidence_review_decisions rd
              where rd.project_id = e.project_id and rd.evidence_id = e.id
              order by rd.sequence desc limit 1
            ) erd on true
            where ere.project_id = ${projectId}
              and ere.revision_id in (${sql.join(revisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
            order by ere.revision_id, e.page_number, e.created_at
          `)) as unknown as Array<Record<string, unknown>>)
        : [];

      const directEvidenceByRevision = new Map<string, Evidence[]>();
      for (const dRow of directEvidenceRows) {
        const revId = String(dRow.revision_id);
        const curDecision = evidenceReviewState(String(dRow.curation_decision));
        const item: Evidence = {
          id: String(dRow.id),
          projectId: String(dRow.project_id),
          paperId: String(dRow.paper_id),
          sourceText: String(dRow.source_text),
          pageNumber: Number(dRow.page_number),
          fullTextDocumentId: dRow.full_text_document_id ? String(dRow.full_text_document_id) : null,
          document: dRow.full_text_document_id
            ? {
                id: String(dRow.full_text_document_id),
                originalFilename: String(dRow.document_original_filename),
                mediaType: "application/pdf" as const,
                byteSize: Number(dRow.document_byte_size),
                sha256: String(dRow.document_sha256),
                createdAt: dRow.document_created_at as Date,
                archivedAt: (dRow.document_archived_at as Date | null) ?? null,
              }
            : null,
          documentTextExtractionId: dRow.document_text_extraction_id ? String(dRow.document_text_extraction_id) : null,
          extractionStartOffset: dRow.extraction_start_offset == null ? null : Number(dRow.extraction_start_offset),
          extractionEndOffset: dRow.extraction_end_offset == null ? null : Number(dRow.extraction_end_offset),
          note: dRow.note ? String(dRow.note) : null,
          reviewState: curDecision,
          curationWarning:
            curDecision === "unreviewed"
              ? "never_reviewed"
              : curDecision === "needs_review"
                ? "needs_review"
                : curDecision === "rejected"
                  ? "currently_rejected"
                  : null,
          createdAt: dRow.created_at as Date,
          updatedAt: dRow.updated_at as Date,
        };
        directEvidenceByRevision.set(revId, [...(directEvidenceByRevision.get(revId) ?? []), item]);
      }

      const candidates: SynthesisCandidate[] = candidateRows.map((row) => {
        const revId = String(row.revision_id);
        const isCurrent = Boolean(row.is_current_extraction_revision);
        const valueState = String(row.value_state) as "present" | "not_reported" | "not_applicable" | "cleared";

        const titleAbstractDecision = row.title_abstract_decision as "include" | "exclude" | "maybe" | null;
        const fullTextDecision = row.full_text_decision === "not_started" ? null : (row.full_text_decision as "include" | "exclude" | "maybe" | null);
        const retrievalState = row.full_text_retrieval_state as "pending" | "unavailable" | "retrieved" | "not_sought";

        const paperStatus = derivePaperReviewStatus({
          titleAbstractDecision,
          fullTextDecision,
          fullTextRetrievalState: retrievalState,
          everRetrieved: Boolean(row.ever_retrieved),
          hasFullTextRetrievalAttempts: Boolean(row.has_full_text_retrieval_attempts),
          hasAnalyticalHistory: true,
        });

        const paperIncluded = isFinallyIncluded(paperStatus);

        const connectingRaw = Array.isArray(row.connecting_evidence)
          ? (row.connecting_evidence as Record<string, unknown>[])
          : typeof row.connecting_evidence === "string"
            ? (JSON.parse(row.connecting_evidence) as Record<string, unknown>[])
            : [];

        const connectingEvidence: SynthesisCandidateConnectingEvidence[] = connectingRaw.map((item) => {
          const curDecision = evidenceReviewState(String(item.curationState));
          return {
            membershipId: String(item.membershipId),
            membershipOrder: Number(item.membershipOrder),
            evidenceId: String(item.evidenceId),
            sourceText: String(item.sourceText),
            pageNumber: Number(item.pageNumber),
            document: item.fullTextDocumentId
              ? {
                  id: String(item.fullTextDocumentId),
                  originalFilename: String(item.documentOriginalFilename),
                  mediaType: "application/pdf" as const,
                  byteSize: Number(item.documentByteSize),
                  sha256: String(item.documentSha256),
                  createdAt: new Date(String(item.documentCreatedAt)),
                  archivedAt: item.documentArchivedAt ? new Date(String(item.documentArchivedAt)) : null,
                }
              : null,
            curationState: curDecision,
            curationWarning:
              curDecision === "unreviewed"
                ? "never_reviewed"
                : curDecision === "needs_review"
                  ? "needs_review"
                  : curDecision === "rejected"
                    ? "currently_rejected"
                    : null,
          };
        });

        const eligibilityReasons: string[] = [];
        if (!paperIncluded) {
          eligibilityReasons.push("Paper is not currently finally included");
        }
        if (valueState === "cleared") {
          eligibilityReasons.push("Extraction value is cleared");
        }

        const selectable = eligibilityReasons.length === 0;

        const warnings: SynthesisCandidateWarning[] = [];
        if (connectingEvidence.some((c) => c.curationState === "unreviewed")) {
          warnings.push("underlying_evidence_unreviewed");
        }
        if (connectingEvidence.some((c) => c.curationState === "needs_review")) {
          warnings.push("underlying_evidence_needs_review");
        }
        if (connectingEvidence.some((c) => c.curationState === "rejected")) {
          warnings.push("underlying_evidence_rejected");
        }
        if (!paperIncluded) {
          warnings.push("paper_not_finally_included");
        }
        if (!isCurrent) {
          warnings.push("extraction_revision_superseded");
        }
        if (valueState === "cleared") {
          warnings.push("extraction_revision_cleared");
        }

        const paper: Paper = {
          id: String(row.paper_id_value ?? row.paper_id),
          projectId: String(row.project_id),
          title: String(row.paper_title),
          authors: (row.paper_authors as string[]) ?? [],
          publicationYear: row.paper_publication_year as number | null,
          venue: row.paper_venue as string | null,
          doi: row.paper_doi as string | null,
          abstract: row.paper_abstract as string | null,
          bibliographicNote: row.paper_bibliographic_note as string | null,
          createdAt: row.paper_created_at as Date,
          updatedAt: row.paper_updated_at as Date,
        };

        const extractionRevision: ExtractionRevisionWithEvidence = {
          id: revId,
          sequence: Number(row.revision_sequence),
          projectId: String(row.project_id),
          paperId: String(row.paper_id),
          fieldId: String(row.field_id),
          extractionValueId: String(row.extraction_value_id),
          fieldType: row.field_type as ExtractionField["fieldType"],
          valueState,
          textValue: row.text_value as string | null,
          numberValue: row.number_value as string | null,
          booleanValue: row.boolean_value as boolean | null,
          optionId: row.option_id as string | null,
          researcherNote: row.revision_note as string | null,
          createdAt: row.revision_created_at as Date,
          finalizedAt: row.revision_finalized_at as Date | null,
          evidence: directEvidenceByRevision.get(revId) ?? [],
        };

        return {
          extractionRevision,
          paper,
          paperScreeningState: mapScreeningState(row.title_abstract_decision),
          isFinallyIncluded: paperIncluded,
          isCurrentExtractionRevision: isCurrent,
          connectingEvidence,
          selected: selectedSet.has(revId),
          selectable,
          eligibilityReasons,
          warnings,
        };
      });

      return {
        preparation,
        evidenceSet: {
          id: evidenceSetRow.id,
          projectId: evidenceSetRow.projectId,
          name: evidenceSetRow.name,
          description: evidenceSetRow.description,
          createdAt: evidenceSetRow.createdAt,
          updatedAt: evidenceSetRow.updatedAt,
          archivedAt: evidenceSetRow.archivedAt,
        },
        pinnedCompositionSequence: pinnedSeq,
        latestCompositionSequence: latestSeq,
        sourceSetChanged: latestSeq > pinnedSeq,
        field,
        targetStatement,
        currentTargetRevision,
        finalizedRevision,
        candidateCount: candidates.length,
        selectedCount: selectedSet.size,
        candidates,
      };
    },

    async updateSynthesisPreparation(
      projectId: string,
      preparationId: string,
      input: UpdateSynthesisPreparationSchemaInput,
    ): Promise<SynthesisPreparation> {
      await deps.requireProject(projectId);
      ensureId(preparationId);
      const values = validate(updateSynthesisPreparationSchema, input);

      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(synthesisPreparations)
          .where(and(eq(synthesisPreparations.projectId, projectId), eq(synthesisPreparations.id, preparationId)))
          .for("update")
          .limit(1);

        if (!locked) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis preparation does not belong to this project");
        }
        if (locked.status !== "active") {
          throw new DomainError("VALIDATION_ERROR", "Cannot update a terminal synthesis preparation");
        }

        if (values.targetSynthesisStatementId) {
          ensureId(values.targetSynthesisStatementId);
          const statement = await deps.synthesisStatementRepo.findById(projectId, values.targetSynthesisStatementId);
          if (!statement) {
            throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
          }
        }

        const [updated] = await tx
          .update(synthesisPreparations)
          .set({
            ...(values.workingTitle !== undefined ? { workingTitle: values.workingTitle } : {}),
            ...(values.workingNote !== undefined ? { workingNote: values.workingNote } : {}),
            ...(values.targetSynthesisStatementId !== undefined
              ? { targetSynthesisStatementId: values.targetSynthesisStatementId }
              : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(synthesisPreparations.projectId, projectId), eq(synthesisPreparations.id, preparationId)))
          .returning();

        return mapPreparation(updated);
      });
    },

    async replaceSynthesisPreparationSelections(
      projectId: string,
      preparationId: string,
      input: ReplaceSynthesisPreparationSelectionsSchemaInput,
    ): Promise<string[]> {
      await deps.requireProject(projectId);
      ensureId(preparationId);
      const values = validate(replaceSynthesisPreparationSelectionsSchema, input);

      return db.transaction(async (tx) => {
        const [prep] = await tx
          .select()
          .from(synthesisPreparations)
          .where(and(eq(synthesisPreparations.projectId, projectId), eq(synthesisPreparations.id, preparationId)))
          .for("update")
          .limit(1);

        if (!prep) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis preparation does not belong to this project");
        }
        if (prep.status !== "active") {
          throw new DomainError("VALIDATION_ERROR", "Cannot modify selections of a terminal synthesis preparation");
        }

        // Read current selections
        const currentSelectionRows = await tx
          .select({ extractionRevisionId: synthesisPreparationSelections.extractionRevisionId })
          .from(synthesisPreparationSelections)
          .where(
            and(
              eq(synthesisPreparationSelections.projectId, projectId),
              eq(synthesisPreparationSelections.preparationId, preparationId),
            ),
          );

        const currentIds = new Set(currentSelectionRows.map((r) => r.extractionRevisionId));
        const desiredIds = new Set(values.extractionRevisionIds);

        const addedIds = values.extractionRevisionIds.filter((id) => !currentIds.has(id));
        const removedIds = [...currentIds].filter((id) => !desiredIds.has(id));

        // Approved Correction 3: Validate ONLY newly added IDs (desired - existing).
        // Removed and unchanged remain permitted even if unchanged drifted to ineligible.
        if (addedIds.length > 0) {
          const addedRows = (await tx.execute(sql`
            select
              r.id, r.project_id, r.field_id, r.finalized_at, r.value_state,
              coalesce(sd.decision, 'unscreened') as screening_state,
              coalesce(fd.decision, 'not_started') as full_text_state,
              exists (
                select 1
                from evidence_set_composition_members cm
                join evidence_set_memberships m
                  on m.project_id = cm.project_id
                 and m.evidence_set_id = cm.evidence_set_id
                 and m.id = cm.membership_id
                join extraction_revision_evidence ere
                  on ere.project_id = m.project_id
                 and ere.evidence_id = m.evidence_id
                where cm.project_id = ${projectId}
                  and cm.evidence_set_id = ${prep.evidenceSetId}
                  and cm.composition_revision_id = ${prep.evidenceSetCompositionRevisionId}
                  and ere.revision_id = r.id
              ) as is_reachable
            from extraction_value_revisions r
            left join lateral (
              select decision from screening_decisions
              where project_id = r.project_id and paper_id = r.paper_id and stage = 'title_abstract'
              order by sequence desc limit 1
            ) sd on true
            left join lateral (
              select decision from full_text_screening_decisions
              where project_id = r.project_id and paper_id = r.paper_id
              order by sequence desc limit 1
            ) fd on true
            where r.project_id = ${projectId} and r.id in (${sql.join(addedIds.map((id) => sql`${id}::uuid`), sql`, `)})
          `)) as unknown as Array<Record<string, unknown>>;

          if (addedRows.length !== addedIds.length) {
            throw new DomainError("CROSS_PROJECT_REFERENCE", "One or more extraction revisions do not belong to this project");
          }

          for (const row of addedRows) {
            if (row.field_id !== prep.extractionFieldId) {
              throw new DomainError("VALIDATION_ERROR", "Selected revision does not match preparation extraction field");
            }
            if (!row.finalized_at) {
              throw new DomainError("VALIDATION_ERROR", "Selected revision is not finalized");
            }
            if (row.value_state === "cleared") {
              throw new DomainError("VALIDATION_ERROR", "Cleared extraction revisions cannot be selected");
            }
            if (row.screening_state !== "include" || row.full_text_state !== "include") {
              throw new DomainError("VALIDATION_ERROR", "Selected revision belongs to a paper that is not finally included");
            }
            if (!row.is_reachable) {
              throw new DomainError("VALIDATION_ERROR", "Selected revision is not reachable from pinned evidence set composition");
            }
          }
        }

        // Apply removals
        if (removedIds.length > 0) {
          await tx
            .delete(synthesisPreparationSelections)
            .where(
              and(
                eq(synthesisPreparationSelections.projectId, projectId),
                eq(synthesisPreparationSelections.preparationId, preparationId),
                inArray(synthesisPreparationSelections.extractionRevisionId, removedIds),
              ),
            );
        }

        // Apply additions
        if (addedIds.length > 0) {
          await tx.insert(synthesisPreparationSelections).values(
            addedIds.map((id) => ({
              projectId,
              preparationId,
              extractionRevisionId: id,
            })),
          );
        }

        await tx
          .update(synthesisPreparations)
          .set({ updatedAt: new Date() })
          .where(and(eq(synthesisPreparations.projectId, projectId), eq(synthesisPreparations.id, preparationId)));

        return values.extractionRevisionIds;
      });
    },

    async abandonSynthesisPreparation(
      projectId: string,
      preparationId: string,
    ): Promise<SynthesisPreparation> {
      await deps.requireProject(projectId);
      ensureId(preparationId);

      return db.transaction(async (tx) => {
        const [prep] = await tx
          .select()
          .from(synthesisPreparations)
          .where(and(eq(synthesisPreparations.projectId, projectId), eq(synthesisPreparations.id, preparationId)))
          .for("update")
          .limit(1);

        if (!prep) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis preparation does not belong to this project");
        }
        if (prep.status !== "active") {
          throw new DomainError("VALIDATION_ERROR", "Only active synthesis preparations can be abandoned");
        }

        const [updated] = await tx
          .update(synthesisPreparations)
          .set({
            status: "abandoned",
            abandonedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(synthesisPreparations.projectId, projectId), eq(synthesisPreparations.id, preparationId)))
          .returning();

        return mapPreparation(updated);
      });
    },

    async finalizeSynthesisPreparation(
      projectId: string,
      preparationId: string,
      input: FinalizeSynthesisPreparationSchemaInput,
    ): Promise<{
      preparation: SynthesisPreparation;
      statement: SynthesisStatement;
      revision: SynthesisRevision;
    }> {
      await deps.requireProject(projectId);
      ensureId(preparationId);
      const values = validate(finalizeSynthesisPreparationSchema, input);

      return db.transaction(async (tx) => {
        // Canonical lock order: Preparation -> supporting Papers (UUID order) -> SynthesisStatement.
        // 1. Lock preparation
        const [prep] = await tx
          .select()
          .from(synthesisPreparations)
          .where(and(eq(synthesisPreparations.projectId, projectId), eq(synthesisPreparations.id, preparationId)))
          .for("update")
          .limit(1);

        if (!prep) {
          throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis preparation does not belong to this project");
        }
        if (prep.status !== "active") {
          throw new DomainError("VALIDATION_ERROR", "Only active preparations can be finalized");
        }

        // 2. Read current selections
        const selectionRows = await tx
          .select({ extractionRevisionId: synthesisPreparationSelections.extractionRevisionId })
          .from(synthesisPreparationSelections)
          .where(
            and(
              eq(synthesisPreparationSelections.projectId, projectId),
              eq(synthesisPreparationSelections.preparationId, preparationId),
            ),
          );
        const selectedIds = selectionRows.map((r) => r.extractionRevisionId);

        // 3. Resolve target
        const target = prep.targetSynthesisStatementId
          ? ({ kind: "existing", statementId: prep.targetSynthesisStatementId } as const)
          : ({ kind: "new" } as const);

        // 4. Delegate to shared synthesis writer single authority (locks Papers in UUID order, checks Slice 4 eligibility, locks statement, writes supports and finalizes revision)
        const writerResult = await writeActiveSynthesisRevision(
          tx,
          projectId,
          target,
          {
            title: values.title ?? prep.workingTitle ?? null,
            statementText: values.statementText,
            researcherNote: values.researcherNote ?? prep.workingNote ?? null,
            extractionRevisionIds: selectedIds,
          },
          {
            paperRepo: deps.paperRepo,
            synthesisStatementRepo: deps.synthesisStatementRepo,
            synthesisRevisionRepo: deps.synthesisRevisionRepo,
            synthesisSupportRepo: deps.synthesisSupportRepo,
          },
        );

        // 5. Verify exact equality between preparation selections and revision supports
        if (
          writerResult.supportExtractionRevisionIds.length !== selectedIds.length ||
          !selectedIds.every((id) => writerResult.supportExtractionRevisionIds.includes(id))
        ) {
          throw new DomainError("VALIDATION_ERROR", "Finalized synthesis supports must match preparation selections exactly");
        }

        // 6. Update preparation to finalized
        const [finalizedPrep] = await tx
          .update(synthesisPreparations)
          .set({
            status: "finalized",
            targetSynthesisStatementId: writerResult.statement.id,
            finalizedSynthesisRevisionId: writerResult.revision.id,
            finalizedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(synthesisPreparations.projectId, projectId), eq(synthesisPreparations.id, preparationId)))
          .returning();

        return {
          preparation: mapPreparation(finalizedPrep),
          statement: writerResult.statement,
          revision: mapSynthesisRevision(writerResult.revision),
        };
      });
    },

    async getSynthesisPreparationContextForRevision(
      projectId: string,
      synthesisRevisionId: string,
    ): Promise<SynthesisPreparationContext | null> {
      await deps.requireProject(projectId);
      ensureId(synthesisRevisionId);

      // Approved Correction 4: Preparation context belongs strictly to the exact finalized_synthesis_revision_id, not the stable SynthesisStatement
      const rows = (await db.execute(sql`
        select
          p.id as preparation_id,
          p.evidence_set_id,
          es.name as evidence_set_name,
          es.archived_at as evidence_set_archived_at,
          p.evidence_set_composition_revision_id,
          cr.sequence as pinned_composition_sequence,
          p.finalized_at
        from synthesis_preparations p
        join evidence_sets es on es.project_id = p.project_id and es.id = p.evidence_set_id
        join evidence_set_composition_revisions cr on cr.project_id = p.project_id and cr.evidence_set_id = p.evidence_set_id and cr.id = p.evidence_set_composition_revision_id
        where p.project_id = ${projectId} and p.finalized_synthesis_revision_id = ${synthesisRevisionId}
        limit 1
      `)) as unknown as Array<Record<string, unknown>>;

      if (!rows[0]) return null;

      const row = rows[0];
      return {
        preparationId: String(row.preparation_id),
        evidenceSetId: String(row.evidence_set_id),
        evidenceSetName: String(row.evidence_set_name),
        evidenceSetArchivedAt: (row.evidence_set_archived_at as Date | null) ?? null,
        pinnedCompositionRevisionId: String(row.evidence_set_composition_revision_id),
        pinnedCompositionSequence: Number(row.pinned_composition_sequence),
        finalizedAt: row.finalized_at as Date,
      };
    },
  };
}