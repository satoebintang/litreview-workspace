import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { ensureId } from "@/application/review-services/shared";
import {
  decodeClaimSynthesisHistoryCursor,
  effectiveClaimSynthesisHistoryPageSize,
  encodeClaimSynthesisHistoryCursor,
} from "./claim-synthesis-history-cursor";
import type {
  ClaimRevisionHistoryCursor,
  ClaimRevisionHistoryItem,
  CurrentClaimRevisionIdentity,
  CurrentSynthesisInterpretationIdentity,
  CurrentSynthesisRevisionIdentity,
  HistoryPage,
  HistoryPageOptions,
  SynthesisInterpretationHistoryPageOptions,
  SynthesisInterpretationHistoryItem,
  SynthesisRevisionHistoryCursor,
  SynthesisRevisionHistoryItem,
  SynthesisPreparationHistorySummary,
  SynthesisInterpretationHistoryCursor,
} from "./claim-synthesis-history-read-types";

const READ_TRANSACTION = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
type ReadExecutor = Pick<Database, "execute">;
type RawRow = Record<string, unknown>;

function rows(value: unknown): RawRow[] {
  return value as unknown as RawRow[];
}

function number(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isSafeInteger(result) && result >= 0 ? result : 0;
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : date(value);
}

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === 1;
}

function lifecycle(value: unknown): "active" | "withdrawn" {
  return String(value) === "withdrawn" ? "withdrawn" : "active";
}

async function withExecutor<T>(
  db: Database,
  executor: ReadExecutor | undefined,
  operation: (executor: ReadExecutor) => Promise<T>,
): Promise<T> {
  if (executor) return operation(executor);
  return db.transaction((tx) => operation(tx), READ_TRANSACTION);
}

function historyCursorInvalid(): DomainError {
  return new DomainError("VALIDATION_ERROR", "History link is invalid or belongs to a different record. Start from the first page.");
}

function claimHistoryScopeQuery(projectId: string, claimId: string, cursor: ClaimRevisionHistoryCursor | null) {
  const anchorMembership = cursor
    ? sql`exists (
        select 1 from claim_revisions anchor
        where anchor.project_id=p.id and anchor.claim_id=c.id
          and anchor.id=${cursor.lastEventId}::uuid
          and anchor.sequence=${cursor.lastSequence}::bigint
          and anchor.finalized_at is not null
      )`
    : sql`true`;
  return sql`
    select p.id is not null as project_exists, c.id is not null as claim_exists,
      ${anchorMembership} as anchor_valid,
      current_r.id as current_id, current_r.sequence::text as current_sequence, current_r.state as current_state
    from projects p
    left join claims c on c.project_id=p.id and c.id=${claimId}::uuid
    left join lateral (
      select r.id, r.sequence, r.state
      from claim_revisions r
      where r.project_id=p.id and r.claim_id=c.id and r.finalized_at is not null
      order by r.sequence desc
      limit 1
    ) current_r on true
    where p.id=${projectId}::uuid
  `;
}

