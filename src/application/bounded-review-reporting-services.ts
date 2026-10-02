import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  REVIEW_REPORT_METRIC_KEYS,
  type BoundedReviewReportContributor,
  type InteractiveReviewReportSummary,
  type ReviewReportContextKind,
  type ReviewReportContextPage,
  type ReviewReportContextPageItem,
  type ReviewReportContributorPage,
  type ReviewReportContributorSelector,
  type ReviewReportReasonAggregatePage,
} from "@/domain/review-report";
import { DomainError } from "@/domain/errors";
import { idSchema } from "@/domain/validation";
import { buildInteractiveReviewReportSummary } from "./review-reporting";
import { ReviewReportingRepository } from "./review-reporting-repositories";
import { DeduplicationDecisionRepository } from "./deduplication-repositories";
import { mapReviewFlowSummaryRow, safeDatabaseInteger } from "./review-flow-summary";
import { unresolvedDuplicatePairCtes, unresolvedDuplicatePairProbeCtes } from "./unresolved-duplicate-pair-query";

type Row = Record<string, unknown>;
type ContextBoundary = { sortOrder: number; id: string } | { sourceKey: string; id: string } | { criterionId: string };
type ContributorBoundary = { sequence: string; id: string } | { rank: 0 | 1; leftId: string; rightId: string } | { leftId: string; rightId: string } | { firstRecordId: string; paperId: string } | { id: string };
type DecodedCursor = { v: 1; p: string; k: string; n: number; b: unknown[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BIGINT = "9223372036854775807";
const METRIC_KEYS = new Set<string>(REVIEW_REPORT_METRIC_KEYS);
const SOURCE_METRICS = new Set(["runs", "reportedResults", "retrievedRecords", "resolvedRecords", "acquisitionPapers"]);
const REASON_KINDS = new Set<ReviewReportContextKind>(["exclusion-reasons", "full-text-exclusion-reasons"]);
const CONTEXT_PAGE_SIZE = 10;
const CONTEXT_PAGE_MAX = 25;
const CONTRIBUTOR_PAGE_SIZE = 25;
const CONTRIBUTOR_PAGE_MAX = 50;
const CONTEXT_CURSOR_LIMIT = 2048;
const CONTRIBUTOR_CURSOR_LIMIT = 1024;
const CONTEXT_PAYLOAD_LIMIT = 128 * 1024;
const CONTRIBUTOR_PAYLOAD_LIMIT = 256 * 1024;
const SUMMARY_PAYLOAD_LIMIT = 256 * 1024;

function rows(value: unknown): Row[] { return value as Row[]; }

function uuid(value: unknown, label: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success || typeof value !== "string" || !UUID.test(value)) throw new DomainError("VALIDATION_ERROR", `${label} must be a valid UUID`);
  return parsed.data.toLowerCase();
}

function normalizePageSize(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new DomainError("VALIDATION_ERROR", "Page size must be a positive integer");
  return Math.min(value, maximum);
}

function invalidCursor(): DomainError {
  return new DomainError("VALIDATION_ERROR", "Page cursor is invalid or belongs to a different page. Start from the first page.");
}

function decodeCursor(token: string | null | undefined, maxLength: number): Record<string, unknown> | null {
  if (token == null) return null;
  if (typeof token !== "string" || token.length === 0 || token.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(token)) throw invalidCursor();
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== token) throw new Error("non-canonical base64url");
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid cursor object");
    return parsed as Record<string, unknown>;
  } catch {
    throw invalidCursor();
  }
}

function exactCursor(raw: Record<string, unknown>, projectId: string, kind: string, size: number, key: "k" | "s"): DecodedCursor {
  try {
    const cursor: DecodedCursor = {
      v: raw.v as 1,
      p: cursorUuid(raw.p),
      k: String(raw[key]),
      n: raw.n as number,
      b: raw.b as unknown[],
    };
    if (cursor.v !== 1 || cursor.p !== projectId || cursor.k !== kind || cursor.n !== size || !Array.isArray(cursor.b)) throw new Error("binding mismatch");
    const expectedKeys = key === "k" ? ["v", "p", "k", "n", "b"] : ["v", "p", "s", "n", "b"];
    if (Object.keys(raw).length !== expectedKeys.length || expectedKeys.some((name) => !Object.hasOwn(raw, name))) throw new Error("shape mismatch");
    if (JSON.stringify({ v: cursor.v, p: cursor.p, [key]: cursor.k, n: cursor.n, b: cursor.b }) !== JSON.stringify(raw)) throw new Error("non-canonical shape");
    return cursor;
  } catch {
    throw invalidCursor();
  }
}

function cursorUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value) || value !== value.toLowerCase()) throw new Error("invalid cursor UUID");
  return value;
}

function cursorBigint(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid cursor sequence");
  if (value.length > MAX_BIGINT.length || (value.length === MAX_BIGINT.length && value > MAX_BIGINT)) throw new Error("cursor sequence out of range");
  return value;
}

function encodeCursor(value: object, maxLength: number): string {
  const token = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (token.length > maxLength) throw new DomainError("DATABASE_CONSTRAINT", "Page cursor exceeds its size limit");
  return token;
}

function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

function assertPayload(value: unknown, maxBytes: number, name: string): void {
  if (jsonBytes(value) > maxBytes) throw new DomainError("DATABASE_CONSTRAINT", `${name} exceeds its serialized payload limit`);
}

function contextCursor(token: string | null | undefined, projectId: string, kind: ReviewReportContextKind, size: number): ContextBoundary | null {
  const raw = decodeCursor(token, CONTEXT_CURSOR_LIMIT);
  if (!raw) return null;
  const cursor = exactCursor(raw, projectId, kind, size, "k");
  try {
    if (kind === "questions" || kind === "screening-criteria" || kind === "full-text-criteria") {
      if (cursor.b.length !== 2 || !Number.isSafeInteger(cursor.b[0]) || Number(cursor.b[0]) < 0) throw new Error("invalid order boundary");
      return { sortOrder: Number(cursor.b[0]), id: cursorUuid(cursor.b[1]) };
    }
    if (kind === "sources") {
      if (cursor.b.length !== 2 || typeof cursor.b[0] !== "string" || cursor.b[0].length > 1200) throw new Error("invalid source boundary");
      return { sourceKey: cursor.b[0], id: cursorUuid(cursor.b[1]) };
    }
    if (cursor.b.length !== 1) throw new Error("invalid reason boundary");
    return { criterionId: cursorUuid(cursor.b[0]) };
  } catch {
    throw invalidCursor();
  }
}

