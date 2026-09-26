import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import type { ExtractionFieldType } from "@/domain/types";
import type { PaperReviewStatus } from "@/domain/types";
import { DomainError } from "@/domain/errors";
import { ensureId } from "@/application/review-services/shared";
import { paperReviewFactsCtes, paperReviewStatusFromFacts, type PaperReviewFactsRow } from "@/application/paper-review-read-model";

export const SYNTHESIS_READ_DEFAULT_PAGE_SIZE = 50;
export const SYNTHESIS_READ_MAX_PAGE_SIZE = 100;

export type SynthesisComparisonPageOptions = {
  page?: string | number;
  pageSize?: number;
};

export type SynthesisComparisonPage = {
  items: Array<{
    paper: { id: string; projectId: string; title: string; createdAt: Date };
    field: { id: string; name: string; fieldType: ExtractionFieldType; required: boolean; sortOrder: number };
    extractionRevision: null | {
      id: string;
      sequence: number;
      valueState: "present" | "not_reported" | "not_applicable" | "cleared";
      textValue: string | null;
      numberValue: string | null;
      booleanValue: boolean | null;
      optionId: string | null;
      optionLabel: string | null;
    };
    valueState: "not_extracted" | "present" | "not_reported" | "not_applicable" | "cleared";
    displayValue: string | null;
    evidenceCount: number;
    supportStatus: "grounded" | "ungrounded";
    isSelectable: boolean;
  }>;
  field: { id: string; name: string; fieldType: ExtractionFieldType; required: boolean; sortOrder: number };
  summary: {
    totalIncludedPapers: number;
    counts: Record<"not_extracted" | "present" | "not_reported" | "not_applicable" | "cleared", number>;
  };
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    from: number;
    to: number;
  };
};

export type SynthesisLedgerPageOptions = SynthesisComparisonPageOptions;

export type SynthesisLedgerPage = {
  items: Array<{
    projectId: string;
    synthesisStatementId: string;
    statementCreatedAt: Date;
    id: string;
    sequence: number;
    state: "active" | "withdrawn";
    title: string | null;
    statementText: string | null;
    researcherNote: string | null;
    createdAt: Date;
    finalizedAt: Date;
    supportStatus: "supported" | "unsupported";
    supportingRevisionCount: number;
    supportingPaperCount: number;
    supportingFieldCount: number;
  }>;
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    from: number;
    to: number;
  };
};

export type SynthesisHistorySummary = {
  projectId: string;
  synthesisStatementId: string;
  id: string;
  sequence: number;
  state: "active" | "withdrawn";
  title: string | null;
  statementText: string | null;
  researcherNote: string | null;
  createdAt: Date;
  finalizedAt: Date;
  supportStatus: "supported" | "unsupported";
  supportingRevisionCount: number;
  supportingPaperCount: number;
  supportingFieldCount: number;
  supports: Array<{
    extractionRevisionId: string;
    extractionRevisionSequence: number;
    supportCreatedAt: Date;
    paperId: string;
    paperTitle: string;
    fieldId: string;
    fieldName: string;
    valueState: "present" | "not_reported" | "not_applicable" | "cleared";
    textValue: string | null;
    numberValue: string | null;
    booleanValue: boolean | null;
    optionId: string | null;
    optionLabel: string | null;
    displayValue: string;
    isCurrentExtractionRevision: boolean;
  }>;
};

export type SynthesisPreparationContextSummary = {
  synthesisRevisionId: string;
  preparationId: string;
  evidenceSetId: string;
  evidenceSetName: string;
  evidenceSetArchivedAt: Date | null;
  pinnedCompositionRevisionId: string;
  pinnedCompositionSequence: number;
  finalizedAt: Date;
};

export type SynthesisRevisionEditContextTarget = {
  paperId: string;
  fieldId: string;
  extractionRevisionId: string;
};

export type SynthesisRevisionEditContext = {
  paperId: string;
  fieldId: string;
  extractionRevisionId: string;
  reviewStatus: PaperReviewStatus;
  finalEligibility: PaperReviewStatus["finalEligibility"];
  exactSupportFinalized: boolean;
  exactSupportValueState: string;
  carryForwardEligible: boolean;
  fieldArchived: boolean;
  latestExtractionRevision: null | {
    id: string;
    sequence: number;
    valueState: string;
    displayValue: string | null;
  };
  replacementEligible: boolean;
};

