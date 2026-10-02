import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { canonicalizeDeduplicationPair } from "@/domain/deduplication";
import { DomainError } from "@/domain/errors";
import { idSchema } from "@/domain/validation";
import { deduplicationCandidateSignalPredicates, unresolvedDuplicatePairProbeCtes } from "./unresolved-duplicate-pair-query";
import type {
  DeduplicationDecisionEvent,
  DeduplicationHistoryItem,
  DeduplicationHistoryPage,
  DeduplicationQueueItem,
  DeduplicationQueuePage,
} from "./deduplication-read-types";

type Row = Record<string, unknown>;
type QueueCursor = { v: 1; p: string; f: "all"; n: number; s: 0 | 1; l: string; r: string };
type HistoryCursor = { v: 1; p: string; l: string; r: string; n: number; s: string; i: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BIGINT = "9223372036854775807";
const QUEUE_DEFAULT_PAGE_SIZE = 25;
const QUEUE_MAX_PAGE_SIZE = 50;
const HISTORY_DEFAULT_PAGE_SIZE = 20;
const HISTORY_MAX_PAGE_SIZE = 50;
const QUEUE_CURSOR_LIMIT = 256;
const HISTORY_CURSOR_LIMIT = 512;
const QUEUE_PAYLOAD_LIMIT = 512 * 1024;
const HISTORY_PAYLOAD_LIMIT = 256 * 1024;

function rows(value: unknown): Row[] { return value as Row[]; }

function uuid(value: unknown, label: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success || typeof value !== "string" || !UUID.test(value)) {
    throw new DomainError("VALIDATION_ERROR", `${label} must be a valid UUID`);
  }
  return parsed.data.toLowerCase();
}

function pageSize(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new DomainError("VALIDATION_ERROR", "Page size must be a positive integer");
  return Math.min(value, maximum);
}

function invalidCursor(): DomainError {
  return new DomainError("VALIDATION_ERROR", "Page cursor is invalid or belongs to a different page. Start from the first page.");
}

function decodeCursor(token: string | null | undefined, maximumLength: number): Record<string, unknown> | null {
  if (token == null) return null;
  if (typeof token !== "string" || token.length === 0 || token.length > maximumLength || !/^[A-Za-z0-9_-]+$/.test(token)) throw invalidCursor();
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== token) throw new Error("non-canonical cursor");
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid cursor");
    return parsed as Record<string, unknown>;
  } catch {
    throw invalidCursor();
  }
}

function encodeCursor(value: object, maximumLength: number): string {
  const token = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (token.length > maximumLength) throw new DomainError("DATABASE_CONSTRAINT", "Page cursor exceeds its size limit");
  return token;
}

function cursorUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value) || value !== value.toLowerCase()) throw new Error("invalid cursor UUID");
  return value;
}

function cursorBigint(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid cursor sequence");
  if (value.length > MAX_BIGINT.length || (value.length === MAX_BIGINT.length && value > MAX_BIGINT)) throw new Error("cursor sequence is out of range");
  return value;
}

function bindQueueCursor(token: string | null | undefined, projectId: string, size: number): QueueCursor | null {
  const raw = decodeCursor(token, QUEUE_CURSOR_LIMIT);
  if (!raw) return null;
  try {
    const cursor: QueueCursor = {
      v: raw.v as 1,
      p: cursorUuid(raw.p),
      f: raw.f as "all",
      n: raw.n as number,
      s: raw.s as 0 | 1,
      l: cursorUuid(raw.l),
      r: cursorUuid(raw.r),
    };
    if (cursor.v !== 1 || cursor.p !== projectId || cursor.f !== "all" || cursor.n !== size || (cursor.s !== 0 && cursor.s !== 1) || cursor.l >= cursor.r) throw new Error("cursor binding mismatch");
    if (Object.keys(raw).length !== 7 || JSON.stringify(cursor) !== JSON.stringify(raw)) throw new Error("non-canonical cursor shape");
    return cursor;
  } catch {
    throw invalidCursor();
  }
}