function claimHistoryPageQuery(projectId: string, claimId: string, pageSize: number, cursor: ClaimRevisionHistoryCursor | null) {
  const cursorRange = cursor
    ? sql`and (r.sequence, r.id) < (${cursor.lastSequence}::bigint, ${cursor.lastEventId}::uuid)`
    : sql``;
  return sql`
    with page_keys as materialized (
      select r.id, r.sequence::text as sequence
      from claim_revisions r
      where r.project_id=${projectId}::uuid and r.claim_id=${claimId}::uuid
        and r.finalized_at is not null ${cursorRange}
      order by r.sequence desc, r.id desc
      limit ${pageSize + 1}
    ),
    visible_page as materialized (
      select id, sequence from page_keys
      order by sequence::bigint desc, id desc
      limit ${pageSize}
    ),
    page_state as (select count(*) > ${pageSize} as has_more from page_keys),
    evidence_support_counts as (
      select s.claim_revision_id, count(*)::text as support_count
      from claim_revision_evidence_supports s
      join visible_page v on v.id=s.claim_revision_id
      group by s.claim_revision_id
    ),
    extraction_support_counts as (
      select s.claim_revision_id, count(*)::text as support_count
      from claim_revision_extraction_supports s
      join visible_page v on v.id=s.claim_revision_id
      group by s.claim_revision_id
    ),
    synthesis_support_counts as (
      select s.claim_revision_id, count(*)::text as support_count
      from claim_revision_synthesis_supports s
      join visible_page v on v.id=s.claim_revision_id
      group by s.claim_revision_id
    ),
    structural_papers as (
      select s.claim_revision_id, e.paper_id
      from claim_revision_evidence_supports s
      join visible_page v on v.id=s.claim_revision_id
      join evidence e on e.project_id=s.project_id and e.id=s.evidence_id
      union
      select s.claim_revision_id, x.paper_id
      from claim_revision_extraction_supports s
      join visible_page v on v.id=s.claim_revision_id
      join extraction_value_revisions x on x.project_id=s.project_id and x.id=s.extraction_revision_id
      union
      select s.claim_revision_id, x.paper_id
      from claim_revision_synthesis_supports s
      join visible_page v on v.id=s.claim_revision_id
      join synthesis_revision_supports ss on ss.project_id=s.project_id and ss.synthesis_revision_id=s.synthesis_revision_id
      join extraction_value_revisions x on x.project_id=ss.project_id and x.id=ss.extraction_revision_id
    ),
    citation_papers as (
      select s.claim_revision_id, e.paper_id
      from claim_revision_evidence_supports s
      join visible_page v on v.id=s.claim_revision_id
      join evidence e on e.project_id=s.project_id and e.id=s.evidence_id
      union
      select s.claim_revision_id, x.paper_id
      from claim_revision_extraction_supports s
      join visible_page v on v.id=s.claim_revision_id
      join extraction_value_revisions x on x.project_id=s.project_id and x.id=s.extraction_revision_id
      join extraction_revision_evidence path on path.project_id=x.project_id and path.revision_id=x.id and path.paper_id=x.paper_id
      union
      select s.claim_revision_id, x.paper_id
      from claim_revision_synthesis_supports s
      join visible_page v on v.id=s.claim_revision_id
      join synthesis_revision_supports ss on ss.project_id=s.project_id and ss.synthesis_revision_id=s.synthesis_revision_id
      join extraction_value_revisions x on x.project_id=ss.project_id and x.id=ss.extraction_revision_id
      join extraction_revision_evidence path on path.project_id=x.project_id and path.revision_id=x.id and path.paper_id=x.paper_id
    ),
    structural_counts as (
      select claim_revision_id, count(*)::text as paper_count from structural_papers group by claim_revision_id
    ),
    citation_counts as (
      select claim_revision_id, count(*)::text as paper_count from citation_papers group by claim_revision_id
    ),
    hydrated as (
      select v.id, v.sequence, r.state, r.claim_text, r.researcher_note, r.created_at, r.finalized_at
      from visible_page v
      join claim_revisions r on r.project_id=${projectId}::uuid and r.claim_id=${claimId}::uuid
        and r.id=v.id and r.finalized_at is not null
    ),
    metrics as (
      select h.*,
        coalesce(e.support_count, '0') as direct_evidence_count,
        coalesce(x.support_count, '0') as extraction_revision_count,
        coalesce(s.support_count, '0') as synthesis_revision_count,
        coalesce(e.support_count::bigint, 0) + coalesce(x.support_count::bigint, 0) + coalesce(s.support_count::bigint, 0) as total_support_count,
        coalesce(c.paper_count, '0') as citation_candidate_count,
        coalesce(p.paper_count, '0') as distinct_paper_count,
        case when h.state='active' and
          (coalesce(e.support_count::bigint, 0) + coalesce(x.support_count::bigint, 0) + coalesce(s.support_count::bigint, 0)) > 0
          then 'supported' else 'unsupported' end as support_status
      from hydrated h
      left join evidence_support_counts e on e.claim_revision_id=h.id
      left join extraction_support_counts x on x.claim_revision_id=h.id
      left join synthesis_support_counts s on s.claim_revision_id=h.id
      left join citation_counts c on c.claim_revision_id=h.id
      left join structural_counts p on p.claim_revision_id=h.id
    )
    select ps.has_more, r.id as revision_id, r.sequence, r.state,
      left(r.claim_text, 448) as claim_text_preview,
      (r.claim_text is not null and char_length(r.claim_text) > 448) as claim_text_truncated,
      left(r.researcher_note, 256) as researcher_note_preview,
      (r.researcher_note is not null and char_length(r.researcher_note) > 256) as researcher_note_truncated,
      r.created_at, r.finalized_at, r.support_status, r.direct_evidence_count,
      r.extraction_revision_count, r.synthesis_revision_count, r.total_support_count,
      r.citation_candidate_count, r.distinct_paper_count
    from page_state ps
    left join metrics r on true
    order by r.sequence::bigint desc nulls last, r.id desc nulls last
  `;
}