function contextNextCursor(projectId: string, kind: ReviewReportContextKind, size: number, row: Row): string {
  let boundary: unknown[];
  if (kind === "questions" || kind === "screening-criteria" || kind === "full-text-criteria") boundary = [safeDatabaseInteger(row.cursor_sort_order, "Context sort order"), String(row.cursor_id)];
  else if (kind === "sources") boundary = [String(row.cursor_source_key), String(row.cursor_id)];
  else boundary = [String(row.criterion_id)];
  return encodeCursor({ v: 1, p: projectId, k: kind, n: size, b: boundary }, CONTEXT_CURSOR_LIMIT);
}

function reasonType(kind: ReviewReportContextKind): "title_abstract" | "full_text" {
  return kind === "exclusion-reasons" ? "title_abstract" : "full_text";
}

function contextScopeQuery(projectId: string): SQL {
  return sql`select id::text as id from projects where id = ${projectId}::uuid limit 1`;
}

function contextPageQuery(projectId: string, kind: ReviewReportContextKind, size: number, boundary: ContextBoundary | null): SQL {
  const limit = size + 1;
  if (kind === "questions") {
    const after = boundary && "sortOrder" in boundary
      ? sql`and (q.sort_order, q.id) > (${boundary.sortOrder}, ${boundary.id}::uuid)`
      : sql``;
    return sql`
      select q.id::text as id, left(q.identifier, 100) as identifier_preview,
        coalesce(char_length(q.identifier) > 100, false) as identifier_truncated,
        left(q.label, 600) as label_preview, coalesce(char_length(q.label) > 600, false) as label_truncated,
        q.sort_order as cursor_sort_order, q.id::text as cursor_id
      from research_questions q where q.project_id = ${projectId}::uuid and q.archived_at is null ${after}
      order by q.sort_order, q.id limit ${limit}
    `;
  }
  if (kind === "screening-criteria") {
    const after = boundary && "sortOrder" in boundary
      ? sql`and (c.sort_order, c.id) > (${boundary.sortOrder}, ${boundary.id}::uuid)`
      : sql``;
    return sql`
      select c.id::text as id, c.type::text as criterion_type,
        left(c.text, 600) as text_preview, coalesce(char_length(c.text) > 600, false) as text_truncated,
        c.sort_order as cursor_sort_order, c.id::text as cursor_id
      from screening_criteria c where c.project_id = ${projectId}::uuid and c.archived_at is null ${after}
      order by c.sort_order, c.id limit ${limit}
    `;
  }
  if (kind === "full-text-criteria") {
    const after = boundary && "sortOrder" in boundary
      ? sql`and (c.sort_order, c.id) > (${boundary.sortOrder}, ${boundary.id}::uuid)`
      : sql``;
    return sql`
      select c.id::text as id, left(c.text, 600) as text_preview,
        coalesce(char_length(c.text) > 600, false) as text_truncated,
        c.sort_order as cursor_sort_order, c.id::text as cursor_id
      from full_text_screening_criteria c where c.project_id = ${projectId}::uuid and c.archived_at is null ${after}
      order by c.sort_order, c.id limit ${limit}
    `;
  }
  if (kind === "sources") {
    const after = boundary && "sourceKey" in boundary
      ? sql`and (s.source_key, s.id) > (${boundary.sourceKey}, ${boundary.id}::uuid)`
      : sql``;
    return sql`
      select s.id::text as id,
        left(s.source_key, 100) as source_key_preview, coalesce(char_length(s.source_key) > 100, false) as source_key_truncated,
        left(s.display_name, 160) as display_name_preview, coalesce(char_length(s.display_name) > 160, false) as display_name_truncated,
        (s.archived_at is not null) as archived,
        s.source_key as cursor_source_key, s.id::text as cursor_id
      from search_sources s
      where s.project_id = ${projectId}::uuid
        and exists (select 1 from search_runs r where r.project_id = s.project_id and r.search_source_id = s.id)
        ${after}
      order by s.source_key, s.id limit ${limit}
    `;
  }
  return reasonAggregatePageQuery(projectId, kind, size, boundary && "criterionId" in boundary ? boundary.criterionId : null);
}

function titleAbstractReasonCtes(projectId: string): SQL {
  return sql`current_screening as materialized (
    select distinct on (project_id, paper_id) project_id, paper_id, decision, exclusion_criterion_id
    from screening_decisions where project_id = ${projectId}::uuid and stage = 'title_abstract'
    order by project_id, paper_id, sequence desc, id desc
  ), reason_aggregates as (
    select c.id as criterion_id, c.text, c.archived_at, count(*) as contribution_count
    from current_screening s
    join screening_criteria c on c.project_id = s.project_id and c.id = s.exclusion_criterion_id and c.type = 'exclusion'
    where s.decision = 'exclude' and s.exclusion_criterion_id is not null
    group by c.id, c.text, c.archived_at
  )`;
}

function fullTextReasonCtes(projectId: string): SQL {
  return sql`current_screening as materialized (
    select distinct on (project_id, paper_id) project_id, paper_id, decision
    from screening_decisions where project_id = ${projectId}::uuid and stage = 'title_abstract'
    order by project_id, paper_id, sequence desc, id desc
  ), current_full_text as materialized (
    select distinct on (project_id, paper_id) project_id, paper_id, decision, exclusion_criterion_id
    from full_text_screening_decisions where project_id = ${projectId}::uuid
    order by project_id, paper_id, sequence desc, id desc
  ), reason_aggregates as (
    select c.id as criterion_id, c.text, c.archived_at, count(*) as contribution_count
    from current_full_text f
    join current_screening s on s.project_id = f.project_id and s.paper_id = f.paper_id and s.decision = 'include'
    join full_text_screening_criteria c on c.project_id = f.project_id and c.id = f.exclusion_criterion_id
    where f.decision = 'exclude' and f.exclusion_criterion_id is not null
    group by c.id, c.text, c.archived_at
  )`;
}

