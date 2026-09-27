import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";

export const PAPER_OPTIONS_DEFAULT_PAGE_SIZE = 20;
export const PAPER_OPTIONS_MAX_PAGE_SIZE = 50;
export const PAPER_SEARCH_MAX_CODE_POINTS = 200;

export type PaperOption = {
  id: string;
  title: string;
  authors: string[];
  publicationYear: number | null;
  doi: string | null;
};

export type SearchPaperOptionsInput = {
  projectId: string;
  query?: string;
  page?: number;
  pageSize?: number;
  excludePaperId?: string;
};

export type PaperOptionPage = {
  items: PaperOption[];
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

function ensureUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function normalizeSearch(input: SearchPaperOptionsInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DomainError("VALIDATION_ERROR", "Paper search input is invalid");
  }
  const projectId = ensureUuid(input.projectId, "Project");
  if (input.query !== undefined && typeof input.query !== "string") {
    throw new DomainError("VALIDATION_ERROR", "Paper search query must be text");
  }
  const query = (input.query ?? "").trim();
  if (Array.from(query).length > PAPER_SEARCH_MAX_CODE_POINTS) {
    throw new DomainError("VALIDATION_ERROR", `Paper search query cannot exceed ${PAPER_SEARCH_MAX_CODE_POINTS} Unicode code points`);
  }
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1) throw new DomainError("VALIDATION_ERROR", "Paper search page must be a positive integer");
  const requestedPageSize = input.pageSize ?? PAPER_OPTIONS_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1) {
    throw new DomainError("VALIDATION_ERROR", "Paper search page size must be a positive integer");
  }
  const excludePaperId = input.excludePaperId === undefined
    ? null
    : ensureUuid(input.excludePaperId, "Excluded Paper");
  return {
    projectId,
    query,
    page,
    pageSize: Math.min(requestedPageSize, PAPER_OPTIONS_MAX_PAGE_SIZE),
    excludePaperId,
  };
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

function countValue(value: unknown) {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new DomainError("DATABASE_CONSTRAINT", "Paper option count is invalid");
  return count;
}

function paperOption(row: Row): PaperOption {
  return {
    id: String(row.id),
    title: String(row.title),
    authors: Array.isArray(row.authors) ? row.authors as string[] : [],
    publicationYear: row.publication_year == null ? null : Number(row.publication_year),
    doi: row.doi == null ? null : String(row.doi),
  };
}

function paperSearchPredicate(projectId: string, query: string, excludePaperId: string | null) {
  const conditions = [sql`paper.project_id=${projectId}`];
  if (query !== "") conditions.push(sql`strpos(lower(paper.title), lower(${query})) > 0`);
  if (excludePaperId) conditions.push(sql`paper.id <> ${excludePaperId}::uuid`);
  return sql.join(conditions, sql` and `);
}

export function createPaperSelectionReadServices(db: Database) {
  return {
    async searchPaperOptions(input: SearchPaperOptionsInput): Promise<PaperOptionPage> {
      const values = normalizeSearch(input);
      return db.transaction(async (tx) => {
        const countRows = rows(await tx.execute(sql`
          select project.id as project_id, count(paper.id)::bigint as total_count
          from projects project
          left join papers paper on paper.project_id=project.id
            and (${values.query === ""} or strpos(lower(paper.title), lower(${values.query})) > 0)
            and (${values.excludePaperId === null} or paper.id <> ${values.excludePaperId}::uuid)
          where project.id=${values.projectId}
          group by project.id
        `));
        const countRow = countRows[0];
        if (!countRow?.project_id) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        const totalCount = countValue(countRow.total_count);
        const bounds = pageBounds(values.page, values.pageSize, totalCount);
        const optionRows = rows(await tx.execute(sql`
          select paper.id, paper.title, paper.authors, paper.publication_year, paper.doi
          from papers paper
          where ${paperSearchPredicate(values.projectId, values.query, values.excludePaperId)}
          order by paper.created_at desc, paper.id desc
          limit ${bounds.pageSize} offset ${(bounds.page - 1) * bounds.pageSize}
        `));
        return { ...bounds, items: optionRows.map(paperOption) };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async getPaperOption(projectId: string, paperId: string): Promise<PaperOption | null> {
      const project = ensureUuid(projectId, "Project");
      const paper = ensureUuid(paperId, "Paper");
      const optionRows = rows(await db.execute(sql`
        select paper.id, paper.title, paper.authors, paper.publication_year, paper.doi
        from papers paper
        where paper.project_id=${project} and paper.id=${paper}
        limit 1
      `));
      return optionRows[0] ? paperOption(optionRows[0]) : null;
    },

    async getPaperOptionsByIds(projectId: string, paperIds: readonly string[]) {
      const project = ensureUuid(projectId, "Project");
      if (!Array.isArray(paperIds)) throw new DomainError("VALIDATION_ERROR", "Paper IDs must be an array");
      const requestedIds = paperIds.map((paperId) => ensureUuid(paperId, "Paper"));
      if (requestedIds.length === 0) return [];
      const optionRows = rows(await db.execute(sql`
        with requested_papers as (
          select value::uuid as paper_id, ordinal
          from jsonb_array_elements_text(${JSON.stringify(requestedIds)}::jsonb)
            with ordinality as requested(value, ordinal)
        ), first_requested as (
          select distinct on (paper_id) paper_id, ordinal
          from requested_papers
          order by paper_id, ordinal
        )
        select requested.paper_id as requested_paper_id,
          paper.id, paper.title, paper.authors, paper.publication_year, paper.doi
        from first_requested requested
        left join papers paper on paper.project_id=${project} and paper.id=requested.paper_id
        order by requested.ordinal
      `));
      return optionRows.map((row) => ({
        paperId: String(row.requested_paper_id),
        option: row.id == null ? null : paperOption(row),
      }));
    },
  };
}

export type PaperSelectionReadServices = ReturnType<typeof createPaperSelectionReadServices>;