function synthesisHistoryScopeQuery(projectId: string, statementId: string, cursor: SynthesisRevisionHistoryCursor | null) {
  const anchorMembership = cursor
    ? sql`exists (
        select 1 from synthesis_revisions anchor
        where anchor.project_id=p.id and anchor.synthesis_statement_id=s.id
          and anchor.id=${cursor.lastEventId}::uuid
          and anchor.sequence=${cursor.lastSequence}::bigint
          and anchor.finalized_at is not null
      )`
    : sql`true`;
  return sql`
    select p.id is not null as project_exists, s.id is not null as statement_exists,
      ${anchorMembership} as anchor_valid,
      current_r.id as current_id, current_r.sequence::text as current_sequence, current_r.state as current_state
    from projects p
    left join synthesis_statements s on s.project_id=p.id and s.id=${statementId}::uuid
    left join lateral (
      select r.id, r.sequence, r.state
      from synthesis_revisions r
      where r.project_id=p.id and r.synthesis_statement_id=s.id and r.finalized_at is not null
      order by r.sequence desc
      limit 1
    ) current_r on true
    where p.id=${projectId}::uuid
  `;
}

function synthesisHistoryPageQuery(projectId: string, statementId: string, pageSize: number, cursor: SynthesisRevisionHistoryCursor | null) {
  const cursorRange = cursor
    ? sql`and (r.sequence, r.id) > (${cursor.lastSequence}::bigint, ${cursor.lastEventId}::uuid)`
    : sql``;
  return sql`
    with page_keys as materialized (
      select r.id, r.sequence::text as sequence
      from synthesis_revisions r
      where r.project_id=${projectId}::uuid and r.synthesis_statement_id=${statementId}::uuid
        and r.finalized_at is not null ${cursorRange}
      order by r.sequence asc, r.id asc
      limit ${pageSize + 1}
    ),
    visible_page as materialized (
      select id, sequence from page_keys
      order by sequence::bigint asc, id asc
      limit ${pageSize}
    ),
    page_state as (select count(*) > ${pageSize} as has_more from page_keys),
    support_counts as (
      select v.id as synthesis_revision_id, counts.supporting_revision_count,
        counts.supporting_paper_count, counts.supporting_field_count
      from visible_page v
      cross join lateral (
        select count(distinct s.extraction_revision_id)::text as supporting_revision_count,
          count(distinct x.paper_id)::text as supporting_paper_count,
          count(distinct x.field_id)::text as supporting_field_count
        from synthesis_revision_supports s
        join extraction_value_revisions x on x.project_id=s.project_id and x.id=s.extraction_revision_id
        where s.project_id=${projectId}::uuid and s.synthesis_revision_id=v.id
      ) counts
    ),
    hydrated as (
      select v.id, v.sequence, r.state, r.title, r.statement_text, r.researcher_note, r.created_at, r.finalized_at
      from visible_page v
      join synthesis_revisions r on r.project_id=${projectId}::uuid
        and r.synthesis_statement_id=${statementId}::uuid and r.id=v.id and r.finalized_at is not null
    ),
    metrics as (
      select h.*, coalesce(c.supporting_revision_count, '0') as supporting_revision_count,
        coalesce(c.supporting_paper_count, '0') as supporting_paper_count,
        coalesce(c.supporting_field_count, '0') as supporting_field_count,
        (coalesce(c.supporting_revision_count::bigint, 0) > 0) as is_supported
      from hydrated h left join support_counts c on c.synthesis_revision_id=h.id
    )
    select ps.has_more,
      r.id as revision_id, r.sequence, r.state, left(r.title, 96) as title_preview,
      (r.title is not null and char_length(r.title) > 96) as title_truncated,
      left(r.statement_text, 320) as statement_preview,
      (r.statement_text is not null and char_length(r.statement_text) > 320) as statement_truncated,
      left(r.researcher_note, 160) as researcher_note_preview,
      (r.researcher_note is not null and char_length(r.researcher_note) > 160) as researcher_note_truncated,
      r.created_at, r.finalized_at, r.is_supported,
      r.supporting_revision_count, r.supporting_paper_count, r.supporting_field_count
    from page_state ps
    left join metrics r on true
    order by r.sequence::bigint asc nulls last, r.id asc nulls last
  `;
}