function reasonAggregatePageQuery(projectId: string, kind: ReviewReportContextKind, size: number, criterionId: string | null): SQL {
  const cursorId = criterionId ? sql`${criterionId}::uuid` : sql`null::uuid`;
  const titleAbstract = reasonType(kind) === "title_abstract";
  const ctes = titleAbstract ? titleAbstractReasonCtes(projectId) : fullTextReasonCtes(projectId);
  const criterionTable = titleAbstract ? sql.raw("screening_criteria") : sql.raw("full_text_screening_criteria");
  return sql`
    with ${ctes}
    select criterion_id::text as criterion_id, left(text, 600) as text_preview,
      coalesce(char_length(text) > 600, false) as text_truncated,
      (archived_at is not null) as archived, contribution_count::text as contribution_count
    from reason_aggregates r
    where ${criterionId ? sql`(r.text, r.criterion_id) > ((select text from ${criterionTable} where project_id = ${projectId}::uuid and id = ${cursorId}), ${cursorId})` : sql`true`}
    order by text, criterion_id limit ${size + 1}
  `;
}

function rowsToReasonPage(projectId: string, kind: ReviewReportContextKind, size: number, rawRows: Row[]): ReviewReportReasonAggregatePage {
  const hasMore = rawRows.length > size;
  const visible = rawRows.slice(0, size);
  const scope = kind === "exclusion-reasons" ? "exclusionReason" as const : "fullTextExclusionReason" as const;
  const items = visible.map((row) => {
    const criterionId = String(row.criterion_id);
    return {
      criterionId,
      text: String(row.text_preview ?? ""),
      textTruncated: row.text_truncated === true || row.text_truncated === "t",
      archived: row.archived === true || row.archived === "t",
      count: safeDatabaseInteger(row.contribution_count, "Review report exclusion reason count"),
      contributor: scope === "exclusionReason" ? { scope, criterionId } : { scope, criterionId },
    };
  });
  const nextCursor = hasMore && visible.length > 0
    ? encodeCursor({ v: 1, p: projectId, k: kind, n: size, b: [visible[visible.length - 1].criterion_id] }, CONTEXT_CURSOR_LIMIT)
    : null;
  return { items, pageSize: size, hasMore, nextCursor };
}

function contextItems(kind: ReviewReportContextKind, rawRows: Row[]): ReviewReportContextPageItem[] {
  if (kind === "questions") return rawRows.map((row) => ({ kind: "question", id: String(row.id), identifier: String(row.identifier_preview ?? ""), identifierTruncated: row.identifier_truncated === true || row.identifier_truncated === "t", label: String(row.label_preview ?? ""), labelTruncated: row.label_truncated === true || row.label_truncated === "t" }));
  if (kind === "screening-criteria") return rawRows.map((row) => ({ kind: "screeningCriterion", id: String(row.id), criterionType: String(row.criterion_type) as "inclusion" | "exclusion", text: String(row.text_preview ?? ""), textTruncated: row.text_truncated === true || row.text_truncated === "t" }));
  if (kind === "full-text-criteria") return rawRows.map((row) => ({ kind: "fullTextCriterion", id: String(row.id), text: String(row.text_preview ?? ""), textTruncated: row.text_truncated === true || row.text_truncated === "t" }));
  if (kind === "sources") return rawRows.map((row) => ({ kind: "searchSource", id: String(row.id), sourceKey: String(row.source_key_preview ?? ""), sourceKeyTruncated: row.source_key_truncated === true || row.source_key_truncated === "t", displayName: String(row.display_name_preview ?? ""), displayNameTruncated: row.display_name_truncated === true || row.display_name_truncated === "t", archived: row.archived === true || row.archived === "t" }));
  const scope = kind === "exclusion-reasons" ? "exclusionReason" as const : "fullTextExclusionReason" as const;
  return rawRows.map((row) => {
    const criterionId = String(row.criterion_id);
    return {
      kind: scope,
      criterionId,
      text: String(row.text_preview ?? ""),
      textTruncated: row.text_truncated === true || row.text_truncated === "t",
      archived: row.archived === true || row.archived === "t",
      count: safeDatabaseInteger(row.contribution_count, "Review report exclusion reason count"),
      contributor: scope === "exclusionReason" ? { scope, criterionId } : { scope, criterionId },
    } as ReviewReportContextPageItem;
  });
}

function countValue(row: Row, key: string): number { return safeDatabaseInteger(row[key], `Review report ${key}`); }

function normalizeSelector(input: ReviewReportContributorSelector): ReviewReportContributorSelector {
  if (!input || typeof input !== "object") throw new DomainError("VALIDATION_ERROR", "Review report contributor selector is invalid");
  if (input.scope === "metric" && METRIC_KEYS.has(input.metric)) return { scope: "metric", metric: input.metric };
  if (input.scope === "source" && SOURCE_METRICS.has(input.metric)) return { scope: "source", sourceId: uuid(input.sourceId, "SearchSource identifier"), metric: input.metric };
  if (input.scope === "exclusionReason") return { scope: input.scope, criterionId: uuid(input.criterionId, "Screening criterion identifier") };
  if (input.scope === "fullTextExclusionReason") return { scope: input.scope, criterionId: uuid(input.criterionId, "Full-text criterion identifier") };
  if (input.scope === "overlap") return { scope: "overlap" };
  throw new DomainError("VALIDATION_ERROR", "Review report contributor selector is invalid");
}

function selectorBindingKey(selector: ReviewReportContributorSelector): string {
  if (selector.scope === "metric") return `metric:${selector.metric}`;
  if (selector.scope === "source") return `source:${selector.sourceId}:${selector.metric}`;
  if (selector.scope === "exclusionReason") return `exclusionReason:${selector.criterionId}`;
  if (selector.scope === "fullTextExclusionReason") return `fullTextExclusionReason:${selector.criterionId}`;
  return "overlap";
}

