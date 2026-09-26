import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { ensureId } from "./review-services/shared";

export type ClaimLedgerFilter = "all" | "supported" | "unsupported" | "withdrawn";
export type ClaimReadLifecycle = "active" | "withdrawn";

export interface ClaimLedgerCounts {
  all: number;
  supported: number;
  unsupported: number;
  withdrawn: number;
}

export interface ClaimLedgerRow {
  projectId: string;
  claimId: string;
  claimCreatedAt: Date;
  revisionId: string;
  sequence: number;
  lifecycle: ClaimReadLifecycle;
  claimText: string | null;
  researcherNote: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
  supportStatus: "supported" | "unsupported";
  directEvidenceCount: number;
  extractionRevisionCount: number;
  synthesisRevisionCount: number;
  totalSupportCount: number;
  citationCandidateCount: number;
  distinctPaperCount: number;
}

export interface ClaimHistorySummary {
  projectId: string;
  claimId: string;
  revisionId: string;
  sequence: number;
  lifecycle: ClaimReadLifecycle;
  claimText: string | null;
  researcherNote: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
  supportStatus: "supported" | "unsupported";
  directEvidenceCount: number;
  extractionRevisionCount: number;
  synthesisRevisionCount: number;
  totalSupportCount: number;
  citationCandidateCount: number;
  distinctPaperCount: number;
}

export interface ClaimLedgerPage {
  filter: ClaimLedgerFilter;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  from: number;
  to: number;
  hasPrevious: boolean;
  hasNext: boolean;
  counts: ClaimLedgerCounts;
  /** Sum of each current ClaimRevision's distinct Paper count. */
  citationCandidateTotal: number;
  items: ClaimLedgerRow[];
}

export interface ClaimReadService {
  /** Returns null when projectId does not identify a Project. */
  getClaimLedgerPage(projectId: string, input?: { filter?: string; page?: number; pageSize?: number }): Promise<ClaimLedgerPage | null>;
  getClaimHistorySummaries(projectId: string, claimId: string): Promise<ClaimHistorySummary[]>;
  getLatestActiveClaimRevisionId(projectId: string, claimId: string): Promise<string | null>;
}

type DbRow = Record<string, unknown>;

function rows(value: unknown): DbRow[] {
  return value as unknown as DbRow[];
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : date(value);
}

function lifecycle(value: unknown): ClaimReadLifecycle {
  return String(value) === "withdrawn" ? "withdrawn" : "active";
}

function supportStatus(value: unknown): "supported" | "unsupported" {
  return String(value) === "supported" ? "supported" : "unsupported";
}