type RawRow = Record<string, unknown>;

function rows<T extends RawRow>(value: unknown): T[] {
  return value as T[];
}

function countValue(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function pageRequest(value: string | number | undefined): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function pageSizeRequest(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return SYNTHESIS_READ_DEFAULT_PAGE_SIZE;
  return Math.min(value, SYNTHESIS_READ_MAX_PAGE_SIZE);
}

function pagination(requestedPage: number, pageSize: number, totalCount: number) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
  return {
    page,
    pageSize,
    totalCount,
    totalPages,
    from: totalCount === 0 ? 0 : (page - 1) * pageSize + 1,
    to: totalCount === 0 ? 0 : Math.min(page * pageSize, totalCount),
  };
}

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function displayExtractionValue(input: {
  valueState: string;
  textValue: unknown;
  numberValue: unknown;
  booleanValue: unknown;
  optionId: unknown;
  optionLabel: unknown;
}) {
  if (input.valueState !== "present") return input.valueState.replaceAll("_", " ");
  if (input.textValue != null) return String(input.textValue);
  if (input.numberValue != null) return String(input.numberValue);
  if (input.booleanValue != null) return Boolean(input.booleanValue) ? "Yes" : "No";
  if (input.optionLabel != null) return String(input.optionLabel);
  return input.optionId == null ? "—" : "Selected option";
}

function compactField(row: RawRow) {
  return {
    id: String(row.field_id),
    name: String(row.field_name),
    fieldType: String(row.field_type) as ExtractionFieldType,
    required: Boolean(row.field_required),
    sortOrder: Number(row.field_sort_order),
  };
}

function compactComparisonItem(row: RawRow): SynthesisComparisonPage["items"][number] {
  const revisionId = row.revision_id == null ? null : String(row.revision_id);
  const valueState = revisionId === null ? "not_extracted" : String(row.value_state) as "present" | "not_reported" | "not_applicable" | "cleared";
  const textValue = row.text_value == null ? null : String(row.text_value);
  const numberValue = row.number_value == null ? null : String(row.number_value);
  const booleanValue = row.boolean_value == null ? null : Boolean(row.boolean_value);
  const optionId = row.option_id == null ? null : String(row.option_id);
  const optionLabel = row.option_label == null ? null : String(row.option_label);
  const displayValue = valueState !== "present"
    ? null
    : textValue ?? numberValue ?? (booleanValue === null ? optionLabel : String(booleanValue));
  const evidenceCount = countValue(row.evidence_count);
  const extractionRevision = revisionId === null ? null : {
    id: revisionId,
    sequence: Number(row.revision_sequence),
    valueState: valueState as "present" | "not_reported" | "not_applicable" | "cleared",
    textValue,
    numberValue,
    booleanValue,
    optionId,
    optionLabel,
  };
  return {
    paper: {
      id: String(row.paper_id),
      projectId: String(row.project_id),
      title: String(row.paper_title),
      createdAt: dateValue(row.paper_created_at),
    },
    field: compactField(row),
    extractionRevision,
    valueState,
    displayValue,
    evidenceCount,
    supportStatus: revisionId !== null && valueState !== "cleared" && evidenceCount > 0 ? "grounded" : "ungrounded",
    isSelectable: revisionId !== null && valueState !== "cleared",
  };
}

