import { and, eq, isNull, sql } from "drizzle-orm";
import { screeningCriteria, fullTextScreeningCriteria } from "@/db/schema";
import type { ReviewTransaction } from "@/application/review-services/shared";
import type { ScreeningCriterionType } from "@/domain/types";
import { derivePaperReviewStatus } from "@/domain/paper-review";
import { DomainError } from "@/domain/errors";
import { mapScreeningPaperNavigation, screeningNavigationQuery } from "./screening-navigation-query";
import { encodeScreeningHistoryCursor } from "./screening-history-cursor";
import type {
  CompactRetrievalEvent,
  CompactScreeningEvent,
  FullTextRetrievalAttemptEvent,
  FullTextRetrievalHistoryItem,
  FullTextScreeningDecisionEvent,
  FullTextScreeningDecisionHistoryItem,
  ScreeningDecisionEvent,
  ScreeningDecisionHistoryItem,
  ScreeningHistoryCursor,
  ScreeningHistoryPage,
  ScreeningHistoryType,
  ScreeningPaperDetail,
  FullTextScreeningPaperDetail,
  FullTextRetrievalPaperDetail,
} from "./screening-history-read-types";

type Row = Record<string, unknown>;

function rows(result: unknown): Row[] {
  return result as Row[];
}

function dateValue(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new DomainError("DATABASE_CONSTRAINT", "Screening history timestamp is invalid");
  return parsed;
}

function decisionValue(value: unknown): CompactScreeningEvent["decision"] | null {
  return value === "include" || value === "exclude" || value === "maybe" ? value : null;
}

function retrievalValue(value: unknown): CompactRetrievalEvent["outcome"] | null {
  return value === "pending" || value === "unavailable" || value === "retrieved" ? value : null;
}

function compactScreeningEvent(row: Row, prefix: "ta" | "ft"): CompactScreeningEvent | null {
  const id = row[`${prefix}_event_id`];
  const value = decisionValue(row[`${prefix}_decision`]);
  if (id == null || value == null) return null;
  return { id: String(id), sequence: String(row[`${prefix}_sequence`]), decision: value };
}

function compactRetrievalEvent(row: Row): CompactRetrievalEvent | null {
  const id = row.retrieval_event_id;
  const outcome = retrievalValue(row.retrieval_outcome);
  if (id == null || outcome == null) return null;
  return { id: String(id), sequence: String(row.retrieval_sequence), outcome };
}

function paperProjection(includeContent: boolean) {
  if (!includeContent) return sql`p.id::text as paper_id, p.project_id::text as project_id, p.title`;
  return sql`
    p.id::text as paper_id, p.project_id::text as project_id, p.title, p.authors,
    p.publication_year, p.venue, p.doi, p.abstract, p.bibliographic_note,
    p.created_at as paper_created_at, p.updated_at as paper_updated_at`;
}

function anchorValidationProjection(cursor: ScreeningHistoryCursor | null) {
  if (!cursor) return sql`true as cursor_anchor_valid`;
  switch (cursor.historyType) {
    case "title-abstract-decision":
      return sql`exists (
        select 1 from screening_decisions anchor
        where anchor.project_id=${cursor.projectId}::uuid
          and anchor.paper_id=${cursor.paperId}::uuid
          and anchor.stage='title_abstract'
          and anchor.sequence=${cursor.lastSequence}::bigint
          and anchor.id=${cursor.lastEventId}::uuid
      ) as cursor_anchor_valid`;
    case "full-text-decision":
      return sql`exists (
        select 1 from full_text_screening_decisions anchor
        where anchor.project_id=${cursor.projectId}::uuid
          and anchor.paper_id=${cursor.paperId}::uuid
          and anchor.sequence=${cursor.lastSequence}::bigint
          and anchor.id=${cursor.lastEventId}::uuid
      ) as cursor_anchor_valid`;
    case "full-text-retrieval-attempt":
      return sql`exists (
        select 1 from full_text_retrieval_attempts anchor
        where anchor.project_id=${cursor.projectId}::uuid
          and anchor.paper_id=${cursor.paperId}::uuid
          and anchor.sequence=${cursor.lastSequence}::bigint
          and anchor.id=${cursor.lastEventId}::uuid
      ) as cursor_anchor_valid`;
  }
}