function synthesisPreparationHistoryQuery(projectId: string, revisionIds: string[]) {
  const ids = sql.join(revisionIds.map((id) => sql`${id}::uuid`), sql`, `);
  return sql`
    select p.finalized_synthesis_revision_id as synthesis_revision_id,
      p.id as preparation_id, p.evidence_set_id, left(es.name, 64) as evidence_set_name_preview,
      (char_length(es.name) > 64) as evidence_set_name_truncated,
      es.archived_at as evidence_set_archived_at, p.evidence_set_composition_revision_id,
      cr.sequence::text as pinned_composition_sequence, p.finalized_at
    from synthesis_preparations p
    join evidence_sets es on es.project_id=p.project_id and es.id=p.evidence_set_id
    join evidence_set_composition_revisions cr on cr.project_id=p.project_id
      and cr.evidence_set_id=p.evidence_set_id and cr.id=p.evidence_set_composition_revision_id
    where p.project_id=${projectId}::uuid and p.finalized_synthesis_revision_id in (${ids})
  `;
}

function interpretationHistoryScopeAndPageKeysQuery(
  projectId: string,
  statementId: string,
  revisionId: string,
  pageSize: number,
  cursor: SynthesisInterpretationHistoryCursor | null,
  selectedCurrentIdentity: CurrentSynthesisInterpretationIdentity | null | undefined,
) {
  const anchorMembership = cursor
    ? sql`exists (
        select 1 from synthesis_interpretations anchor
        join scope s on s.project_id=anchor.project_id and s.statement_id=anchor.synthesis_statement_id
          and s.revision_id=anchor.synthesis_revision_id
        where anchor.id=${cursor.lastEventId}::uuid
          and anchor.sequence=${cursor.lastSequence}::bigint
          and anchor.finalized_at is not null
      )`
    : sql`true`;
  const cursorRange = cursor
    ? sql`and (i.sequence, i.id) < (${cursor.lastSequence}::bigint, ${cursor.lastEventId}::uuid)`
    : sql``;
  const currentInterpretationCte = selectedCurrentIdentity === undefined
    ? sql`current_interpretation as (
        select i.id, i.sequence::text as sequence, i.convergence_state, i.finalized_at
        from scope s
        join lateral (
          select current_i.id, current_i.sequence, current_i.convergence_state, current_i.finalized_at
          from synthesis_interpretations current_i
          where current_i.project_id=s.project_id and current_i.synthesis_statement_id=s.statement_id
            and current_i.synthesis_revision_id=s.revision_id and current_i.finalized_at is not null
          order by current_i.sequence desc
          limit 1
        ) i on true
      )`
    : selectedCurrentIdentity === null
      ? sql`current_interpretation as (
          select null::uuid as id, null::text as sequence, null::text as convergence_state,
            null::timestamptz as finalized_at
          from scope s where false
        )`
      : sql`current_interpretation as (
          select i.id, i.sequence::text as sequence, i.convergence_state, i.finalized_at
          from scope s
          join synthesis_interpretations i on i.project_id=s.project_id
            and i.synthesis_statement_id=s.statement_id and i.synthesis_revision_id=s.revision_id
            and i.id=${selectedCurrentIdentity.id}::uuid and i.finalized_at is not null
        )`;
  return sql`
    with scope as materialized (
      select p.id as project_id, s.id as statement_id, r.id as revision_id
      from projects p
      left join synthesis_statements s on s.project_id=p.id and s.id=${statementId}::uuid
      left join synthesis_revisions r on r.project_id=s.project_id and r.synthesis_statement_id=s.id
        and r.id=${revisionId}::uuid and r.finalized_at is not null
      where p.id=${projectId}::uuid
    ),
    ${currentInterpretationCte},
    anchor_status as (select ${anchorMembership} as anchor_valid),
    page_keys as materialized (
      select i.id, i.sequence::text as sequence
      from synthesis_interpretations i
      where i.project_id=${projectId}::uuid and i.synthesis_statement_id=${statementId}::uuid
        and i.synthesis_revision_id=${revisionId}::uuid and i.finalized_at is not null ${cursorRange}
      order by i.sequence desc, i.id desc
      limit ${pageSize + 1}
    ),
    page_state as (select count(*) > ${pageSize} as has_more from page_keys)
    select s.project_id is not null as project_exists, s.statement_id is not null as statement_exists,
      s.revision_id is not null as revision_exists, a.anchor_valid,
      current_i.id as current_id, current_i.sequence as current_sequence,
      current_i.convergence_state as current_convergence_state, current_i.finalized_at as current_finalized_at,
      ps.has_more, k.id as interpretation_id, k.sequence as interpretation_sequence
    from scope s
    cross join anchor_status a
    cross join page_state ps
    left join current_interpretation current_i on true
    left join page_keys k on true
    order by k.sequence::bigint desc nulls last, k.id desc nulls last
  `;
}