function contributorOrder(selector: ReviewReportContributorSelector): "run" | "pair" | "acquisition" | "id" | "unresolvedPair" {
  if (selector.scope === "metric") {
    if (selector.metric === "unresolvedDuplicatePairs") return "unresolvedPair";
    if (selector.metric === "distinctSearchRuns" || selector.metric === "reportedResultsTotal") return "run";
    if (selector.metric === "sameWorkDecisionPairs" || selector.metric === "differentWorkDecisionPairs") return "pair";
  }
  if (selector.scope === "source") {
    if (selector.metric === "runs" || selector.metric === "reportedResults") return "run";
    if (selector.metric === "acquisitionPapers") return "acquisition";
  }
  return "id";
}

function contributorCursor(token: string | null | undefined, projectId: string, selectorKey: string, size: number, selector: ReviewReportContributorSelector): ContributorBoundary | null {
  const raw = decodeCursor(token, CONTRIBUTOR_CURSOR_LIMIT);
  if (!raw) return null;
  const cursor = exactCursor(raw, projectId, selectorKey, size, "s");
  try {
    const order = contributorOrder(selector);
    if (order === "run") {
      if (cursor.b.length !== 2) throw new Error("invalid run boundary");
      const sequence = cursorBigint(cursor.b[0]);
      return { sequence, id: cursorUuid(cursor.b[1]) };
    }
    if (order === "unresolvedPair") {
      if (cursor.b.length !== 3 || (cursor.b[0] !== 0 && cursor.b[0] !== 1)) throw new Error("invalid candidate pair boundary");
      const leftId = cursorUuid(cursor.b[1]);
      const rightId = cursorUuid(cursor.b[2]);
      if (leftId >= rightId) throw new Error("non-canonical candidate pair");
      return { rank: cursor.b[0], leftId, rightId };
    }
    if (order === "pair") {
      if (cursor.b.length !== 2) throw new Error("invalid adjudication boundary");
      return { leftId: cursorUuid(cursor.b[0]), rightId: cursorUuid(cursor.b[1]) };
    }
    if (order === "acquisition") {
      if (cursor.b.length !== 2) throw new Error("invalid acquisition Paper boundary");
      return { firstRecordId: cursorUuid(cursor.b[0]), paperId: cursorUuid(cursor.b[1]) };
    }
    if (cursor.b.length !== 1) throw new Error("invalid identity boundary");
    return { id: cursorUuid(cursor.b[0]) };
  } catch {
    throw invalidCursor();
  }
}

function makeContributorNextCursor(projectId: string, selectorKey: string, size: number, selector: ReviewReportContributorSelector, row: Row): string {
  const order = contributorOrder(selector);
  let boundary: unknown[];
  if (order === "run") boundary = [String(row.page_key_a), String(row.page_key_b)];
  else if (order === "unresolvedPair") boundary = [safeDatabaseInteger(row.page_key_a, "Candidate strength rank"), String(row.page_key_b), String(row.page_key_c)];
  else if (order === "pair") boundary = [String(row.page_key_a), String(row.page_key_b)];
  else if (order === "acquisition") boundary = [String(row.page_key_a), String(row.page_key_b)];
  else boundary = [String(row.page_key_a)];
  return encodeCursor({ v: 1, p: projectId, s: selectorKey, n: size, b: boundary }, CONTRIBUTOR_CURSOR_LIMIT);
}

function sourceMetricRows(projectId: string, selector: Extract<ReviewReportContributorSelector, { scope: "source" }>): SQL {
  const sourceId = selector.sourceId;
  if (selector.metric === "runs" || selector.metric === "reportedResults") return sql`
    select r.id, r.sequence, r.source_display_name_snapshot, r.reported_result_count, r.search_source_id
    from search_runs r where r.project_id = ${projectId}::uuid and r.search_source_id = ${sourceId}::uuid
  `;
  if (selector.metric === "retrievedRecords") return sql`
    select r.id, r.title, r.search_run_id, r.search_source_id
    from retrieved_records r where r.project_id = ${projectId}::uuid and r.search_source_id = ${sourceId}::uuid
  `;
  if (selector.metric === "resolvedRecords") return sql`
    with latest_matches as materialized (
      select distinct on (project_id, retrieved_record_id) project_id, retrieved_record_id, paper_id, action
      from retrieved_record_matches where project_id = ${projectId}::uuid
      order by project_id, retrieved_record_id, sequence desc, id desc
    )
    select r.id, r.title, r.search_run_id, r.search_source_id
    from retrieved_records r
    join latest_matches m on m.project_id = r.project_id and m.retrieved_record_id = r.id and m.action = 'linked'
    where r.project_id = ${projectId}::uuid and r.search_source_id = ${sourceId}::uuid
  `;
  return sql`
    with latest_matches as materialized (
      select distinct on (project_id, retrieved_record_id) project_id, retrieved_record_id, paper_id, action
      from retrieved_record_matches where project_id = ${projectId}::uuid
      order by project_id, retrieved_record_id, sequence desc, id desc
    )
    select distinct on (m.paper_id) m.paper_id as id, r.title, r.id as first_record_id
    from retrieved_records r
    join latest_matches m on m.project_id = r.project_id and m.retrieved_record_id = r.id and m.action = 'linked'
    where r.project_id = ${projectId}::uuid and r.search_source_id = ${sourceId}::uuid
    order by m.paper_id, r.id
  `;
}

function titleAbstractReasonRows(projectId: string, criterionId: string): SQL {
  return sql`
    with current_screening as materialized (
      select distinct on (project_id, paper_id) project_id, paper_id, id, decision, exclusion_criterion_id
      from screening_decisions where project_id = ${projectId}::uuid and stage = 'title_abstract'
      order by project_id, paper_id, sequence desc, id desc
    )
    select p.id, p.title, s.id as decision_id, s.decision
    from papers p
    join current_screening s on s.project_id = p.project_id and s.paper_id = p.id
    join screening_criteria c on c.project_id = p.project_id and c.id = s.exclusion_criterion_id and c.type = 'exclusion'
    where p.project_id = ${projectId}::uuid and s.decision = 'exclude' and s.exclusion_criterion_id = ${criterionId}::uuid
  `;
}