function normalizeFilter(value: string | undefined): ClaimLedgerFilter {
  return value === "supported" || value === "unsupported" || value === "withdrawn" ? value : "all";
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function currentRevisionRows(projectId: string): SQL {
  return sql`
    select c.project_id, c.id as claim_id, c.created_at as claim_created_at,
      r.id as revision_id, r.sequence, r.state, r.claim_text, r.researcher_note,
      r.created_at, r.finalized_at
    from claims c
    join lateral (
      select current_r.id, current_r.sequence, current_r.state, current_r.claim_text,
        current_r.researcher_note, current_r.created_at, current_r.finalized_at
      from claim_revisions current_r
      where current_r.project_id=c.project_id and current_r.claim_id=c.id
        and current_r.finalized_at is not null
      order by current_r.sequence desc
      limit 1
    ) r on true
    where c.project_id=${projectId}
  `;
}

function historyRevisionRows(projectId: string, claimId: string): SQL {
  return sql`
    select r.project_id, r.claim_id, null::timestamptz as claim_created_at,
      r.id as revision_id, r.sequence, r.state, r.claim_text, r.researcher_note,
      r.created_at, r.finalized_at
    from claim_revisions r
    where r.project_id=${projectId} and r.claim_id=${claimId} and r.finalized_at is not null
  `;
}

/**
 * Shared exact-snapshot metrics for current ledger rows and historical detail
 * summaries. Structural and citation Paper paths intentionally stay separate.
 */
function claimMetricsCtes(revisionRows: SQL): SQL {
  return sql`
    with revisions as (${revisionRows}),
    evidence_support_counts as (
      select s.project_id, s.claim_revision_id, count(*)::integer as support_count
      from claim_revision_evidence_supports s
      join revisions r on r.project_id=s.project_id and r.revision_id=s.claim_revision_id
      group by s.project_id, s.claim_revision_id
    ),
    extraction_support_counts as (
      select s.project_id, s.claim_revision_id, count(*)::integer as support_count
      from claim_revision_extraction_supports s
      join revisions r on r.project_id=s.project_id and r.revision_id=s.claim_revision_id
      group by s.project_id, s.claim_revision_id
    ),
    synthesis_support_counts as (
      select s.project_id, s.claim_revision_id, count(*)::integer as support_count
      from claim_revision_synthesis_supports s
      join revisions r on r.project_id=s.project_id and r.revision_id=s.claim_revision_id
      group by s.project_id, s.claim_revision_id
    ),
    support_counts as (
      select r.project_id, r.revision_id,
        coalesce(e.support_count, 0)::integer as direct_evidence_count,
        coalesce(x.support_count, 0)::integer as extraction_revision_count,
        coalesce(s.support_count, 0)::integer as synthesis_revision_count
      from revisions r
      left join evidence_support_counts e on e.project_id=r.project_id and e.claim_revision_id=r.revision_id
      left join extraction_support_counts x on x.project_id=r.project_id and x.claim_revision_id=r.revision_id
      left join synthesis_support_counts s on s.project_id=r.project_id and s.claim_revision_id=r.revision_id
    ),
    structural_papers as (
      select s.project_id, s.claim_revision_id, e.paper_id
      from claim_revision_evidence_supports s
      join revisions r on r.project_id=s.project_id and r.revision_id=s.claim_revision_id
      join evidence e on e.project_id=s.project_id and e.id=s.evidence_id
      union
      select s.project_id, s.claim_revision_id, extraction.paper_id
      from claim_revision_extraction_supports s
      join revisions r on r.project_id=s.project_id and r.revision_id=s.claim_revision_id
      join extraction_value_revisions extraction
        on extraction.project_id=s.project_id and extraction.id=s.extraction_revision_id
      union
      select s.project_id, s.claim_revision_id, extraction.paper_id
      from claim_revision_synthesis_supports s
      join revisions r on r.project_id=s.project_id and r.revision_id=s.claim_revision_id
      join synthesis_revision_supports synthesis_support
        on synthesis_support.project_id=s.project_id and synthesis_support.synthesis_revision_id=s.synthesis_revision_id
      join extraction_value_revisions extraction
        on extraction.project_id=synthesis_support.project_id and extraction.id=synthesis_support.extraction_revision_id
    ),
    citation_papers as (
      select s.project_id, s.claim_revision_id, e.paper_id
      from claim_revision_evidence_supports s
      join revisions r on r.project_id=s.project_id and r.revision_id=s.claim_revision_id
      join evidence e on e.project_id=s.project_id and e.id=s.evidence_id
      union
      select s.project_id, s.claim_revision_id, extraction.paper_id
      from claim_revision_extraction_supports s
      join revisions r on r.project_id=s.project_id and r.revision_id=s.claim_revision_id
      join extraction_value_revisions extraction
        on extraction.project_id=s.project_id and extraction.id=s.extraction_revision_id
      join extraction_revision_evidence path
        on path.project_id=extraction.project_id and path.revision_id=extraction.id and path.paper_id=extraction.paper_id
      union
      select s.project_id, s.claim_revision_id, extraction.paper_id
      from claim_revision_synthesis_supports s
      join revisions r on r.project_id=s.project_id and r.revision_id=s.claim_revision_id
      join synthesis_revision_supports synthesis_support
        on synthesis_support.project_id=s.project_id and synthesis_support.synthesis_revision_id=s.synthesis_revision_id
      join extraction_value_revisions extraction
        on extraction.project_id=synthesis_support.project_id and extraction.id=synthesis_support.extraction_revision_id
      join extraction_revision_evidence path
        on path.project_id=extraction.project_id and path.revision_id=extraction.id and path.paper_id=extraction.paper_id
    ),
    structural_counts as (
      select project_id, claim_revision_id, count(*)::integer as paper_count
      from structural_papers
      group by project_id, claim_revision_id
    ),
    citation_counts as (
      select project_id, claim_revision_id, count(*)::integer as paper_count
      from citation_papers
      group by project_id, claim_revision_id
    ),
    claim_metrics as (
      select r.project_id, r.claim_id, r.claim_created_at, r.revision_id, r.sequence,
        r.state, r.claim_text, r.researcher_note, r.created_at, r.finalized_at,
        s.direct_evidence_count, s.extraction_revision_count, s.synthesis_revision_count,
        (s.direct_evidence_count + s.extraction_revision_count + s.synthesis_revision_count)::integer as total_support_count,
        coalesce(citation.paper_count, 0)::integer as citation_candidate_count,
        coalesce(structural.paper_count, 0)::integer as distinct_paper_count,
        case when r.state='active' and
          (s.direct_evidence_count + s.extraction_revision_count + s.synthesis_revision_count) > 0
          then 'supported' else 'unsupported' end as support_status
      from revisions r
      join support_counts s on s.project_id=r.project_id and s.revision_id=r.revision_id
      left join citation_counts citation on citation.project_id=r.project_id and citation.claim_revision_id=r.revision_id
      left join structural_counts structural on structural.project_id=r.project_id and structural.claim_revision_id=r.revision_id
    )
  `;
}

function mapLedgerRow(row: DbRow): ClaimLedgerRow {
  return {
    projectId: String(row.project_id),
    claimId: String(row.claim_id),
    claimCreatedAt: date(row.claim_created_at),
    revisionId: String(row.revision_id),
    sequence: count(row.sequence),
    lifecycle: lifecycle(row.state),
    claimText: row.claim_text == null ? null : String(row.claim_text),
    researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
    createdAt: date(row.created_at),
    finalizedAt: nullableDate(row.finalized_at),
    supportStatus: supportStatus(row.support_status),
    directEvidenceCount: count(row.direct_evidence_count),
    extractionRevisionCount: count(row.extraction_revision_count),
    synthesisRevisionCount: count(row.synthesis_revision_count),
    totalSupportCount: count(row.total_support_count),
    citationCandidateCount: count(row.citation_candidate_count),
    distinctPaperCount: count(row.distinct_paper_count),
  };
}

function mapHistorySummary(row: DbRow): ClaimHistorySummary {
  return {
    projectId: String(row.project_id),
    claimId: String(row.claim_id),
    revisionId: String(row.revision_id),
    sequence: count(row.sequence),
    lifecycle: lifecycle(row.state),
    claimText: row.claim_text == null ? null : String(row.claim_text),
    researcherNote: row.researcher_note == null ? null : String(row.researcher_note),
    createdAt: date(row.created_at),
    finalizedAt: nullableDate(row.finalized_at),
    supportStatus: supportStatus(row.support_status),
    directEvidenceCount: count(row.direct_evidence_count),
    extractionRevisionCount: count(row.extraction_revision_count),
    synthesisRevisionCount: count(row.synthesis_revision_count),
    totalSupportCount: count(row.total_support_count),
    citationCandidateCount: count(row.citation_candidate_count),
    distinctPaperCount: count(row.distinct_paper_count),
  };
}

export function createClaimReadServices(db: Database): ClaimReadService {
  async function requireClaimIdentity(projectId: string, claimId: string) {
    ensureId(projectId);
    ensureId(claimId);
    const found = rows(await db.execute(sql`
      select p.id as project_id, c.id as claim_id
      from projects p
      left join claims c on c.project_id=p.id and c.id=${claimId}
      where p.id=${projectId}
      limit 1
    `));
    if (!found.length) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
    if (found[0].claim_id == null) throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim does not belong to this project");
  }

  return {
    async getClaimLedgerPage(projectId, input = {}) {
      ensureId(projectId);
      const filter = normalizeFilter(input.filter);
      const requestedPage = normalizePositiveInteger(input.page, 1);
      const pageSize = Math.min(normalizePositiveInteger(input.pageSize, 50), 100);

      return db.transaction(async (tx) => {
        const aggregateRows = rows(await tx.execute(sql`
          ${claimMetricsCtes(currentRevisionRows(projectId))}
          select p.id as project_id,
            count(metrics.revision_id)::integer as all_count,
            count(metrics.revision_id) filter (where metrics.state='active' and metrics.support_status='supported')::integer as supported_count,
            count(metrics.revision_id) filter (where metrics.state='active' and metrics.support_status='unsupported')::integer as unsupported_count,
            count(metrics.revision_id) filter (where metrics.state='withdrawn')::integer as withdrawn_count,
            coalesce(sum(metrics.citation_candidate_count), 0)::integer as citation_candidate_total
          from projects p
          left join claim_metrics metrics on true
          where p.id=${projectId}
          group by p.id
        `));

        // The Project row is the aggregate anchor: an existing empty Project
        // returns zeros, while a missing Project produces no row.
        if (!aggregateRows.length) return null;
        const aggregate = aggregateRows[0];
        const counts: ClaimLedgerCounts = {
          all: count(aggregate.all_count),
          supported: count(aggregate.supported_count),
          unsupported: count(aggregate.unsupported_count),
          withdrawn: count(aggregate.withdrawn_count),
        };
        const totalCount = counts[filter];
        const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);
        const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
        const offset = (page - 1) * pageSize;
        const predicate = filter === "all"
          ? sql`true`
          : filter === "supported"
            ? sql`state='active' and support_status='supported'`
            : filter === "unsupported"
              ? sql`state='active' and support_status='unsupported'`
              : sql`state='withdrawn'`;
        const pageRows = rows(await tx.execute(sql`
          ${claimMetricsCtes(currentRevisionRows(projectId))}
          select project_id, claim_id, claim_created_at, revision_id, sequence, state,
            claim_text, researcher_note, created_at, finalized_at, support_status,
            direct_evidence_count, extraction_revision_count, synthesis_revision_count,
            total_support_count, citation_candidate_count, distinct_paper_count
          from claim_metrics
          where ${predicate}
          order by sequence desc, claim_id asc
          limit ${pageSize} offset ${offset}
        `));
        const from = totalCount === 0 ? 0 : offset + 1;
        const to = totalCount === 0 ? 0 : Math.min(offset + pageRows.length, totalCount);

        return {
          filter,
          page,
          pageSize,
          totalCount,
          totalPages,
          from,
          to,
          hasPrevious: page > 1,
          hasNext: totalPages > 0 && page < totalPages,
          counts,
          citationCandidateTotal: count(aggregate.citation_candidate_total),
          items: pageRows.map(mapLedgerRow),
        };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },

    async getClaimHistorySummaries(projectId, claimId) {
      await requireClaimIdentity(projectId, claimId);
      const summaryRows = rows(await db.execute(sql`
        ${claimMetricsCtes(historyRevisionRows(projectId, claimId))}
        select project_id, claim_id, revision_id, sequence, state, claim_text,
          researcher_note, created_at, finalized_at, support_status,
          direct_evidence_count, extraction_revision_count, synthesis_revision_count,
          total_support_count, citation_candidate_count, distinct_paper_count
        from claim_metrics
        order by sequence desc
      `));
      return summaryRows.map(mapHistorySummary);
    },

    async getLatestActiveClaimRevisionId(projectId, claimId) {
      ensureId(projectId);
      ensureId(claimId);
      const lookupRows = rows(await db.execute(sql`
        select c.id as claim_id,
          (select active_revision.id
           from claim_revisions active_revision
           where active_revision.project_id=p.id and active_revision.claim_id=c.id
             and active_revision.state='active' and active_revision.finalized_at is not null
           order by active_revision.sequence desc
           limit 1) as revision_id
        from projects p
        left join claims c on c.project_id=p.id and c.id=${claimId}
        where p.id=${projectId}
        limit 1
      `));
      if (!lookupRows.length) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
      if (lookupRows[0].claim_id == null) throw new DomainError("CROSS_PROJECT_REFERENCE", "Claim does not belong to this project");
      return lookupRows[0].revision_id == null ? null : String(lookupRows[0].revision_id);
    },
  };
}
