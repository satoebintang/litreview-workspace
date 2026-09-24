import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { ensureId } from "./review-services/shared";

export type ClaimSupportSearchKind = "evidence" | "extractionRevision" | "synthesisRevision";

export type SearchClaimSupportOptionsInput = {
  projectId: string;
  kind: ClaimSupportSearchKind;
  query?: string;
  page?: number;
  pageSize?: number;
};

export type ClaimSupportSearchPage<TItem> = {
  items: TItem[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

export type ResolveEligibleClaimSupportIdsInput = {
  projectId: string;
  evidenceIds?: string[];
  extractionRevisionIds?: string[];
  synthesisRevisionIds?: string[];
};

export type EligibleClaimSupportIds = {
  evidence: string[];
  extractionRevision: string[];
  synthesisRevision: string[];
};

type SearchRow = Record<string, unknown>;

function normalizeSearchInput(input: SearchClaimSupportOptionsInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DomainError("VALIDATION_ERROR", "Claim support search input is invalid");
  }
  const projectId = ensureId(input.projectId);
  if (input.kind !== "evidence" && input.kind !== "extractionRevision" && input.kind !== "synthesisRevision") {
    throw new DomainError("VALIDATION_ERROR", "Claim support kind is invalid");
  }

  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1) throw new DomainError("VALIDATION_ERROR", "Page must be a positive integer");

  const requestedPageSize = input.pageSize ?? 20;
  if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1) {
    throw new DomainError("VALIDATION_ERROR", "Page size must be a positive integer");
  }
  const pageSize = Math.min(requestedPageSize, 50);
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw new DomainError("VALIDATION_ERROR", "Page is outside the supported range");

  if (input.query !== undefined && typeof input.query !== "string") {
    throw new DomainError("VALIDATION_ERROR", "Search query must be text");
  }
  const trimmedQuery = typeof input.query === "string" ? input.query.trim() : "";
  const query = trimmedQuery ? [...trimmedQuery.slice(0, 400)].slice(0, 200).join("") || null : null;
  return { projectId, kind: input.kind, query, page, pageSize };
}

function normalizeSupportIds(ids: string[] | undefined): string[] {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new DomainError("VALIDATION_ERROR", "Support identifiers must be UUIDs");
  }
  return [...new Set(ids.map((id) => ensureId(id)))];
}

function includesQuery(query: string | null, columns: SQL[]): SQL {
  if (!query) return sql`true`;
  return sql`(${sql.join(columns.map((column) => sql`strpos(lower(coalesce(${column}, '')), lower(${query})) > 0`), sql` or `)})`;
}

function evidenceEligible(projectId: string, query: string | null): SQL {
  return sql`with eligible as (
    select e.id, e.project_id, e.paper_id, e.source_text, e.page_number, e.created_at,
      p.title as paper_title,
      coalesce(review.decision, 'unreviewed') as review_state
    from evidence e
    join papers p on p.project_id=e.project_id and p.id=e.paper_id
    left join lateral (
      select d.decision
      from evidence_review_decisions d
      where d.project_id=e.project_id and d.evidence_id=e.id
      order by d.sequence desc
      limit 1
    ) review on true
    where e.project_id=${projectId}
      and coalesce(review.decision, 'unreviewed') <> 'rejected'
      and ${includesQuery(query, [sql`p.title`, sql`e.source_text`])}
  )`;
}

function extractionEligible(projectId: string, query: string | null): SQL {
  return sql`with eligible as (
    select r.id, r.project_id, r.paper_id, r.field_id, r.sequence, r.field_type,
      r.value_state, r.text_value, r.number_value, r.boolean_value, r.option_id,
      r.researcher_note, r.created_at, p.title as paper_title,
      f.name as field_name, o.label as option_label,
      not exists (
        select 1 from extraction_value_revisions newer
        where newer.project_id=r.project_id and newer.extraction_value_id=r.extraction_value_id
          and newer.finalized_at is not null and newer.sequence > r.sequence
      ) as is_current_extraction_revision,
      coalesce(title_abstract.decision, 'unscreened') as screening_state
    from extraction_value_revisions r
    join papers p on p.project_id=r.project_id and p.id=r.paper_id
    join extraction_fields f on f.project_id=r.project_id and f.id=r.field_id
    left join extraction_options o on o.project_id=r.project_id and o.field_id=r.field_id and o.id=r.option_id
    left join lateral (
      select d.decision
      from screening_decisions d
      where d.project_id=r.project_id and d.paper_id=r.paper_id and d.stage='title_abstract'
      order by d.sequence desc
      limit 1
    ) title_abstract on true
    left join lateral (
      select d.decision
      from full_text_screening_decisions d
      where d.project_id=r.project_id and d.paper_id=r.paper_id
      order by d.sequence desc
      limit 1
    ) full_text on true
    where r.project_id=${projectId}
      and r.finalized_at is not null
      and r.value_state <> 'cleared'
      and title_abstract.decision='include'
      and full_text.decision='include'
      and ${includesQuery(query, [sql`p.title`, sql`f.name`, sql`r.text_value`])}
  )`;
}