function currentStateParts(mode: "detail" | "exact" | ScreeningHistoryType) {
  const emptyProjection = sql`null::text as ta_event_id, null::text as ta_sequence, null::text as ta_decision,
    null::text as ft_event_id, null::text as ft_sequence, null::text as ft_decision,
    null::text as retrieval_event_id, null::text as retrieval_sequence, null::text as retrieval_outcome,
    false as has_retrieval_attempts, false as ever_retrieved, false as has_analytical_history`;
  const taProjection = sql`ta.id::text as ta_event_id, ta.sequence::text as ta_sequence, ta.decision as ta_decision,
    null::text as ft_event_id, null::text as ft_sequence, null::text as ft_decision,
    null::text as retrieval_event_id, null::text as retrieval_sequence, null::text as retrieval_outcome,
    false as has_retrieval_attempts, false as ever_retrieved, false as has_analytical_history`;
  const ftProjection = sql`null::text as ta_event_id, null::text as ta_sequence, null::text as ta_decision,
    ft.id::text as ft_event_id, ft.sequence::text as ft_sequence, ft.decision as ft_decision,
    null::text as retrieval_event_id, null::text as retrieval_sequence, null::text as retrieval_outcome,
    false as has_retrieval_attempts, false as ever_retrieved, false as has_analytical_history`;
  const retrievalProjection = sql`null::text as ta_event_id, null::text as ta_sequence, null::text as ta_decision,
    null::text as ft_event_id, null::text as ft_sequence, null::text as ft_decision,
    retrieval.id::text as retrieval_event_id, retrieval.sequence::text as retrieval_sequence, retrieval.outcome as retrieval_outcome,
    exists(select 1 from full_text_retrieval_attempts attempts where attempts.project_id=p.project_id and attempts.paper_id=p.id) as has_retrieval_attempts,
    exists(select 1 from full_text_retrieval_attempts attempts where attempts.project_id=p.project_id and attempts.paper_id=p.id and attempts.outcome='retrieved') as ever_retrieved,
    false as has_analytical_history`;
  const detailProjection = sql`ta.id::text as ta_event_id, ta.sequence::text as ta_sequence, ta.decision as ta_decision,
    ft.id::text as ft_event_id, ft.sequence::text as ft_sequence, ft.decision as ft_decision,
    retrieval.id::text as retrieval_event_id, retrieval.sequence::text as retrieval_sequence, retrieval.outcome as retrieval_outcome,
    exists(select 1 from full_text_retrieval_attempts attempts where attempts.project_id=p.project_id and attempts.paper_id=p.id) as has_retrieval_attempts,
    exists(select 1 from full_text_retrieval_attempts attempts where attempts.project_id=p.project_id and attempts.paper_id=p.id and attempts.outcome='retrieved') as ever_retrieved,
    exists(select 1 from extraction_value_revisions revisions where revisions.project_id=p.project_id and revisions.paper_id=p.id and revisions.finalized_at is not null) as has_analytical_history`;
  const emptyJoins = sql``;
  const taJoin = sql`left join lateral (
    select event.id, event.sequence, event.decision from screening_decisions event
    where event.project_id=p.project_id and event.paper_id=p.id and event.stage='title_abstract'
    order by event.sequence desc limit 1
  ) ta on true`;
  const ftJoin = sql`left join lateral (
    select event.id, event.sequence, event.decision from full_text_screening_decisions event
    where event.project_id=p.project_id and event.paper_id=p.id
    order by event.sequence desc limit 1
  ) ft on true`;
  const retrievalJoin = sql`left join lateral (
    select event.id, event.sequence, event.outcome from full_text_retrieval_attempts event
    where event.project_id=p.project_id and event.paper_id=p.id
    order by event.sequence desc limit 1
  ) retrieval on true`;
  switch (mode) {
    case "title-abstract-decision": return { projection: taProjection, joins: taJoin };
    case "full-text-decision": return { projection: ftProjection, joins: ftJoin };
    case "full-text-retrieval-attempt": return { projection: retrievalProjection, joins: retrievalJoin };
    case "detail": return { projection: detailProjection, joins: sql`${taJoin} ${ftJoin} ${retrievalJoin}` };
    case "exact": return { projection: emptyProjection, joins: emptyJoins };
  }
}

