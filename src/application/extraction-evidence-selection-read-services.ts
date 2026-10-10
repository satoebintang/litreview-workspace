import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { idSchema } from "@/domain/validation";
import { evidenceCurationWarning, evidenceReviewState, ensureId } from "@/application/review-services/shared";
import {
  decodeExtractionEvidenceCandidateCursor,
  effectiveExtractionEvidencePageSize,
  encodeExtractionEvidenceCandidateCursor,
  hashExtractionEvidenceSearchQuery,
  type ExtractionEvidenceCandidateCursor,
} from "./extraction-evidence-selection-cursor";
import { normalizeExtractionEvidenceSearchQuery } from "./extraction-evidence-search-query";

type RawRow = Record<string, unknown>;
export type ExtractionEvidencePreview = {
  id: string;
  projectId: string;
  paperId: string;
  pageNumber: number;
  sourceTextPreview: string;
  sourceTextTruncated: boolean;
  notePreview: string | null;
  noteTruncated: boolean;
  reviewState: "unreviewed" | "needs_review" | "accepted" | "rejected";
  curationWarning: "never_reviewed" | "needs_review" | "currently_rejected" | null;
  href: string;
};

export type ExtractionEvidenceCandidatePage = {
  items: ExtractionEvidencePreview[];
  pageSize: number;
  hasNext: boolean;
  nextCursor: string | null;
};

const READ_STATEMENT_TIMEOUT = sql`set local statement_timeout = '15000ms'`;
const READ_TRANSACTION = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

function rows(value: unknown): RawRow[] {
  return value as unknown as RawRow[];
}

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === 1;
}

function mapPreview(row: RawRow): ExtractionEvidencePreview {
  const id = String(row.evidence_id);
  const projectId = String(row.project_id);
  const paperId = String(row.paper_id);
  const reviewState = evidenceReviewState(row.current_review_decision == null ? undefined : String(row.current_review_decision));
  return {
    id,
    projectId,
    paperId,
    pageNumber: Number(row.page_number),
    sourceTextPreview: String(row.source_text_preview ?? ""),
    sourceTextTruncated: bool(row.source_text_truncated),
    notePreview: row.note_preview == null ? null : String(row.note_preview),
    noteTruncated: bool(row.note_truncated),
    reviewState,
    curationWarning: evidenceCurationWarning(reviewState),
    href: `/projects/${projectId}/evidence/${id}`,
  };
}

function encodeCursor(
  projectId: string,
  paperId: string,
  pageSize: number,
  queryHash: string,
  last: { createdAt: string; id: string },
): string {
  return encodeExtractionEvidenceCandidateCursor({
    kind: "paper-extraction-evidence-candidate",
    version: 2,
    projectId,
    paperId,
    pageSize,
    createdAt: last.createdAt,
    id: last.id,
    queryHash,
  });
}

export function buildExtractionEvidenceCandidateKeyQuery(input: {
  projectId: string;
  paperId: string;
  pageSize: number;
  query: string;
  cursor: ExtractionEvidenceCandidateCursor | null;
}): SQL {
  const boundary = input.cursor
    ? sql`and (e.created_at < ${input.cursor.createdAt}::timestamptz or (e.created_at = ${input.cursor.createdAt}::timestamptz and e.id > ${input.cursor.id}::uuid))`
    : sql``;
  const matching = input.query
    ? sql`and (strpos(lower(e.source_text), lower(${input.query})) > 0 or strpos(lower(e.note), lower(${input.query})) > 0)`
    : sql``;
  return sql`
    select e.id::text as evidence_id,
      to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at
    from evidence e
    where e.project_id=${input.projectId}::uuid and e.paper_id=${input.paperId}::uuid
      ${matching}
      ${boundary}
    order by e.created_at desc, e.id asc
    limit ${input.pageSize + 1}
  `;
}