function synthesisEligible(projectId: string, query: string | null): SQL {
  return sql`with eligible as (
    select r.id, r.project_id, r.synthesis_statement_id, r.sequence, r.state,
      r.title, r.statement_text, r.researcher_note, r.created_at,
      current_revision.id as current_revision_id
    from synthesis_revisions r
    join synthesis_statements s on s.project_id=r.project_id and s.id=r.synthesis_statement_id
    join lateral (
      select latest.id, latest.state
      from synthesis_revisions latest
      where latest.project_id=r.project_id
        and latest.synthesis_statement_id=r.synthesis_statement_id
        and latest.finalized_at is not null
      order by latest.sequence desc
      limit 1
    ) current_revision on true
    where r.project_id=${projectId}
      and r.finalized_at is not null
      and r.state='active'
      and current_revision.state='active'
      and ${includesQuery(query, [sql`r.title`, sql`r.statement_text`])}
  )`;
}

function toEvidenceOption(row: SearchRow) {
  const reviewState = String(row.review_state) as "unreviewed" | "needs_review" | "accepted";
  return {
    id: String(row.id),
    paperId: String(row.paper_id),
    sourceText: String(row.source_text).slice(0, 500),
    pageNumber: Number(row.page_number),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    reviewState,
    curationWarning: reviewState === "unreviewed" ? "never_reviewed" : reviewState === "needs_review" ? "needs_review" : null,
    paper: { id: String(row.paper_id), title: String(row.paper_title) },
  };
}

function toExtractionOption(row: SearchRow) {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    fieldType: String(row.field_type),
    valueState: String(row.value_state),
    textValue: row.text_value == null ? null : String(row.text_value).slice(0, 500),
    numberValue: row.number_value == null ? null : String(row.number_value),
    booleanValue: row.boolean_value == null ? null : Boolean(row.boolean_value),
    optionId: row.option_id == null ? null : String(row.option_id),
    optionLabel: row.option_label == null ? null : String(row.option_label),
    researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
    isCurrentExtractionRevision: Boolean(row.is_current_extraction_revision),
    paperScreeningState: String(row.screening_state) === "include" ? "included" : "unscreened",
    evidenceCount: Number(row.evidence_count),
    paper: { id: String(row.paper_id), title: String(row.paper_title) },
    field: { id: String(row.field_id), name: String(row.field_name) },
  };
}

function toSynthesisOption(row: SearchRow) {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    state: String(row.state) as "active",
    title: row.title == null ? null : String(row.title),
    statementText: row.statement_text == null ? null : String(row.statement_text).slice(0, 1000),
    researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
    isCurrentSynthesisRevision: String(row.current_revision_id) === String(row.id),
    observationCount: Number(row.observation_count),
    evidencePathCount: Number(row.evidence_path_count),
  };
}