function selectedCurrentEvent(row: Row, mode: "detail" | "exact" | ScreeningHistoryType) {
  switch (mode) {
    case "title-abstract-decision": return compactScreeningEvent(row, "ta");
    case "full-text-decision": return compactScreeningEvent(row, "ft");
    case "full-text-retrieval-attempt": return compactRetrievalEvent(row);
    case "detail": case "exact": return null;
  }
}

function contextQuery(projectId: string, paperId: string, includeContent: boolean, cursor: ScreeningHistoryCursor | null, mode: "detail" | "exact" | ScreeningHistoryType) {
  const state = currentStateParts(mode);
  return sql`select
    ${paperProjection(includeContent)},
    ${state.projection},
    ${anchorValidationProjection(cursor)}
  from papers p
  ${state.joins}
  where p.project_id=${projectId}::uuid and p.id=${paperId}::uuid
  limit 1`;
}

function compactContext(row: Row) {
  const titleAbstractCurrent = compactScreeningEvent(row, "ta");
  const fullTextCurrent = compactScreeningEvent(row, "ft");
  const retrievalCurrent = compactRetrievalEvent(row);
  const reviewStatus = derivePaperReviewStatus({
    titleAbstractDecision: titleAbstractCurrent?.decision ?? null,
    fullTextDecision: fullTextCurrent?.decision ?? null,
    fullTextRetrievalState: retrievalCurrent?.outcome ?? "not_sought",
    hasFullTextRetrievalAttempts: Boolean(row.has_retrieval_attempts),
    everRetrieved: Boolean(row.ever_retrieved),
    hasAnalyticalHistory: Boolean(row.has_analytical_history),
  });
  return { titleAbstractCurrent, fullTextCurrent, retrievalCurrent, reviewStatus };
}

async function loadContext(tx: ReviewTransaction, projectId: string, paperId: string, cursor: ScreeningHistoryCursor | null, includeContent: boolean, mode: "detail" | "exact" | ScreeningHistoryType) {
  const row = rows(await tx.execute(contextQuery(projectId, paperId, includeContent, cursor, mode)))[0];
  if (!row) throw new DomainError("NOT_FOUND", "Screening history event was not found");
  if (!row.cursor_anchor_valid) throw new DomainError("VALIDATION_ERROR", "History link is invalid or belongs to a different Paper. Start from the first page.");
  const context = compactContext(row);
  return {
    row,
    ...context,
    route: {
      projectId: String(row.project_id),
      paperId: String(row.paper_id),
      title: String(row.title),
      currentEvent: selectedCurrentEvent(row, mode),
      everRetrieved: Boolean(row.ever_retrieved),
    },
  };
}

function paperFromContext(row: Row) {
  return {
    id: String(row.paper_id),
    projectId: String(row.project_id),
    title: String(row.title),
    authors: Array.isArray(row.authors) ? row.authors.map(String) : [],
    publicationYear: row.publication_year == null ? null : Number(row.publication_year),
    venue: row.venue == null ? null : String(row.venue),
    doi: row.doi == null ? null : String(row.doi),
    abstract: row.abstract == null ? null : String(row.abstract),
    bibliographicNote: row.bibliographic_note == null ? null : String(row.bibliographic_note),
    createdAt: dateValue(row.paper_created_at),
    updatedAt: dateValue(row.paper_updated_at),
  };
}

function afterBoundary(cursor: ScreeningHistoryCursor | null, alias: string) {
  if (!cursor) return sql``;
  return sql`and ${sql.raw(`${alias}.sequence`)} >= ${cursor.lastSequence}::bigint
    and (
      ${sql.raw(`${alias}.sequence`)} > ${cursor.lastSequence}::bigint
      or (${sql.raw(`${alias}.sequence`)} = ${cursor.lastSequence}::bigint and ${sql.raw(`${alias}.id`)} > ${cursor.lastEventId}::uuid)
    )`;
}

