import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import type { Evidence, ExtractionFieldType, ExtractionValueState, ProjectId } from "@/domain/types";
import { ensureId, evidenceCurationWarning, evidenceReviewState } from "./review-services/shared";
import { decodeExtractionHistoryCursor, effectiveExtractionHistoryPageSize, encodeExtractionHistoryCursor } from "./extraction-history-cursor";
import {
  EXTRACTION_HISTORY_TYPE,
  type CurrentExtractionRevisionIdentity,
  type ExactExtractionRevisionAudit,
  type ExtractionHistoryCursor,
  type ExtractionHistoryPageOptions,
  type ExtractionRevisionHistoryItem,
} from "./extraction-history-read-types";

const READ_TRANSACTION = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
const READ_STATEMENT_TIMEOUT = sql`set local statement_timeout = '15000ms'`;
type ReadExecutor = Pick<Database, "execute">;
type RawRow = Record<string, unknown>;

function rows(value: unknown): RawRow[] {
  return value as unknown as RawRow[];
}

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === 1;
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : date(value);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function invalidHistoryCursor(): DomainError {
  return new DomainError("VALIDATION_ERROR", "History link is invalid or belongs to a different record. Start from the first page.");
}

async function withExecutor<T>(
  db: Database,
  executor: ReadExecutor | undefined,
  operation: (executor: ReadExecutor) => Promise<T>,
): Promise<T> {
  const run = async (read: ReadExecutor) => {
    // Route callers supply a transaction-bound executor; keep the timeout
    // local to that composed read just as we do for owned read transactions.
    await read.execute(READ_STATEMENT_TIMEOUT);
    return operation(read);
  };
  if (executor) return run(executor);
  return db.transaction((tx) => run(tx), READ_TRANSACTION);
}

function historyScopeQuery(
  projectId: string,
  paperId: string,
  fieldId: string,
  cursor: ExtractionHistoryCursor | null,
) {
  const anchorMembership = cursor
    ? sql`(
        x.id=${cursor.extractionValueId}::uuid and exists (
          select 1 from extraction_value_revisions anchor
          where anchor.project_id=p.id and anchor.paper_id=paper.id
            and anchor.field_id=f.id and anchor.extraction_value_id=x.id
            and anchor.id=${cursor.lastRevisionId}::uuid
            and anchor.sequence=${cursor.lastSequence}::bigint
            and anchor.finalized_at is not null
        )
      )`
    : sql`true`;
  return sql`
    select p.id as project_id, paper.id as paper_id, f.id as field_id,
      left(f.name, 500) as field_name_preview,
      (char_length(f.name) > 500) as field_name_truncated,
      f.field_type, f.archived_at as field_archived_at,
      x.id as extraction_value_id,
      ${anchorMembership} as anchor_valid,
      current_r.id as current_revision_id,
      current_r.sequence::text as current_sequence
    from projects p
    left join papers paper on paper.project_id=p.id and paper.id=${paperId}::uuid
    left join extraction_fields f on f.project_id=p.id and f.id=${fieldId}::uuid
    left join extraction_values x on x.project_id=p.id and x.paper_id=paper.id and x.field_id=f.id
    left join lateral (
      select r.id, r.sequence
      from extraction_value_revisions r
      where r.project_id=p.id and r.paper_id=paper.id and r.field_id=f.id
        and r.extraction_value_id=x.id and r.finalized_at is not null
      order by r.sequence desc
      limit 1
    ) current_r on true
    where p.id=${projectId}::uuid
    limit 1
  `;
}