function interpretationHistoryHydrationQuery(
  projectId: string,
  statementId: string,
  revisionId: string,
  visibleIds: string[],
) {
  const visibleIdsArray = sql`${sql.param(visibleIds)}::uuid[]`;
  return sql`
    with visible_page as materialized (
      select i.id, i.sequence::text as sequence
      from synthesis_interpretations i
      where i.project_id=${projectId}::uuid and i.synthesis_statement_id=${statementId}::uuid
        and i.synthesis_revision_id=${revisionId}::uuid and i.finalized_at is not null
        and i.id=any(${visibleIdsArray})
    ),
    limitation_counts as (
      select l.interpretation_id, count(*)::text as child_count
      from synthesis_interpretation_limitations l
      where l.project_id=${projectId}::uuid and l.interpretation_id=any(${visibleIdsArray})
      group by l.interpretation_id
    ),
    question_counts as (
      select q.interpretation_id, count(*)::text as child_count
      from synthesis_interpretation_questions q
      where q.project_id=${projectId}::uuid and q.interpretation_id=any(${visibleIdsArray})
      group by q.interpretation_id
    ),
    contradiction_counts as (
      select c.interpretation_id, count(*)::text as child_count
      from synthesis_interpretation_contradictions c
      where c.project_id=${projectId}::uuid and c.interpretation_id=any(${visibleIdsArray})
      group by c.interpretation_id
    ),
    hydrated as (
      select v.id, v.sequence, i.convergence_state, i.summary, i.researcher_note, i.created_at, i.finalized_at
      from visible_page v
      join synthesis_interpretations i on i.project_id=${projectId}::uuid
        and i.synthesis_statement_id=${statementId}::uuid and i.synthesis_revision_id=${revisionId}::uuid
        and i.id=v.id and i.finalized_at is not null
    ),
    metrics as (
      select h.*, coalesce(l.child_count, '0') as limitation_count,
        coalesce(q.child_count, '0') as question_count,
        coalesce(c.child_count, '0') as contradiction_count
      from hydrated h
      left join limitation_counts l on l.interpretation_id=h.id
      left join question_counts q on q.interpretation_id=h.id
      left join contradiction_counts c on c.interpretation_id=h.id
    )
    select r.id as interpretation_id, r.sequence, r.convergence_state,
      left(r.summary, 448) as summary_preview, (char_length(r.summary) > 448) as summary_truncated,
      left(r.researcher_note, 256) as researcher_note_preview,
      (r.researcher_note is not null and char_length(r.researcher_note) > 256) as researcher_note_truncated,
      r.created_at, r.finalized_at, r.limitation_count, r.question_count, r.contradiction_count
    from metrics r
    order by r.sequence::bigint desc, r.id desc
  `;
}