async function titleAbstractRows(tx: ReviewTransaction, projectId: string, paperId: string, pageSize: number, cursor: ScreeningHistoryCursor | null): Promise<Row[]> {
  const boundary = afterBoundary(cursor, "decision");
  return rows(await tx.execute(sql`with page_keys as materialized (
      select decision.id, decision.sequence
      from screening_decisions decision
      where decision.project_id=${projectId}::uuid and decision.paper_id=${paperId}::uuid and decision.stage='title_abstract'
      ${boundary}
      order by decision.sequence asc, decision.id asc
      limit ${pageSize + 1}
    )
    select event.id::text as id, page_keys.sequence::text as sequence, event.project_id::text as project_id,
      event.paper_id::text as paper_id, event.decision, event.exclusion_criterion_id::text as criterion_id,
      event.exclusion_criterion_type as criterion_type,
      left(left(criterion.text,129),128) as criterion_text,
      (char_length(left(criterion.text,129)) > 128) as criterion_text_truncated,
      criterion.archived_at as criterion_archived_at,
      left(left(event.note,601),600) as note_preview,
      (event.note is not null and char_length(left(event.note,601)) > 600) as note_truncated,
      event.created_at
    from page_keys
    join screening_decisions event on event.id=page_keys.id and event.project_id=${projectId}::uuid and event.paper_id=${paperId}::uuid
    left join screening_criteria criterion on criterion.project_id=event.project_id and criterion.id=event.exclusion_criterion_id
    order by page_keys.sequence asc, page_keys.id asc`));
}

async function fullTextDecisionRows(tx: ReviewTransaction, projectId: string, paperId: string, pageSize: number, cursor: ScreeningHistoryCursor | null): Promise<Row[]> {
  const boundary = afterBoundary(cursor, "decision");
  return rows(await tx.execute(sql`with page_keys as materialized (
      select decision.id, decision.sequence
      from full_text_screening_decisions decision
      where decision.project_id=${projectId}::uuid and decision.paper_id=${paperId}::uuid
      ${boundary}
      order by decision.sequence asc, decision.id asc
      limit ${pageSize + 1}
    )
    select event.id::text as id, page_keys.sequence::text as sequence, event.project_id::text as project_id,
      event.paper_id::text as paper_id, event.decision, event.exclusion_criterion_id::text as criterion_id,
      left(left(criterion.text,129),128) as criterion_text,
      (char_length(left(criterion.text,129)) > 128) as criterion_text_truncated,
      criterion.archived_at as criterion_archived_at,
      left(left(event.note,601),600) as note_preview,
      (event.note is not null and char_length(left(event.note,601)) > 600) as note_truncated,
      event.created_at
    from page_keys
    join full_text_screening_decisions event on event.id=page_keys.id and event.project_id=${projectId}::uuid and event.paper_id=${paperId}::uuid
    left join full_text_screening_criteria criterion on criterion.project_id=event.project_id and criterion.id=event.exclusion_criterion_id
    order by page_keys.sequence asc, page_keys.id asc`));
}

async function retrievalRows(tx: ReviewTransaction, projectId: string, paperId: string, pageSize: number, cursor: ScreeningHistoryCursor | null): Promise<Row[]> {
  const boundary = afterBoundary(cursor, "attempt");
  return rows(await tx.execute(sql`with page_keys as materialized (
      select attempt.id, attempt.sequence
      from full_text_retrieval_attempts attempt
      where attempt.project_id=${projectId}::uuid and attempt.paper_id=${paperId}::uuid
      ${boundary}
      order by attempt.sequence asc, attempt.id asc
      limit ${pageSize + 1}
    )
    select event.id::text as id, page_keys.sequence::text as sequence, event.project_id::text as project_id,
      event.paper_id::text as paper_id, event.outcome, event.method,
      event.attempted_at, event.created_at,
      left(left(event.source_reference,385),384) as source_reference_preview,
      (event.source_reference is not null and char_length(left(event.source_reference,385)) > 384) as source_reference_truncated,
      left(left(event.note,385),384) as note_preview,
      (event.note is not null and char_length(left(event.note,385)) > 384) as note_truncated
    from page_keys
    join full_text_retrieval_attempts event on event.id=page_keys.id and event.project_id=${projectId}::uuid and event.paper_id=${paperId}::uuid
    order by page_keys.sequence asc, page_keys.id asc`));
}

