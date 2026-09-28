import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { normalizeDoiForComparison, normalizeTitleForComparison } from "@/domain/search-normalization";

export const ACQUISITION_PAGE_DEFAULT_SIZE = 50;
export const ACQUISITION_PAGE_MAX_SIZE = 100;
export const ACQUISITION_HISTORY_DEFAULT_SIZE = 25;
export const ACQUISITION_HISTORY_MAX_SIZE = 50;
export const ACQUISITION_CANDIDATE_DEFAULT_SIZE = 20;
export const ACQUISITION_CANDIDATE_MAX_SIZE = 50;
export const ACQUISITION_CURSOR_ERROR = "Page link expired or invalid. Start from the first page.";

export type RetrievedRecordSearchField = "title" | "doi" | "sourceRecordId";

export type SearchRunPageRow = {
  id: string;
  sequence: number;
  searchSourceId: string;
  sourceKeySnapshotPreview: string;
  sourceDisplayNameSnapshotPreview: string;
  queryPreview: string;
  executedAt: Date;
  reportedResultCount: number;
};

export type SearchRunPage = {
  items: SearchRunPageRow[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type RetrievedRecordPageRow = {
  id: string;
  retrievedAt: Date;
  title: string;
  authorsPreview: string[];
  additionalAuthorsCount: number;
  publicationYear: number | null;
  venuePreview: string | null;
  doiPreview: string | null;
  sourceRecordIdPreview: string | null;
  abstractPreview: string | null;
  rawCitationPreview: string | null;
  currentMatch: { paperId: string; paperTitle: string } | null;
};

export type RetrievedRecordPage = {
  items: RetrievedRecordPageRow[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  searchField: RetrievedRecordSearchField | null;
  normalizedSearch: string | null;
};

export type RetrievedRecordDetail = {
  record: {
    id: string;
    projectId: string;
    searchRunId: string;
    searchSourceId: string;
    sourceRecordId: string | null;
    title: string;
    authors: string[];
    abstract: string | null;
    doi: string | null;
    url: string | null;
    publicationYear: number | null;
    venue: string | null;
    rawCitation: string | null;
    retrievedAt: Date;
    createdAt: Date;
  };
  run: {
    id: string;
    sequence: number;
    searchSourceId: string;
    sourceKeySnapshot: string;
    sourceDisplayNameSnapshot: string;
    strategyId: string;
    queryText: string;
    filtersTextSnapshot: string | null;
    reportedResultCount: number;
    executedAt: Date;
    notes: string | null;
  };
  currentMatch: { id: string; sequence: number; paperId: string; paperTitle: string; createdAt: Date } | null;
};

export type RetrievedRecordMatchHistoryRow = {
  id: string;
  sequence: number;
  action: "linked" | "unlinked";
  paperId: string;
  paperTitle: string;
  createdAt: Date;
};

export type RetrievedRecordMatchHistoryPage = {
  items: RetrievedRecordMatchHistoryRow[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type RetrievedRecordDuplicateCandidate = {
  id: string;
  title: string;
  createdAt: Date;
};

export type RetrievedRecordDuplicateCandidatePage = {
  items: RetrievedRecordDuplicateCandidate[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type AcquisitionPageOptions = { cursor?: string; pageSize?: number };
export type RetrievedRecordPageOptions = AcquisitionPageOptions & {
  searchField?: RetrievedRecordSearchField | "";
  query?: string;
};

type Row = Record<string, unknown>;
type SearchRunCursor = { v: 1; projectId: string; pageSize: number; highWaterSequence: number; lastSequence: number; lastId: string };
type RetrievedRecordCursor = { v: 2; projectId: string; runId: string; pageSize: number; filterKind: RetrievedRecordSearchField | "none"; normalizedFilter: string; snapshotAt: string; lastRetrievedAt: string; lastId: string };
type MatchHistoryCursor = { v: 1; projectId: string; runId: string; recordId: string; pageSize: number; highWaterSequence: number; lastSequence: number; lastId: string };
type DuplicateCandidateCursor = { v: 2; projectId: string; runId: string; recordId: string; pageSize: number; snapshotAt: string; matchHighWaterSequence: number; lastCreatedAt: string; lastId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEARCH_FIELDS = new Set<RetrievedRecordSearchField>(["title", "doi", "sourceRecordId"]);

function records(value: unknown): Row[] { return value as Row[]; }

function ensureUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`);
  return value.toLowerCase();
}

function positivePageSize(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new DomainError("VALIDATION_ERROR", "Page size must be a positive integer");
  return Math.min(value, maximum);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new DomainError("DATABASE_CONSTRAINT", `${label} is invalid`);
  return parsed;
}

function cursorInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid cursor");
  return value;
}

function cursorTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) throw new Error("invalid cursor");
  const millisecondPrefix = `${value.slice(0, 23)}Z`;
  const date = new Date(millisecondPrefix);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== millisecondPrefix) throw new Error("invalid cursor");
  return value;
}

function parseCursor(value: string | undefined): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new DomainError("VALIDATION_ERROR", ACQUISITION_CURSOR_ERROR);
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid cursor");
    return decoded as Record<string, unknown>;
  } catch {
    throw new DomainError("VALIDATION_ERROR", ACQUISITION_CURSOR_ERROR);
  }
}

function encodeCursor(cursor: SearchRunCursor | RetrievedRecordCursor | MatchHistoryCursor | DuplicateCandidateCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function requireBoundCursor<T extends { v: number; projectId: string; pageSize: number }>(
  value: string | undefined,
  expected: { projectId: string; pageSize: number },
  parse: (cursor: Record<string, unknown>) => T,
): T | null {
  const raw = parseCursor(value);
  if (!raw) return null;
  try {
    if (raw.projectId !== expected.projectId || raw.pageSize !== expected.pageSize) throw new Error("invalid cursor");
    return parse(raw);
  } catch {
    throw new DomainError("VALIDATION_ERROR", ACQUISITION_CURSOR_ERROR);
  }
}

function codePointPreview(expression: SQL, maximum: number): SQL {
  return sql`case when char_length(${expression}) > ${maximum} then left(${expression}, ${maximum - 1}) || '…' else ${expression} end`;
}

function normalizeFilter(input: RetrievedRecordPageOptions) {
  const rawField = input.searchField ?? "";
  const query = input.query ?? "";
  if (typeof query !== "string") throw new DomainError("VALIDATION_ERROR", "Search text must be text");
  if (rawField !== "" && !SEARCH_FIELDS.has(rawField)) throw new DomainError("VALIDATION_ERROR", "Search field is invalid");
  const trimmed = query.trim();
  if (rawField === "" && trimmed === "") return { filterKind: "none" as const, normalizedFilter: "" };
  if (rawField === "" || trimmed === "") throw new DomainError("VALIDATION_ERROR", "Choose a search field and enter a search value");
  const maximum = rawField === "title" ? 1000 : 2000;
  if (Array.from(trimmed).length > maximum) throw new DomainError("VALIDATION_ERROR", `Search text cannot exceed ${maximum} Unicode code points`);
  const normalized = rawField === "title"
    ? normalizeTitleForComparison(trimmed)
    : rawField === "doi" ? normalizeDoiForComparison(trimmed) : trimmed;
  if (!normalized) throw new DomainError("VALIDATION_ERROR", "Search text must not be empty");
  return { filterKind: rawField, normalizedFilter: normalized };
}

function searchRunRow(row: Row): SearchRunPageRow {
  return {
    id: String(row.id),
    sequence: safeInteger(row.sequence, "SearchRun sequence"),
    searchSourceId: String(row.search_source_id),
    sourceKeySnapshotPreview: String(row.source_key_snapshot_preview),
    sourceDisplayNameSnapshotPreview: String(row.source_display_name_snapshot_preview),
    queryPreview: String(row.query_preview),
    executedAt: row.executed_at instanceof Date ? row.executed_at : new Date(String(row.executed_at)),
    reportedResultCount: safeInteger(row.reported_result_count, "Reported result count"),
  };
}

function retrievedRecordPageRow(row: Row): RetrievedRecordPageRow {
  return {
    id: String(row.id),
      retrievedAt: row.retrieved_at instanceof Date ? row.retrieved_at : new Date(String(row.retrieved_at)),
    title: String(row.title),
    authorsPreview: Array.isArray(row.authors_preview) ? row.authors_preview.map(String) : [],
    additionalAuthorsCount: safeInteger(row.additional_authors_count, "Additional author count"),
    publicationYear: row.publication_year == null ? null : safeInteger(row.publication_year, "Publication year"),
    venuePreview: row.venue_preview == null ? null : String(row.venue_preview),
    doiPreview: row.doi_preview == null ? null : String(row.doi_preview),
    sourceRecordIdPreview: row.source_record_id_preview == null ? null : String(row.source_record_id_preview),
    abstractPreview: row.abstract_preview == null ? null : String(row.abstract_preview),
    rawCitationPreview: row.raw_citation_preview == null ? null : String(row.raw_citation_preview),
    currentMatch: row.current_paper_id == null || row.current_paper_title == null
      ? null
      : { paperId: String(row.current_paper_id), paperTitle: String(row.current_paper_title) },
  };
}

function sqlSearchPredicate(filterKind: RetrievedRecordSearchField | "none", normalizedFilter: string): SQL | null {
  if (filterKind === "none") return null;
  if (filterKind === "sourceRecordId") return sql`rr.source_record_id = ${normalizedFilter}`;
  if (filterKind === "title") return sql`lower(regexp_replace(btrim(rr.title), '[[:space:]]+', ' ', 'g')) = ${normalizedFilter}`;
  return sql`btrim(lower(regexp_replace(regexp_replace(btrim(rr.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))) = ${normalizedFilter}`;
}

export function buildSearchRunPageQuery(input: {
  projectId: string; highWaterSequence: number; pageSize: number; lastSequence?: number; lastId?: string;
}) {
  const continuation = input.lastSequence === undefined || input.lastId === undefined
    ? null
    : sql`(run.sequence < ${input.lastSequence} or (run.sequence = ${input.lastSequence} and run.id < ${input.lastId}::uuid))`;
  return sql`
    select run.id, run.sequence, run.search_source_id,
      ${codePointPreview(sql`run.source_key_snapshot`, 100)} as source_key_snapshot_preview,
      ${codePointPreview(sql`run.source_display_name_snapshot`, 120)} as source_display_name_snapshot_preview,
      ${codePointPreview(sql`run.query_text`, 250)} as query_preview,
      run.executed_at, run.reported_result_count
    from search_runs run
    where run.project_id=${input.projectId}
      and run.sequence <= ${input.highWaterSequence}
      ${continuation ? sql`and ${continuation}` : sql``}
    order by run.sequence desc, run.id desc
    limit ${input.pageSize + 1}
  `;
}

export function buildRetrievedRecordPageQuery(input: {
  projectId: string; runId: string; pageSize: number; snapshotAt: string;
  filterKind: RetrievedRecordSearchField | "none"; normalizedFilter: string;
  lastRetrievedAt?: string; lastId?: string;
}) {
  const predicates: SQL[] = [
    sql`rr.project_id=${input.projectId}`,
    sql`rr.search_run_id=${input.runId}`,
    sql`rr.created_at <= ${input.snapshotAt}::timestamptz`,
  ];
  const filter = sqlSearchPredicate(input.filterKind, input.normalizedFilter);
  if (filter) predicates.push(filter);
  if (input.lastRetrievedAt && input.lastId) predicates.push(sql`(rr.retrieved_at, rr.id) < (${input.lastRetrievedAt}::timestamptz, ${input.lastId}::uuid)`);
  return sql`
      with page as materialized (
        select rr.id, rr.project_id, rr.retrieved_at, rr.title, rr.authors, rr.publication_year,
          rr.venue, rr.doi, rr.source_record_id, rr.abstract, rr.raw_citation
        from retrieved_records rr
        where ${sql.join(predicates, sql` and `)}
        order by rr.retrieved_at desc nulls last, rr.id desc nulls last
        limit ${input.pageSize + 1}
      )
      select rr.id, rr.retrieved_at,
        to_char(rr.retrieved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as retrieved_at_cursor,
      ${codePointPreview(sql`rr.title`, 200)} as title,
      author_preview.authors_preview,
      greatest(cardinality(rr.authors)-3, 0)::int as additional_authors_count,
      rr.publication_year,
      ${codePointPreview(sql`rr.venue`, 100)} as venue_preview,
      ${codePointPreview(sql`rr.doi`, 120)} as doi_preview,
      ${codePointPreview(sql`rr.source_record_id`, 120)} as source_record_id_preview,
      ${codePointPreview(sql`rr.abstract`, 240)} as abstract_preview,
      ${codePointPreview(sql`rr.raw_citation`, 300)} as raw_citation_preview,
      case when latest.action='linked' then latest.paper_id else null end as current_paper_id,
      case when latest.action='linked' then ${codePointPreview(sql`current_paper.title`, 200)} else null end as current_paper_title
    from page rr
    cross join lateral (
      select coalesce(array_agg(
        case when char_length(author_value) > 80 then left(author_value, 79) || '…' else author_value end
        order by author_ordinal
      ), '{}'::text[]) as authors_preview
      from (
        select author_value, author_ordinal
        from unnest(rr.authors) with ordinality as author_rows(author_value, author_ordinal)
        order by author_ordinal
        limit 3
      ) selected_authors
    ) author_preview
    left join lateral (
      select match.paper_id, match.action
      from retrieved_record_matches match
      where match.project_id=rr.project_id and match.retrieved_record_id=rr.id
      order by match.sequence desc, match.id desc
      limit 1
    ) latest on true
    left join papers current_paper on current_paper.project_id=rr.project_id and current_paper.id=latest.paper_id
    order by rr.retrieved_at desc nulls last, rr.id desc nulls last
  `;
}

function buildRetrievedRecordDetailQuery(projectId: string, runId: string, recordId: string) {
  return sql`
    select rr.id as record_id, rr.project_id, rr.search_run_id, rr.search_source_id,
      rr.source_record_id, rr.title, rr.authors, rr.abstract, rr.doi, rr.url,
      rr.publication_year, rr.venue, rr.raw_citation, rr.retrieved_at, rr.created_at as record_created_at,
      sr.sequence as run_sequence, sr.source_key_snapshot, sr.source_display_name_snapshot,
      sr.strategy_id, sr.query_text, sr.filters_text_snapshot, sr.reported_result_count,
      sr.executed_at, sr.notes as run_notes,
      latest.id as match_id, latest.sequence as match_sequence, latest.paper_id,
      paper.title as paper_title, latest.created_at as match_created_at
    from retrieved_records rr
    join search_runs sr on sr.project_id=rr.project_id and sr.id=rr.search_run_id
    left join lateral (
      select match.id, match.sequence, match.paper_id, match.action, match.created_at
      from retrieved_record_matches match
      where match.project_id=rr.project_id and match.retrieved_record_id=rr.id
      order by match.sequence desc, match.id desc
      limit 1
    ) latest on latest.action='linked'
    left join papers paper on paper.project_id=rr.project_id and paper.id=latest.paper_id
    where rr.project_id=${projectId} and rr.search_run_id=${runId} and rr.id=${recordId}
    limit 1
  `;
}

function buildMatchHistoryPageQuery(input: {
  projectId: string; runId: string; recordId: string; pageSize: number;
  highWaterSequence: number; lastSequence?: number; lastId?: string;
}) {
  const continuation = input.lastSequence === undefined || !input.lastId
    ? null
    : sql`(match.sequence > ${input.lastSequence} or (match.sequence = ${input.lastSequence} and match.id > ${input.lastId}::uuid))`;
  return sql`
    select match.id, match.sequence, match.action, match.paper_id,
      ${codePointPreview(sql`paper.title`, 200)} as paper_title, match.created_at
    from retrieved_record_matches match
    join retrieved_records record on record.project_id=match.project_id and record.id=match.retrieved_record_id
    join papers paper on paper.project_id=match.project_id and paper.id=match.paper_id
    where match.project_id=${input.projectId} and record.search_run_id=${input.runId}
      and match.retrieved_record_id=${input.recordId} and match.sequence <= ${input.highWaterSequence}
      ${continuation ? sql`and ${continuation}` : sql``}
    order by match.sequence asc, match.id asc
    limit ${input.pageSize + 1}
  `;
}

function doiComparison(expression: SQL): SQL {
  return sql`btrim(lower(regexp_replace(regexp_replace(btrim(${expression}), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))`;
}

export function buildRetrievedRecordDuplicateCandidatePageQuery(input: {
  projectId: string; runId: string; recordId: string; pageSize: number; snapshotAt: string;
  matchHighWaterSequence: number; lastCreatedAt?: string; lastId?: string;
}) {
  const continuation = input.lastCreatedAt && input.lastId
    ? sql`and (paper.created_at, paper.id) > (${input.lastCreatedAt}::timestamptz, ${input.lastId}::uuid)`
    : sql``;
  return sql`
    with record as (
      select rr.id, rr.project_id, rr.search_run_id, rr.search_source_id, rr.source_record_id,
        rr.doi, rr.title, rr.publication_year
      from retrieved_records rr
      where rr.project_id=${input.projectId} and rr.search_run_id=${input.runId} and rr.id=${input.recordId}
    ), current_match as (
      select match.paper_id, match.action
      from retrieved_record_matches match
      where match.project_id=${input.projectId} and match.retrieved_record_id=${input.recordId}
        and match.sequence <= ${input.matchHighWaterSequence}
      order by match.sequence desc, match.id desc
      limit 1
    )
    select paper.id, ${codePointPreview(sql`paper.title`, 200)} as title, paper.created_at,
      to_char(paper.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_cursor
    from record
    join papers paper on paper.project_id=record.project_id and paper.created_at <= ${input.snapshotAt}::timestamptz
    where (
      (record.doi is not null and btrim(record.doi) <> '' and paper.doi is not null and btrim(paper.doi) <> ''
        and ${doiComparison(sql`record.doi`)}=${doiComparison(sql`paper.doi`)})
      or (record.publication_year is not null and lower(regexp_replace(btrim(record.title), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(btrim(paper.title), '[[:space:]]+', ' ', 'g')) and record.publication_year=paper.publication_year)
      or (record.source_record_id is not null and exists (
        select 1 from retrieved_records sibling
        where sibling.project_id=record.project_id and sibling.id <> record.id
          and sibling.search_source_id=record.search_source_id
          and sibling.source_record_id=record.source_record_id
          and exists (
            select 1 from retrieved_record_matches linked
            where linked.project_id=sibling.project_id and linked.retrieved_record_id=sibling.id
              and linked.paper_id=paper.id and linked.action='linked'
              and linked.sequence <= ${input.matchHighWaterSequence}
              and not exists (
                select 1 from retrieved_record_matches newer
                where newer.project_id=linked.project_id and newer.retrieved_record_id=linked.retrieved_record_id
                  and newer.sequence <= ${input.matchHighWaterSequence}
                  and (newer.sequence > linked.sequence or (newer.sequence=linked.sequence and newer.id > linked.id))
              )
          )
      ))
    )
      and not exists (select 1 from current_match where action='linked' and paper_id=paper.id)
      ${continuation}
    order by paper.created_at asc, paper.id asc
    limit ${input.pageSize + 1}
  `;
}

function pageResult<T, C extends SearchRunCursor | RetrievedRecordCursor | MatchHistoryCursor | DuplicateCandidateCursor>(
  rows: T[], pageSize: number, createCursor: (last: T) => C,
) {
  const hasMore = rows.length > pageSize;
  const items = hasMore ? rows.slice(0, pageSize) : rows;
  return { items, pageSize, hasMore, nextCursor: hasMore && items.length ? encodeCursor(createCursor(items[items.length - 1]!)) : null };
}

export function createAcquisitionReadServices(db: Database) {
  return {
    async getSearchRunPage(projectIdInput: string, input: AcquisitionPageOptions = {}): Promise<SearchRunPage> {
      const projectId = ensureUuid(projectIdInput, "Project");
      const pageSize = positivePageSize(input.pageSize, ACQUISITION_PAGE_DEFAULT_SIZE, ACQUISITION_PAGE_MAX_SIZE);
      const cursor = requireBoundCursor<SearchRunCursor>(input.cursor, { projectId, pageSize }, (raw) => {
        if (raw.v !== 1 || raw.lastId == null) throw new Error("invalid cursor");
        return {
          v: 1, projectId, pageSize,
          highWaterSequence: cursorInteger(raw.highWaterSequence),
          lastSequence: cursorInteger(raw.lastSequence),
          lastId: ensureUuid(raw.lastId, "Cursor record"),
        };
      });
      return db.transaction(async (tx) => {
        let highWaterSequence = cursor?.highWaterSequence;
        if (highWaterSequence === undefined) {
          const anchor = records(await tx.execute(sql`select coalesce(max(sequence), 0)::bigint as high_water_sequence from search_runs where project_id=${projectId}`))[0];
          highWaterSequence = safeInteger(anchor?.high_water_sequence, "SearchRun high-water sequence");
        }
        const selected = records(await tx.execute(buildSearchRunPageQuery({
          projectId, highWaterSequence, pageSize,
          lastSequence: cursor?.lastSequence, lastId: cursor?.lastId,
        })));
        const mapped = selected.map(searchRunRow);
        return pageResult(mapped, pageSize, (last) => ({ v: 1, projectId, pageSize, highWaterSequence, lastSequence: last.sequence, lastId: last.id }));
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async getRetrievedRecordPage(projectIdInput: string, runIdInput: string, input: RetrievedRecordPageOptions = {}): Promise<RetrievedRecordPage> {
      const projectId = ensureUuid(projectIdInput, "Project");
      const runId = ensureUuid(runIdInput, "SearchRun");
      const filter = normalizeFilter(input);
      const pageSize = positivePageSize(input.pageSize, ACQUISITION_PAGE_DEFAULT_SIZE, ACQUISITION_PAGE_MAX_SIZE);
      const cursor = requireBoundCursor<RetrievedRecordCursor>(input.cursor, { projectId, pageSize }, (raw) => {
        if (raw.v !== 2 || raw.runId !== runId || raw.filterKind !== filter.filterKind || raw.normalizedFilter !== filter.normalizedFilter) throw new Error("invalid cursor");
        return {
          v: 2, projectId, runId, pageSize,
          filterKind: filter.filterKind,
          normalizedFilter: filter.normalizedFilter,
          snapshotAt: cursorTimestamp(raw.snapshotAt),
          lastRetrievedAt: cursorTimestamp(raw.lastRetrievedAt),
          lastId: ensureUuid(raw.lastId, "Cursor record"),
        };
      });
      const result = await db.transaction(async (tx) => {
        let snapshotAt = cursor?.snapshotAt;
        if (snapshotAt === undefined) {
          const anchor = records(await tx.execute(sql`
            select run.id, to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as snapshot_at
            from search_runs run where run.project_id=${projectId} and run.id=${runId} limit 1
          `))[0];
          if (!anchor) throw new DomainError("CROSS_PROJECT_REFERENCE", "SearchRun does not belong to this project");
          snapshotAt = cursorTimestamp(anchor.snapshot_at);
        }
        const selected = records(await tx.execute(buildRetrievedRecordPageQuery({
          projectId, runId, pageSize, snapshotAt,
          filterKind: filter.filterKind, normalizedFilter: filter.normalizedFilter,
          lastRetrievedAt: cursor?.lastRetrievedAt, lastId: cursor?.lastId,
        })));
        const mapped = selected.map((row) => ({
          item: retrievedRecordPageRow(row),
          cursorRetrievedAt: cursorTimestamp(row.retrieved_at_cursor),
        }));
        const page = pageResult(mapped, pageSize, (last) => ({
          v: 2, projectId, runId, pageSize, filterKind: filter.filterKind,
          normalizedFilter: filter.normalizedFilter, snapshotAt,
          lastRetrievedAt: last.cursorRetrievedAt, lastId: last.item.id,
        }));
        return { ...page, items: page.items.map(({ item }) => item) };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
      return { ...result, searchField: filter.filterKind === "none" ? null : filter.filterKind, normalizedSearch: filter.filterKind === "none" ? null : filter.normalizedFilter };
    },

    async getRetrievedRecordDetail(projectIdInput: string, runIdInput: string, recordIdInput: string): Promise<RetrievedRecordDetail | null> {
      const projectId = ensureUuid(projectIdInput, "Project");
      const runId = ensureUuid(runIdInput, "SearchRun");
      const recordId = ensureUuid(recordIdInput, "RetrievedRecord");
      const row = records(await db.execute(buildRetrievedRecordDetailQuery(projectId, runId, recordId)))[0];
      if (!row) return null;
      const asDate = (value: unknown) => value instanceof Date ? value : new Date(String(value));
      return {
        record: {
          id: String(row.record_id), projectId: String(row.project_id), searchRunId: String(row.search_run_id), searchSourceId: String(row.search_source_id),
          sourceRecordId: row.source_record_id == null ? null : String(row.source_record_id), title: String(row.title),
          authors: Array.isArray(row.authors) ? row.authors.map(String) : [], abstract: row.abstract == null ? null : String(row.abstract),
          doi: row.doi == null ? null : String(row.doi), url: row.url == null ? null : String(row.url),
          publicationYear: row.publication_year == null ? null : safeInteger(row.publication_year, "Publication year"),
          venue: row.venue == null ? null : String(row.venue), rawCitation: row.raw_citation == null ? null : String(row.raw_citation),
          retrievedAt: asDate(row.retrieved_at), createdAt: asDate(row.record_created_at),
        },
        run: {
          id: String(row.search_run_id), sequence: safeInteger(row.run_sequence, "SearchRun sequence"), searchSourceId: String(row.search_source_id),
          sourceKeySnapshot: String(row.source_key_snapshot), sourceDisplayNameSnapshot: String(row.source_display_name_snapshot),
          strategyId: String(row.strategy_id), queryText: String(row.query_text),
          filtersTextSnapshot: row.filters_text_snapshot == null ? null : String(row.filters_text_snapshot),
          reportedResultCount: safeInteger(row.reported_result_count, "Reported result count"), executedAt: asDate(row.executed_at),
          notes: row.run_notes == null ? null : String(row.run_notes),
        },
        currentMatch: row.match_id == null ? null : {
          id: String(row.match_id), sequence: safeInteger(row.match_sequence, "Match sequence"),
          paperId: String(row.paper_id), paperTitle: String(row.paper_title), createdAt: asDate(row.match_created_at),
        },
      };
    },

    async getRetrievedRecordMatchHistoryPage(projectIdInput: string, runIdInput: string, recordIdInput: string, input: AcquisitionPageOptions = {}): Promise<RetrievedRecordMatchHistoryPage> {
      const projectId = ensureUuid(projectIdInput, "Project");
      const runId = ensureUuid(runIdInput, "SearchRun");
      const recordId = ensureUuid(recordIdInput, "RetrievedRecord");
      const pageSize = positivePageSize(input.pageSize, ACQUISITION_HISTORY_DEFAULT_SIZE, ACQUISITION_HISTORY_MAX_SIZE);
      const cursor = requireBoundCursor<MatchHistoryCursor>(input.cursor, { projectId, pageSize }, (raw) => {
        if (raw.v !== 1 || raw.runId !== runId || raw.recordId !== recordId || raw.lastId == null) throw new Error("invalid cursor");
        return {
          v: 1, projectId, runId, recordId, pageSize,
          highWaterSequence: cursorInteger(raw.highWaterSequence), lastSequence: cursorInteger(raw.lastSequence),
          lastId: ensureUuid(raw.lastId, "Cursor event"),
        };
      });
      return db.transaction(async (tx) => {
        let highWaterSequence = cursor?.highWaterSequence;
        if (highWaterSequence === undefined) {
          const anchor = records(await tx.execute(sql`
            select record.id, coalesce(max(match.sequence),0)::bigint as high_water_sequence
            from retrieved_records record
            left join retrieved_record_matches match on match.project_id=record.project_id and match.retrieved_record_id=record.id
            where record.project_id=${projectId} and record.search_run_id=${runId} and record.id=${recordId}
            group by record.id
          `))[0];
          if (!anchor) throw new DomainError("NOT_FOUND", "RetrievedRecord was not found");
          highWaterSequence = safeInteger(anchor.high_water_sequence, "Match history high-water sequence");
        }
        const selected = records(await tx.execute(buildMatchHistoryPageQuery({
          projectId, runId, recordId, pageSize, highWaterSequence,
          lastSequence: cursor?.lastSequence, lastId: cursor?.lastId,
        })));
        const mapped = selected.map((row): RetrievedRecordMatchHistoryRow => ({
          id: String(row.id), sequence: safeInteger(row.sequence, "Match sequence"), action: String(row.action) as "linked" | "unlinked",
          paperId: String(row.paper_id), paperTitle: String(row.paper_title), createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
        }));
        return pageResult(mapped, pageSize, (last) => ({ v: 1, projectId, runId, recordId, pageSize, highWaterSequence, lastSequence: last.sequence, lastId: last.id }));
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async getRetrievedRecordDuplicateCandidatePage(projectIdInput: string, runIdInput: string, recordIdInput: string, input: AcquisitionPageOptions = {}): Promise<RetrievedRecordDuplicateCandidatePage> {
      const projectId = ensureUuid(projectIdInput, "Project");
      const runId = ensureUuid(runIdInput, "SearchRun");
      const recordId = ensureUuid(recordIdInput, "RetrievedRecord");
      const pageSize = positivePageSize(input.pageSize, ACQUISITION_CANDIDATE_DEFAULT_SIZE, ACQUISITION_CANDIDATE_MAX_SIZE);
      const cursor = requireBoundCursor<DuplicateCandidateCursor>(input.cursor, { projectId, pageSize }, (raw) => {
        if (raw.v !== 2 || raw.runId !== runId || raw.recordId !== recordId || raw.lastId == null) throw new Error("invalid cursor");
        return {
          v: 2, projectId, runId, recordId, pageSize,
          snapshotAt: cursorTimestamp(raw.snapshotAt), matchHighWaterSequence: cursorInteger(raw.matchHighWaterSequence),
          lastCreatedAt: cursorTimestamp(raw.lastCreatedAt), lastId: ensureUuid(raw.lastId, "Cursor Paper"),
        };
      });
      return db.transaction(async (tx) => {
        let snapshotAt = cursor?.snapshotAt;
        let matchHighWaterSequence = cursor?.matchHighWaterSequence;
        if (snapshotAt === undefined || matchHighWaterSequence === undefined) {
          const anchor = records(await tx.execute(sql`
              select record.id, to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as snapshot_at,
              coalesce((select max(match.sequence) from retrieved_record_matches match where match.project_id=${projectId}),0)::bigint as match_high_water_sequence
            from retrieved_records record
            where record.project_id=${projectId} and record.search_run_id=${runId} and record.id=${recordId}
          `))[0];
          if (!anchor) throw new DomainError("NOT_FOUND", "RetrievedRecord was not found");
          snapshotAt = cursorTimestamp(anchor.snapshot_at);
          matchHighWaterSequence = safeInteger(anchor.match_high_water_sequence, "Match high-water sequence");
        }
        const selected = records(await tx.execute(buildRetrievedRecordDuplicateCandidatePageQuery({
          projectId, runId, recordId, pageSize, snapshotAt, matchHighWaterSequence,
          lastCreatedAt: cursor?.lastCreatedAt, lastId: cursor?.lastId,
        })));
        const mapped = selected.map((row) => ({
          item: { id: String(row.id), title: String(row.title), createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)) } satisfies RetrievedRecordDuplicateCandidate,
          cursorCreatedAt: cursorTimestamp(row.created_at_cursor),
        }));
        const page = pageResult(mapped, pageSize, (last) => ({
          v: 2, projectId, runId, recordId, pageSize, snapshotAt, matchHighWaterSequence,
          lastCreatedAt: last.cursorCreatedAt, lastId: last.item.id,
        }));
        return { ...page, items: page.items.map(({ item }) => item) };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}

export type AcquisitionReadServices = ReturnType<typeof createAcquisitionReadServices>;
