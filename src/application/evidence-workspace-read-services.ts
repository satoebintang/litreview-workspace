import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { evidenceWorkspaceFilterSchema } from "@/domain/validation";
import type { EvidenceWorkspaceFilter } from "./evidence-curation-services";
import {
  deriveEvidenceReviewState,
  evidenceReviewWarnings,
  mapEvidenceWorkspaceEvidence,
  mapEvidenceWorkspaceLabel,
} from "./evidence-workspace-projection";

export const EVIDENCE_WORKSPACE_DEFAULT_PAGE_SIZE = 50;
export const EVIDENCE_WORKSPACE_MAX_PAGE_SIZE = 100;
export const EVIDENCE_PAPER_OPTIONS_DEFAULT_PAGE_SIZE = 20;
export const EVIDENCE_PAPER_OPTIONS_MAX_PAGE_SIZE = 50;
export const EVIDENCE_PAPER_SEARCH_MAX_CODE_POINTS = 200;
export const evidenceWorkspaceStates = ["attention", "unreviewed", "needs_review", "accepted", "rejected", "all"] as const;
export type EvidenceWorkspaceState = typeof evidenceWorkspaceStates[number];

export type EvidencePaperOption = {
  id: string;
  title: string;
  authors: string[];
  publicationYear: number | null;
  doi: string | null;
};

export type SearchEvidencePaperOptionsInput = {
  projectId: string;
  query?: string;
  page?: number;
  pageSize?: number;
};

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return value as Row[];
}

function ensureUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`);
  }
  return value;
}

function currentReviewCte(projectId: string) {
  return sql`current_review as (
    select distinct on (project_id, evidence_id)
      project_id, evidence_id, decision, id as decision_id, sequence
    from evidence_review_decisions
    where project_id=${projectId}
    order by project_id, evidence_id, sequence desc
  )`;
}

function currentAssignedLabelsCtes(projectId: string) {
  return sql`current_label_events as (
    select distinct on (project_id, evidence_id, label_id)
      project_id, evidence_id, label_id, event, sequence
    from evidence_label_events
    where project_id=${projectId}
    order by project_id, evidence_id, label_id, sequence desc
  ), current_assigned_labels as (
    select event.project_id, event.evidence_id, label.id, label.name, label.description,
      label.created_at, label.archived_at
    from current_label_events event
    join evidence_labels label on label.project_id=event.project_id and label.id=event.label_id
    where event.event='assigned'
  )`;
}

function usedEvidenceCte(projectId: string) {
  return sql`used_evidence(project_id, evidence_id) as (
    select project_id, evidence_id
    from extraction_revision_evidence
    where project_id=${projectId}
    union
    select project_id, evidence_id
    from claim_revision_evidence_supports
    where project_id=${projectId}
    union
    select link.project_id, link.evidence_id
    from claim_revision_extraction_supports support
    join extraction_revision_evidence link
      on link.project_id=support.project_id and link.revision_id=support.extraction_revision_id
    where support.project_id=${projectId}
    union
    select link.project_id, link.evidence_id
    from synthesis_revision_supports support
    join extraction_revision_evidence link
      on link.project_id=support.project_id and link.revision_id=support.extraction_revision_id
    where support.project_id=${projectId}
    union
    select link.project_id, link.evidence_id
    from claim_revision_synthesis_supports claim_support
    join synthesis_revision_supports synthesis_support
      on synthesis_support.project_id=claim_support.project_id
      and synthesis_support.synthesis_revision_id=claim_support.synthesis_revision_id
    join extraction_revision_evidence link
      on link.project_id=synthesis_support.project_id
      and link.revision_id=synthesis_support.extraction_revision_id
    where claim_support.project_id=${projectId}
  )`;
}

function workspaceCtes(projectId: string) {
  return sql`${currentReviewCte(projectId)},
    ${currentAssignedLabelsCtes(projectId)},
    ${usedEvidenceCte(projectId)}`;
}

function usedEvidenceJoin(filter: EvidenceWorkspaceFilter) {
  return filter.usage === "used" || filter.usage === "unused"
    ? sql`left join used_evidence used on used.project_id=e.project_id and used.evidence_id=e.id`
    : sql``;
}

function pageIdsCte(ids: string[]) {
  return sql`page_ids(evidence_id) as (
    select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid
  )`;
}

function workspacePredicate(projectId: string, filter: EvidenceWorkspaceFilter) {
  const conditions = [sql`e.project_id=${projectId}`];
  const state = filter.state ?? "attention";
  if (state === "attention") conditions.push(sql`(review.decision is null or review.decision='needs_review')`);
  else if (state === "unreviewed") conditions.push(sql`review.decision is null`);
  else if (state !== "all") conditions.push(sql`review.decision=${state}`);
  if (filter.paperId) conditions.push(sql`e.paper_id=${filter.paperId}`);
  if (filter.fullTextDocumentId) conditions.push(sql`e.full_text_document_id=${filter.fullTextDocumentId}`);
  if (filter.documentTextExtractionId) conditions.push(sql`e.document_text_extraction_id=${filter.documentTextExtractionId}`);
  if (filter.pageNumber) conditions.push(sql`e.page_number=${filter.pageNumber}`);
  if (filter.documentProvenance === "none") conditions.push(sql`e.full_text_document_id is null`);
  if (filter.documentProvenance === "document") conditions.push(sql`e.full_text_document_id is not null and e.document_text_extraction_id is null`);
  if (filter.documentProvenance === "extraction") conditions.push(sql`e.document_text_extraction_id is not null`);
  if (filter.labelId) conditions.push(sql`exists (
    select 1 from current_assigned_labels label
    where label.project_id=e.project_id and label.evidence_id=e.id and label.id=${filter.labelId}
  )`);
  if (filter.usage === "used") conditions.push(sql`used.evidence_id is not null`);
  if (filter.usage === "unused") conditions.push(sql`used.evidence_id is null`);
  return sql.join(conditions, sql` and `);
}

function countQuery(projectId: string, filter: EvidenceWorkspaceFilter) {
  const predicate = workspacePredicate(projectId, filter);
  return sql`with ${workspaceCtes(projectId)}
    select project.id as project_id,
      (count(e.id) filter (where ${predicate}))::bigint as total_count
    from projects project
    left join evidence e on e.project_id=project.id
    left join current_review review on review.project_id=e.project_id and review.evidence_id=e.id
    ${usedEvidenceJoin(filter)}
    where project.id=${projectId}
    group by project.id`;
}

function pageQuery(projectId: string, filter: EvidenceWorkspaceFilter, pageSize: number, offset: number) {
  const predicate = workspacePredicate(projectId, filter);
  return sql`with ${workspaceCtes(projectId)}
    select e.id, e.project_id, e.paper_id, e.full_text_document_id, e.document_text_extraction_id,
      e.source_text, e.page_number, e.extraction_start_offset, e.extraction_end_offset, e.note,
      e.created_at, e.updated_at,
      paper.title as paper_title, paper.authors, paper.publication_year, paper.venue, paper.doi,
      document.original_filename as document_original_filename,
      document.sha256 as document_sha256,
      document.archived_at as document_archived_at,
      review.decision, review.decision_id, review.sequence as decision_sequence
    from evidence e
    join papers paper on paper.project_id=e.project_id and paper.id=e.paper_id
    left join full_text_documents document
      on document.project_id=e.project_id and document.paper_id=e.paper_id and document.id=e.full_text_document_id
    left join current_review review on review.project_id=e.project_id and review.evidence_id=e.id
    ${usedEvidenceJoin(filter)}
    where ${predicate}
    order by e.created_at asc, e.id asc
    limit ${pageSize} offset ${offset}`;
}

function labelsQuery(projectId: string, ids: string[]) {
  return sql`with ${currentAssignedLabelsCtes(projectId)}, ${pageIdsCte(ids)}
    select labels.evidence_id, labels.id, labels.project_id, labels.name,
      labels.description, labels.created_at, labels.archived_at
    from page_ids page
    join current_assigned_labels labels
      on labels.project_id=${projectId} and labels.evidence_id=page.evidence_id
    order by labels.evidence_id, lower(labels.name), labels.id`;
}

function usageQuery(projectId: string, ids: string[]) {
  return sql`with ${usedEvidenceCte(projectId)}, ${pageIdsCte(ids)}
    select page.evidence_id,
      (used.evidence_id is not null) as used
    from page_ids page
    left join used_evidence used
      on used.project_id=${projectId} and used.evidence_id=page.evidence_id
    order by page.evidence_id`;
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
  if (!Number.isSafeInteger(count) || count < 0) throw new DomainError("DATABASE_CONSTRAINT", "Evidence workspace count is invalid");
  return count;
}

function paperOption(row: Row): EvidencePaperOption {
  return {
    id: String(row.id),
    title: String(row.title),
    authors: Array.isArray(row.authors) ? row.authors as string[] : [],
    publicationYear: row.publication_year == null ? null : Number(row.publication_year),
    doi: row.doi == null ? null : String(row.doi),
  };
}

function normalizePaperSearch(input: SearchEvidencePaperOptionsInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DomainError("VALIDATION_ERROR", "Paper search input is invalid");
  }
  const projectId = ensureUuid(input.projectId, "Project");
  if (input.query !== undefined && typeof input.query !== "string") {
    throw new DomainError("VALIDATION_ERROR", "Paper search query must be text");
  }
  const query = (input.query ?? "").trim();
  if (Array.from(query).length > EVIDENCE_PAPER_SEARCH_MAX_CODE_POINTS) {
    throw new DomainError("VALIDATION_ERROR", `Paper search query cannot exceed ${EVIDENCE_PAPER_SEARCH_MAX_CODE_POINTS} Unicode code points`);
  }
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1) throw new DomainError("VALIDATION_ERROR", "Paper search page must be a positive integer");
  const requestedPageSize = input.pageSize ?? EVIDENCE_PAPER_OPTIONS_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1) {
    throw new DomainError("VALIDATION_ERROR", "Paper search page size must be a positive integer");
  }
  return {
    projectId,
    query,
    page,
    pageSize: Math.min(requestedPageSize, EVIDENCE_PAPER_OPTIONS_MAX_PAGE_SIZE),
  };
}

function paperSearchPredicate(projectId: string, query: string) {
  return query === ""
    ? sql`paper.project_id=${projectId}`
    : sql`paper.project_id=${projectId} and strpos(lower(paper.title), lower(${query})) > 0`;
}

export function createEvidenceWorkspaceReadServices(db: Database) {
  return {
    async getEvidenceWorkspacePage(projectId: string, input: EvidenceWorkspaceFilter = {}) {
      ensureUuid(projectId, "Project");
      const parsed = evidenceWorkspaceFilterSchema.safeParse(input);
      if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Evidence workspace filters are invalid", parsed.error.issues);
      const filter = parsed.data;

      return db.transaction(async (tx) => {
        const countRows = rows(await tx.execute(countQuery(projectId, filter)));
        const countRow = countRows[0];
        if (!countRow?.project_id) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
        const totalCount = countValue(countRow.total_count);
        const page = pageBounds(filter.page, filter.pageSize, totalCount);
        const evidenceRows = rows(await tx.execute(pageQuery(projectId, filter, page.pageSize, (page.page - 1) * page.pageSize)));
        const ids = evidenceRows.map((row) => String(row.id));
        const labelRows = rows(await tx.execute(labelsQuery(projectId, ids)));
        const usageRows = rows(await tx.execute(usageQuery(projectId, ids)));
        const labelsByEvidence = new Map<string, ReturnType<typeof mapEvidenceWorkspaceLabel>[]>();
        for (const row of labelRows) {
          const evidenceId = String(row.evidence_id);
          labelsByEvidence.set(evidenceId, [...(labelsByEvidence.get(evidenceId) ?? []), mapEvidenceWorkspaceLabel(row)]);
        }
        const usageByEvidence = new Map(usageRows.map((row) => [String(row.evidence_id), Boolean(row.used)]));
        const items = evidenceRows.map((row) => {
          const evidenceItem = mapEvidenceWorkspaceEvidence(row);
          const reviewState = deriveEvidenceReviewState(row.decision == null ? null : String(row.decision));
          return {
            ...evidenceItem,
            reviewState,
            latestDecisionId: row.decision_id == null ? null : String(row.decision_id),
            warnings: evidenceReviewWarnings(reviewState),
            labels: labelsByEvidence.get(evidenceItem.id) ?? [],
            usage: usageByEvidence.get(evidenceItem.id) ? "used" as const : "unused" as const,
          };
        });

        return { ...page, state: filter.state, filters: filter, items };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async searchEvidencePaperOptions(input: SearchEvidencePaperOptionsInput) {
      const values = normalizePaperSearch(input);
      return db.transaction(async (tx) => {
        const countRows = rows(await tx.execute(sql`
          select project.id as project_id, count(paper.id)::bigint as total_count
          from projects project
          left join papers paper on paper.project_id=project.id
            and (${values.query === ""} or strpos(lower(paper.title), lower(${values.query})) > 0)
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
          where ${paperSearchPredicate(values.projectId, values.query)}
          order by paper.created_at desc, paper.id desc
          limit ${bounds.pageSize} offset ${(bounds.page - 1) * bounds.pageSize}
        `));
        return { ...bounds, items: optionRows.map(paperOption) };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async getEvidencePaperOption(projectId: string, paperId: string): Promise<EvidencePaperOption | null> {
      ensureUuid(projectId, "Project");
      ensureUuid(paperId, "Paper");
      const optionRows = rows(await db.execute(sql`
        select paper.id, paper.title, paper.authors, paper.publication_year, paper.doi
        from papers paper
        where paper.project_id=${projectId} and paper.id=${paperId}
        limit 1
      `));
      return optionRows[0] ? paperOption(optionRows[0]) : null;
    },
  };
}

export type EvidenceWorkspaceReadServices = ReturnType<typeof createEvidenceWorkspaceReadServices>;
