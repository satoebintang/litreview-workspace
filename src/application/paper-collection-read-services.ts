import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { ensureId } from "@/application/review-services/shared";

export const PAPER_COLLECTION_DEFAULT_PAGE_SIZE = 50;
export const PAPER_COLLECTION_MAX_PAGE_SIZE = 100;

export type PaperCollectionScreeningState = "unscreened" | "included" | "excluded" | "maybe";

export type PaperCollectionRow = {
  id: string;
  projectId: string;
  title: string;
  authors: string[];
  publicationYear: number | null;
  venue: string | null;
  doi: string | null;
  createdAt: Date;
  updatedAt: Date;
  screeningState: PaperCollectionScreeningState;
};

export type PaperCollectionPageOptions = {
  page?: string | number;
  pageSize?: number;
};

export type PaperCollectionPage = {
  items: PaperCollectionRow[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  from: number;
  to: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

type Row = Record<string, unknown>;

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
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return PAPER_COLLECTION_DEFAULT_PAGE_SIZE;
  return Math.min(value, PAPER_COLLECTION_MAX_PAGE_SIZE);
}

function countValue(value: unknown): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new DomainError("DATABASE_CONSTRAINT", "Paper collection count is invalid");
  }
  return count;
}

function pageBounds(pageRequest: number, pageSize: number, totalCount: number) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const page = totalPages === 0 ? 1 : Math.min(pageRequest, totalPages);
  return {
    page,
    pageSize,
    totalCount,
    totalPages,
    from: totalCount === 0 ? 0 : (page - 1) * pageSize + 1,
    to: totalCount === 0 ? 0 : Math.min(page * pageSize, totalCount),
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function paperCollectionRow(row: Row): PaperCollectionRow {
  const state = String(row.screening_state);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    authors: Array.isArray(row.authors) ? row.authors.map(String) : [],
    publicationYear: row.publication_year == null ? null : Number(row.publication_year),
    venue: row.venue == null ? null : String(row.venue),
    doi: row.doi == null ? null : String(row.doi),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
    screeningState: state === "included" || state === "excluded" || state === "maybe" ? state : "unscreened",
  };
}

function projectPaperCountQuery(projectId: string) {
  return sql`select project.id as project_id, count(paper.id) as total_count
    from projects project
    left join papers paper on paper.project_id=project.id
    where project.id=${projectId}
    group by project.id`;
}

function paperCollectionPageQuery(projectId: string, pageSize: number, offset: number) {
  return sql`with selected_papers as (
      select paper.id, paper.project_id, paper.title, paper.authors, paper.publication_year,
        paper.venue, paper.doi, paper.created_at, paper.updated_at
      from papers paper
      where paper.project_id=${projectId}
      order by paper.created_at desc, paper.id desc
      limit ${pageSize} offset ${offset}
    )
    select paper.id, paper.project_id, paper.title, paper.authors, paper.publication_year,
      paper.venue, paper.doi, paper.created_at, paper.updated_at,
      case latest.decision
        when 'include' then 'included'
        when 'exclude' then 'excluded'
        when 'maybe' then 'maybe'
        else 'unscreened'
      end as screening_state
    from selected_papers paper
    left join lateral (
      select decision.decision
      from screening_decisions decision
      where decision.project_id=paper.project_id
        and decision.paper_id=paper.id
        and decision.stage='title_abstract'
      order by decision.sequence desc, decision.id desc
      limit 1
    ) latest on true
    order by paper.created_at desc, paper.id desc`;
}

export function createPaperCollectionReadServices(db: Database) {
  return {
    async getPaperCollectionPage(projectId: string, input: PaperCollectionPageOptions = {}): Promise<PaperCollectionPage | null> {
      ensureId(projectId);
      const pageRequest = requestedPage(input.page);
      const pageSize = requestedPageSize(input.pageSize);

      return db.transaction(async (tx) => {
        const countRow = rows(await tx.execute(projectPaperCountQuery(projectId)))[0];
        if (!countRow?.project_id) return null;

        const totalCount = countValue(countRow.total_count);
        const page = pageBounds(pageRequest, pageSize, totalCount);
        const selectedRows = rows(await tx.execute(paperCollectionPageQuery(
          projectId,
          page.pageSize,
          (page.page - 1) * page.pageSize,
        )));

        return { ...page, items: selectedRows.map(paperCollectionRow) };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}