function fullTextReasonRows(projectId: string, criterionId: string): SQL {
  return sql`
    with current_screening as materialized (
      select distinct on (project_id, paper_id) project_id, paper_id, decision
      from screening_decisions where project_id = ${projectId}::uuid and stage = 'title_abstract'
      order by project_id, paper_id, sequence desc, id desc
    ), current_full_text as materialized (
      select distinct on (project_id, paper_id) project_id, paper_id, id, decision, exclusion_criterion_id
      from full_text_screening_decisions where project_id = ${projectId}::uuid
      order by project_id, paper_id, sequence desc, id desc
    )
    select p.id, p.title, f.id as decision_id, f.decision
    from papers p
    join current_screening s on s.project_id = p.project_id and s.paper_id = p.id and s.decision = 'include'
    join current_full_text f on f.project_id = p.project_id and f.paper_id = p.id
    join full_text_screening_criteria c on c.project_id = p.project_id and c.id = f.exclusion_criterion_id
    where p.project_id = ${projectId}::uuid and f.decision = 'exclude' and f.exclusion_criterion_id = ${criterionId}::uuid
  `;
}

function overlapRows(projectId: string): SQL {
  return sql`
    with latest_matches as materialized (
      select distinct on (project_id, retrieved_record_id) project_id, retrieved_record_id, paper_id, action
      from retrieved_record_matches where project_id = ${projectId}::uuid
      order by project_id, retrieved_record_id, sequence desc, id desc
    )
    select p.id, p.title
    from papers p
    join (
      select m.paper_id, count(distinct r.search_source_id) as source_count
      from latest_matches m
      join retrieved_records r on r.project_id = m.project_id and r.id = m.retrieved_record_id
      where m.action = 'linked'
      group by m.paper_id having count(distinct r.search_source_id) > 1
    ) represented on represented.paper_id = p.id
    where p.project_id = ${projectId}::uuid
  `;
}

function contributorRelation(projectId: string, selector: ReviewReportContributorSelector, reporting: ReviewReportingRepository): SQL {
  if (selector.scope === "metric") return reporting.metricContributorRows(projectId, selector.metric);
  if (selector.scope === "source") return sourceMetricRows(projectId, selector);
  if (selector.scope === "exclusionReason") return titleAbstractReasonRows(projectId, selector.criterionId);
  if (selector.scope === "fullTextExclusionReason") return fullTextReasonRows(projectId, selector.criterionId);
  return overlapRows(projectId);
}

function contributorScopeExpression(projectId: string, selector: ReviewReportContributorSelector): SQL {
  if (selector.scope === "source") return sql`exists (
    select 1 from search_sources s where s.project_id = ${projectId}::uuid and s.id = ${selector.sourceId}::uuid
      and exists (select 1 from search_runs r where r.project_id = s.project_id and r.search_source_id = s.id)
  )`;
  if (selector.scope === "exclusionReason") return sql`exists (
    select 1 from screening_criteria c where c.project_id = ${projectId}::uuid and c.id = ${selector.criterionId}::uuid and c.type = 'exclusion'
  )`;
  if (selector.scope === "fullTextExclusionReason") return sql`exists (
    select 1 from full_text_screening_criteria c where c.project_id = ${projectId}::uuid and c.id = ${selector.criterionId}::uuid
  )`;
  return sql`exists (select 1 from projects p where p.id = ${projectId}::uuid)`;
}

function contributionExpression(relation: SQL, selector: ReviewReportContributorSelector): SQL {
  if (selector.scope === "metric" && selector.metric === "reportedResultsTotal") return sql`(select coalesce(sum(r.reported_result_count::numeric), 0)::text from (${relation}) r)`;
  if (selector.scope === "metric" && selector.metric === "duplicateRecordsCollapsed") return sql`(select coalesce(sum(r.record_count::numeric - 1), 0)::text from (${relation}) r)`;
  if (selector.scope === "source" && selector.metric === "reportedResults") return sql`(select coalesce(sum(r.reported_result_count::numeric), 0)::text from (${relation}) r)`;
  return sql`(select count(*)::text from (${relation}) r)`;
}

function contributorScopeTotalQuery(projectId: string, selector: ReviewReportContributorSelector, reporting: ReviewReportingRepository): SQL {
  if (selector.scope === "metric" && selector.metric === "unresolvedDuplicatePairs") return sql`
    select exists (select 1 from projects p where p.id = ${projectId}::uuid) as scope_valid,
      (with ${unresolvedDuplicatePairCtes(projectId)} select count(*)::text from unresolved_candidate_pairs) as contribution_total
  `;
  const relation = contributorRelation(projectId, selector, reporting);
  return sql`
    select ${contributorScopeExpression(projectId, selector)} as scope_valid,
      ${contributionExpression(relation, selector)} as contribution_total
  `;
}

type PageDescriptor = {
  kind: BoundedReviewReportContributor["kind"];
  identity: SQL;
  label: SQL;
  contribution: SQL;
  sourceId?: SQL;
  searchRunId?: SQL;
  paperId?: SQL;
  decision?: SQL;
  leftRecordId?: SQL;
  rightRecordId?: SQL;
  recordCount?: SQL;
};

function boundedText(expression: SQL, maximum: number): SQL {
  return sql`left(coalesce(${expression}, ''), ${maximum})`;
}

