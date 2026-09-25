import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { paperReviewFactsCtes, paperReviewStatusFromFacts } from "@/application/paper-review-read-model";
import type { PaperReviewStatus } from "@/domain/types";
import type { papers } from "@/db/schema";

export const FULL_TEXT_QUEUE_DEFAULT_PAGE_SIZE = 50;
export const FULL_TEXT_QUEUE_MAX_PAGE_SIZE = 100;

export const fullTextRetrievalQueueStates = [
  "all",
  "not_sought",
  "pending",
  "unavailable",
  "retrieved",
  "conflict",
] as const;

export const fullTextScreeningQueueStates = [
  "all",
  "ready",
  "awaiting",
  "included",
  "excluded",
  "maybe",
  "legacy",
  "conflict",
] as const;

export type FullTextRetrievalQueueState = typeof fullTextRetrievalQueueStates[number];
export type FullTextScreeningQueueState = typeof fullTextScreeningQueueStates[number];
type Paper = typeof papers.$inferSelect;

export type FullTextQueuePage<TState extends string> = {
  items: Array<{ paper: Paper; reviewStatus: PaperReviewStatus }>;
  state: TState;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  from: number;
  to: number;
  counts: Record<TState, number>;
};

export type FullTextQueuePageOptions = {
  state?: string;
  page?: string | number;
  pageSize?: number;
};

type QueueFactsRow = Record<string, unknown> & {
  title_abstract_decision: unknown;
  full_text_decision: unknown;
  full_text_retrieval_state: unknown;
  has_retrieval_history: unknown;
  ever_retrieved: unknown;
  has_analytical_history: unknown;
};

type QueueCountRow = Record<string, unknown>;

function retrievalConflictPredicate() {
  return sql`f.has_retrieval_history and f.title_abstract_decision is distinct from 'include'`;
}

function retrievalPredicate(state: FullTextRetrievalQueueState) {
  switch (state) {
    case "all":
      return sql`(f.title_abstract_decision='include' or ${retrievalConflictPredicate()})`;
    case "conflict":
      return retrievalConflictPredicate();
    case "not_sought":
      return sql`f.title_abstract_decision='include' and f.full_text_retrieval_state='not_sought'`;
    case "pending":
    case "unavailable":
    case "retrieved":
      return sql`f.title_abstract_decision='include' and f.full_text_retrieval_state=${state}`;
  }
}

function fullTextCrossStageConflictPredicate() {
  return sql`f.full_text_decision is not null and f.title_abstract_decision is distinct from 'include'`;
}

function fullTextRetrievalConflictPredicate() {
  return sql`f.has_retrieval_history and f.title_abstract_decision is distinct from 'include'`;
}

function fullTextQueuePredicate() {
  return sql`(
    f.title_abstract_decision='include'
    or ${fullTextCrossStageConflictPredicate()}
    or ${fullTextRetrievalConflictPredicate()}
  )`;
}

function fullTextPredicate(state: FullTextScreeningQueueState) {
  switch (state) {
    case "all":
      return fullTextQueuePredicate();
    case "ready":
      return sql`f.title_abstract_decision='include' and f.full_text_retrieval_state='retrieved' and f.full_text_decision is null`;
    case "awaiting":
      return sql`f.title_abstract_decision='include' and f.full_text_decision is null`;
    case "included":
      return sql`f.title_abstract_decision='include' and f.full_text_decision='include'`;
    case "excluded":
      return sql`f.title_abstract_decision='include' and f.full_text_decision='exclude'`;
    case "maybe":
      return sql`f.title_abstract_decision='include' and f.full_text_decision='maybe'`;
    case "legacy":
      return sql`${fullTextQueuePredicate()} and f.full_text_decision is not null and not f.has_retrieval_history`;
    case "conflict":
      return sql`(${fullTextCrossStageConflictPredicate()} or ${fullTextRetrievalConflictPredicate()})`;
  }
}

function countQuery(projectId: string, totalPredicate: ReturnType<typeof sql>, predicates: Array<[string, ReturnType<typeof sql>]>) {
  return sql`${paperReviewFactsCtes(projectId)}
    select
      count(*) filter (where ${totalPredicate}) as total_count,
      ${sql.join(predicates.map(([name, predicate]) => sql`count(*) filter (where ${predicate}) as ${sql.raw(`"${name}"`)}`), sql`,\n      `)}
    from review_facts f`;
}

function pageQuery(projectId: string, predicate: ReturnType<typeof sql>, pageSize: number, offset: number) {
  return sql`${paperReviewFactsCtes(projectId)}
    select p.*, f.title_abstract_decision, f.full_text_decision,
      f.current_retrieval_outcome, f.full_text_retrieval_state, f.has_retrieval_history,
      f.ever_retrieved, f.has_analytical_history
    from review_facts f
    join papers p on p.project_id=f.project_id and p.id=f.paper_id
    where ${predicate}
    order by f.created_at desc, f.paper_id desc
    limit ${pageSize} offset ${offset}`;
}