function pageQuery(
  projectId: string,
  paperId: string,
  fieldId: string,
  extractionValueId: string,
  pageSize: number,
  cursor: ExtractionHistoryCursor | null,
) {
  const cursorRange = cursor
    ? sql`and (r.sequence, r.id) < (${cursor.lastSequence}::bigint, ${cursor.lastRevisionId}::uuid)`
    : sql``;
  return sql`
    with page_keys as materialized (
      select r.id, r.sequence
      from extraction_value_revisions r
      where r.project_id=${projectId}::uuid and r.paper_id=${paperId}::uuid
        and r.field_id=${fieldId}::uuid and r.extraction_value_id=${extractionValueId}::uuid
        and r.finalized_at is not null ${cursorRange}
      order by r.sequence desc, r.id desc
      limit ${pageSize + 1}
    ),
    visible_page as materialized (
      select id, sequence from page_keys
      order by sequence desc, id desc
      limit ${pageSize}
    ),
    page_state as (
      select count(*) > ${pageSize} as has_more from page_keys
    ),
    visible_evidence_counts as (
      select link.revision_id, count(*)::text as evidence_count
      from extraction_revision_evidence link
      join visible_page visible on visible.id=link.revision_id
      where link.project_id=${projectId}::uuid and link.paper_id=${paperId}::uuid
      group by link.revision_id
    )
    select state.has_more, revision.id as revision_id,
      revision.sequence::text as sequence, revision.field_type, revision.value_state,
      left(revision.text_value, 448) as text_value_preview,
      (revision.text_value is not null and char_length(revision.text_value) > 448) as text_value_truncated,
      revision.number_value::text as number_value, revision.boolean_value, revision.option_id,
      left(option.label, 500) as option_label_preview,
      (option.label is not null and char_length(option.label) > 500) as option_label_truncated,
      option.archived_at as option_archived_at,
      left(revision.researcher_note, 192) as researcher_note_preview,
      (revision.researcher_note is not null and char_length(revision.researcher_note) > 192) as researcher_note_truncated,
      revision.created_at, revision.finalized_at,
      coalesce(counts.evidence_count, '0') as evidence_count
    from page_state state
    left join visible_page visible on true
    left join extraction_value_revisions revision
      on revision.project_id=${projectId}::uuid and revision.paper_id=${paperId}::uuid
      and revision.field_id=${fieldId}::uuid and revision.extraction_value_id=${extractionValueId}::uuid
      and revision.id=visible.id and revision.finalized_at is not null
    left join extraction_options option
      on option.project_id=revision.project_id and option.field_id=revision.field_id and option.id=revision.option_id
    left join visible_evidence_counts counts on counts.revision_id=revision.id
    order by revision.sequence desc, revision.id desc
  `;
}

function exactOwnershipQuery(projectId: string, paperId: string, fieldId: string, revisionId: string) {
  return sql`
    with scope as materialized (
      select p.id as project_id, paper.id as paper_id, paper.title as paper_title,
        f.id as field_id, f.name as field_name, f.field_type as current_field_type,
        f.archived_at as field_archived_at, slot.id as extraction_value_id,
        revision.id as revision_id, revision.sequence::text as sequence,
        revision.field_type, revision.value_state, revision.text_value,
        revision.number_value::text as number_value, revision.boolean_value,
        revision.option_id, revision.researcher_note, revision.created_at,
        revision.finalized_at, option.label as option_label, option.archived_at as option_archived_at
      from projects p
      join papers paper on paper.project_id=p.id and paper.id=${paperId}::uuid
      join extraction_fields f on f.project_id=p.id and f.id=${fieldId}::uuid
      join extraction_values slot on slot.project_id=p.id and slot.paper_id=paper.id and slot.field_id=f.id
      join extraction_value_revisions revision
        on revision.project_id=slot.project_id and revision.paper_id=slot.paper_id
        and revision.field_id=slot.field_id and revision.extraction_value_id=slot.id
        and revision.id=${revisionId}::uuid and revision.finalized_at is not null
      left join extraction_options option
        on option.project_id=revision.project_id and option.field_id=revision.field_id and option.id=revision.option_id
      where p.id=${projectId}::uuid
    ), current_revision as (
      select latest.id
      from scope s
      join lateral (
        select candidate.id
        from extraction_value_revisions candidate
        where candidate.project_id=s.project_id and candidate.paper_id=s.paper_id
          and candidate.field_id=s.field_id and candidate.extraction_value_id=s.extraction_value_id
          and candidate.finalized_at is not null
        order by candidate.sequence desc
        limit 1
      ) latest on true
    )
    select s.*, (select id from current_revision) as current_revision_id from scope s limit 1
  `;
}