function comparisonSummaryQuery(projectId: string, fieldId: string) {
  return sql`${paperReviewFactsCtes(projectId)}, active_field as (
      select id as field_id, name as field_name, field_type, required as field_required, sort_order as field_sort_order
      from extraction_fields
      where project_id=${projectId}::uuid and id=${fieldId}::uuid and archived_at is null
    ), current_values as (
      select f.paper_id, r.value_state
      from review_facts f
      cross join active_field af
      left join extraction_values v on v.project_id=${projectId}::uuid and v.paper_id=f.paper_id and v.field_id=af.field_id
      left join lateral (
        select r.value_state
        from extraction_value_revisions r
        where r.project_id=${projectId}::uuid and r.extraction_value_id=v.id and r.finalized_at is not null
        order by r.sequence desc, r.id desc
        limit 1
      ) r on true
      where f.title_abstract_decision='include' and f.full_text_decision='include'
    ), counts as (
      select count(*)::int as total_count,
        count(*) filter (where value_state is null)::int as not_extracted_count,
        count(*) filter (where value_state='present')::int as present_count,
        count(*) filter (where value_state='not_reported')::int as not_reported_count,
        count(*) filter (where value_state='not_applicable')::int as not_applicable_count,
        count(*) filter (where value_state='cleared')::int as cleared_count
      from current_values
    )
    select exists(select 1 from projects where id=${projectId}::uuid) as project_exists,
      af.field_id, af.field_name, af.field_type, af.field_required, af.field_sort_order,
      c.total_count, c.not_extracted_count, c.present_count, c.not_reported_count, c.not_applicable_count, c.cleared_count
    from counts c left join active_field af on true`;
}

function comparisonPageQuery(projectId: string, fieldId: string, limit: number, offset: number) {
  return sql`${paperReviewFactsCtes(projectId)}, active_field as (
      select id as field_id, name as field_name, field_type, required as field_required, sort_order as field_sort_order
      from extraction_fields
      where project_id=${projectId}::uuid and id=${fieldId}::uuid and archived_at is null
    ), page_papers as (
      select p.id as paper_id, p.project_id, p.title as paper_title, p.created_at as paper_created_at
      from review_facts f
      join papers p on p.project_id=f.project_id and p.id=f.paper_id
      where f.title_abstract_decision='include' and f.full_text_decision='include'
      order by p.created_at asc, p.id asc
      limit ${limit} offset ${offset}
    )
    select p.paper_id, p.project_id, p.paper_title, p.paper_created_at,
      af.field_id, af.field_name, af.field_type, af.field_required, af.field_sort_order,
      r.id as revision_id, r.sequence as revision_sequence, r.value_state,
      r.text_value, r.number_value, r.boolean_value, r.option_id, o.label as option_label,
      (select count(*)::int from extraction_revision_evidence er
        where er.project_id=${projectId}::uuid and er.revision_id=r.id) as evidence_count
    from page_papers p
    cross join active_field af
    left join extraction_values v on v.project_id=${projectId}::uuid and v.paper_id=p.paper_id and v.field_id=af.field_id
    left join lateral (
      select r.id, r.sequence, r.value_state, r.text_value, r.number_value, r.boolean_value, r.option_id
      from extraction_value_revisions r
      where r.project_id=${projectId}::uuid and r.extraction_value_id=v.id and r.finalized_at is not null
      order by r.sequence desc, r.id desc
      limit 1
    ) r on true
    left join extraction_options o on o.project_id=${projectId}::uuid and o.field_id=af.field_id and o.id=r.option_id
    order by p.paper_created_at asc, p.paper_id asc`;
}

function synthesisLedgerCountQuery(projectId: string) {
  return sql`select exists(select 1 from projects where id=${projectId}::uuid) as project_exists,
      count(*)::int as total_count
    from synthesis_statements s
    join lateral (
      select r.id
      from synthesis_revisions r
      where r.project_id=s.project_id and r.synthesis_statement_id=s.id and r.finalized_at is not null
      order by r.sequence desc
      limit 1
    ) current_revision on true
    where s.project_id=${projectId}::uuid`;
}

function synthesisLedgerPageQuery(projectId: string, limit: number, offset: number) {
  return sql`with page_statements as (
      select s.id as statement_id, s.project_id, s.created_at as statement_created_at,
        r.id as revision_id, r.sequence, r.state, r.title, r.statement_text, r.researcher_note,
        r.created_at, r.finalized_at
      from synthesis_statements s
      join lateral (
        select r.*
        from synthesis_revisions r
        where r.project_id=s.project_id and r.synthesis_statement_id=s.id and r.finalized_at is not null
        order by r.sequence desc
        limit 1
      ) r on true
      where s.project_id=${projectId}::uuid
      order by r.sequence desc, s.id asc
      limit ${limit} offset ${offset}
    ), support_counts as (
      select p.revision_id,
        count(distinct s.extraction_revision_id)::int as supporting_revision_count,
        count(distinct r.paper_id)::int as supporting_paper_count,
        count(distinct r.field_id)::int as supporting_field_count
      from page_statements p
      left join synthesis_revision_supports s on s.project_id=p.project_id and s.synthesis_revision_id=p.revision_id
      left join extraction_value_revisions r on r.project_id=s.project_id and r.id=s.extraction_revision_id
      group by p.revision_id
    )
    select p.statement_id, p.project_id, p.statement_created_at, p.revision_id, p.sequence,
      p.state, p.title, p.statement_text, p.researcher_note, p.created_at, p.finalized_at,
      coalesce(c.supporting_revision_count, 0)::int as supporting_revision_count,
      coalesce(c.supporting_paper_count, 0)::int as supporting_paper_count,
      coalesce(c.supporting_field_count, 0)::int as supporting_field_count
    from page_statements p
    left join support_counts c on c.revision_id=p.revision_id
    order by p.sequence desc, p.statement_id asc`;
}