function stateOrAll<TState extends string>(value: string | undefined, states: readonly TState[]): TState {
  return states.includes(value as TState) ? value as TState : states[0];
}

function requestedPage(value: string | number | undefined): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function requestedPageSize(value: number | undefined): number {
  if (value === undefined) return FULL_TEXT_QUEUE_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) return FULL_TEXT_QUEUE_DEFAULT_PAGE_SIZE;
  return Math.min(value, FULL_TEXT_QUEUE_MAX_PAGE_SIZE);
}

function countValue(row: QueueCountRow, key: string): number {
  const value = Number(row[key] ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function paperFromRow(row: Record<string, unknown>): Paper {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    authors: Array.isArray(row.authors) ? row.authors as string[] : [],
    publicationYear: row.publication_year == null ? null : Number(row.publication_year),
    venue: row.venue == null ? null : String(row.venue),
    doi: row.doi == null ? null : String(row.doi),
    abstract: row.abstract == null ? null : String(row.abstract),
    bibliographicNote: row.bibliographic_note == null ? null : String(row.bibliographic_note),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}

function pagination<TState extends string>(state: TState, pageRequest: number, pageSize: number, totalCount: number) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const page = totalPages === 0 ? 1 : Math.min(pageRequest, totalPages);
  return {
    state,
    page,
    pageSize,
    totalCount,
    totalPages,
    from: totalCount === 0 ? 0 : (page - 1) * pageSize + 1,
    to: totalCount === 0 ? 0 : Math.min(page * pageSize, totalCount),
  };
}

function rows<T>(value: unknown): T[] {
  return value as T[];
}

export function createFullTextQueueReadServices(db: Database) {
  async function listPage<TState extends FullTextRetrievalQueueState | FullTextScreeningQueueState>(args: {
    projectId: string;
    state: TState;
    pageRequest: number;
    pageSize: number;
    predicates: Array<[string, ReturnType<typeof sql>]>
    totalPredicate: ReturnType<typeof sql>;
    pagePredicate: ReturnType<typeof sql>;
  }): Promise<FullTextQueuePage<TState>> {
    return db.transaction(async (tx) => {
      const countRows = rows<QueueCountRow>(await tx.execute(countQuery(args.projectId, args.totalPredicate, args.predicates)));
      const countRow = countRows[0] ?? {};
      const counts = Object.fromEntries(args.predicates.map(([key]) => [key, countValue(countRow, key)])) as Record<TState, number>;
      const page = pagination(args.state, args.pageRequest, args.pageSize, countValue(countRow, "total_count"));
      const selectedRows = rows<QueueFactsRow>(await tx.execute(pageQuery(args.projectId, args.pagePredicate, page.pageSize, (page.page - 1) * page.pageSize)));
      return {
        ...page,
        counts,
        items: selectedRows.map((row) => ({ paper: paperFromRow(row), reviewStatus: paperReviewStatusFromFacts(row) })),
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  return {
    async listFullTextRetrievalQueuePage(projectId: string, options: FullTextQueuePageOptions = {}) {
      const state = stateOrAll(options.state, fullTextRetrievalQueueStates);
      const pageRequest = options.state !== undefined && state !== options.state ? 1 : requestedPage(options.page);
      const pageSize = requestedPageSize(options.pageSize);
      const predicates: Array<[FullTextRetrievalQueueState, ReturnType<typeof sql>]> = fullTextRetrievalQueueStates.map((key) => [key, retrievalPredicate(key)]);
      return listPage({
        projectId,
        state,
        pageRequest,
        pageSize,
        predicates,
        totalPredicate: retrievalPredicate(state),
        pagePredicate: retrievalPredicate(state),
      });
    },

    async listFullTextScreeningQueuePage(projectId: string, options: FullTextQueuePageOptions = {}) {
      const state = stateOrAll(options.state, fullTextScreeningQueueStates);
      const pageRequest = options.state !== undefined && state !== options.state ? 1 : requestedPage(options.page);
      const pageSize = requestedPageSize(options.pageSize);
      const predicates: Array<[FullTextScreeningQueueState, ReturnType<typeof sql>]> = fullTextScreeningQueueStates.map((key) => [key, fullTextPredicate(key)]);
      return listPage({
        projectId,
        state,
        pageRequest,
        pageSize,
        predicates,
        totalPredicate: fullTextPredicate(state),
        pagePredicate: fullTextPredicate(state),
      });
    },
  };
}

export type FullTextQueueReadServices = ReturnType<typeof createFullTextQueueReadServices>;
