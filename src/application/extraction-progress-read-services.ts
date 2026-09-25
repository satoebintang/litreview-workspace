import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import type { papers } from "@/db/schema";
import { DomainError } from "@/domain/errors";
import type { PaperReviewStatus } from "@/domain/types";
import { ensureId } from "@/application/review-services/shared";
import { paperReviewFactsCtes, paperReviewStatusFromFacts } from "@/application/paper-review-read-model";

export const EXTRACTION_PROGRESS_DEFAULT_PAGE_SIZE = 50;
export const EXTRACTION_PROGRESS_MAX_PAGE_SIZE = 100;

type Paper = typeof papers.$inferSelect;
type ProgressStatus = "not_configured" | "complete" | "partial" | "not_started";

export type ExtractionProgressPageOptions = {
  page?: string | number;
  pageSize?: number;
};

export type ExtractionProgressItem = {
  paper: Paper;
  completedRequired: number;
  requiredCount: number;
  status: ProgressStatus;
  percentage: number | null;
  reviewStatus: PaperReviewStatus;
  writeEligible: boolean;
};

export type ExtractionProgressPage = {
  items: ExtractionProgressItem[];
  counts: {
    includedPaperCount: number;
    historicalPaperCount: number;
    requiredFieldCount: number;
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

type CountRow = Record<string, unknown> & {
  project_exists: unknown;
  included_count: unknown;
  historical_count: unknown;
  required_field_count: unknown;
};

type ProgressRow = Record<string, unknown> & {
  title_abstract_decision: unknown;
  full_text_decision: unknown;
  full_text_retrieval_state: unknown;
  has_retrieval_history: unknown;
  ever_retrieved: unknown;
  has_analytical_history: unknown;
  completed_required: unknown;
  has_started: unknown;
};

function rows<T>(value: unknown): T[] {
  return value as T[];
}

function countValue(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function requestedPage(value: string | number | undefined): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function requestedPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return EXTRACTION_PROGRESS_DEFAULT_PAGE_SIZE;
  return Math.min(value, EXTRACTION_PROGRESS_MAX_PAGE_SIZE);
}

function pagination(pageRequest: number, pageSize: number, totalCount: number) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const page = totalPages === 0 ? 1 : Math.min(pageRequest, totalPages);
  return {
    page,
    pageSize,
    totalCount,
    totalPages,
    from: totalCount === 0 ? 0 : (page - 1) * pageSize + 1,
    to: totalCount === 0 ? 0 : Math.min(page * pageSize, totalCount),
  };
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

function countsQuery(projectId: string) {
  return sql`${paperReviewFactsCtes(projectId)}, field_counts as (
      select count(*) filter (where required)::int as required_field_count
      from extraction_fields
      where project_id=${projectId}::uuid and archived_at is null
    ), member_counts as (
      select
        count(*) filter (where f.title_abstract_decision='include' and f.full_text_decision='include')::int as included_count,
        count(*) filter (where f.full_text_decision is null and f.has_analytical_history)::int as historical_count
      from review_facts f
    )
    select exists(select 1 from projects where id=${projectId}::uuid) as project_exists,
      mc.included_count, mc.historical_count, fc.required_field_count
    from member_counts mc cross join field_counts fc`;
}

function pageQuery(projectId: string, pageSize: number, offset: number) {
  return sql`${paperReviewFactsCtes(projectId)}, page_rows as (
      select p.*,
        f.title_abstract_decision, f.full_text_decision,
        f.full_text_retrieval_state, f.has_retrieval_history,
        f.ever_retrieved, f.has_analytical_history
      from review_facts f
      join papers p on p.project_id=f.project_id and p.id=f.paper_id
      where (f.title_abstract_decision='include' and f.full_text_decision='include')
        or (f.full_text_decision is null and f.has_analytical_history)
      order by f.created_at desc, f.paper_id desc
      limit ${pageSize} offset ${offset}
    ), active_fields as (
      select id, required
      from extraction_fields
      where project_id=${projectId}::uuid and archived_at is null
    ), current_revisions as (
      select distinct on (r.paper_id, r.field_id)
        r.paper_id, r.field_id, r.value_state
      from page_rows p
      join extraction_values v on v.project_id=p.project_id and v.paper_id=p.id
      join extraction_value_revisions r on r.project_id=v.project_id and r.paper_id=v.paper_id
        and r.extraction_value_id=v.id and r.finalized_at is not null
      join active_fields af on af.id=r.field_id
      order by r.paper_id, r.field_id, r.sequence desc, r.id desc
    ), progress_by_paper as (
      select cr.paper_id,
        count(*) filter (where af.required and cr.value_state in ('present', 'not_reported', 'not_applicable'))::int as completed_required,
        bool_or(cr.value_state <> 'cleared') as has_started
      from current_revisions cr
      join active_fields af on af.id=cr.field_id
      group by cr.paper_id
    )
    select p.*,
      p.title_abstract_decision, p.full_text_decision,
      p.full_text_retrieval_state, p.has_retrieval_history,
      p.ever_retrieved, p.has_analytical_history,
      coalesce(progress.completed_required, 0)::int as completed_required,
      coalesce(progress.has_started, false) as has_started
    from page_rows p
    left join progress_by_paper progress on progress.paper_id=p.id
    order by p.created_at desc, p.id desc`;
}

export function createExtractionProgressReadServices(db: Database) {
  return {
    async getExtractionProgressPage(projectId: string, options: ExtractionProgressPageOptions = {}): Promise<ExtractionProgressPage> {
      ensureId(projectId);
      const pageRequest = requestedPage(options.page);
      const pageSize = requestedPageSize(options.pageSize);

      return db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '15000ms'`);
        const countRow = rows<CountRow>(await tx.execute(countsQuery(projectId)))[0];
        if (!countRow || !Boolean(countRow.project_exists)) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");

        const includedPaperCount = countValue(countRow.included_count);
        const historicalPaperCount = countValue(countRow.historical_count);
        const requiredFieldCount = countValue(countRow.required_field_count);
        const totalCount = includedPaperCount + historicalPaperCount;
        const page = pagination(pageRequest, pageSize, totalCount);
        const selectedRows = rows<ProgressRow>(await tx.execute(pageQuery(projectId, page.pageSize, (page.page - 1) * page.pageSize)));
        const items = selectedRows.map((row) => {
          const completedRequired = countValue(row.completed_required);
          const started = Boolean(row.has_started);
          const status: ProgressStatus = requiredFieldCount === 0
            ? "not_configured"
            : completedRequired === requiredFieldCount ? "complete" : started ? "partial" : "not_started";
          const reviewStatus = paperReviewStatusFromFacts(row);
          return {
            paper: paperFromRow(row),
            completedRequired,
            requiredCount: requiredFieldCount,
            status,
            percentage: requiredFieldCount ? Math.round((completedRequired / requiredFieldCount) * 100) : null,
            reviewStatus,
            writeEligible: reviewStatus.finalEligibility === "included",
          };
        });

        return {
          items,
          counts: { includedPaperCount, historicalPaperCount, requiredFieldCount },
          pagination: page,
        };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}

export type ExtractionProgressReadServices = ReturnType<typeof createExtractionProgressReadServices>;