function descriptor(selector: ReviewReportContributorSelector): PageDescriptor {
  if (selector.scope === "source") {
    if (selector.metric === "runs" || selector.metric === "reportedResults") {
      const label = sql`concat(r.source_display_name_snapshot, ' · Run ', r.sequence::text)`;
      return { kind: "searchRun", identity: sql`r.id::text`, label, contribution: selector.metric === "runs" ? sql`1::numeric` : sql`coalesce(r.reported_result_count, 0)::numeric`, sourceId: sql`r.search_source_id::text` };
    }
    if (selector.metric === "acquisitionPapers") return { kind: "paper", identity: sql`r.id::text`, label: sql`r.title`, contribution: sql`1::numeric`, paperId: sql`r.id::text` };
    return { kind: "retrievedRecord", identity: sql`r.id::text`, label: sql`r.title`, contribution: sql`1::numeric`, sourceId: sql`r.search_source_id::text`, searchRunId: sql`r.search_run_id::text` };
  }
  if (selector.scope === "exclusionReason") return { kind: "screeningDecision", identity: sql`r.decision_id::text`, label: sql`r.title`, contribution: sql`1::numeric`, paperId: sql`r.id::text`, decision: sql`r.decision::text` };
  if (selector.scope === "fullTextExclusionReason") return { kind: "fullTextScreeningDecision", identity: sql`r.decision_id::text`, label: sql`r.title`, contribution: sql`1::numeric`, paperId: sql`r.id::text`, decision: sql`r.decision::text` };
  if (selector.scope === "overlap") return { kind: "paper", identity: sql`r.id::text`, label: sql`r.title`, contribution: sql`1::numeric`, paperId: sql`r.id::text` };

  const metric = selector.metric;
  if (metric === "distinctSearchRuns" || metric === "reportedResultsTotal") {
    const label = sql`concat(r.source_display_name_snapshot, ' · Run ', r.sequence::text)`;
    return { kind: "searchRun", identity: sql`r.id::text`, label, contribution: metric === "distinctSearchRuns" ? sql`1::numeric` : sql`coalesce(r.reported_result_count, 0)::numeric`, sourceId: sql`r.search_source_id::text` };
  }
  if (metric === "distinctSources") return { kind: "searchSource", identity: sql`r.id::text`, label: sql`r.display_name`, contribution: sql`1::numeric` };
  if (["retrievedRecords", "currentlyResolvedRecords", "unresolvedRecords"].includes(metric)) return { kind: "retrievedRecord", identity: sql`r.id::text`, label: sql`r.title`, contribution: sql`1::numeric`, sourceId: sql`r.search_source_id::text`, searchRunId: sql`r.search_run_id::text` };
  if (metric === "sameWorkDecisionPairs" || metric === "differentWorkDecisionPairs") {
    return { kind: "deduplicationPair", identity: sql`concat(r.left_retrieved_record_id::text, ':', r.right_retrieved_record_id::text)`, label: sql`concat(r.left_retrieved_record_id::text, ' ↔ ', r.right_retrieved_record_id::text)`, contribution: sql`1::numeric`, leftRecordId: sql`r.left_retrieved_record_id::text`, rightRecordId: sql`r.right_retrieved_record_id::text` };
  }
  if (["included", "excluded", "maybe"].includes(metric)) return { kind: "screeningDecision", identity: sql`r.decision_id::text`, label: sql`r.title`, contribution: sql`1::numeric`, paperId: sql`r.id::text`, decision: sql`r.decision::text` };
  const isFullTextDecision = ["fullTextEligible", "fullTextAwaiting", "fullTextAssessed", "fullTextIncluded", "fullTextExcluded", "fullTextMaybe", "fullTextConflicts", "fullTextRetrieved", "fullTextUnavailable"].includes(metric);
  if (isFullTextDecision) {
    const blankLegacyIdentity = metric === "fullTextEligible" || metric === "fullTextRetrieved" || metric === "fullTextUnavailable";
    const identity = blankLegacyIdentity ? sql`''::text` : metric === "fullTextAwaiting" ? sql`coalesce(r.decision_id::text, '')` : sql`r.decision_id::text`;
    const decision = blankLegacyIdentity ? sql`''::text` : metric === "fullTextAwaiting" ? sql`coalesce(r.decision::text, '')` : sql`r.decision::text`;
    return { kind: "fullTextScreeningDecision", identity, label: sql`r.title`, contribution: sql`1::numeric`, paperId: sql`r.id::text`, decision };
  }
  const isCollapsed = metric === "duplicateRecordsCollapsed";
  return {
    kind: "paper",
    identity: sql`r.id::text`,
    label: metric === "unresolvedDuplicatePairs" ? sql`''::text` : sql`r.title`,
    contribution: isCollapsed ? sql`(r.record_count::numeric - 1)` : sql`1::numeric`,
    paperId: sql`r.id::text`,
    recordCount: isCollapsed ? sql`r.record_count::text` : undefined,
  };
}

function pageKeyExpressions(selector: ReviewReportContributorSelector): { order: "run" | "pair" | "acquisition" | "id"; a: SQL; b?: SQL; c?: SQL } {
  const order = contributorOrder(selector);
  if (order === "run") return { order, a: sql`r.sequence::text`, b: sql`r.id::text` };
  if (order === "pair") return { order, a: sql`r.left_retrieved_record_id::text`, b: sql`r.right_retrieved_record_id::text` };
  if (order === "acquisition") return { order, a: sql`r.first_record_id::text`, b: sql`r.id::text` };
  return { order: "id", a: sql`r.id::text` };
}

function contributorAfterPredicate(selector: ReviewReportContributorSelector, boundary: ContributorBoundary | null): SQL {
  if (!boundary) return sql``;
  const order = contributorOrder(selector);
  if (order === "run" && "sequence" in boundary) return sql`where (r.sequence, r.id) > (${boundary.sequence}::bigint, ${boundary.id}::uuid)`;
  if (order === "pair" && "leftId" in boundary) return sql`where (r.left_retrieved_record_id, r.right_retrieved_record_id) > (${boundary.leftId}::uuid, ${boundary.rightId}::uuid)`;
  if (order === "acquisition" && "firstRecordId" in boundary) return sql`where (r.first_record_id, r.id) > (${boundary.firstRecordId}::uuid, ${boundary.paperId}::uuid)`;
  if (order === "id" && "id" in boundary) return sql`where r.id > ${boundary.id}::uuid`;
  return sql``;
}