function decisionHistoryItem(row: Row, current: CompactScreeningEvent | null): ScreeningDecisionHistoryItem {
  const criterion = row.criterion_id == null ? null : {
    id: String(row.criterion_id),
    type: row.criterion_type == null ? null : String(row.criterion_type) as ScreeningCriterionType,
    text: String(row.criterion_text ?? ""),
    archivedAt: row.criterion_archived_at == null ? null : dateValue(row.criterion_archived_at),
  };
  return {
    id: String(row.id), sequence: String(row.sequence), decision: String(row.decision) as ScreeningDecisionHistoryItem["decision"],
    exclusionCriterion: criterion,
    criterionTextTruncated: Boolean(row.criterion_text_truncated),
    note: row.note_preview == null ? null : String(row.note_preview),
    noteTruncated: Boolean(row.note_truncated),
    createdAt: dateValue(row.created_at),
    isCurrent: current?.id === String(row.id),
  };
}

function fullTextDecisionHistoryItem(row: Row, current: CompactScreeningEvent | null): FullTextScreeningDecisionHistoryItem {
  const criterion = row.criterion_id == null ? null : {
    id: String(row.criterion_id), text: String(row.criterion_text ?? ""),
    archivedAt: row.criterion_archived_at == null ? null : dateValue(row.criterion_archived_at),
  };
  return {
    id: String(row.id), sequence: String(row.sequence), decision: String(row.decision) as FullTextScreeningDecisionHistoryItem["decision"],
    exclusionCriterion: criterion,
    criterionTextTruncated: Boolean(row.criterion_text_truncated),
    note: row.note_preview == null ? null : String(row.note_preview),
    noteTruncated: Boolean(row.note_truncated),
    createdAt: dateValue(row.created_at),
    isCurrent: current?.id === String(row.id),
  };
}

function retrievalHistoryItem(row: Row, current: CompactRetrievalEvent | null): FullTextRetrievalHistoryItem {
  return {
    id: String(row.id), sequence: String(row.sequence), outcome: String(row.outcome) as FullTextRetrievalHistoryItem["outcome"],
    method: row.method == null ? null : String(row.method) as FullTextRetrievalHistoryItem["method"],
    attemptedAt: dateValue(row.attempted_at),
    sourceReference: row.source_reference_preview == null ? null : String(row.source_reference_preview),
    sourceReferenceTruncated: Boolean(row.source_reference_truncated),
    note: row.note_preview == null ? null : String(row.note_preview), noteTruncated: Boolean(row.note_truncated),
    createdAt: dateValue(row.created_at), isCurrent: current?.id === String(row.id),
  };
}

function buildPage<T extends { id: string; sequence: string }>(rowsIn: Row[], pageSize: number, type: ScreeningHistoryType, projectId: string, paperId: string, current: CompactScreeningEvent | CompactRetrievalEvent | null, cursor: ScreeningHistoryCursor | null, mapper: (row: Row) => T): ScreeningHistoryPage<T> {
  const hasMore = rowsIn.length > pageSize;
  const pageRows = rowsIn.slice(0, pageSize);
  const items = pageRows.map(mapper);
  const last = items.at(-1);
  const nextCursor = hasMore && last
    ? encodeScreeningHistoryCursor({
      v: 1, projectId: projectId.toLowerCase(), paperId: paperId.toLowerCase(), historyType: type,
      pageSize, lastSequence: last.sequence, lastEventId: last.id,
    })
    : null;
  return { items, pageSize, hasMore, nextCursor, currentEvent: current };
}

export async function getScreeningHistoryContext(tx: ReviewTransaction, projectId: string, paperId: string, cursor: ScreeningHistoryCursor | null = null, mode: "detail" | "exact" | ScreeningHistoryType = "exact", includeContent = false) {
  return loadContext(tx, projectId, paperId, cursor, includeContent, mode);
}

export function mapHistoryPaper(contextRow: Row) {
  return paperFromContext(contextRow);
}

export async function getTitleAbstractPage(tx: ReviewTransaction, projectId: string, paperId: string, pageSize: number, cursor: ScreeningHistoryCursor | null, current: CompactScreeningEvent | null) {
  const found = await titleAbstractRows(tx, projectId, paperId, pageSize, cursor);
  return buildPage(found, pageSize, "title-abstract-decision", projectId, paperId, current, cursor, (row) => decisionHistoryItem(row, current));
}

