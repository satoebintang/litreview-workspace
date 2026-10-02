import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { ensureId } from "@/application/review-services/shared";
import { mapScreeningPaperNavigation, screeningNavigationQuery } from "./screening-navigation-query";

export const SCREENING_QUEUE_DEFAULT_PAGE_SIZE = 50;
export const SCREENING_QUEUE_MAX_PAGE_SIZE = 100;

export const screeningQueueStates = ["all", "unscreened", "included", "excluded", "maybe"] as const;

export type ScreeningState = Exclude<typeof screeningQueueStates[number], "all">;
export type ScreeningQueueState = typeof screeningQueueStates[number];

export type ScreeningQueueRow = {
  id: string;
  title: string;
  authors: string[];
  publicationYear: number | null;
  screeningState: ScreeningState;
};

export type ScreeningQueuePage = {
  items: ScreeningQueueRow[];
  state: ScreeningQueueState;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  from: number;
  to: number;
  hasPrevious: boolean;
  hasNext: boolean;
  counts: {
    all: number;
    unscreened: number;
    included: number;
    excluded: number;
    maybe: number;
  };
  startPaperId: string | null;
};

export type ScreeningPaperNavigation = {
  paperId: string;
  position: number;
  totalCount: number;
  previousPaperId: string | null;
  nextPaperId: string | null;
};

export type ScreeningQueuePageOptions = {
  state?: string;
  page?: string | number;
  pageSize?: number;
};

type Row = Record<string, unknown>;
type ScreeningQueueCounts = ScreeningQueuePage["counts"];

function rows(value: unknown): Row[] {
  return value as Row[];
}

function requestedPage(value: string | number | undefined): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function requestedPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return SCREENING_QUEUE_DEFAULT_PAGE_SIZE;
  return Math.min(value, SCREENING_QUEUE_MAX_PAGE_SIZE);
}

function countValue(value: unknown): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new DomainError("DATABASE_CONSTRAINT", "Screening queue count is invalid");
  }
  return count;
}

function queueState(value: string | undefined): ScreeningQueueState {
  return screeningQueueStates.includes(value as ScreeningQueueState) ? value as ScreeningQueueState : "all";
}

function screeningState(value: unknown): ScreeningState {
  return value === "included" || value === "excluded" || value === "maybe" ? value : "unscreened";
}

function queueItem(row: Row): ScreeningQueueRow {
  return {
    id: String(row.id),
    title: String(row.title),
    authors: Array.isArray(row.authors) ? row.authors.map(String) : [],
    publicationYear: row.publication_year == null ? null : Number(row.publication_year),
    screeningState: screeningState(row.screening_state),
  };
}

function screeningPaperFacts(projectId: string) {
  return sql`with paper_facts as (
    select
      paper.id,
      paper.project_id,
      paper.title,
      paper.authors,
      paper.publication_year,
      paper.created_at,
      case latest.decision
        when 'include' then 'included'
        when 'exclude' then 'excluded'
        when 'maybe' then 'maybe'
        else 'unscreened'
      end as screening_state
    from papers paper
    left join lateral (
      select decision.decision
      from screening_decisions decision
      where decision.project_id=paper.project_id
        and decision.paper_id=paper.id
        and decision.stage='title_abstract'
      order by decision.sequence desc, decision.id desc
      limit 1
    ) latest on true
    where paper.project_id=${projectId}
  )`;
}

function queueCountsQuery(projectId: string, state: ScreeningQueueState) {
  const selectedPredicate = state === "all" ? sql`true` : sql`facts.screening_state=${state}`;
  return sql`${screeningPaperFacts(projectId)}
    select
      project.id as project_id,
      count(facts.id) as all_count,
      count(facts.id) filter (where facts.screening_state='unscreened') as unscreened_count,
      count(facts.id) filter (where facts.screening_state='included') as included_count,
      count(facts.id) filter (where facts.screening_state='excluded') as excluded_count,
      count(facts.id) filter (where facts.screening_state='maybe') as maybe_count,
      count(facts.id) filter (where ${selectedPredicate}) as total_count,
      coalesce(
        (select candidate.id from paper_facts candidate
          where candidate.screening_state='unscreened'
          order by candidate.created_at asc, candidate.id asc
          limit 1),
        (select candidate.id from paper_facts candidate
          order by candidate.created_at asc, candidate.id asc
          limit 1)
      ) as start_paper_id
    from projects project
    left join paper_facts facts on facts.project_id=project.id
    where project.id=${projectId}
    group by project.id`;
}

function queuePageQuery(projectId: string, state: ScreeningQueueState, pageSize: number, offset: number) {
  const selectedPredicate = state === "all" ? sql`true` : sql`facts.screening_state=${state}`;
  return sql`${screeningPaperFacts(projectId)}
    select facts.id, facts.title, facts.authors, facts.publication_year, facts.screening_state
    from paper_facts facts
    where ${selectedPredicate}
    order by facts.created_at asc, facts.id asc
    limit ${pageSize} offset ${offset}`;
}

function queueCounts(row: Row): ScreeningQueueCounts {
  return {
    all: countValue(row.all_count),
    unscreened: countValue(row.unscreened_count),
    included: countValue(row.included_count),
    excluded: countValue(row.excluded_count),
    maybe: countValue(row.maybe_count),
  };
}

export function createScreeningReadServices(db: Database) {
  return {
    async getScreeningQueuePage(projectId: string, options: ScreeningQueuePageOptions = {}): Promise<ScreeningQueuePage> {
      ensureId(projectId);
      const state = queueState(options.state);
      const pageRequest = options.state !== undefined && state !== options.state ? 1 : requestedPage(options.page);
      const pageSize = requestedPageSize(options.pageSize);

      return db.transaction(async (tx) => {
        const countRow = rows(await tx.execute(queueCountsQuery(projectId, state)))[0];
        if (!countRow?.project_id) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");

        const counts = queueCounts(countRow);
        const totalCount = countValue(countRow.total_count);
        const totalPages = Math.ceil(totalCount / pageSize);
        const page = totalPages === 0 ? 1 : Math.min(pageRequest, totalPages);
        const offset = (page - 1) * pageSize;
        const selectedRows = rows(await tx.execute(queuePageQuery(projectId, state, pageSize, offset)));

        return {
          items: selectedRows.map(queueItem),
          state,
          page,
          pageSize,
          totalCount,
          totalPages,
          from: totalCount === 0 ? 0 : offset + 1,
          to: totalCount === 0 ? 0 : Math.min(offset + pageSize, totalCount),
          hasPrevious: page > 1,
          hasNext: page < totalPages,
          counts,
          startPaperId: countRow.start_paper_id == null ? null : String(countRow.start_paper_id),
        };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async getScreeningPaperNavigation(projectId: string, paperId: string): Promise<ScreeningPaperNavigation | null> {
      ensureId(projectId);
      ensureId(paperId);

      const navigationRow = rows(await db.execute(screeningNavigationQuery(projectId, paperId)))[0];
      return mapScreeningPaperNavigation(navigationRow);
    },
  };
}

export type ScreeningReadServices = ReturnType<typeof createScreeningReadServices>;