function normalContributorPageQuery(projectId: string, selector: ReviewReportContributorSelector, size: number, boundary: ContributorBoundary | null, reporting: ReviewReportingRepository): SQL {
  const relation = contributorRelation(projectId, selector, reporting);
  const info = descriptor(selector);
  const keys = pageKeyExpressions(selector);
  const after = contributorAfterPredicate(selector, boundary);
  const label = boundedText(info.label, 600);
  const labelLength = sql`char_length(coalesce(${info.label}, '')) > 600`;
  const source = info.sourceId ?? sql`null::text`;
  const runId = info.searchRunId ?? sql`null::text`;
  const paperId = info.paperId ?? sql`null::text`;
  const decision = info.decision ?? sql`null::text`;
  const leftId = info.leftRecordId ?? sql`null::text`;
  const rightId = info.rightRecordId ?? sql`null::text`;
  const recordCount = info.recordCount ?? sql`null::text`;
  // This value comes only from descriptor()'s closed internal kind mapping.
  // Keep it as a SQL literal: quoting a bound placeholder would make Postgres
  // see the text "$1" rather than a parameter with a known type.
  const kind = sql.raw(`'${info.kind}'::text`);
  const orderBy = keys.order === "run" ? sql`r.sequence, r.id` : keys.order === "pair" ? sql`r.left_retrieved_record_id, r.right_retrieved_record_id` : keys.order === "acquisition" ? sql`r.first_record_id, r.id` : sql`r.id`;
  return sql`
    select ${kind} as kind, ${info.identity} as identity_id, ${label} as label_preview,
      ${labelLength} as label_truncated, (${info.contribution})::text as contribution_exact,
      ${source} as source_id, ${runId} as search_run_id, ${paperId} as paper_id, ${decision} as decision_value,
      ${leftId} as left_record_id, ${rightId} as right_record_id, ${recordCount} as record_count,
      ${keys.a} as page_key_a, ${keys.b ?? sql`null::text`} as page_key_b
    from (${relation}) r ${after}
    order by ${orderBy} limit ${size + 1}
  `;
}

function unresolvedPairPageQuery(projectId: string, size: number, boundary: ContributorBoundary | null): SQL {
  const pairBoundary = boundary && "rank" in boundary
    ? { strengthRank: boundary.rank, leftId: boundary.leftId, rightId: boundary.rightId }
    : null;
  const after = boundary && "rank" in boundary ? sql`where (p.strength_rank, p.left_record_id, p.right_record_id) > (${boundary.rank}, ${boundary.leftId}::uuid, ${boundary.rightId}::uuid)` : sql``;
  return sql`
    with ${unresolvedDuplicatePairProbeCtes(projectId, size + 1, pairBoundary)}
    select 'deduplicationPair'::text as kind,
      concat(p.left_record_id::text, ':', p.right_record_id::text) as identity_id,
      concat(
        case when char_length(a.title) > 230 then left(a.title, 229) || '…' else a.title end,
        ' ↔ ',
        case when char_length(b.title) > 230 then left(b.title, 229) || '…' else b.title end
      ) as label_preview,
      (char_length(a.title) > 230 or char_length(b.title) > 230) as label_truncated,
      '1'::text as contribution_exact, p.left_record_id::text as left_record_id,
      p.right_record_id::text as right_record_id, p.strength_rank::text as strength_rank,
      p.strength_rank as page_key_a, p.left_record_id::text as page_key_b, p.right_record_id::text as page_key_c
    from ordered_probe p
    join retrieved_records a on a.project_id = ${projectId}::uuid and a.id = p.left_record_id
    join retrieved_records b on b.project_id = ${projectId}::uuid and b.id = p.right_record_id
    ${after}
    order by p.strength_rank, p.left_record_id, p.right_record_id limit ${size + 1}
  `;
}

function contributorPageQuery(projectId: string, selector: ReviewReportContributorSelector, size: number, boundary: ContributorBoundary | null, reporting: ReviewReportingRepository): SQL {
  if (selector.scope === "metric" && selector.metric === "unresolvedDuplicatePairs") return unresolvedPairPageQuery(projectId, size, boundary);
  return normalContributorPageQuery(projectId, selector, size, boundary, reporting);
}

function mapBoundedContributor(selector: ReviewReportContributorSelector, row: Row): BoundedReviewReportContributor {
  const common = {
    id: String(row.identity_id ?? ""),
    label: String(row.label_preview ?? ""),
    labelTruncated: row.label_truncated === true || row.label_truncated === "t",
    contribution: safeDatabaseInteger(row.contribution_exact, "Review report contributor contribution"),
  };
  const kind = String(row.kind);
  if (kind === "searchRun") return { kind, ...common, sourceId: String(row.source_id ?? "") };
  if (kind === "retrievedRecord") return { kind, ...common, searchRunId: String(row.search_run_id ?? ""), sourceId: String(row.source_id ?? "") };
  if (kind === "searchSource") return { kind, ...common };
  if (kind === "deduplicationPair") return { kind, ...common, leftRecordId: String(row.left_record_id), rightRecordId: String(row.right_record_id), ...(row.strength_rank == null ? {} : { strength: String(row.strength_rank) === "0" ? "strong" as const : "possible" as const }) };
  if (kind === "screeningDecision") return { kind, ...common, paperId: String(row.paper_id), decision: String(row.decision_value ?? "") };
  if (kind === "fullTextScreeningDecision") return { kind, ...common, paperId: String(row.paper_id), decision: String(row.decision_value ?? "") };
  return { kind: "paper", ...common, ...(row.paper_id == null ? {} : { paperId: String(row.paper_id) }), ...(row.record_count == null ? {} : { recordCount: safeDatabaseInteger(row.record_count, "Collapsed record count") }) };
}