export async function getFullTextDecisionPage(tx: ReviewTransaction, projectId: string, paperId: string, pageSize: number, cursor: ScreeningHistoryCursor | null, current: CompactScreeningEvent | null) {
  const found = await fullTextDecisionRows(tx, projectId, paperId, pageSize, cursor);
  return buildPage(found, pageSize, "full-text-decision", projectId, paperId, current, cursor, (row) => fullTextDecisionHistoryItem(row, current));
}

export async function getRetrievalPage(tx: ReviewTransaction, projectId: string, paperId: string, pageSize: number, cursor: ScreeningHistoryCursor | null, current: CompactRetrievalEvent | null) {
  const found = await retrievalRows(tx, projectId, paperId, pageSize, cursor);
  return buildPage(found, pageSize, "full-text-retrieval-attempt", projectId, paperId, current, cursor, (row) => retrievalHistoryItem(row, current));
}

export async function getActiveTitleAbstractCriteria(tx: ReviewTransaction, projectId: string) {
  const criteria = await tx.select().from(screeningCriteria).where(and(eq(screeningCriteria.projectId, projectId), isNull(screeningCriteria.archivedAt))).orderBy(screeningCriteria.sortOrder);
  return criteria.map((criterion) => ({ ...criterion, type: criterion.type as ScreeningCriterionType }));
}

export async function getActiveFullTextCriteria(tx: ReviewTransaction, projectId: string) {
  return tx.select().from(fullTextScreeningCriteria).where(and(eq(fullTextScreeningCriteria.projectId, projectId), isNull(fullTextScreeningCriteria.archivedAt))).orderBy(fullTextScreeningCriteria.sortOrder, fullTextScreeningCriteria.id);
}

export async function getScreeningNavigation(tx: ReviewTransaction, projectId: string, paperId: string) {
  const found = rows(await tx.execute(screeningNavigationQuery(projectId, paperId)))[0];
  const navigation = mapScreeningPaperNavigation(found);
  if (!navigation) throw new DomainError("NOT_FOUND", "Screening history event was not found");
  return navigation;
}

export async function getTitleAbstractEvent(tx: ReviewTransaction, projectId: string, paperId: string, eventId: string): Promise<ScreeningDecisionEvent> {
  const row = rows(await tx.execute(sql`select event.id::text as id, event.sequence::text as sequence,
      event.project_id::text as project_id, event.paper_id::text as paper_id, event.decision,
      event.exclusion_criterion_id::text as criterion_id, event.exclusion_criterion_type as criterion_type,
      criterion.text as criterion_text, criterion.archived_at as criterion_archived_at,
      event.note, event.created_at
    from screening_decisions event
    left join screening_criteria criterion on criterion.project_id=event.project_id and criterion.id=event.exclusion_criterion_id
    where event.project_id=${projectId}::uuid and event.paper_id=${paperId}::uuid and event.id=${eventId}::uuid and event.stage='title_abstract'
    limit 1`))[0];
  if (!row) throw new DomainError("NOT_FOUND", "Screening history event was not found");
  return {
    id: String(row.id), sequence: String(row.sequence), projectId: String(row.project_id), paperId: String(row.paper_id),
    decision: String(row.decision) as ScreeningDecisionEvent["decision"],
    exclusionCriterion: row.criterion_id == null ? null : {
      id: String(row.criterion_id), type: row.criterion_type == null ? null : String(row.criterion_type) as ScreeningCriterionType,
      text: String(row.criterion_text ?? ""), archivedAt: row.criterion_archived_at == null ? null : dateValue(row.criterion_archived_at),
    },
    note: row.note == null ? null : String(row.note), createdAt: dateValue(row.created_at),
  };
}