function exactEvidenceQuery(projectId: string, paperId: string, fieldId: string, revisionId: string) {
  return sql`
    with scoped_revision as materialized (
      select p.id as project_id, paper.id as paper_id, field.id as field_id,
        slot.id as extraction_value_id, revision.id as revision_id
      from projects p
      join papers paper on paper.project_id=p.id and paper.id=${paperId}::uuid
      join extraction_fields field on field.project_id=p.id and field.id=${fieldId}::uuid
      join extraction_values slot on slot.project_id=p.id and slot.paper_id=paper.id and slot.field_id=field.id
      join extraction_value_revisions revision
        on revision.project_id=slot.project_id and revision.paper_id=slot.paper_id
        and revision.field_id=slot.field_id and revision.extraction_value_id=slot.id
        and revision.id=${revisionId}::uuid and revision.finalized_at is not null
      where p.id=${projectId}::uuid
    )
    select item.id, item.project_id, item.paper_id, item.full_text_document_id,
      item.document_text_extraction_id, item.source_text, item.page_number,
      item.extraction_start_offset, item.extraction_end_offset, item.note,
      item.created_at, item.updated_at,
      (select review.decision from evidence_review_decisions review
        where review.project_id=item.project_id and review.evidence_id=item.id
        order by review.sequence desc limit 1) as current_review_decision
    from scoped_revision scope
    join extraction_revision_evidence link
      on link.project_id=scope.project_id and link.paper_id=scope.paper_id and link.revision_id=scope.revision_id
    join evidence item
      on item.project_id=link.project_id and item.paper_id=link.paper_id and item.id=link.evidence_id
    order by item.page_number asc, item.created_at asc
  `;
}