function synthesisHistorySummaryQuery(projectId: string, statementId: string) {
  return sql`with target_revisions as (
      select r.id, r.project_id, r.synthesis_statement_id, r.sequence, r.state, r.title,
        r.statement_text, r.researcher_note, r.created_at, r.finalized_at
      from synthesis_revisions r
      where r.project_id=${projectId}::uuid and r.synthesis_statement_id=${statementId}::uuid and r.finalized_at is not null
    ), support_counts as (
      select s.synthesis_revision_id,
        count(distinct s.extraction_revision_id)::int as supporting_revision_count,
        count(distinct r.paper_id)::int as supporting_paper_count,
        count(distinct r.field_id)::int as supporting_field_count
      from target_revisions tr
      join synthesis_revision_supports s on s.project_id=tr.project_id and s.synthesis_revision_id=tr.id
      join extraction_value_revisions r on r.project_id=s.project_id and r.id=s.extraction_revision_id
      group by s.synthesis_revision_id
    )
    select tr.*, coalesce(c.supporting_revision_count, 0)::int as supporting_revision_count,
      coalesce(c.supporting_paper_count, 0)::int as supporting_paper_count,
      coalesce(c.supporting_field_count, 0)::int as supporting_field_count
    from target_revisions tr
    left join support_counts c on c.synthesis_revision_id=tr.id
    order by tr.sequence asc, tr.id asc`;
}

function synthesisHistorySupportsQuery(projectId: string, statementId: string) {
  return sql`select s.synthesis_revision_id, s.extraction_revision_id, s.created_at as support_created_at,
      r.id as revision_id, r.sequence as revision_sequence, r.value_state, r.text_value, r.number_value,
      r.boolean_value, r.option_id, o.label as option_label,
      p.id as paper_id, p.title as paper_title, f.id as field_id, f.name as field_name,
      exists(select 1 from extraction_value_revisions cr
        where cr.project_id=r.project_id and cr.extraction_value_id=r.extraction_value_id
          and cr.finalized_at is not null and cr.sequence > r.sequence) as has_newer_revision
    from synthesis_revisions sr
    join synthesis_revision_supports s on s.project_id=sr.project_id and s.synthesis_revision_id=sr.id
    join extraction_value_revisions r on r.project_id=s.project_id and r.id=s.extraction_revision_id and r.finalized_at is not null
    join papers p on p.project_id=r.project_id and p.id=r.paper_id
    join extraction_fields f on f.project_id=r.project_id and f.id=r.field_id
    left join extraction_options o on o.project_id=r.project_id and o.field_id=r.field_id and o.id=r.option_id
    where sr.project_id=${projectId}::uuid and sr.synthesis_statement_id=${statementId}::uuid and sr.finalized_at is not null
    order by s.synthesis_revision_id, s.created_at, s.extraction_revision_id`;
}

function synthesisPreparationContextsQuery(projectId: string, revisionIds: string[]) {
  const ids = sql.join(revisionIds.map((id) => sql`${id}::uuid`), sql`, `);
  return sql`select p.finalized_synthesis_revision_id as synthesis_revision_id,
      p.id as preparation_id, p.evidence_set_id, es.name as evidence_set_name,
      es.archived_at as evidence_set_archived_at, p.evidence_set_composition_revision_id,
      cr.sequence as pinned_composition_sequence, p.finalized_at
    from synthesis_preparations p
    join evidence_sets es on es.project_id=p.project_id and es.id=p.evidence_set_id
    join evidence_set_composition_revisions cr on cr.project_id=p.project_id
      and cr.evidence_set_id=p.evidence_set_id and cr.id=p.evidence_set_composition_revision_id
    where p.project_id=${projectId}::uuid and p.finalized_synthesis_revision_id in (${ids})`;
}