export async function getFullTextDecisionEvent(tx: ReviewTransaction, projectId: string, paperId: string, eventId: string): Promise<FullTextScreeningDecisionEvent> {
  const row = rows(await tx.execute(sql`select event.id::text as id, event.sequence::text as sequence,
      event.project_id::text as project_id, event.paper_id::text as paper_id, event.decision,
      event.exclusion_criterion_id::text as criterion_id, criterion.text as criterion_text,
      criterion.archived_at as criterion_archived_at, event.note, event.created_at
    from full_text_screening_decisions event
    left join full_text_screening_criteria criterion on criterion.project_id=event.project_id and criterion.id=event.exclusion_criterion_id
    where event.project_id=${projectId}::uuid and event.paper_id=${paperId}::uuid and event.id=${eventId}::uuid
    limit 1`))[0];
  if (!row) throw new DomainError("NOT_FOUND", "Screening history event was not found");
  return {
    id: String(row.id), sequence: String(row.sequence), projectId: String(row.project_id), paperId: String(row.paper_id),
    decision: String(row.decision) as FullTextScreeningDecisionEvent["decision"],
    exclusionCriterion: row.criterion_id == null ? null : {
      id: String(row.criterion_id), text: String(row.criterion_text ?? ""),
      archivedAt: row.criterion_archived_at == null ? null : dateValue(row.criterion_archived_at),
    },
    note: row.note == null ? null : String(row.note), createdAt: dateValue(row.created_at),
  };
}

export async function getRetrievalEvent(tx: ReviewTransaction, projectId: string, paperId: string, eventId: string): Promise<FullTextRetrievalAttemptEvent> {
  const row = rows(await tx.execute(sql`select event.id::text as id, event.sequence::text as sequence,
      event.project_id::text as project_id, event.paper_id::text as paper_id,
      event.outcome, event.method, event.source_reference, event.note,
      event.attempted_at, event.created_at
    from full_text_retrieval_attempts event
    where event.project_id=${projectId}::uuid and event.paper_id=${paperId}::uuid and event.id=${eventId}::uuid
    limit 1`))[0];
  if (!row) throw new DomainError("NOT_FOUND", "Screening history event was not found");
  return {
    id: String(row.id), sequence: String(row.sequence), projectId: String(row.project_id), paperId: String(row.paper_id),
    outcome: String(row.outcome) as FullTextRetrievalAttemptEvent["outcome"],
    method: row.method == null ? null : String(row.method) as FullTextRetrievalAttemptEvent["method"],
    sourceReference: row.source_reference == null ? null : String(row.source_reference),
    note: row.note == null ? null : String(row.note), attemptedAt: dateValue(row.attempted_at), createdAt: dateValue(row.created_at),
  };
}

export async function getTitleAbstractDetail(tx: ReviewTransaction, projectId: string, paperId: string, pageSize: number): Promise<ScreeningPaperDetail> {
  const context = await loadContext(tx, projectId, paperId, null, true, "detail");
  const criteria = await getActiveTitleAbstractCriteria(tx, projectId);
  const history = await getTitleAbstractPage(tx, projectId, paperId, pageSize, null, context.titleAbstractCurrent);
  const navigation = await getScreeningNavigation(tx, projectId, paperId);
  return { paper: paperFromContext(context.row), reviewStatus: context.reviewStatus, currentEvent: context.titleAbstractCurrent, history, criteria, navigation };
}

export async function getFullTextDetail(tx: ReviewTransaction, projectId: string, paperId: string, pageSize: number): Promise<FullTextScreeningPaperDetail> {
  const context = await loadContext(tx, projectId, paperId, null, true, "detail");
  const criteria = await getActiveFullTextCriteria(tx, projectId);
  const history = await getFullTextDecisionPage(tx, projectId, paperId, pageSize, null, context.fullTextCurrent);
  const retrievalHistory = await getRetrievalPage(tx, projectId, paperId, pageSize, null, context.retrievalCurrent);
  return { paper: paperFromContext(context.row), reviewStatus: context.reviewStatus, currentEvent: context.fullTextCurrent, retrievalCurrent: context.retrievalCurrent, history, retrievalHistory, criteria };
}

export async function getRetrievalDetail(tx: ReviewTransaction, projectId: string, paperId: string, pageSize: number): Promise<FullTextRetrievalPaperDetail> {
  const context = await loadContext(tx, projectId, paperId, null, true, "detail");
  const history = await getRetrievalPage(tx, projectId, paperId, pageSize, null, context.retrievalCurrent);
  return { paper: paperFromContext(context.row), reviewStatus: context.reviewStatus, currentAttempt: context.retrievalCurrent, currentState: context.reviewStatus.fullTextRetrievalState, everRetrieved: context.reviewStatus.everRetrieved, history };
}