function bindHistoryCursor(token: string | null | undefined, scope: { projectId: string; leftId: string; rightId: string; size: number }): HistoryCursor | null {
  const raw = decodeCursor(token, HISTORY_CURSOR_LIMIT);
  if (!raw) return null;
  try {
    const cursor: HistoryCursor = {
      v: raw.v as 1,
      p: cursorUuid(raw.p),
      l: cursorUuid(raw.l),
      r: cursorUuid(raw.r),
      n: raw.n as number,
      s: cursorBigint(raw.s),
      i: cursorUuid(raw.i),
    };
    if (cursor.v !== 1 || cursor.p !== scope.projectId || cursor.l !== scope.leftId || cursor.r !== scope.rightId || cursor.n !== scope.size || cursor.l >= cursor.r) throw new Error("cursor binding mismatch");
    if (Object.keys(raw).length !== 7 || JSON.stringify(cursor) !== JSON.stringify(raw)) throw new Error("non-canonical cursor shape");
    return cursor;
  } catch {
    throw invalidCursor();
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function preview(column: SQL, maximum: number): SQL {
  return sql`case when ${column} is null then null when char_length(${column}) > ${maximum} then left(${column}, ${maximum - 1}) || '…' else ${column} end`;
}

function authorPreview(alias: "a" | "b"): SQL {
  const authors = sql.raw(`${alias}.authors`);
  return sql`(select case when char_length(value) > 230 then left(value, 229) || '…' else value end from (select array_to_string(${authors}[1:3], ', ') as value) author_preview)`;
}

function pairProbeQuery(projectId: string, keyLimit: number, cursor: QueueCursor | null): SQL {
  const signals = deduplicationCandidateSignalPredicates();
  const pairCursor = cursor ? { strengthRank: cursor.s, leftId: cursor.l, rightId: cursor.r } : null;
  return sql`
    with ${unresolvedDuplicatePairProbeCtes(projectId, keyLimit, pairCursor)}, visible_pairs as materialized (
      select strength_rank, left_record_id, right_record_id
      from ordered_probe order by strength_rank, left_record_id, right_record_id limit ${Math.max(1, keyLimit - 1)}
    ), visible_record_ids as (
      select left_record_id as record_id from visible_pairs
      union
      select right_record_id as record_id from visible_pairs
    ), latest_match_state as (
      select distinct on (m.retrieved_record_id) m.retrieved_record_id, m.paper_id, m.action
      from retrieved_record_matches m
      join visible_record_ids v on v.record_id = m.retrieved_record_id
      where m.project_id = ${projectId}::uuid
      order by m.retrieved_record_id, m.sequence desc, m.id desc
    ), hydrated as (
      select p.strength_rank, p.left_record_id, p.right_record_id,
        jsonb_build_object(
          'leftRetrievedRecord', jsonb_build_object(
            'id', a.id::text, 'title', ${preview(sql.raw("a.title"), 230)}, 'authors', ${authorPreview("a")},
            'publicationYear', a.publication_year, 'doi', ${preview(sql.raw("a.doi"), 200)},
            'sourceRecordId', ${preview(sql.raw("a.source_record_id"), 160)},
            'currentPaperId', case when lm.action='linked' then lm.paper_id::text else null end,
            'mappingStatus', coalesce(lm.action, 'unmapped')
          ),
          'rightRetrievedRecord', jsonb_build_object(
            'id', b.id::text, 'title', ${preview(sql.raw("b.title"), 230)}, 'authors', ${authorPreview("b")},
            'publicationYear', b.publication_year, 'doi', ${preview(sql.raw("b.doi"), 200)},
            'sourceRecordId', ${preview(sql.raw("b.source_record_id"), 160)},
            'currentPaperId', case when rm.action='linked' then rm.paper_id::text else null end,
            'mappingStatus', coalesce(rm.action, 'unmapped')
          ),
          'reasons', array_remove(array[
            case when ${signals.doi} then 'normalized_doi'::text end,
            case when ${signals.sourceRecordId} then 'same_source_record_id'::text end,
            case when ${signals.titleYear} then 'normalized_title_year'::text end
          ], null::text),
          'strength', case when p.strength_rank=0 then 'strong' else 'possible' end
        ) as item
      from visible_pairs p
      join retrieved_records a on a.project_id = ${projectId}::uuid and a.id = p.left_record_id
      join retrieved_records b on b.project_id = ${projectId}::uuid and b.id = p.right_record_id
      left join latest_match_state lm on lm.retrieved_record_id = a.id
      left join latest_match_state rm on rm.retrieved_record_id = b.id
    )
    select coalesce((select jsonb_agg(item order by strength_rank, left_record_id, right_record_id) from hydrated), '[]'::jsonb) as items,
      (select count(*) > ${Math.max(1, keyLimit - 1)} from ordered_probe) as has_more
  `;
}

/** The exact bounded pair-ID and visible-record SQL used by the queue service. */
export function buildDeduplicationQueuePageQuery(projectIdInput: string, options: { pageSize?: number; cursor?: string | null } = {}): SQL {
  const projectId = uuid(projectIdInput, "Project identifier");
  const size = pageSize(options.pageSize, QUEUE_DEFAULT_PAGE_SIZE, QUEUE_MAX_PAGE_SIZE);
  const cursor = bindQueueCursor(options.cursor, projectId, size);
  return pairProbeQuery(projectId, size + 1, cursor);
}

function historyScopeQuery(projectId: string, leftId: string, rightId: string): SQL {
  return sql`
    select p.id::text as project_id, p.title as project_title
    from projects p
    where p.id = ${projectId}::uuid
      and exists (
        select 1 from retrieved_records a
        join retrieved_records b on b.project_id = a.project_id and b.id = ${rightId}::uuid
        where a.project_id = p.id and a.id = ${leftId}::uuid
      )
    limit 1
  `;
}

function historyPageQuery(projectId: string, leftId: string, rightId: string, size: number, cursor: HistoryCursor | null): SQL {
  const after = cursor ? sql`and (sequence > ${cursor.s}::bigint or (sequence = ${cursor.s}::bigint and id > ${cursor.i}::uuid))` : sql``;
  return sql`
    select id::text, sequence::text as sequence, decision,
      case when note is null then null when char_length(note) > 600 then left(note, 599) || '…' else note end as note_preview,
      coalesce(char_length(note) > 600, false) as note_truncated,
      created_at
    from retrieved_record_deduplication_decisions
    where project_id = ${projectId}::uuid
      and left_retrieved_record_id = ${leftId}::uuid
      and right_retrieved_record_id = ${rightId}::uuid
      ${after}
    order by sequence asc, id asc
    limit ${size + 1}
  `;
}

/** The exact bounded history-page SQL used by the history service and PG benchmark. */
export function buildDeduplicationHistoryPageQuery(
  projectIdInput: string,
  leftInput: string,
  rightInput: string,
  options: { pageSize?: number; cursor?: string | null } = {},
): SQL {
  const projectId = uuid(projectIdInput, "Project identifier");
  let canonical: { leftRetrievedRecordId: string; rightRetrievedRecordId: string };
  try {
    canonical = canonicalizeDeduplicationPair({
      leftRetrievedRecordId: uuid(leftInput, "Retrieved record identifier"),
      rightRetrievedRecordId: uuid(rightInput, "Retrieved record identifier"),
    });
  } catch (error) {
    throw new DomainError("VALIDATION_ERROR", error instanceof Error ? error.message : "Record pair is invalid");
  }
  const size = pageSize(options.pageSize, HISTORY_DEFAULT_PAGE_SIZE, HISTORY_MAX_PAGE_SIZE);
  const scope = { projectId, leftId: canonical.leftRetrievedRecordId, rightId: canonical.rightRetrievedRecordId, size };
  return historyPageQuery(projectId, scope.leftId, scope.rightId, size, bindHistoryCursor(options.cursor, scope));
}

export function createDeduplicationReadServices(db: Database) {
  async function listDeduplicationQueuePage(projectIdInput: string, options: { pageSize?: number; cursor?: string | null } = {}): Promise<DeduplicationQueuePage> {
    const projectId = uuid(projectIdInput, "Project identifier");
    const size = pageSize(options.pageSize, QUEUE_DEFAULT_PAGE_SIZE, QUEUE_MAX_PAGE_SIZE);
    const cursor = bindQueueCursor(options.cursor, projectId, size);
    return db.transaction(async (tx) => {
      const scope = rows(await tx.execute(sql`select id::text as id, case when char_length(title)>230 then left(title,229)||'…' else title end as title from projects where id=${projectId}::uuid limit 1`))[0];
      if (!scope) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
      const result = rows(await tx.execute(pairProbeQuery(projectId, size + 1, cursor)))[0];
      const items = (result?.items ?? []) as DeduplicationQueueItem[];
      const hasMore = result?.has_more === true || result?.has_more === "t";
      const last = hasMore ? items[items.length - 1] : undefined;
      const rank: 0 | 1 | undefined = last ? last.strength === "strong" ? 0 : 1 : undefined;
      const page: DeduplicationQueuePage = {
        project: { id: projectId, title: String(scope.title) }, items, pageSize: size, hasMore,
        nextCursor: last && rank !== undefined ? encodeCursor({ v: 1, p: projectId, f: "all", n: size, s: rank, l: last.leftRetrievedRecord.id, r: last.rightRetrievedRecord.id } satisfies QueueCursor, QUEUE_CURSOR_LIMIT) : null,
      };
      if (jsonBytes(page) > QUEUE_PAYLOAD_LIMIT) throw new DomainError("DATABASE_CONSTRAINT", "Deduplication queue page exceeds its payload limit");
      return page;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function listDeduplicationHistoryPage(projectIdInput: string, leftInput: string, rightInput: string, options: { pageSize?: number; cursor?: string | null } = {}): Promise<DeduplicationHistoryPage> {
    const projectId = uuid(projectIdInput, "Project identifier");
    let canonical: { leftRetrievedRecordId: string; rightRetrievedRecordId: string };
    try { canonical = canonicalizeDeduplicationPair({ leftRetrievedRecordId: uuid(leftInput, "Retrieved record identifier"), rightRetrievedRecordId: uuid(rightInput, "Retrieved record identifier") }); }
    catch (error) { throw new DomainError("VALIDATION_ERROR", error instanceof Error ? error.message : "Record pair is invalid"); }
    const size = pageSize(options.pageSize, HISTORY_DEFAULT_PAGE_SIZE, HISTORY_MAX_PAGE_SIZE);
    const scope = { projectId, leftId: canonical.leftRetrievedRecordId, rightId: canonical.rightRetrievedRecordId, size };
    const cursor = bindHistoryCursor(options.cursor, scope);
    return db.transaction(async (tx) => {
      const head = rows(await tx.execute(historyScopeQuery(scope.projectId, scope.leftId, scope.rightId)))[0];
      if (!head) throw new DomainError("CROSS_PROJECT_REFERENCE", "Retrieved record pair was not found");
      const fetched = rows(await tx.execute(historyPageQuery(scope.projectId, scope.leftId, scope.rightId, size, cursor)));
      const hasMore = fetched.length > size;
      const selected = (hasMore ? fetched.slice(0, size) : fetched).map((row): DeduplicationHistoryItem => ({
        id: String(row.id), sequence: cursorBigint(row.sequence), decision: row.decision as DeduplicationHistoryItem["decision"],
        notePreview: row.note_preview == null ? null : String(row.note_preview), noteTruncated: row.note_truncated === true || row.note_truncated === "t",
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
      }));
      const payload = { project: { id: projectId, title: String(head.project_title) }, items: selected, pageSize: size, hasMore, nextCursor: null as string | null };
      const last = hasMore ? selected[selected.length - 1] : undefined;
      payload.nextCursor = last ? encodeCursor({ v: 1, p: projectId, l: scope.leftId, r: scope.rightId, n: size, s: last.sequence, i: last.id } satisfies HistoryCursor, HISTORY_CURSOR_LIMIT) : null;
      if (jsonBytes(payload) > HISTORY_PAYLOAD_LIMIT) throw new DomainError("DATABASE_CONSTRAINT", "Deduplication history page exceeds its payload limit");
      return payload;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function getDeduplicationDecisionEvent(projectIdInput: string, leftInput: string, rightInput: string, decisionIdInput: string): Promise<DeduplicationDecisionEvent> {
    const projectId = uuid(projectIdInput, "Project identifier");
    const decisionId = uuid(decisionIdInput, "Decision identifier");
    let canonical: { leftRetrievedRecordId: string; rightRetrievedRecordId: string };
    try { canonical = canonicalizeDeduplicationPair({ leftRetrievedRecordId: uuid(leftInput, "Retrieved record identifier"), rightRetrievedRecordId: uuid(rightInput, "Retrieved record identifier") }); }
    catch (error) { throw new DomainError("VALIDATION_ERROR", error instanceof Error ? error.message : "Record pair is invalid"); }
    const result = rows(await db.execute(sql`
      select id::text, sequence::text as sequence, project_id::text as project_id,
        left_retrieved_record_id::text as left_retrieved_record_id,
        right_retrieved_record_id::text as right_retrieved_record_id,
        decision, note, created_at
      from retrieved_record_deduplication_decisions
      where project_id=${projectId}::uuid
        and left_retrieved_record_id=${canonical.leftRetrievedRecordId}::uuid
        and right_retrieved_record_id=${canonical.rightRetrievedRecordId}::uuid
        and id=${decisionId}::uuid
      limit 1
    `))[0];
    if (!result) throw new DomainError("CROSS_PROJECT_REFERENCE", "Decision event was not found for this Project and record pair");
    return {
      id: String(result.id), sequence: cursorBigint(result.sequence), projectId: String(result.project_id),
      leftRetrievedRecordId: String(result.left_retrieved_record_id), rightRetrievedRecordId: String(result.right_retrieved_record_id),
      decision: result.decision as DeduplicationDecisionEvent["decision"], note: result.note == null ? null : String(result.note),
      createdAt: result.created_at instanceof Date ? result.created_at : new Date(String(result.created_at)),
    };
  }

  async function getDeduplicationPairForPage(projectId: string, left: string, right: string) {
    const projectIdValue = uuid(projectId, "Project identifier");
    let canonical: { leftRetrievedRecordId: string; rightRetrievedRecordId: string };
    try { canonical = canonicalizeDeduplicationPair({ leftRetrievedRecordId: uuid(left, "Retrieved record identifier"), rightRetrievedRecordId: uuid(right, "Retrieved record identifier") }); }
    catch (error) { throw new DomainError("VALIDATION_ERROR", error instanceof Error ? error.message : "Record pair is invalid"); }
    const rowsForPair = rows(await db.execute(sql`
      with latest_decision as (
        select distinct on (project_id, left_retrieved_record_id, right_retrieved_record_id)
          project_id, left_retrieved_record_id, right_retrieved_record_id, id, decision
        from retrieved_record_deduplication_decisions
        where project_id=${projectIdValue}::uuid and left_retrieved_record_id=${canonical.leftRetrievedRecordId}::uuid and right_retrieved_record_id=${canonical.rightRetrievedRecordId}::uuid
        order by project_id, left_retrieved_record_id, right_retrieved_record_id, sequence desc
      ), latest_matches as (
        select distinct on (project_id, retrieved_record_id) project_id, retrieved_record_id, paper_id, action
        from retrieved_record_matches
        where project_id=${projectIdValue}::uuid and retrieved_record_id in (${canonical.leftRetrievedRecordId}::uuid, ${canonical.rightRetrievedRecordId}::uuid)
        order by project_id, retrieved_record_id, sequence desc, id desc
      )
      select a.id as left_record_id, a.title as left_title, a.authors as left_authors, a.abstract as left_abstract,
        a.doi as left_doi, a.source_record_id as left_source_record_id, a.search_run_id as left_search_run_id,
        a.search_source_id as left_search_source_id, a.publication_year as left_publication_year,
        b.id as right_record_id, b.title as right_title, b.authors as right_authors, b.abstract as right_abstract,
        b.doi as right_doi, b.source_record_id as right_source_record_id, b.search_run_id as right_search_run_id,
        b.search_source_id as right_search_source_id, b.publication_year as right_publication_year,
        ld.id as decision_id, ld.decision,
        lm.paper_id as left_paper_id, rm.paper_id as right_paper_id
      from projects p
      join retrieved_records a on a.project_id=p.id and a.id=${canonical.leftRetrievedRecordId}::uuid
      join retrieved_records b on b.project_id=p.id and b.id=${canonical.rightRetrievedRecordId}::uuid
      left join latest_decision ld on true
      left join latest_matches lm on lm.retrieved_record_id=a.id and lm.action='linked'
      left join latest_matches rm on rm.retrieved_record_id=b.id and rm.action='linked'
      where p.id=${projectIdValue}::uuid
      limit 1
    `))[0];
    if (!rowsForPair) throw new DomainError("CROSS_PROJECT_REFERENCE", "Retrieved record pair was not found");
    const side = (row: Row, prefix: "left" | "right") => ({
      id: String(row[`${prefix}_record_id`]), title: String(row[`${prefix}_title`]), authors: row[`${prefix}_authors`] as string[],
      abstract: row[`${prefix}_abstract`] == null ? null : String(row[`${prefix}_abstract`]), doi: row[`${prefix}_doi`] == null ? null : String(row[`${prefix}_doi`]),
      sourceRecordId: row[`${prefix}_source_record_id`] == null ? null : String(row[`${prefix}_source_record_id`]),
      publicationYear: row[`${prefix}_publication_year`] == null ? null : Number(row[`${prefix}_publication_year`]),
    });
    return {
      leftRetrievedRecord: side(rowsForPair, "left"), rightRetrievedRecord: side(rowsForPair, "right"),
      reasons: [], strength: null, decision: rowsForPair.decision == null ? null : rowsForPair.decision,
      decisionId: rowsForPair.decision_id == null ? null : String(rowsForPair.decision_id),
      leftPaperId: rowsForPair.left_paper_id == null ? null : String(rowsForPair.left_paper_id),
      rightPaperId: rowsForPair.right_paper_id == null ? null : String(rowsForPair.right_paper_id),
    };
  }

  return { listDeduplicationQueuePage, listDeduplicationHistoryPage, getDeduplicationDecisionEvent, getDeduplicationPairForPage };
}