function synthesisRevisionEditContextQuery(projectId: string, targets: SynthesisRevisionEditContextTarget[], paperIds: string[]) {
  return sql`${paperReviewFactsCtes(projectId, paperIds)}, target_rows as (
      select (e.value->>'paperId')::uuid as paper_id,
        (e.value->>'fieldId')::uuid as field_id,
        (e.value->>'extractionRevisionId')::uuid as extraction_revision_id,
        e.ordinality as target_order
      from jsonb_array_elements(${JSON.stringify(targets)}::jsonb) with ordinality as e(value, ordinality)
    )
    select t.paper_id, t.field_id, t.extraction_revision_id, t.target_order,
      rf.title_abstract_decision, rf.full_text_decision, rf.full_text_retrieval_state,
      rf.has_retrieval_history, rf.ever_retrieved, rf.has_analytical_history,
      exact.finalized_at as exact_finalized_at, exact.value_state as exact_value_state,
      f.archived_at as field_archived_at,
      current_revision.id as current_revision_id, current_revision.sequence as current_revision_sequence,
      current_revision.value_state as current_value_state,
      current_revision.text_value as current_text_value, current_revision.number_value as current_number_value,
      current_revision.boolean_value as current_boolean_value, current_revision.option_id as current_option_id,
      current_option.label as current_option_label
    from target_rows t
    join review_facts rf on rf.project_id=${projectId}::uuid and rf.paper_id=t.paper_id
    join extraction_value_revisions exact on exact.project_id=${projectId}::uuid
      and exact.id=t.extraction_revision_id and exact.paper_id=t.paper_id and exact.field_id=t.field_id
    join extraction_fields f on f.project_id=${projectId}::uuid and f.id=t.field_id
    left join extraction_values v on v.project_id=${projectId}::uuid and v.paper_id=t.paper_id and v.field_id=t.field_id
    left join lateral (
      select r.id, r.sequence, r.value_state, r.text_value, r.number_value, r.boolean_value, r.option_id
      from extraction_value_revisions r
      where r.project_id=${projectId}::uuid and r.extraction_value_id=v.id and r.finalized_at is not null
      order by r.sequence desc, r.id desc
      limit 1
    ) current_revision on true
    left join extraction_options current_option on current_option.project_id=${projectId}::uuid
      and current_option.field_id=t.field_id and current_option.id=current_revision.option_id
    order by t.target_order`;
}