export function createBoundedReviewReportingServices(db: Database) {
  const reporting = new ReviewReportingRepository(db);
  const deduplication = new DeduplicationDecisionRepository(db);

  async function getInteractiveReviewReportSummary(projectIdInput: string): Promise<InteractiveReviewReportSummary> {
    const projectId = uuid(projectIdInput, "Project identifier");
    return db.transaction(async (tx) => {
      const contextRows = rows(await tx.execute(sql`
        with latest_matches as materialized (
          select distinct on (project_id, retrieved_record_id) project_id, retrieved_record_id, paper_id, action
          from retrieved_record_matches where project_id = ${projectId}::uuid
          order by project_id, retrieved_record_id, sequence desc, id desc
        ), paper_sources as (
          select lm.paper_id, count(distinct rr.search_source_id) as source_count
          from latest_matches lm
          join retrieved_records rr on rr.project_id = lm.project_id and rr.id = lm.retrieved_record_id
          where lm.action = 'linked' group by lm.paper_id
        )
        select p.id::text as project_id, p.title,
          (select count(*)::text from research_questions q where q.project_id = p.id and q.archived_at is null) as active_questions,
          (select count(*)::text from screening_criteria c where c.project_id = p.id and c.archived_at is null) as active_screening_criteria,
          (select count(*)::text from full_text_screening_criteria c where c.project_id = p.id and c.archived_at is null) as active_full_text_criteria,
          (select count(distinct r.search_source_id)::text from search_runs r where r.project_id = p.id) as represented_sources,
          (select count(*)::text from paper_sources where source_count > 1) as overlapping_papers
        from projects p where p.id = ${projectId}::uuid limit 1
      `));
      const context = contextRows[0];
      if (!context) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
      const metricsRow = await deduplication.flowSummary(projectId, tx);
      const metrics = mapReviewFlowSummaryRow(metricsRow);
      const titleReasonRows = rows(await tx.execute(reasonAggregatePageQuery(projectId, "exclusion-reasons", CONTEXT_PAGE_SIZE, null)));
      const fullTextReasonRows = rows(await tx.execute(reasonAggregatePageQuery(projectId, "full-text-exclusion-reasons", CONTEXT_PAGE_SIZE, null)));
      const titleReasons = rowsToReasonPage(projectId, "exclusion-reasons", CONTEXT_PAGE_SIZE, titleReasonRows);
      const fullTextReasons = rowsToReasonPage(projectId, "full-text-exclusion-reasons", CONTEXT_PAGE_SIZE, fullTextReasonRows);
      const summary = buildInteractiveReviewReportSummary({
        summary: metrics,
        project: { id: String(context.project_id), title: String(context.title ?? "") },
        overlappingPaperCount: countValue(context, "overlapping_papers"),
        contextCounts: {
          activeResearchQuestions: countValue(context, "active_questions"),
          activeScreeningCriteria: countValue(context, "active_screening_criteria"),
          activeFullTextCriteria: countValue(context, "active_full_text_criteria"),
          representedSearchSources: countValue(context, "represented_sources"),
        },
        exclusionReasons: titleReasons,
        fullTextExclusionReasons: fullTextReasons,
      });
      assertPayload(summary, SUMMARY_PAYLOAD_LIMIT, "Review report summary");
      return summary;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function listReviewReportContextPage(projectIdInput: string, kind: ReviewReportContextKind, options: { pageSize?: number; cursor?: string | null } = {}): Promise<ReviewReportContextPage> {
    const projectId = uuid(projectIdInput, "Project identifier");
    if (!["questions", "screening-criteria", "full-text-criteria", "sources", "exclusion-reasons", "full-text-exclusion-reasons"].includes(kind)) throw new DomainError("VALIDATION_ERROR", "Review report context page kind is invalid");
    const size = normalizePageSize(options.pageSize, CONTEXT_PAGE_SIZE, CONTEXT_PAGE_MAX);
    const boundary = contextCursor(options.cursor, projectId, kind, size);
    return db.transaction(async (tx) => {
      const scope = rows(await tx.execute(contextScopeQuery(projectId)))[0];
      if (!scope) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
      const pageRows = rows(await tx.execute(contextPageQuery(projectId, kind, size, boundary)));
      const hasMore = pageRows.length > size;
      const visible = pageRows.slice(0, size);
      const items = contextItems(kind, visible);
      let nextCursor: string | null = null;
      if (hasMore && visible.length > 0) {
        if (REASON_KINDS.has(kind)) {
          nextCursor = encodeCursor({ v: 1, p: projectId, k: kind, n: size, b: [visible[visible.length - 1].criterion_id] }, CONTEXT_CURSOR_LIMIT);
        } else {
          nextCursor = contextNextCursor(projectId, kind, size, visible[visible.length - 1]);
        }
      }
      const page = { kind, items, pageSize: size, hasMore, nextCursor } satisfies ReviewReportContextPage;
      assertPayload(page, CONTEXT_PAYLOAD_LIMIT, "Review report context page");
      return page;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async function listReviewReportContributorPage(projectIdInput: string, selectorInput: ReviewReportContributorSelector, options: { pageSize?: number; cursor?: string | null } = {}): Promise<ReviewReportContributorPage> {
    const projectId = uuid(projectIdInput, "Project identifier");
    const selector = normalizeSelector(selectorInput);
    const size = normalizePageSize(options.pageSize, CONTRIBUTOR_PAGE_SIZE, CONTRIBUTOR_PAGE_MAX);
    const selectorKey = selectorBindingKey(selector);
    const boundary = contributorCursor(options.cursor, projectId, selectorKey, size, selector);
    return db.transaction(async (tx) => {
      const scopeTotalRows = rows(await tx.execute(contributorScopeTotalQuery(projectId, selector, reporting)));
      const scopeTotal = scopeTotalRows[0];
      if (!scopeTotal || !(scopeTotal.scope_valid === true || scopeTotal.scope_valid === "t")) {
        throw new DomainError(selector.scope === "metric" || selector.scope === "overlap" ? "PROJECT_NOT_FOUND" : "NOT_FOUND", "Review report contributor scope was not found");
      }
      const contributionTotal = safeDatabaseInteger(scopeTotal.contribution_total, "Review report contribution total");
      const pageRows = rows(await tx.execute(contributorPageQuery(projectId, selector, size, boundary, reporting)));
      const hasMore = pageRows.length > size;
      const visibleRows = pageRows.slice(0, size);
      const items = visibleRows.map((row) => mapBoundedContributor(selector, row));
      const last = hasMore ? visibleRows[visibleRows.length - 1] : null;
      const nextCursor = last ? makeContributorNextCursor(projectId, selectorKey, size, selector, last) : null;
      const page = { contributionTotal, items, pageSize: size, hasMore, nextCursor } satisfies ReviewReportContributorPage;
      assertPayload(page, CONTRIBUTOR_PAYLOAD_LIMIT, "Review report contributor page");
      return page;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  return { getInteractiveReviewReportSummary, listReviewReportContextPage, listReviewReportContributorPage };
}