export function createExtractionEvidenceSelectionReadServices(db: Database) {
  async function getPaperExtractionEvidenceCandidatePage(
    projectIdInput: string,
    paperIdInput: string,
    options: { pageSize?: number; after?: string | null; query?: unknown } = {},
  ): Promise<ExtractionEvidenceCandidatePage> {
    const query = options.query === undefined ? "" : normalizeExtractionEvidenceSearchQuery(options.query);
    const queryHash = hashExtractionEvidenceSearchQuery(query);
    const projectId = ensureId(projectIdInput).toLowerCase();
    const paperId = ensureId(paperIdInput).toLowerCase();
    const pageSize = effectiveExtractionEvidencePageSize(options.pageSize);
    return db.transaction(async (tx) => {
      await tx.execute(READ_STATEMENT_TIMEOUT);
      const [scope] = rows(await tx.execute(sql`
        select p.id::text as project_id, paper.id::text as paper_id
        from projects p
        left join papers paper on paper.project_id=p.id and paper.id=${paperId}::uuid
        where p.id=${projectId}::uuid
        limit 1
      `));
      if (!scope) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
      if (scope.paper_id == null) throw new DomainError("CROSS_PROJECT_REFERENCE", "Paper does not belong to this project");

      const cursor = decodeExtractionEvidenceCandidateCursor(options.after, { projectId, paperId, pageSize, queryHash });
      const keyRows = rows(await tx.execute(buildExtractionEvidenceCandidateKeyQuery({
        projectId, paperId, pageSize, query, cursor,
      })));
      const hasNext = keyRows.length > pageSize;
      const visibleKeys = keyRows.slice(0, pageSize).map((row) => ({ id: String(row.evidence_id), createdAt: String(row.cursor_created_at) }));
      const visibleIds = visibleKeys.map((key) => key.id);
      const candidateRows = visibleIds.length === 0 ? [] : rows(await tx.execute(sql`
        with visible_keys as (
          select keys.id, keys.ord
          from unnest(array[${sql.join(visibleIds.map((id) => sql`${id}::uuid`), sql`, `)}]) with ordinality as keys(id, ord)
        )
        select e.id::text as evidence_id, e.project_id::text as project_id, e.paper_id::text as paper_id,
          e.page_number,
          left(e.source_text, 1200) as source_text_preview,
          char_length(e.source_text) > 1200 as source_text_truncated,
          left(e.note, 600) as note_preview,
          coalesce(char_length(e.note) > 600, false) as note_truncated,
          latest_review.decision as current_review_decision
        from visible_keys keys
        join evidence e on e.id=keys.id
        left join lateral (
          select decision.decision
          from evidence_review_decisions decision
          where decision.project_id=e.project_id and decision.evidence_id=e.id
          order by decision.sequence desc
          limit 1
        ) latest_review on true
        where e.project_id=${projectId}::uuid and e.paper_id=${paperId}::uuid
        order by keys.ord
      `));
      const items = candidateRows.map(mapPreview);
      const lastVisible = visibleKeys.at(-1);
      return {
        items,
        pageSize,
        hasNext,
        nextCursor: hasNext && lastVisible ? encodeCursor(projectId, paperId, pageSize, queryHash, lastVisible) : null,
      };
    }, READ_TRANSACTION);
  }

  async function getPaperExtractionEvidenceSupportMetadata(
    projectIdInput: string,
    paperIdInput: string,
    evidenceIdsInput: string[],
  ): Promise<ExtractionEvidencePreview[]> {
    const projectId = ensureId(projectIdInput).toLowerCase();
    const paperId = ensureId(paperIdInput).toLowerCase();
    const evidenceIds = [...new Set(evidenceIdsInput.flatMap((id) => {
      const parsed = idSchema.safeParse(id);
      return parsed.success ? [parsed.data.toLowerCase()] : [];
    }))];
    if (evidenceIds.length === 0) return [];
    return db.transaction(async (tx) => {
      await tx.execute(READ_STATEMENT_TIMEOUT);
      const result = rows(await tx.execute(sql`
        select e.id::text as evidence_id, e.project_id::text as project_id, e.paper_id::text as paper_id,
          e.page_number,
          left(e.source_text, 1200) as source_text_preview,
          char_length(e.source_text) > 1200 as source_text_truncated,
          left(e.note, 600) as note_preview,
          coalesce(char_length(e.note) > 600, false) as note_truncated,
          latest_review.decision as current_review_decision
        from evidence e
        left join lateral (
          select decision.decision
          from evidence_review_decisions decision
          where decision.project_id=e.project_id and decision.evidence_id=e.id
          order by decision.sequence desc
          limit 1
        ) latest_review on true
        where e.project_id=${projectId}::uuid and e.paper_id=${paperId}::uuid
          and e.id in (${sql.join(evidenceIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `));
      return result.map(mapPreview);
    }, READ_TRANSACTION);
  }

  return { getPaperExtractionEvidenceCandidatePage, getPaperExtractionEvidenceSupportMetadata };
}

export type ExtractionEvidenceSelectionReadServices = ReturnType<typeof createExtractionEvidenceSelectionReadServices>;