/** Bounded Synthesis matrix and full-population state summary from one snapshot. */
export function createSynthesisReadServices(db: Database) {
  return {
    async getSynthesisComparisonPage(projectId: string, fieldId: string, options: SynthesisComparisonPageOptions = {}): Promise<SynthesisComparisonPage> {
      ensureId(projectId);
      ensureId(fieldId);
      const requested = pageRequest(options.page);
      const pageSize = pageSizeRequest(options.pageSize);
      return db.transaction(async (tx) => {
        const summaryRows = rows<RawRow>(await tx.execute(comparisonSummaryQuery(projectId, fieldId)));
        const summaryRow = summaryRows[0];
        if (!summaryRow || !Boolean(summaryRow.project_exists)) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        if (summaryRow.field_id == null) throw new DomainError("CROSS_PROJECT_REFERENCE", "Extraction field does not belong to this project or is archived");
        const totalCount = countValue(summaryRow.total_count);
        const selectedPage = pagination(requested, pageSize, totalCount);
        const selectedRows = rows<RawRow>(await tx.execute(comparisonPageQuery(projectId, fieldId, selectedPage.pageSize, (selectedPage.page - 1) * selectedPage.pageSize)));
        const field = compactField(summaryRow);
        return {
          items: selectedRows.map(compactComparisonItem),
          field,
          summary: {
            totalIncludedPapers: totalCount,
            counts: {
              not_extracted: countValue(summaryRow.not_extracted_count),
              present: countValue(summaryRow.present_count),
              not_reported: countValue(summaryRow.not_reported_count),
              not_applicable: countValue(summaryRow.not_applicable_count),
              cleared: countValue(summaryRow.cleared_count),
            },
          },
          pagination: selectedPage,
        };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async getSynthesisLedgerPage(projectId: string, options: SynthesisLedgerPageOptions = {}): Promise<SynthesisLedgerPage> {
      ensureId(projectId);
      const requested = pageRequest(options.page);
      const pageSize = pageSizeRequest(options.pageSize);
      return db.transaction(async (tx) => {
        const countRows = rows<RawRow>(await tx.execute(synthesisLedgerCountQuery(projectId)));
        const countRow = countRows[0];
        if (!countRow || !Boolean(countRow.project_exists)) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        const totalCount = countValue(countRow.total_count);
        const selectedPage = pagination(requested, pageSize, totalCount);
        const selectedRows = rows<RawRow>(await tx.execute(synthesisLedgerPageQuery(projectId, selectedPage.pageSize, (selectedPage.page - 1) * selectedPage.pageSize)));
        return {
          items: selectedRows.map((row) => {
            const supportingRevisionCount = countValue(row.supporting_revision_count);
            return {
              projectId: String(row.project_id),
              synthesisStatementId: String(row.statement_id),
              statementCreatedAt: dateValue(row.statement_created_at),
              id: String(row.revision_id),
              sequence: Number(row.sequence),
              state: String(row.state) as "active" | "withdrawn",
              title: row.title == null ? null : String(row.title),
              statementText: row.statement_text == null ? null : String(row.statement_text),
              researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
              createdAt: dateValue(row.created_at),
              finalizedAt: dateValue(row.finalized_at),
              supportStatus: supportingRevisionCount > 0 ? "supported" as const : "unsupported" as const,
              supportingRevisionCount,
              supportingPaperCount: countValue(row.supporting_paper_count),
              supportingFieldCount: countValue(row.supporting_field_count),
            };
          }),
          pagination: selectedPage,
        };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async getSynthesisHistorySummaries(projectId: string, statementId: string): Promise<SynthesisHistorySummary[]> {
      ensureId(projectId);
      ensureId(statementId);
      const revisionRows = rows<RawRow>(await db.execute(synthesisHistorySummaryQuery(projectId, statementId)));
      if (revisionRows.length === 0) return [];
      const supportRows = rows<RawRow>(await db.execute(synthesisHistorySupportsQuery(projectId, statementId)));
      const supportsByRevision = new Map<string, SynthesisHistorySummary["supports"]>();
      for (const row of supportRows) {
        const revisionId = String(row.synthesis_revision_id);
        const valueState = String(row.value_state) as "present" | "not_reported" | "not_applicable" | "cleared";
        supportsByRevision.set(revisionId, [...(supportsByRevision.get(revisionId) ?? []), {
          extractionRevisionId: String(row.extraction_revision_id),
          extractionRevisionSequence: Number(row.revision_sequence),
          supportCreatedAt: dateValue(row.support_created_at),
          paperId: String(row.paper_id),
          paperTitle: String(row.paper_title),
          fieldId: String(row.field_id),
          fieldName: String(row.field_name),
          valueState,
          textValue: row.text_value == null ? null : String(row.text_value),
          numberValue: row.number_value == null ? null : String(row.number_value),
          booleanValue: row.boolean_value == null ? null : Boolean(row.boolean_value),
          optionId: row.option_id == null ? null : String(row.option_id),
          optionLabel: row.option_label == null ? null : String(row.option_label),
          displayValue: displayExtractionValue({
            valueState,
            textValue: row.text_value,
            numberValue: row.number_value,
            booleanValue: row.boolean_value,
            optionId: row.option_id,
            optionLabel: row.option_label,
          }),
          isCurrentExtractionRevision: !Boolean(row.has_newer_revision),
        }]);
      }
      return revisionRows.map((row) => {
        const supports = supportsByRevision.get(String(row.id)) ?? [];
        const supportingRevisionCount = countValue(row.supporting_revision_count);
        return {
          projectId: String(row.project_id),
          synthesisStatementId: String(row.synthesis_statement_id),
          id: String(row.id),
          sequence: Number(row.sequence),
          state: String(row.state) as "active" | "withdrawn",
          title: row.title == null ? null : String(row.title),
          statementText: row.statement_text == null ? null : String(row.statement_text),
          researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
          createdAt: dateValue(row.created_at),
          finalizedAt: dateValue(row.finalized_at),
          supportStatus: supportingRevisionCount > 0 ? "supported" as const : "unsupported" as const,
          supportingRevisionCount,
          supportingPaperCount: countValue(row.supporting_paper_count),
          supportingFieldCount: countValue(row.supporting_field_count),
          supports,
        };
      });
    },

    async getSynthesisPreparationContextsForRevisions(projectId: string, revisionIds: string[]): Promise<SynthesisPreparationContextSummary[]> {
      ensureId(projectId);
      revisionIds.forEach(ensureId);
      if (revisionIds.length === 0) return [];
      const contextRows = rows<RawRow>(await db.execute(synthesisPreparationContextsQuery(projectId, revisionIds)));
      return contextRows.map((row) => ({
        synthesisRevisionId: String(row.synthesis_revision_id),
        preparationId: String(row.preparation_id),
        evidenceSetId: String(row.evidence_set_id),
        evidenceSetName: String(row.evidence_set_name),
        evidenceSetArchivedAt: row.evidence_set_archived_at == null ? null : dateValue(row.evidence_set_archived_at),
        pinnedCompositionRevisionId: String(row.evidence_set_composition_revision_id),
        pinnedCompositionSequence: Number(row.pinned_composition_sequence),
        finalizedAt: dateValue(row.finalized_at),
      }));
    },

    async getSynthesisRevisionEditContext(projectId: string, targets: SynthesisRevisionEditContextTarget[]): Promise<SynthesisRevisionEditContext[]> {
      ensureId(projectId);
      for (const target of targets) {
        ensureId(target.paperId);
        ensureId(target.fieldId);
        ensureId(target.extractionRevisionId);
      }
      if (targets.length === 0) return [];
      const paperIds = [...new Set(targets.map((target) => target.paperId))];
      const contextRows = rows<RawRow>(await db.execute(synthesisRevisionEditContextQuery(projectId, targets, paperIds)));
      if (contextRows.length !== targets.length) {
        throw new DomainError("CROSS_PROJECT_REFERENCE", "One or more synthesis supports do not match their Paper and Field");
      }
      return contextRows.map((row) => {
        const reviewStatus = paperReviewStatusFromFacts(row as unknown as PaperReviewFactsRow);
        const finalEligibility = reviewStatus.finalEligibility;
        const exactSupportFinalized = row.exact_finalized_at != null;
        const exactSupportValueState = String(row.exact_value_state);
        const carryForwardEligible = finalEligibility === "included" && exactSupportFinalized && exactSupportValueState !== "cleared";
        const fieldArchived = row.field_archived_at != null;
        const latestRevisionId = row.current_revision_id == null ? null : String(row.current_revision_id);
        const latestValueState = row.current_value_state == null ? null : String(row.current_value_state);
        const latestExtractionRevision = latestRevisionId === null || latestValueState === null ? null : {
          id: latestRevisionId,
          sequence: Number(row.current_revision_sequence),
          valueState: latestValueState,
          displayValue: displayExtractionValue({
            valueState: latestValueState,
            textValue: row.current_text_value,
            numberValue: row.current_number_value,
            booleanValue: row.current_boolean_value,
            optionId: row.current_option_id,
            optionLabel: row.current_option_label,
          }),
        };
        const replacementEligible = !fieldArchived && finalEligibility === "included"
          && latestExtractionRevision !== null
          && latestExtractionRevision.id !== String(row.extraction_revision_id)
          && latestExtractionRevision.valueState !== "cleared";
        return {
          paperId: String(row.paper_id),
          fieldId: String(row.field_id),
          extractionRevisionId: String(row.extraction_revision_id),
          reviewStatus,
          finalEligibility,
          exactSupportFinalized,
          exactSupportValueState,
          carryForwardEligible,
          fieldArchived,
          latestExtractionRevision,
          replacementEligible,
        };
      });
    },
  };
}

export type SynthesisReadServices = ReturnType<typeof createSynthesisReadServices>;