export function createClaimSupportReadServices(db: Database) {
  return {
    async searchClaimSupportOptions(input: SearchClaimSupportOptionsInput): Promise<ClaimSupportSearchPage<unknown>> {
      const values = normalizeSearchInput(input);
      return db.transaction(async (tx) => {
        let countRows: SearchRow[];
        let pageRows: SearchRow[];

        if (values.kind === "evidence") {
          const eligible = evidenceEligible(values.projectId, values.query);
          countRows = await tx.execute(sql`
            ${eligible}
            select exists(select 1 from projects where id=${values.projectId}) as project_exists,
              count(*)::bigint as total_count
            from eligible
          `) as unknown as SearchRow[];
          const count = countRows[0];
          if (!count || !count.project_exists) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
          const totalCount = Number(count.total_count);
          const totalPages = Math.ceil(totalCount / values.pageSize);
          const page = Math.min(values.page, Math.max(totalPages, 1));
          const offset = (page - 1) * values.pageSize;
          pageRows = await tx.execute(sql`
            ${eligible}
            select id, paper_id, paper_title, left(source_text, 500) as source_text, page_number, created_at, review_state
            from eligible
            order by created_at desc, id desc
            limit ${values.pageSize} offset ${offset}
          `) as unknown as SearchRow[];
          return {
            items: pageRows.map(toEvidenceOption), page, pageSize: values.pageSize, totalCount,
            totalPages, hasPrevious: page > 1, hasNext: page < totalPages,
          };
        }

        if (values.kind === "extractionRevision") {
          const eligible = extractionEligible(values.projectId, values.query);
          countRows = await tx.execute(sql`
            ${eligible}
            select exists(select 1 from projects where id=${values.projectId}) as project_exists,
              count(*)::bigint as total_count
            from eligible
          `) as unknown as SearchRow[];
          const count = countRows[0];
          if (!count || !count.project_exists) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
          const totalCount = Number(count.total_count);
          const totalPages = Math.ceil(totalCount / values.pageSize);
          const page = Math.min(values.page, Math.max(totalPages, 1));
          const offset = (page - 1) * values.pageSize;
          pageRows = await tx.execute(sql`
            ${eligible}
            , limited_page as (
              select * from eligible
              order by sequence desc, id desc
              limit ${values.pageSize} offset ${offset}
            )
            select limited_page.id, limited_page.sequence, limited_page.field_type,
              limited_page.value_state, left(limited_page.text_value, 500) as text_value,
              limited_page.number_value, limited_page.boolean_value, limited_page.option_id,
              limited_page.option_label, limited_page.researcher_note,
              limited_page.is_current_extraction_revision, limited_page.screening_state,
              limited_page.paper_id, limited_page.paper_title, limited_page.field_id, limited_page.field_name,
              (select count(*)::bigint from extraction_revision_evidence l
                where l.project_id=limited_page.project_id and l.revision_id=limited_page.id) as evidence_count
            from limited_page
          `) as unknown as SearchRow[];
          return {
            items: pageRows.map(toExtractionOption), page, pageSize: values.pageSize, totalCount,
            totalPages, hasPrevious: page > 1, hasNext: page < totalPages,
          };
        }

        const eligible = synthesisEligible(values.projectId, values.query);
        countRows = await tx.execute(sql`
          ${eligible}
          select exists(select 1 from projects where id=${values.projectId}) as project_exists,
            count(*)::bigint as total_count
          from eligible
        `) as unknown as SearchRow[];
        const count = countRows[0];
        if (!count || !count.project_exists) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        const totalCount = Number(count.total_count);
        const totalPages = Math.ceil(totalCount / values.pageSize);
        const page = Math.min(values.page, Math.max(totalPages, 1));
        const offset = (page - 1) * values.pageSize;
        pageRows = await tx.execute(sql`
          ${eligible}
          , limited_page as (
            select * from eligible
            order by sequence desc, id desc
            limit ${values.pageSize} offset ${offset}
          )
          select limited_page.id, limited_page.sequence, limited_page.state, limited_page.title,
            left(limited_page.statement_text, 1000) as statement_text,
            limited_page.researcher_note, limited_page.current_revision_id, limited_page.project_id,
            limited_page.synthesis_statement_id,
            (select count(*)::bigint from synthesis_revision_supports supports
              where supports.project_id=limited_page.project_id
                and supports.synthesis_revision_id=limited_page.id) as observation_count,
            (select count(*)::bigint
              from synthesis_revision_supports supports
              join extraction_revision_evidence links
                on links.project_id=supports.project_id and links.revision_id=supports.extraction_revision_id
              where supports.project_id=limited_page.project_id
                and supports.synthesis_revision_id=limited_page.id) as evidence_path_count
          from limited_page
        `) as unknown as SearchRow[];
        return {
          items: pageRows.map(toSynthesisOption), page, pageSize: values.pageSize, totalCount,
          totalPages, hasPrevious: page > 1, hasNext: page < totalPages,
        };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async resolveEligibleClaimSupportIds(input: ResolveEligibleClaimSupportIdsInput): Promise<EligibleClaimSupportIds> {
      const projectId = ensureId(input.projectId);
      const evidenceIds = normalizeSupportIds(input.evidenceIds);
      const extractionRevisionIds = normalizeSupportIds(input.extractionRevisionIds);
      const synthesisRevisionIds = normalizeSupportIds(input.synthesisRevisionIds);

      return db.transaction(async (tx) => {
        const eligible: EligibleClaimSupportIds = { evidence: [], extractionRevision: [], synthesisRevision: [] };

        if (evidenceIds.length > 0) {
          const rows = await tx.execute(sql`
            ${evidenceEligible(projectId, null)}
            select eligible.id
            from eligible
            join jsonb_array_elements_text(${JSON.stringify(evidenceIds)}::jsonb) as requested(id)
              on requested.id::uuid = eligible.id
          `) as unknown as SearchRow[];
          eligible.evidence = rows.map((row) => String(row.id));
        }

        if (extractionRevisionIds.length > 0) {
          const rows = await tx.execute(sql`
            ${extractionEligible(projectId, null)}
            select eligible.id
            from eligible
            join jsonb_array_elements_text(${JSON.stringify(extractionRevisionIds)}::jsonb) as requested(id)
              on requested.id::uuid = eligible.id
          `) as unknown as SearchRow[];
          eligible.extractionRevision = rows.map((row) => String(row.id));
        }

        if (synthesisRevisionIds.length > 0) {
          const rows = await tx.execute(sql`
            ${synthesisEligible(projectId, null)}
            select eligible.id
            from eligible
            join jsonb_array_elements_text(${JSON.stringify(synthesisRevisionIds)}::jsonb) as requested(id)
              on requested.id::uuid = eligible.id
          `) as unknown as SearchRow[];
          eligible.synthesisRevision = rows.map((row) => String(row.id));
        }

        return eligible;
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
  };
}

export type ClaimSupportReadServices = ReturnType<typeof createClaimSupportReadServices>;