export function createExtractionHistoryReadServices(db: Database) {
  return {
    getExtractionFieldRevisionHistoryPage(
      projectId: string,
      paperId: string,
      fieldId: string,
      options: ExtractionHistoryPageOptions = {},
      executor?: ReadExecutor,
    ) {
      const project = ensureId(projectId).toLowerCase();
      const paper = ensureId(paperId).toLowerCase();
      const field = ensureId(fieldId).toLowerCase();
      const pageSize = effectiveExtractionHistoryPageSize(options.pageSize);
      const cursor = decodeExtractionHistoryCursor(options.cursor, { projectId: project, paperId: paper, fieldId: field, pageSize });

      return withExecutor(db, executor, async (read) => {
        const scopeRows = rows(await read.execute(historyScopeQuery(project, paper, field, cursor)));
        const scope = scopeRows[0];
        if (!scope || scope.project_id == null) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        if (scope.paper_id == null) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");
        if (scope.field_id == null) throw new DomainError("NOT_FOUND", "Extraction Field was not found");
        if (cursor && (!bool(scope.anchor_valid) || scope.extraction_value_id == null || String(scope.extraction_value_id) !== cursor.extractionValueId)) {
          throw invalidHistoryCursor();
        }

        const fieldContext = {
          id: String(scope.field_id),
          namePreview: String(scope.field_name_preview),
          nameTruncated: bool(scope.field_name_truncated),
          fieldType: String(scope.field_type) as ExtractionFieldType,
          archivedAt: nullableDate(scope.field_archived_at),
          extractionValueId: scope.extraction_value_id == null ? null : String(scope.extraction_value_id),
        };
        const current: CurrentExtractionRevisionIdentity | null = scope.current_revision_id == null ? null : {
          id: String(scope.current_revision_id),
          sequence: String(scope.current_sequence),
        };
        if (scope.extraction_value_id == null) {
          return { field: fieldContext, items: [], pageSize, hasMore: false, nextCursor: null, current };
        }

        const pageRows = rows(await read.execute(pageQuery(project, paper, field, fieldContext.extractionValueId!, pageSize, cursor)));
        const hasMore = pageRows.length > 0 && bool(pageRows[0].has_more);
        const items = pageRows.filter((row) => row.revision_id != null).map((row): ExtractionRevisionHistoryItem => {
          const id = String(row.revision_id);
          const valueState = String(row.value_state) as ExtractionValueState;
          const evidenceCount = String(row.evidence_count ?? "0");
          return {
            id,
            sequence: String(row.sequence),
            fieldType: String(row.field_type) as ExtractionFieldType,
            valueState,
            textValuePreview: nullableString(row.text_value_preview),
            textValueTruncated: bool(row.text_value_truncated),
            numberValue: nullableString(row.number_value),
            booleanValue: row.boolean_value == null ? null : row.boolean_value === true,
            optionId: nullableString(row.option_id),
            optionLabelPreview: nullableString(row.option_label_preview),
            optionLabelTruncated: bool(row.option_label_truncated),
            optionArchivedAt: nullableDate(row.option_archived_at),
            researcherNotePreview: nullableString(row.researcher_note_preview),
            researcherNoteTruncated: bool(row.researcher_note_truncated),
            createdAt: date(row.created_at),
            finalizedAt: date(row.finalized_at),
            evidenceCount,
            supportStatus: valueState !== "cleared" && evidenceCount !== "0" ? "grounded" : "ungrounded",
            isCurrent: current?.id === id,
            href: `/projects/${project}/extraction/${paper}/fields/${field}/revisions/${id}`,
          };
        });
        const last = items[items.length - 1];
        const nextCursor = hasMore && last ? encodeExtractionHistoryCursor({
          v: 1,
          projectId: project,
          paperId: paper,
          fieldId: field,
          extractionValueId: fieldContext.extractionValueId!,
          historyType: EXTRACTION_HISTORY_TYPE,
          pageSize,
          lastSequence: last.sequence,
          lastRevisionId: last.id,
        }) : null;
        return { field: fieldContext, items, pageSize, hasMore, nextCursor, current };
      });
    },

    async getExtractionRevisionExact(
      projectId: string,
      paperId: string,
      fieldId: string,
      revisionId: string,
      executor?: ReadExecutor,
    ): Promise<ExactExtractionRevisionAudit> {
      const project = ensureId(projectId).toLowerCase();
      const paper = ensureId(paperId).toLowerCase();
      const field = ensureId(fieldId).toLowerCase();
      const revision = ensureId(revisionId).toLowerCase();
      return withExecutor(db, executor, async (read) => {
        const [row] = rows(await read.execute(exactOwnershipQuery(project, paper, field, revision)));
        if (!row) throw new DomainError("NOT_FOUND", "Extraction revision was not found");

        const evidenceRows = rows(await read.execute(exactEvidenceQuery(project, paper, field, revision)));
        const exactEvidence: ExactExtractionRevisionAudit["revision"]["evidence"] = evidenceRows.map((item) => {
          const reviewState = evidenceReviewState(item.current_review_decision == null ? undefined : String(item.current_review_decision));
          const evidenceItem: Evidence = {
            id: String(item.id),
            projectId: String(item.project_id),
            paperId: String(item.paper_id),
            fullTextDocumentId: nullableString(item.full_text_document_id),
            documentTextExtractionId: nullableString(item.document_text_extraction_id),
            sourceText: String(item.source_text),
            pageNumber: Number(item.page_number),
            extractionStartOffset: item.extraction_start_offset == null ? null : Number(item.extraction_start_offset),
            extractionEndOffset: item.extraction_end_offset == null ? null : Number(item.extraction_end_offset),
            note: nullableString(item.note),
            createdAt: date(item.created_at),
            updatedAt: date(item.updated_at),
          };
          return {
            ...evidenceItem,
            reviewState,
            curationWarning: evidenceCurationWarning(reviewState),
          };
        });
        const isCurrentRevision = row.current_revision_id != null && String(row.current_revision_id) === String(row.revision_id);
        return {
          projectId: String(row.project_id) as ProjectId,
          paper: { id: String(row.paper_id), title: String(row.paper_title) },
          field: {
            id: String(row.field_id),
            name: String(row.field_name),
            fieldType: String(row.current_field_type) as ExtractionFieldType,
            archivedAt: nullableDate(row.field_archived_at),
          },
          revision: {
            id: String(row.revision_id),
            sequence: String(row.sequence),
            projectId: String(row.project_id) as ProjectId,
            paperId: String(row.paper_id) as ExactExtractionRevisionAudit["revision"]["paperId"],
            fieldId: String(row.field_id),
            extractionValueId: String(row.extraction_value_id),
            fieldType: String(row.field_type) as ExtractionFieldType,
            valueState: String(row.value_state) as ExtractionValueState,
            textValue: nullableString(row.text_value),
            numberValue: nullableString(row.number_value),
            booleanValue: row.boolean_value == null ? null : row.boolean_value === true,
            optionId: nullableString(row.option_id),
            researcherNote: nullableString(row.researcher_note),
            createdAt: date(row.created_at),
            finalizedAt: date(row.finalized_at),
            optionLabel: nullableString(row.option_label),
            optionArchivedAt: nullableDate(row.option_archived_at),
            evidence: exactEvidence,
          },
          isCurrentRevision,
        };
      });
    },
  };
}

export type ExtractionHistoryReadServices = ReturnType<typeof createExtractionHistoryReadServices>;