function normalizeScope(projectId: string, parentId: string) {
  return { projectId: ensureId(projectId).toLowerCase(), parentId: ensureId(parentId).toLowerCase() };
}

export function createClaimSynthesisHistoryReadServices(db: Database) {
  return {
    getClaimRevisionHistoryPage(
      projectId: string,
      claimId: string,
      options: HistoryPageOptions = {},
      executor?: ReadExecutor,
    ): Promise<HistoryPage<ClaimRevisionHistoryItem, CurrentClaimRevisionIdentity>> {
      const scope = normalizeScope(projectId, claimId);
      const pageSize = effectiveClaimSynthesisHistoryPageSize(options.pageSize);
      const cursor = decodeClaimSynthesisHistoryCursor(options.cursor, {
        projectId: scope.projectId,
        claimId: scope.parentId,
        historyType: "claim-revision",
        pageSize,
      }) as ClaimRevisionHistoryCursor | null;
      return withExecutor(db, executor, async (read) => {
        const scopeRows = rows(await read.execute(claimHistoryScopeQuery(scope.projectId, scope.parentId, cursor)));
        if (!scopeRows.length || !bool(scopeRows[0].project_exists)) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        if (!bool(scopeRows[0].claim_exists)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim does not belong to this project");
        if (cursor && !bool(scopeRows[0].anchor_valid)) throw historyCursorInvalid();
        const currentRow = scopeRows[0];
        const resultRows = rows(await read.execute(claimHistoryPageQuery(scope.projectId, scope.parentId, pageSize, cursor)));
        const items = resultRows.filter((row) => row.revision_id != null).map((row): ClaimRevisionHistoryItem => ({
          id: String(row.revision_id),
          sequence: String(row.sequence),
          lifecycle: lifecycle(row.state),
          isCurrent: row.revision_id === currentRow.current_id,
          claimTextPreview: row.claim_text_preview == null ? null : String(row.claim_text_preview),
          claimTextTruncated: bool(row.claim_text_truncated),
          researcherNotePreview: row.researcher_note_preview == null ? null : String(row.researcher_note_preview),
          researcherNoteTruncated: bool(row.researcher_note_truncated),
          createdAt: date(row.created_at),
          finalizedAt: date(row.finalized_at),
          supportStatus: String(row.support_status) === "supported" ? "supported" : "unsupported",
          directEvidenceCount: number(row.direct_evidence_count),
          extractionRevisionCount: number(row.extraction_revision_count),
          synthesisRevisionCount: number(row.synthesis_revision_count),
          totalSupportCount: number(row.total_support_count),
          citationCandidateCount: number(row.citation_candidate_count),
          distinctPaperCount: number(row.distinct_paper_count),
          href: `/projects/${scope.projectId}/claims/${scope.parentId}/revisions/${String(row.revision_id)}`,
        }));
        const current: CurrentClaimRevisionIdentity | null = currentRow.current_id == null ? null : {
          id: String(currentRow.current_id), sequence: String(currentRow.current_sequence), lifecycle: lifecycle(currentRow.current_state),
        };
        const hasMore = bool(resultRows[0]?.has_more);
        const last = items[items.length - 1];
        const nextCursor = hasMore && last ? encodeClaimSynthesisHistoryCursor({
          v: 1, projectId: scope.projectId, claimId: scope.parentId, historyType: "claim-revision",
          pageSize, lastSequence: last.sequence, lastEventId: last.id,
        }) : null;
        return { items, pageSize, hasMore, nextCursor, current };
      });
    },

    getSynthesisRevisionHistoryPage(
      projectId: string,
      statementId: string,
      options: HistoryPageOptions = {},
      executor?: ReadExecutor,
    ): Promise<HistoryPage<SynthesisRevisionHistoryItem, CurrentSynthesisRevisionIdentity>> {
      const scope = normalizeScope(projectId, statementId);
      const pageSize = effectiveClaimSynthesisHistoryPageSize(options.pageSize);
      const cursor = decodeClaimSynthesisHistoryCursor(options.cursor, {
        projectId: scope.projectId, statementId: scope.parentId, historyType: "synthesis-revision", pageSize,
      }) as SynthesisRevisionHistoryCursor | null;
      return withExecutor(db, executor, async (read) => {
        const scopeRows = rows(await read.execute(synthesisHistoryScopeQuery(scope.projectId, scope.parentId, cursor)));
        if (!scopeRows.length || !bool(scopeRows[0].project_exists)) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        if (!bool(scopeRows[0].statement_exists)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis statement does not belong to this project");
        if (cursor && !bool(scopeRows[0].anchor_valid)) throw historyCursorInvalid();
        const currentRow = scopeRows[0];
        const resultRows = rows(await read.execute(synthesisHistoryPageQuery(scope.projectId, scope.parentId, pageSize, cursor)));
        const baseItems = resultRows.filter((row) => row.revision_id != null).map((row) => ({
          id: String(row.revision_id), sequence: String(row.sequence), lifecycle: lifecycle(row.state),
          isCurrent: row.revision_id === currentRow.current_id,
          titlePreview: row.title_preview == null ? null : String(row.title_preview), titleTruncated: bool(row.title_truncated),
          statementPreview: row.statement_preview == null ? null : String(row.statement_preview), statementTruncated: bool(row.statement_truncated),
          researcherNotePreview: row.researcher_note_preview == null ? null : String(row.researcher_note_preview), researcherNoteTruncated: bool(row.researcher_note_truncated),
          createdAt: date(row.created_at), finalizedAt: date(row.finalized_at),
          supportStatus: bool(row.is_supported) ? "supported" as const : "unsupported" as const,
          supportingRevisionCount: number(row.supporting_revision_count),
          supportingPaperCount: number(row.supporting_paper_count),
          supportingFieldCount: number(row.supporting_field_count),
          preparation: null as SynthesisPreparationHistorySummary | null,
          href: `/projects/${scope.projectId}/synthesis/${scope.parentId}/revisions/${String(row.revision_id)}`,
        }));
        const preparationRows = baseItems.length > 0
          ? rows(await read.execute(synthesisPreparationHistoryQuery(scope.projectId, baseItems.map((item) => item.id))))
          : [];
        const preparations = new Map<string, SynthesisPreparationHistorySummary>(preparationRows.map((row) => [String(row.synthesis_revision_id), {
          synthesisRevisionId: String(row.synthesis_revision_id), preparationId: String(row.preparation_id),
          evidenceSetId: String(row.evidence_set_id), evidenceSetNamePreview: String(row.evidence_set_name_preview),
          evidenceSetNameTruncated: bool(row.evidence_set_name_truncated), evidenceSetArchivedAt: nullableDate(row.evidence_set_archived_at),
          pinnedCompositionRevisionId: String(row.evidence_set_composition_revision_id),
          pinnedCompositionSequence: String(row.pinned_composition_sequence), finalizedAt: date(row.finalized_at),
        }]));
        const items = baseItems.map((item) => ({ ...item, preparation: preparations.get(item.id) ?? null }));
        const current: CurrentSynthesisRevisionIdentity | null = currentRow.current_id == null ? null : {
          id: String(currentRow.current_id), sequence: String(currentRow.current_sequence), lifecycle: lifecycle(currentRow.current_state),
        };
        const hasMore = bool(resultRows[0]?.has_more);
        const last = items[items.length - 1];
        const nextCursor = hasMore && last ? encodeClaimSynthesisHistoryCursor({
          v: 1, projectId: scope.projectId, statementId: scope.parentId, historyType: "synthesis-revision",
          pageSize, lastSequence: last.sequence, lastEventId: last.id,
        }) : null;
        return { items, pageSize, hasMore, nextCursor, current };
      });
    },

    getSynthesisInterpretationHistoryPage(
      projectId: string,
      statementId: string,
      revisionId: string,
      options: SynthesisInterpretationHistoryPageOptions = {},
      executor?: ReadExecutor,
    ): Promise<HistoryPage<SynthesisInterpretationHistoryItem, CurrentSynthesisInterpretationIdentity>> {
      const scope = normalizeScope(projectId, statementId);
      const exactRevisionId = ensureId(revisionId).toLowerCase();
      const pageSize = effectiveClaimSynthesisHistoryPageSize(options.pageSize);
      const cursor = decodeClaimSynthesisHistoryCursor(options.cursor, {
        projectId: scope.projectId, statementId: scope.parentId, revisionId: exactRevisionId,
        historyType: "synthesis-interpretation", pageSize,
      }) as SynthesisInterpretationHistoryCursor | null;
      return withExecutor(db, executor, async (read) => {
        const scopeRows = rows(await read.execute(interpretationHistoryScopeAndPageKeysQuery(
          scope.projectId, scope.parentId, exactRevisionId, pageSize, cursor, options.currentIdentity,
        )));
        if (!scopeRows.length || !bool(scopeRows[0].project_exists)) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        if (!bool(scopeRows[0].statement_exists) || !bool(scopeRows[0].revision_exists)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Synthesis revision does not belong to this statement and project");
        if (cursor && !bool(scopeRows[0].anchor_valid)) throw historyCursorInvalid();
        const currentRow = scopeRows[0];
        const pageKeys = scopeRows.filter((row) => row.interpretation_id != null);
        const visibleIds = pageKeys.slice(0, pageSize).map((row) => String(row.interpretation_id));
        const resultRows = visibleIds.length > 0
          ? rows(await read.execute(interpretationHistoryHydrationQuery(
            scope.projectId, scope.parentId, exactRevisionId, visibleIds,
          )))
          : [];
        const items = resultRows.filter((row) => row.interpretation_id != null).map((row): SynthesisInterpretationHistoryItem => ({
          id: String(row.interpretation_id), sequence: String(row.sequence),
          convergenceState: String(row.convergence_state) as SynthesisInterpretationHistoryItem["convergenceState"],
          summaryPreview: String(row.summary_preview), summaryTruncated: bool(row.summary_truncated),
          researcherNotePreview: row.researcher_note_preview == null ? null : String(row.researcher_note_preview),
          researcherNoteTruncated: bool(row.researcher_note_truncated),
          createdAt: date(row.created_at), finalizedAt: date(row.finalized_at),
          limitationCount: number(row.limitation_count), questionCount: number(row.question_count),
          contradictionCount: number(row.contradiction_count),
          isCurrent: row.interpretation_id === currentRow.current_id,
          href: `/projects/${scope.projectId}/synthesis/${scope.parentId}/revisions/${exactRevisionId}/interpretations/${String(row.interpretation_id)}`,
        }));
        const current: CurrentSynthesisInterpretationIdentity | null = currentRow.current_id == null ? null : {
          id: String(currentRow.current_id), sequence: String(currentRow.current_sequence),
          convergenceState: String(currentRow.current_convergence_state) as CurrentSynthesisInterpretationIdentity["convergenceState"],
          finalizedAt: date(currentRow.current_finalized_at),
        };
        if (options.currentIdentity && current?.id !== options.currentIdentity.id) {
          throw new DomainError("DATABASE_CONSTRAINT", "Selected current interpretation is outside the exact history scope");
        }
        const hasMore = bool(currentRow.has_more);
        const last = items[items.length - 1];
        const nextCursor = hasMore && last ? encodeClaimSynthesisHistoryCursor({
          v: 1, projectId: scope.projectId, statementId: scope.parentId, revisionId: exactRevisionId,
          historyType: "synthesis-interpretation", pageSize, lastSequence: last.sequence, lastEventId: last.id,
        }) : null;
        return { items, pageSize, hasMore, nextCursor, current };
      });
    },
  };
}

export type ClaimSynthesisHistoryReadServices = ReturnType<typeof createClaimSynthesisHistoryReadServices>;
