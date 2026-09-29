import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import type { ExtractionFieldType, EvidenceReviewState } from "@/domain/types";
import { ensureId } from "@/application/review-services/shared";

export const SYNTHESIS_PREPARATION_LEDGER_DEFAULT_PAGE_SIZE = 50;
export const SYNTHESIS_PREPARATION_LEDGER_MAX_PAGE_SIZE = 100;
export const SYNTHESIS_PREPARATION_CANDIDATE_DEFAULT_PAGE_SIZE = 50;
export const SYNTHESIS_PREPARATION_CANDIDATE_MAX_PAGE_SIZE = 100;
export const SYNTHESIS_PREPARATION_EVIDENCE_DEFAULT_PAGE_SIZE = 25;
export const SYNTHESIS_PREPARATION_EVIDENCE_MAX_PAGE_SIZE = 50;
export const SYNTHESIS_TARGET_SELECTOR_DEFAULT_PAGE_SIZE = 20;
export const SYNTHESIS_TARGET_SELECTOR_MAX_PAGE_SIZE = 50;

export const SYNTHESIS_PREPARATION_READ_TEXT_LIMITS = {
  candidatePaperTitle: 160,
  candidateValue: 240,
  candidateOption: 120,
  evidenceSource: 2_000,
  evidenceNote: 400,
  evidenceFilename: 160,
  targetTitle: 160,
  targetStatementPreview: 240,
  ledgerTitlePreview: 120,
  ledgerNotePreview: 200,
  ledgerSetLabel: 120,
  ledgerFieldLabel: 120,
  ledgerTargetLabel: 120,
} as const;

export type SynthesisPreparationCandidateFilter = "all" | "selected" | "selectable" | "ineligible";
export type SynthesisPreparationCursorPageInput = {
  cursor?: string | null;
  pageSize?: number | string;
};

export type SynthesisPreparationCandidate = {
  extractionRevisionId: string;
  extractionValueId: string;
  sequence: number;
  finalizedAt: Date;
  fieldType: ExtractionFieldType;
  valueState: "present" | "not_reported" | "not_applicable" | "cleared";
  value: string | null;
  optionId: string | null;
  optionLabel: string | null;
  paper: { id: string; title: string };
  isFinallyIncluded: boolean;
  isCurrentExtractionRevision: boolean;
  selected: boolean;
  selectable: boolean;
  membershipOrder: number;
  connectingEvidenceCount: number;
  directEvidenceCount: number;
  eligibilityReasons: string[];
  warnings: Array<
    | "underlying_evidence_unreviewed"
    | "underlying_evidence_needs_review"
    | "underlying_evidence_rejected"
    | "paper_not_finally_included"
    | "extraction_revision_superseded"
    | "extraction_revision_cleared"
  >;
};

export type SynthesisPreparationCandidateEvidence = {
  id: string;
  paperId: string;
  sourcePreview: string;
  sourceTruncated: boolean;
  pageNumber: number;
  note: string | null;
  noteTruncated: boolean;
  document: null | { id: string; originalFilename: string; originalFilenameTruncated: boolean };
  reviewState: EvidenceReviewState;
  curationWarning: "never_reviewed" | "needs_review" | "currently_rejected" | null;
  createdAt: Date;
  membershipId?: string;
  membershipOrder?: number;
};

export type SynthesisPreparationCandidateEvidencePage = {
  extractionRevisionId: string;
  items: SynthesisPreparationCandidateEvidence[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type SynthesisPreparationCandidateDetail = {
  candidate: SynthesisPreparationCandidate;
  header: SynthesisPreparationHeader;
};

export type SynthesisTargetStatementPage = {
  items: SynthesisTargetStatementOption[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

type RawRow = Record<string, unknown>;
type CandidateCursor = {
  v: 1;
  scope: "preparation-candidates";
  projectId: string;
  preparationId: string;
  compositionRevisionId: string;
  fieldId: string;
  pageSize: number;
  filter: SynthesisPreparationCandidateFilter;
  candidateSnapshotAt: string;
  candidateCount: number;
  afterMembershipOrder: number;
  afterNormalizedPaperTitle: string;
  afterPaperId: string;
  afterExtractionValueId: string;
  afterRevisionSequence: string;
  afterRevisionId: string;
};
type LedgerCursor = {
  v: 1;
  scope: "preparation-ledger";
  projectId: string;
  pageSize: number;
  afterCreatedAt: string;
  afterPreparationId: string;
};
type EvidenceCursor = {
  v: 1;
  scope: "connecting-evidence" | "direct-evidence";
  projectId: string;
  preparationId: string;
  extractionRevisionId: string;
  compositionRevisionId: string;
  pageSize: number;
  afterPosition?: number;
  afterMembershipId?: string;
  afterEvidenceId?: string;
  afterPageNumber?: number;
  afterCreatedAt?: string;
};
type TargetCursor = {
  v: 1;
  scope: "synthesis-targets";
  projectId: string;
  pageSize: number;
  query: string;
  afterCreatedAt: string;
  afterStatementId: string;
};
type AnyCursor = Record<string, unknown> & { v: number; scope: string; projectId: string };

const ISO_MICROSECONDS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_SQL_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

function rows(value: unknown): RawRow[] {
  return value as unknown as RawRow[];
}

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : dateValue(value);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function countValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DomainError("VALIDATION_ERROR", "The requested page count is outside the supported range");
  }
  return parsed;
}

function positiveInteger(value: number | string | undefined, defaultValue: number, maximum: number, label: string): number {
  if (value === undefined) return defaultValue;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new DomainError("VALIDATION_ERROR", `${label} must be a positive integer`);
  }
  return Math.min(parsed, maximum);
}

function encodeCursor(data: AnyCursor): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

function invalidCursor(scope: string): never {
  throw new DomainError("VALIDATION_ERROR", `This ${scope} page cursor is invalid. Return to the first page and continue from there.`);
}

function decodeCursor<T extends AnyCursor>(value: string | null | undefined, scope: T["scope"], projectId: string): T | null {
  if (!value) return null;
  if (value.length > 8_192 || !/^[A-Za-z0-9_-]+$/.test(value)) return invalidCursor(scope);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return invalidCursor(scope);
  }
  if (!parsed || typeof parsed !== "object") return invalidCursor(scope);
  const cursor = parsed as Partial<T>;
  if (cursor.v !== 1 || cursor.scope !== scope || cursor.projectId !== projectId) return invalidCursor(scope);
  return cursor as T;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function validUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_MICROSECONDS_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

function checkCandidateCursor(
  cursor: CandidateCursor | null,
  input: { projectId: string; preparationId: string; pageSize: number; filter: SynthesisPreparationCandidateFilter },
): CandidateCursor | null {
  if (!cursor) return null;
  if (cursor.preparationId !== input.preparationId
    || cursor.pageSize !== input.pageSize
    || cursor.filter !== input.filter
    || !validUuid(cursor.compositionRevisionId)
    || !validUuid(cursor.fieldId)
    || !Number.isSafeInteger(cursor.candidateCount)
    || cursor.candidateCount < 0
    || !validUtcTimestamp(cursor.candidateSnapshotAt)
    || !Number.isSafeInteger(cursor.afterMembershipOrder)
    || cursor.afterMembershipOrder < 1
    || typeof cursor.afterNormalizedPaperTitle !== "string"
    || Array.from(cursor.afterNormalizedPaperTitle).length > 4_096
    || !validUuid(cursor.afterPaperId)
    || !validUuid(cursor.afterExtractionValueId)
    || typeof cursor.afterRevisionSequence !== "string"
    || !/^\d+$/.test(cursor.afterRevisionSequence)
    || !validUuid(cursor.afterRevisionId)) return invalidCursor("Synthesis preparation candidate");
  return cursor;
}

function checkLedgerCursor(
  cursor: LedgerCursor | null,
  input: { pageSize: number },
): LedgerCursor | null {
  if (!cursor) return null;
  if (cursor.pageSize !== input.pageSize
    || !validUtcTimestamp(cursor.afterCreatedAt)
    || !validUuid(cursor.afterPreparationId)) return invalidCursor("Synthesis preparation ledger");
  return cursor;
}

function checkEvidenceCursor(
  cursor: EvidenceCursor | null,
  input: { preparationId: string; extractionRevisionId: string; pageSize: number; scope: EvidenceCursor["scope"] },
): EvidenceCursor | null {
  if (!cursor) return null;
  if (cursor.preparationId !== input.preparationId
    || cursor.extractionRevisionId !== input.extractionRevisionId
    || !validUuid(cursor.compositionRevisionId)
    || cursor.pageSize !== input.pageSize) return invalidCursor("Synthesis preparation Evidence");
  if (input.scope === "connecting-evidence") {
    if (!Number.isSafeInteger(cursor.afterPosition) || (cursor.afterPosition ?? 0) < 1
      || !validUuid(cursor.afterMembershipId) || !validUuid(cursor.afterEvidenceId)) return invalidCursor("Synthesis preparation Evidence");
  } else if (!Number.isSafeInteger(cursor.afterPageNumber) || (cursor.afterPageNumber ?? 0) < 1
    || !validUtcTimestamp(cursor.afterCreatedAt) || !validUuid(cursor.afterEvidenceId)) {
    return invalidCursor("Synthesis preparation Evidence");
  }
  return cursor;
}

function checkTargetCursor(
  cursor: TargetCursor | null,
  input: { query: string; pageSize: number },
): TargetCursor | null {
  if (!cursor) return null;
  if (cursor.query !== input.query
    || cursor.pageSize !== input.pageSize
    || !validUtcTimestamp(cursor.afterCreatedAt)
    || !validUuid(cursor.afterStatementId)) return invalidCursor("Synthesis target selector");
  return cursor;
}

function paperTitleKey(expression: SQL): SQL {
  // Preserve the legacy full-workspace sort expression exactly: internal
  // whitespace and the database's default collation are both significant.
  return sql`lower(trim(coalesce(${expression}, '')))`;
}

/** The recursive walk is evaluated in PostgreSQL against the exact pinned set_ordinal. */
function pinnedCompositionCtes(projectId: string, preparationId: string): SQL {
  return sql`
    with recursive prep_context as materialized (
      select p.id as preparation_id, p.project_id, p.evidence_set_id,
        p.evidence_set_composition_revision_id as pinned_revision_id,
        p.extraction_field_id, p.working_title, p.working_note,
        p.target_synthesis_statement_id, p.status, p.finalized_synthesis_revision_id,
        p.created_at as preparation_created_at, p.updated_at as preparation_updated_at,
        p.finalized_at as preparation_finalized_at, p.abandoned_at as preparation_abandoned_at,
        es.name as evidence_set_name, es.description as evidence_set_description,
        es.archived_at as evidence_set_archived_at,
        cr.sequence as pinned_composition_sequence, cr.set_ordinal as pinned_set_ordinal,
        cr.member_count as pinned_member_count, cr.distinct_paper_count as pinned_distinct_paper_count,
        cr.head_membership_id, cr.tail_membership_id,
        f.name as field_name, f.field_type, f.required as field_required,
        f.archived_at as field_archived_at
      from synthesis_preparations p
      join evidence_sets es on es.project_id=p.project_id and es.id=p.evidence_set_id
      join evidence_set_composition_revisions cr
        on cr.project_id=p.project_id and cr.evidence_set_id=p.evidence_set_id
       and cr.id=p.evidence_set_composition_revision_id
      join extraction_fields f on f.project_id=p.project_id and f.id=p.extraction_field_id
      where p.project_id=${projectId}::uuid and p.id=${preparationId}::uuid
    ), pinned_order_versions as materialized (
      select ov.project_id,ov.evidence_set_id,ov.membership_id,ov.next_membership_id
      from prep_context p
      join evidence_set_membership_order_versions ov
        on ov.project_id=p.project_id and ov.evidence_set_id=p.evidence_set_id
       and ov.valid_from_ordinal <= p.pinned_set_ordinal
       and (ov.valid_to_ordinal is null or p.pinned_set_ordinal < ov.valid_to_ordinal)
    ), pinned_order_shape as materialized (
      select p.preparation_id,p.pinned_member_count,p.head_membership_id,p.tail_membership_id,
        count(ov.membership_id)::integer as active_version_count,
        count(distinct ov.membership_id)::integer as active_member_count,
        count(ov.next_membership_id)::integer as active_link_count,
        count(distinct ov.next_membership_id)::integer as unique_active_link_count
      from prep_context p left join pinned_order_versions ov on true
      group by p.preparation_id,p.pinned_member_count,p.head_membership_id,p.tail_membership_id
    ), pinned_walk(membership_id, next_membership_id, position) as (
      select ov.membership_id, ov.next_membership_id, 1::integer
      from prep_context p
      join pinned_order_shape shape on shape.preparation_id=p.preparation_id
      join evidence_set_membership_order_versions ov
        on ov.project_id=p.project_id and ov.evidence_set_id=p.evidence_set_id
       and ov.membership_id=p.head_membership_id
       and ov.valid_from_ordinal <= p.pinned_set_ordinal
       and (ov.valid_to_ordinal is null or p.pinned_set_ordinal < ov.valid_to_ordinal)
      where p.pinned_member_count > 0
        and shape.active_version_count=p.pinned_member_count
        and shape.active_member_count=p.pinned_member_count
        and shape.active_link_count=shape.unique_active_link_count
      union all
      select next_version.membership_id, next_version.next_membership_id, walk.position + 1
      from pinned_walk walk
      join prep_context p on true
      join evidence_set_membership_order_versions next_version
        on next_version.project_id=p.project_id and next_version.evidence_set_id=p.evidence_set_id
       and next_version.membership_id=walk.next_membership_id
       and next_version.valid_from_ordinal <= p.pinned_set_ordinal
       and (next_version.valid_to_ordinal is null or p.pinned_set_ordinal < next_version.valid_to_ordinal)
      where walk.next_membership_id is not null and walk.position < p.pinned_member_count
    ), pinned_members as materialized (
      select walk.position, m.id as membership_id, m.evidence_id, e.paper_id
      from prep_context p
      join pinned_walk walk on true
      join evidence_set_memberships m
        on m.project_id=p.project_id and m.evidence_set_id=p.evidence_set_id and m.id=walk.membership_id
      join evidence e on e.project_id=m.project_id and e.id=m.evidence_id
    ), pinned_walk_summary as materialized (
      select p.preparation_id,
        count(walk.membership_id)::integer as walked_member_count,
        count(distinct walk.membership_id)::integer as unique_walked_member_count,
        (array_agg(walk.membership_id order by walk.position desc))[1] as terminal_membership_id,
        (array_agg(walk.next_membership_id order by walk.position desc))[1] as terminal_next_membership_id
      from prep_context p left join pinned_walk walk on true
      group by p.preparation_id
    ), pinned_members_summary as materialized (
      select p.preparation_id,count(pm.membership_id)::integer as joined_member_count,
        count(distinct pm.membership_id)::integer as unique_joined_member_count
      from prep_context p left join pinned_members pm on true
      group by p.preparation_id
    ), pinned_composition_validation as materialized (
      select p.preparation_id,
        case when p.pinned_member_count=0 then
          p.head_membership_id is null and p.tail_membership_id is null
          and shape.active_version_count=0 and shape.active_member_count=0
          and walk.walked_member_count=0 and joined.joined_member_count=0
        else
          p.head_membership_id is not null and p.tail_membership_id is not null
          and shape.active_version_count=p.pinned_member_count
          and shape.active_member_count=p.pinned_member_count
          and shape.active_link_count=shape.unique_active_link_count
          and walk.walked_member_count=p.pinned_member_count
          and walk.unique_walked_member_count=p.pinned_member_count
          and walk.terminal_membership_id=p.tail_membership_id
          and walk.terminal_next_membership_id is null
          and joined.joined_member_count=p.pinned_member_count
          and joined.unique_joined_member_count=p.pinned_member_count
        end as is_valid
      from prep_context p
      join pinned_order_shape shape on shape.preparation_id=p.preparation_id
      join pinned_walk_summary walk on walk.preparation_id=p.preparation_id
      join pinned_members_summary joined on joined.preparation_id=p.preparation_id
    ), reachable_revision_ids as materialized (
      select r.id as revision_id, r.project_id, r.paper_id, r.extraction_value_id, r.field_id,
        min(pm.position)::integer as min_membership_order
      from prep_context p
      join pinned_members pm on true
      join extraction_revision_evidence ere
        on ere.project_id=p.project_id and ere.paper_id=pm.paper_id and ere.evidence_id=pm.evidence_id
      join extraction_value_revisions r
        on r.project_id=ere.project_id and r.paper_id=ere.paper_id and r.id=ere.revision_id
       and r.field_id=p.extraction_field_id
      group by r.id,r.project_id,r.paper_id,r.extraction_value_id,r.field_id
    )
  `;
}

function candidateUniverseCtes(projectId: string, preparationId: string, snapshotAt: string | null, onlyRevisionId?: string): SQL {
  const snapshotExpression = snapshotAt === null ? sql`statement_timestamp()` : sql`${snapshotAt}::timestamptz`;
  const exactRevisionPredicate = onlyRevisionId === undefined ? sql`` : sql`and r.id=${onlyRevisionId}::uuid`;
  return sql`
    ${pinnedCompositionCtes(projectId, preparationId)},
    candidate_snapshot as materialized (
      select ${snapshotExpression} as candidate_snapshot_at
    ),
    candidate_revision_scope as materialized (
      select distinct r.id as revision_id, r.project_id, r.paper_id,
        reachable.min_membership_order
      from reachable_revision_ids reachable
      join extraction_value_revisions r
        on r.project_id=reachable.project_id and r.id=reachable.revision_id
      cross join candidate_snapshot snapshot
      where r.finalized_at is not null and r.finalized_at <= snapshot.candidate_snapshot_at
        ${exactRevisionPredicate}
    ),
    candidate_universe as materialized (
      select r.id as revision_id, r.sequence as revision_sequence,
        r.project_id, r.paper_id, r.extraction_value_id, r.field_id,
        r.finalized_at, r.value_state, p.title as paper_title,
        candidate.min_membership_order,
        ${paperTitleKey(sql`p.title`)} as paper_title_key,
        ta.decision as title_abstract_decision,
        ft.decision as full_text_decision,
        coalesce(retrieval.current_retrieval_outcome,'not_sought') as full_text_retrieval_state,
        coalesce(retrieval.has_retrieval_history,false) as has_retrieval_history,
        coalesce(retrieval.ever_retrieved,false) as ever_retrieved,
        true as has_analytical_history,
        coalesce((ta.decision='include' and ft.decision='include'), false) as is_finally_included,
        coalesce((ta.decision='include' and ft.decision='include') and r.value_state <> 'cleared', false) as selectable,
        exists (
          select 1 from synthesis_preparation_selections selected
          join prep_context prep on prep.project_id=selected.project_id and prep.preparation_id=selected.preparation_id
          where selected.extraction_revision_id=r.id
        ) as selected,
        not exists (
          select 1 from extraction_value_revisions newer
          where newer.project_id=r.project_id and newer.extraction_value_id=r.extraction_value_id
            and newer.finalized_at is not null and newer.sequence > r.sequence
        ) as is_current_extraction_revision
      from candidate_revision_scope candidate
      join extraction_value_revisions r
        on r.project_id=candidate.project_id and r.id=candidate.revision_id
      join papers p on p.project_id=r.project_id and p.id=r.paper_id
      -- Inline indexed Paper lookups here. A materialized fact CTE joined by
      -- project/paper has no key index and PostgreSQL can rescan all fact rows
      -- once per candidate revision despite a bounded LATERAL body.
      left join lateral (
        select d.decision
        from screening_decisions d
        where d.project_id=r.project_id and d.paper_id=r.paper_id and d.stage='title_abstract'
        order by d.sequence desc,d.id desc
        limit 1
      ) ta on true
      left join lateral (
        select d.decision
        from full_text_screening_decisions d
        where d.project_id=r.project_id and d.paper_id=r.paper_id
        order by d.sequence desc,d.id desc
        limit 1
      ) ft on true
      left join lateral (
        select (array_agg(a.outcome order by a.sequence desc,a.id desc))[1] as current_retrieval_outcome,
          true as has_retrieval_history,
          bool_or(a.outcome='retrieved') as ever_retrieved
        from full_text_retrieval_attempts a
        where a.project_id=r.project_id and a.paper_id=r.paper_id
        group by a.project_id,a.paper_id
      ) retrieval on true
    )
  `;
}

function exactReachableCandidateCtes(projectId: string, preparationId: string, revisionId: string): SQL {
  return sql`
    ${pinnedCompositionCtes(projectId, preparationId)},
    exact_candidate as materialized (
      select r.id as revision_id,r.project_id,r.paper_id,r.extraction_value_id,r.field_id,
        reachable.min_membership_order
      from reachable_revision_ids reachable
      join extraction_value_revisions r
        on r.project_id=reachable.project_id and r.id=reachable.revision_id
      where r.id=${revisionId}::uuid and r.finalized_at is not null
    )
  `;
}

function candidateDetailsAndWarningCtes(sourceName: "visible_page" | "exact_candidate"): SQL {
  const source = sourceName === "visible_page" ? sql.raw("visible_page") : sql.raw("exact_candidate");
  return sql`
    candidate_details as materialized (
      select source.revision_id, source.paper_title_key,
        source.paper_id, source.project_id, source.min_membership_order,
        source.revision_sequence, source.extraction_value_id,
        source.finalized_at, source.value_state, source.is_finally_included, source.selectable,
        source.is_current_extraction_revision, source.selected,
        source.title_abstract_decision, source.full_text_decision,
        source.full_text_retrieval_state, source.has_retrieval_history,
        source.ever_retrieved, source.has_analytical_history,
        r.field_type,
        left(r.text_value, ${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.candidateValue}) as text_value,
        r.number_value, r.boolean_value, r.option_id,
        left(o.label, ${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.candidateOption}) as option_label,
        left(source.paper_title, ${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.candidatePaperTitle}) as paper_title
      from ${source} source
      join extraction_value_revisions r on r.project_id=source.project_id and r.id=source.revision_id
      left join extraction_options o on o.project_id=r.project_id and o.field_id=r.field_id and o.id=r.option_id
    ),
    candidate_evidence_refs as materialized (
      select distinct source.revision_id, ere.evidence_id
      from ${source} source
      join pinned_members pm on pm.paper_id=source.paper_id
      join extraction_revision_evidence ere
        on ere.project_id=source.project_id and ere.paper_id=source.paper_id
       and ere.revision_id=source.revision_id and ere.evidence_id=pm.evidence_id
    ),
    candidate_direct_evidence_counts as materialized (
      select source.revision_id,count(distinct ere.evidence_id)::text as direct_evidence_count
      from ${source} source
      join extraction_revision_evidence ere
        on ere.project_id=source.project_id and ere.paper_id=source.paper_id and ere.revision_id=source.revision_id
      group by source.revision_id
    ),
    candidate_evidence_flags as (
      select refs.revision_id,count(*)::text as connecting_evidence_count,
        bool_or(coalesce(latest.decision,'unreviewed')='unreviewed') as has_unreviewed_evidence,
        bool_or(latest.decision='needs_review') as has_needs_review_evidence,
        bool_or(latest.decision='rejected') as has_rejected_evidence
      from candidate_evidence_refs refs
      left join lateral (
        select decision from evidence_review_decisions d
        where d.project_id=(select project_id from prep_context limit 1)
          and d.evidence_id=refs.evidence_id
        order by d.sequence desc,d.id desc limit 1
      ) latest on true
      group by refs.revision_id
    )
  `;
}

function candidateValue(row: RawRow): string | null {
  const state = String(row.value_state);
  if (state !== "present") return state.replaceAll("_", " ");
  if (row.text_value != null) return String(row.text_value).slice(0, SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.candidateValue);
  if (row.number_value != null) return String(row.number_value).slice(0, SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.candidateValue);
  if (row.boolean_value != null) return Boolean(row.boolean_value) ? "Yes" : "No";
  if (row.option_label != null) return String(row.option_label).slice(0, SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.candidateOption);
  return row.option_id == null ? null : "Selected option";
}

function candidateFromRow(row: RawRow): SynthesisPreparationCandidate {
  const included = Boolean(row.is_finally_included);
  const valueState = String(row.value_state) as SynthesisPreparationCandidate["valueState"];
  const selectable = Boolean(row.selectable);
  const eligibilityReasons: string[] = [];
  if (!included) eligibilityReasons.push("Paper is not currently finally included");
  if (valueState === "cleared") eligibilityReasons.push("Extraction value is cleared");
  const warnings: SynthesisPreparationCandidate["warnings"] = [];
  if (Boolean(row.has_unreviewed_evidence)) warnings.push("underlying_evidence_unreviewed");
  if (Boolean(row.has_needs_review_evidence)) warnings.push("underlying_evidence_needs_review");
  if (Boolean(row.has_rejected_evidence)) warnings.push("underlying_evidence_rejected");
  if (!included) warnings.push("paper_not_finally_included");
  if (!Boolean(row.is_current_extraction_revision)) warnings.push("extraction_revision_superseded");
  if (valueState === "cleared") warnings.push("extraction_revision_cleared");
  return {
    extractionRevisionId: String(row.revision_id),
    extractionValueId: String(row.extraction_value_id),
    sequence: Number(row.revision_sequence),
    finalizedAt: dateValue(row.finalized_at),
    fieldType: String(row.field_type) as ExtractionFieldType,
    valueState,
    value: candidateValue(row),
    optionId: nullableString(row.option_id),
    optionLabel: row.option_label == null ? null : String(row.option_label).slice(0, SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.candidateOption),
    paper: { id: String(row.paper_id), title: String(row.paper_title ?? "").slice(0, SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.candidatePaperTitle) },
    isFinallyIncluded: included,
    isCurrentExtractionRevision: Boolean(row.is_current_extraction_revision),
    selected: Boolean(row.selected),
    selectable,
    membershipOrder: Number(row.min_membership_order),
    connectingEvidenceCount: countValue(row.connecting_evidence_count),
    directEvidenceCount: countValue(row.direct_evidence_count),
    eligibilityReasons,
    warnings,
  };
}

function evidenceReviewState(value: unknown): EvidenceReviewState {
  return value === "accepted" || value === "needs_review" || value === "rejected" ? value : "unreviewed";
}

function evidenceFromRow(row: RawRow): SynthesisPreparationCandidateEvidence {
  const reviewState = evidenceReviewState(row.curation_state);
  return {
    id: String(row.evidence_id),
    paperId: String(row.paper_id),
    sourcePreview: String(row.source_preview ?? "").slice(0, SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.evidenceSource),
    sourceTruncated: Boolean(row.source_truncated),
    pageNumber: Number(row.page_number),
    note: row.evidence_note == null ? null : String(row.evidence_note).slice(0, SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.evidenceNote),
    noteTruncated: Boolean(row.note_truncated),
    document: row.document_id == null ? null : {
      id: String(row.document_id),
      originalFilename: String(row.document_original_filename ?? "").slice(0, SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.evidenceFilename),
      originalFilenameTruncated: Boolean(row.filename_truncated),
    },
    reviewState,
    curationWarning: reviewState === "unreviewed" ? "never_reviewed"
      : reviewState === "needs_review" ? "needs_review"
        : reviewState === "rejected" ? "currently_rejected" : null,
    createdAt: dateValue(row.evidence_created_at),
    ...(row.membership_id == null ? {} : {
      membershipId: String(row.membership_id),
      membershipOrder: Number(row.membership_order),
    }),
  };
}

function readOnly<T>(db: Database, operation: (tx: Pick<Database, "execute">) => Promise<T>): Promise<T> {
  return db.transaction((tx) => operation(tx), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

export type SynthesisPreparationLedgerPage = {
  items: Array<{
    id: string;
    status: "active" | "finalized" | "abandoned";
    evidenceSetId: string;
    evidenceSetName: string;
    evidenceSetNameTruncated: boolean;
    evidenceSetArchivedAt: Date | null;
    pinnedCompositionRevisionId: string;
    pinnedCompositionSequence: number;
    pinnedCompositionSetOrdinal: string;
    sourceSetChanged: boolean;
    extractionFieldId: string;
    extractionFieldName: string;
    extractionFieldNameTruncated: boolean;
    extractionFieldType: ExtractionFieldType;
    workingTitlePreview: string | null;
    workingNotePreview: string | null;
    workingTitleTruncated: boolean;
    workingNoteTruncated: boolean;
    targetSynthesisStatementId: string | null;
    targetSynthesisStatementTitle: string | null;
    targetSynthesisStatementTitleTruncated: boolean;
    targetSynthesisCurrentRevisionId: string | null;
    targetSynthesisCurrentRevisionState: "active" | "withdrawn" | null;
    finalizedSynthesisRevisionId: string | null;
    selectedCount: number;
    createdAt: Date;
    updatedAt: Date;
    finalizedAt: Date | null;
    abandonedAt: Date | null;
  }>;
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type SynthesisPreparationHeader = {
  preparation: {
    id: string;
    projectId: string;
    evidenceSetId: string;
    pinnedCompositionRevisionId: string;
    extractionFieldId: string;
    workingTitle: string | null;
    workingNote: string | null;
    targetSynthesisStatementId: string | null;
    status: "active" | "finalized" | "abandoned";
    finalizedSynthesisRevisionId: string | null;
    createdAt: Date;
    updatedAt: Date;
    finalizedAt: Date | null;
    abandonedAt: Date | null;
  };
  evidenceSet: { id: string; name: string; description: string | null; archivedAt: Date | null };
  pinnedComposition: { id: string; sequence: number; setOrdinal: string; memberCount: number; distinctPaperCount: number };
  latestComposition: null | { id: string; sequence: number; setOrdinal: string };
  sourceSetChanged: boolean;
  field: { id: string; name: string; fieldType: ExtractionFieldType; required: boolean; archivedAt: Date | null };
  targetStatement: null | {
    id: string;
    createdAt: Date;
    currentRevision: null | { id: string; sequence: number; state: "active" | "withdrawn"; title: string | null };
  };
  finalizedRevision: null | {
    id: string;
    sequence: number;
    state: "active" | "withdrawn";
    title: string | null;
    finalizedAt: Date | null;
  };
  selectedCount: number;
};

export type SynthesisTargetStatementOption = {
  id: string;
  createdAt: Date;
  currentRevision: null | {
    id: string;
    sequence: number;
    state: "active" | "withdrawn";
    title: string | null;
    statementPreview: string | null;
  };
};

function preparationStatus(value: unknown): "active" | "finalized" | "abandoned" {
  return value === "finalized" || value === "abandoned" ? value : "active";
}

function synthesisRevisionState(value: unknown): "active" | "withdrawn" | null {
  return value === "active" || value === "withdrawn" ? value : null;
}

function synthesisPreparationHeaderFromRow(row: RawRow, prefix = ""): SynthesisPreparationHeader {
  const value = (name: string) => row[`${prefix}${name}`];
  const targetStatementId = nullableString(value("target_synthesis_statement_id"));
  const finalizedRevision = value("finalized_revision_id") == null ? null : {
    id: String(value("finalized_revision_id")),
    sequence: Number(value("finalized_sequence")),
    state: synthesisRevisionState(value("finalized_state")) ?? "active",
    title: nullableString(value("finalized_title")),
    finalizedAt: nullableDate(value("finalized_revision_at")),
  };
  return {
    preparation: {
      id: String(value("preparation_id")),
      projectId: String(value("project_id")),
      evidenceSetId: String(value("evidence_set_id")),
      pinnedCompositionRevisionId: String(value("pinned_revision_id")),
      extractionFieldId: String(value("extraction_field_id")),
      workingTitle: nullableString(value("working_title")),
      workingNote: nullableString(value("working_note")),
      targetSynthesisStatementId: targetStatementId,
      status: preparationStatus(value("status")),
      finalizedSynthesisRevisionId: nullableString(value("finalized_synthesis_revision_id")),
      createdAt: dateValue(value("created_at")),
      updatedAt: dateValue(value("updated_at")),
      finalizedAt: nullableDate(value("finalized_at")),
      abandonedAt: nullableDate(value("abandoned_at")),
    },
    evidenceSet: {
      id: String(value("evidence_set_id")),
      name: String(value("evidence_set_name")),
      description: nullableString(value("evidence_set_description")),
      archivedAt: nullableDate(value("evidence_set_archived_at")),
    },
    pinnedComposition: {
      id: String(value("pinned_revision_id")),
      sequence: Number(value("pinned_sequence")),
      setOrdinal: String(value("pinned_set_ordinal")),
      memberCount: Number(value("pinned_member_count")),
      distinctPaperCount: Number(value("pinned_distinct_paper_count")),
    },
    latestComposition: value("latest_revision_id") == null ? null : {
      id: String(value("latest_revision_id")),
      sequence: Number(value("latest_sequence")),
      setOrdinal: String(value("latest_set_ordinal")),
    },
    sourceSetChanged: Boolean(value("source_set_changed")),
    field: {
      id: String(value("extraction_field_id")),
      name: String(value("field_name")),
      fieldType: String(value("field_type")) as ExtractionFieldType,
      required: Boolean(value("field_required")),
      archivedAt: nullableDate(value("field_archived_at")),
    },
    targetStatement: targetStatementId == null ? null : {
      id: targetStatementId,
      createdAt: dateValue(value("target_created_at")),
      currentRevision: value("target_current_revision_id") == null ? null : {
        id: String(value("target_current_revision_id")),
        sequence: Number(value("target_current_sequence")),
        state: synthesisRevisionState(value("target_current_state")) ?? "active",
        title: nullableString(value("target_current_title")),
      },
    },
    finalizedRevision,
    selectedCount: countValue(value("selected_count")),
  };
}

function candidateFilter(value: unknown): SynthesisPreparationCandidateFilter {
  if (value === undefined || value === "all") return "all";
  if (value === "selected" || value === "selectable" || value === "ineligible") return value;
  throw new DomainError("VALIDATION_ERROR", "Candidate filter must be all, selected, selectable, or ineligible");
}

function normalizeTargetQuery(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new DomainError("VALIDATION_ERROR", "Target search query must be text");
  const normalized = value.normalize("NFC").trim().replace(/[\s\uFEFF]+/gu, " ");
  if (Array.from(normalized).length > 200) {
    throw new DomainError("VALIDATION_ERROR", "Target search query must be at most 200 code points");
  }
  return normalized;
}

function candidateFilterSql(filter: SynthesisPreparationCandidateFilter): SQL {
  if (filter === "selected") return sql`candidate.selected`;
  if (filter === "selectable") return sql`candidate.selectable`;
  if (filter === "ineligible") return sql`not candidate.selectable`;
  return sql`true`;
}

function candidateAfterPredicate(cursor: CandidateCursor | null): SQL {
  if (!cursor) return sql`true`;
  return sql`row(candidate.min_membership_order,candidate.paper_title_key,candidate.paper_id,candidate.extraction_value_id,candidate.revision_sequence,candidate.revision_id) > row(
    ${cursor.afterMembershipOrder}::integer,
    ${cursor.afterNormalizedPaperTitle}::text,
    ${cursor.afterPaperId}::uuid,
    ${cursor.afterExtractionValueId}::uuid,
    ${cursor.afterRevisionSequence}::bigint,
    ${cursor.afterRevisionId}::uuid
  )`;
}

function candidateDetailRow(row: RawRow): SynthesisPreparationCandidate {
  return candidateFromRow(row);
}

function candidateNextCursor(
  row: RawRow,
  input: { projectId: string; preparationId: string; compositionRevisionId: string; fieldId: string; pageSize: number; filter: SynthesisPreparationCandidateFilter; candidateSnapshotAt: string; candidateCount: number },
): string {
  return encodeCursor({
    v: 1,
    scope: "preparation-candidates",
    projectId: input.projectId,
    preparationId: input.preparationId,
    compositionRevisionId: input.compositionRevisionId,
    fieldId: input.fieldId,
    pageSize: input.pageSize,
    filter: input.filter,
    candidateSnapshotAt: input.candidateSnapshotAt,
    candidateCount: input.candidateCount,
    afterMembershipOrder: Number(row.min_membership_order),
    afterNormalizedPaperTitle: String(row.paper_title_key),
    afterPaperId: String(row.paper_id),
    afterExtractionValueId: String(row.extraction_value_id),
    afterRevisionSequence: String(row.revision_sequence),
    afterRevisionId: String(row.revision_id),
  });
}

export function createSynthesisPreparationReadServices(db: Database) {
  async function listSynthesisPreparationLedger(
    projectId: string,
    input: SynthesisPreparationCursorPageInput = {},
  ): Promise<SynthesisPreparationLedgerPage> {
    ensureId(projectId);
    const pageSize = positiveInteger(input.pageSize, SYNTHESIS_PREPARATION_LEDGER_DEFAULT_PAGE_SIZE, SYNTHESIS_PREPARATION_LEDGER_MAX_PAGE_SIZE, "Page size");
    const cursor = checkLedgerCursor(decodeCursor<LedgerCursor>(input.cursor, "preparation-ledger", projectId), { pageSize });
    const after = cursor === null ? sql`true` : sql`(p.created_at,p.id) < (${cursor.afterCreatedAt}::timestamptz,${cursor.afterPreparationId}::uuid)`;
    const result = await readOnly(db, async (tx) => {
      const projectExists = rows(await tx.execute(sql`select 1 from projects where id=${projectId}::uuid limit 1`)).length > 0;
      if (!projectExists) throw new DomainError("PROJECT_NOT_FOUND", "Project was not found");
      return tx.execute(sql`
      with page_candidates as materialized (
        select p.id as preparation_id,p.project_id,p.evidence_set_id,
          left(es.name,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerSetLabel}) as evidence_set_name,
          (char_length(es.name)>${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerSetLabel}) as evidence_set_name_truncated,
          es.archived_at as evidence_set_archived_at,
          p.evidence_set_composition_revision_id as pinned_revision_id,
          pinned.sequence as pinned_sequence,pinned.set_ordinal as pinned_set_ordinal,
          p.extraction_field_id,left(f.name,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerFieldLabel}) as field_name,
          (char_length(f.name)>${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerFieldLabel}) as field_name_truncated,f.field_type,
          left(p.working_title,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerTitlePreview}) as working_title,
          (p.working_title is not null and char_length(p.working_title)>${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerTitlePreview}) as working_title_truncated,
          left(p.working_note,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerNotePreview}) as working_note,
          (p.working_note is not null and char_length(p.working_note)>${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerNotePreview}) as working_note_truncated,
          p.target_synthesis_statement_id,p.status,
          p.finalized_synthesis_revision_id,p.created_at,p.updated_at,p.finalized_at,p.abandoned_at,
          target.created_at as target_created_at,
          target_revision.id as target_revision_id,target_revision.state as target_revision_state,
          left(target_revision.title,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerTargetLabel}) as target_revision_title,
          (target_revision.title is not null and char_length(target_revision.title)>${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerTargetLabel}) as target_revision_title_truncated,
          to_char(p.created_at at time zone 'UTC',${UTC_SQL_FORMAT}) as cursor_created_at
        from synthesis_preparations p
        join evidence_sets es on es.project_id=p.project_id and es.id=p.evidence_set_id
        join evidence_set_composition_revisions pinned
          on pinned.project_id=p.project_id and pinned.evidence_set_id=p.evidence_set_id
         and pinned.id=p.evidence_set_composition_revision_id
        join extraction_fields f on f.project_id=p.project_id and f.id=p.extraction_field_id
        left join synthesis_statements target
          on target.project_id=p.project_id and target.id=p.target_synthesis_statement_id
        left join lateral (
          select r.id,r.sequence,r.state,r.title
          from synthesis_revisions r
          where r.project_id=p.project_id and r.synthesis_statement_id=p.target_synthesis_statement_id and r.finalized_at is not null
          order by r.sequence desc,r.id desc limit 1
        ) target_revision on true
        where p.project_id=${projectId}::uuid
          and ${after}
        order by p.created_at desc,p.id desc
        limit ${pageSize + 1}
      ), visible_page as materialized (
        select * from page_candidates order by created_at desc,preparation_id desc limit ${pageSize}
      ), page_meta as (
        select (select count(*) > ${pageSize} from page_candidates) as has_more
      ), selected_counts as (
        select s.preparation_id,count(*)::bigint as selected_count
        from synthesis_preparation_selections s
        join visible_page visible on visible.project_id=s.project_id and visible.preparation_id=s.preparation_id
        group by s.preparation_id
      )
      select page_meta.has_more,visible.*,
        coalesce(selected_counts.selected_count,0)::text as selected_count,
        coalesce(latest_composition.set_ordinal > visible.pinned_set_ordinal,false) as source_set_changed
      from page_meta left join visible_page visible on true
      left join selected_counts on selected_counts.preparation_id=visible.preparation_id
      left join lateral (
        select current_composition.set_ordinal
        from evidence_set_composition_revisions current_composition
        where current_composition.project_id=visible.project_id
          and current_composition.evidence_set_id=visible.evidence_set_id
        order by current_composition.set_ordinal desc,current_composition.id desc
        limit 1
      ) latest_composition on true
      order by visible.created_at desc,visible.preparation_id desc
      `);
    });
    const resultRows = rows(result);
    const items = resultRows.flatMap((row) => row.preparation_id == null ? [] : [{
      id: String(row.preparation_id),
      status: preparationStatus(row.status),
      evidenceSetId: String(row.evidence_set_id),
      evidenceSetName: String(row.evidence_set_name),
      evidenceSetNameTruncated: Boolean(row.evidence_set_name_truncated),
      evidenceSetArchivedAt: nullableDate(row.evidence_set_archived_at),
      pinnedCompositionRevisionId: String(row.pinned_revision_id),
      pinnedCompositionSequence: Number(row.pinned_sequence),
      pinnedCompositionSetOrdinal: String(row.pinned_set_ordinal),
      sourceSetChanged: Boolean(row.source_set_changed),
      extractionFieldId: String(row.extraction_field_id),
      extractionFieldName: String(row.field_name),
      extractionFieldNameTruncated: Boolean(row.field_name_truncated),
      extractionFieldType: String(row.field_type) as ExtractionFieldType,
      workingTitlePreview: row.working_title == null ? null : String(row.working_title).slice(0, SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerTitlePreview),
      workingNotePreview: row.working_note == null ? null : String(row.working_note).slice(0, SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerNotePreview),
      workingTitleTruncated: Boolean(row.working_title_truncated),
      workingNoteTruncated: Boolean(row.working_note_truncated),
      targetSynthesisStatementId: nullableString(row.target_synthesis_statement_id),
      targetSynthesisStatementTitle: row.target_revision_title == null ? null : String(row.target_revision_title).slice(0, SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.ledgerTargetLabel),
      targetSynthesisStatementTitleTruncated: Boolean(row.target_revision_title_truncated),
      targetSynthesisCurrentRevisionId: nullableString(row.target_revision_id),
      targetSynthesisCurrentRevisionState: synthesisRevisionState(row.target_revision_state),
      finalizedSynthesisRevisionId: nullableString(row.finalized_synthesis_revision_id),
      selectedCount: countValue(row.selected_count),
      createdAt: dateValue(row.created_at),
      updatedAt: dateValue(row.updated_at),
      finalizedAt: nullableDate(row.finalized_at),
      abandonedAt: nullableDate(row.abandoned_at),
    }]);
    const hasMore = Boolean(resultRows[0]?.has_more);
    const last = resultRows.findLast((row) => row.preparation_id != null);
    const nextCursor = hasMore && last
      ? encodeCursor({
          v: 1,
          scope: "preparation-ledger",
          projectId,
          pageSize,
          afterCreatedAt: String(last.cursor_created_at),
          afterPreparationId: String(last.preparation_id),
        })
      : null;
    return { items, pageSize, hasMore, nextCursor };
  }

  async function getSynthesisPreparationHeader(projectId: string, preparationId: string): Promise<SynthesisPreparationHeader> {
    ensureId(projectId);
    ensureId(preparationId);
    const result = await readOnly(db, (tx) => tx.execute(sql`
      select p.id as preparation_id,p.project_id,p.evidence_set_id,
        p.evidence_set_composition_revision_id as pinned_revision_id,p.extraction_field_id,
        p.working_title,p.working_note,p.target_synthesis_statement_id,p.status,
        p.finalized_synthesis_revision_id,p.created_at,p.updated_at,p.finalized_at,p.abandoned_at,
        es.name as evidence_set_name,es.description as evidence_set_description,es.archived_at as evidence_set_archived_at,
        pinned.sequence as pinned_sequence,pinned.set_ordinal::text as pinned_set_ordinal,
        pinned.member_count as pinned_member_count,pinned.distinct_paper_count as pinned_distinct_paper_count,
        latest.id as latest_revision_id,latest.sequence as latest_sequence,latest.set_ordinal::text as latest_set_ordinal,
        f.name as field_name,f.field_type,f.required as field_required,f.archived_at as field_archived_at,
        target.created_at as target_created_at,
        target_current.id as target_current_revision_id,target_current.sequence as target_current_sequence,
        target_current.state as target_current_state,target_current.title as target_current_title,
        finalized.id as finalized_revision_id,finalized.sequence as finalized_sequence,
        finalized.state as finalized_state,finalized.title as finalized_title,finalized.finalized_at as finalized_revision_at,
        (select count(*)::text from synthesis_preparation_selections selected
         where selected.project_id=p.project_id and selected.preparation_id=p.id) as selected_count,
        coalesce(latest.set_ordinal > pinned.set_ordinal,false) as source_set_changed
      from synthesis_preparations p
      join evidence_sets es on es.project_id=p.project_id and es.id=p.evidence_set_id
      join evidence_set_composition_revisions pinned
        on pinned.project_id=p.project_id and pinned.evidence_set_id=p.evidence_set_id
       and pinned.id=p.evidence_set_composition_revision_id
      join extraction_fields f on f.project_id=p.project_id and f.id=p.extraction_field_id
      left join lateral (
        select current_revision.id,current_revision.sequence,current_revision.set_ordinal
        from evidence_set_composition_revisions current_revision
        where current_revision.project_id=p.project_id and current_revision.evidence_set_id=p.evidence_set_id
        order by current_revision.set_ordinal desc,current_revision.id desc limit 1
      ) latest on true
      left join synthesis_statements target
        on target.project_id=p.project_id and target.id=p.target_synthesis_statement_id
      left join lateral (
        select r.id,r.sequence,r.state,r.title
        from synthesis_revisions r
        where r.project_id=p.project_id and r.synthesis_statement_id=p.target_synthesis_statement_id and r.finalized_at is not null
        order by r.sequence desc,r.id desc limit 1
      ) target_current on true
      left join synthesis_revisions finalized
        on finalized.project_id=p.project_id and finalized.synthesis_statement_id=p.target_synthesis_statement_id
       and finalized.id=p.finalized_synthesis_revision_id
      where p.project_id=${projectId}::uuid and p.id=${preparationId}::uuid
      limit 1
    `));
    const row = rows(result)[0];
    if (!row) throw new DomainError("NOT_FOUND", "Synthesis preparation was not found");
    return synthesisPreparationHeaderFromRow(row);
  }

  async function listSynthesisPreparationCandidates(
    projectId: string,
    preparationId: string,
    input: SynthesisPreparationCursorPageInput & { filter?: SynthesisPreparationCandidateFilter } = {},
  ) {
    ensureId(projectId);
    ensureId(preparationId);
    const pageSize = positiveInteger(input.pageSize, SYNTHESIS_PREPARATION_CANDIDATE_DEFAULT_PAGE_SIZE, SYNTHESIS_PREPARATION_CANDIDATE_MAX_PAGE_SIZE, "Page size");
    const filter = candidateFilter(input.filter);
    const cursor = checkCandidateCursor(decodeCursor<CandidateCursor>(input.cursor, "preparation-candidates", projectId), {
      projectId, preparationId, pageSize, filter,
    });
    const filterSql = candidateFilterSql(filter);
    const afterSql = candidateAfterPredicate(cursor);
    const result = await readOnly(db, (tx) => tx.execute(sql`
      ${candidateUniverseCtes(projectId, preparationId, cursor?.candidateSnapshotAt ?? null)},
      filtered_candidates as materialized (
        select candidate.* from candidate_universe candidate where ${filterSql}
      ),
      page_candidates as materialized (
        select candidate.* from filtered_candidates candidate
        where ${afterSql}
        order by candidate.min_membership_order asc,candidate.paper_title_key asc,
          candidate.paper_id asc,candidate.extraction_value_id asc,candidate.revision_sequence asc,candidate.revision_id asc
        limit ${pageSize + 1}
      ),
      visible_page as materialized (
        select * from page_candidates
        order by min_membership_order asc,paper_title_key asc,
          paper_id asc,extraction_value_id asc,revision_sequence asc,revision_id asc
        limit ${pageSize}
      ),
      page_metadata as (
        select exists(select 1 from prep_context) as preparation_exists,
          (select is_valid from pinned_composition_validation limit 1) as pinned_composition_valid,
          (select pinned_revision_id from prep_context limit 1) as pinned_revision_id,
          (select extraction_field_id from prep_context limit 1) as field_id,
          to_char((select candidate_snapshot_at from candidate_snapshot) at time zone 'UTC',${UTC_SQL_FORMAT}) as candidate_snapshot_at,
          case when ${cursor === null} then (select count(*)::text from candidate_universe) else ${cursor?.candidateCount ?? 0}::text end as candidate_count,
          (select count(*) > ${pageSize} from page_candidates) as has_more,
          (${cursor === null} or exists (
            select 1 from candidate_universe boundary
            where boundary.revision_id=${cursor?.afterRevisionId ?? null}::uuid
              and boundary.paper_id=${cursor?.afterPaperId ?? null}::uuid
              and boundary.min_membership_order=${cursor?.afterMembershipOrder ?? null}::integer
              and boundary.paper_title_key = ${cursor?.afterNormalizedPaperTitle ?? null}::text
              and boundary.extraction_value_id=${cursor?.afterExtractionValueId ?? null}::uuid
              and boundary.revision_sequence=${cursor?.afterRevisionSequence ?? null}::bigint
          )) as cursor_boundary_valid
      ),
      ${candidateDetailsAndWarningCtes("visible_page")}
      select page_metadata.*,details.*,
        coalesce(flags.connecting_evidence_count,'0') as connecting_evidence_count,
        coalesce(direct_counts.direct_evidence_count,'0') as direct_evidence_count,
        coalesce(flags.has_unreviewed_evidence,false) as has_unreviewed_evidence,
        coalesce(flags.has_needs_review_evidence,false) as has_needs_review_evidence,
        coalesce(flags.has_rejected_evidence,false) as has_rejected_evidence
      from page_metadata
      left join candidate_details details on true
      left join candidate_evidence_flags flags on flags.revision_id=details.revision_id
      left join candidate_direct_evidence_counts direct_counts on direct_counts.revision_id=details.revision_id
      order by details.min_membership_order asc,details.paper_title_key asc,
        details.paper_id asc,details.extraction_value_id asc,details.revision_sequence asc,details.revision_id asc
    `));
    const resultRows = rows(result);
    const meta = resultRows[0];
    if (!meta?.preparation_exists) throw new DomainError("NOT_FOUND", "Synthesis preparation was not found");
    if (!Boolean(meta.pinned_composition_valid)) throw new DomainError("DATABASE_CONSTRAINT", "Pinned Evidence Set composition is corrupt and cannot be used for candidate reads");
    if (cursor && (String(meta.pinned_revision_id).toLowerCase() !== cursor.compositionRevisionId.toLowerCase()
      || String(meta.field_id).toLowerCase() !== cursor.fieldId.toLowerCase())) return invalidCursor("Synthesis preparation candidate");
    if (!Boolean(meta.cursor_boundary_valid)) return invalidCursor("Synthesis preparation candidate");
    const candidateSnapshotAt = String(meta.candidate_snapshot_at);
    const candidateCount = countValue(meta.candidate_count);
    const items = resultRows.flatMap((row) => row.revision_id == null ? [] : [candidateDetailRow(row)]);
    const hasMore = Boolean(meta.has_more);
    const lastRaw = resultRows.findLast((row) => row.revision_id != null);
    const nextCursor = hasMore && lastRaw
      ? candidateNextCursor(lastRaw, {
          projectId,
          preparationId,
          compositionRevisionId: String(meta.pinned_revision_id),
          fieldId: String(meta.field_id),
          pageSize,
          filter,
          candidateSnapshotAt,
          candidateCount,
        })
      : null;
    return { items, filter, pageSize, candidateSnapshotAt, candidateCount, hasMore, nextCursor };
  }

  async function getSynthesisPreparationCandidate(
    projectId: string,
    preparationId: string,
    extractionRevisionId: string,
  ): Promise<SynthesisPreparationCandidateDetail> {
    ensureId(projectId);
    ensureId(preparationId);
    ensureId(extractionRevisionId);
    const result = await readOnly(db, (tx) => tx.execute(sql`
      ${candidateUniverseCtes(projectId, preparationId, null, extractionRevisionId)},
      exact_candidate as materialized (
        select candidate.* from candidate_universe candidate
        where candidate.revision_id=${extractionRevisionId}::uuid
      ),
      ${candidateDetailsAndWarningCtes("exact_candidate")}
      , candidate_header as materialized (
        select p.preparation_id as header_preparation_id,p.project_id as header_project_id,
          p.evidence_set_id as header_evidence_set_id,p.pinned_revision_id as header_pinned_revision_id,
          p.extraction_field_id as header_extraction_field_id,p.working_title as header_working_title,
          p.working_note as header_working_note,p.target_synthesis_statement_id as header_target_synthesis_statement_id,
          p.status as header_status,p.finalized_synthesis_revision_id as header_finalized_synthesis_revision_id,
          p.preparation_created_at as header_created_at,p.preparation_updated_at as header_updated_at,
          p.preparation_finalized_at as header_finalized_at,p.preparation_abandoned_at as header_abandoned_at,
          p.evidence_set_name as header_evidence_set_name,p.evidence_set_description as header_evidence_set_description,
          p.evidence_set_archived_at as header_evidence_set_archived_at,
          p.pinned_composition_sequence as header_pinned_sequence,p.pinned_set_ordinal::text as header_pinned_set_ordinal,
          p.pinned_member_count as header_pinned_member_count,
          p.pinned_distinct_paper_count as header_pinned_distinct_paper_count,
          latest.id as header_latest_revision_id,latest.sequence as header_latest_sequence,
          latest.set_ordinal::text as header_latest_set_ordinal,
          p.field_name as header_field_name,p.field_type as header_field_type,
          p.field_required as header_field_required,p.field_archived_at as header_field_archived_at,
          target.created_at as header_target_created_at,
          target_current.id as header_target_current_revision_id,
          target_current.sequence as header_target_current_sequence,
          target_current.state as header_target_current_state,
          target_current.title as header_target_current_title,
          finalized.id as header_finalized_revision_id,finalized.sequence as header_finalized_sequence,
          finalized.state as header_finalized_state,finalized.title as header_finalized_title,
          finalized.finalized_at as header_finalized_revision_at,
          (select count(*)::text from synthesis_preparation_selections selected
           where selected.project_id=p.project_id and selected.preparation_id=p.preparation_id) as header_selected_count,
          coalesce(latest.set_ordinal > p.pinned_set_ordinal,false) as header_source_set_changed
        from prep_context p
        left join lateral (
          select current_revision.id,current_revision.sequence,current_revision.set_ordinal
          from evidence_set_composition_revisions current_revision
          where current_revision.project_id=p.project_id and current_revision.evidence_set_id=p.evidence_set_id
          order by current_revision.set_ordinal desc,current_revision.id desc limit 1
        ) latest on true
        left join synthesis_statements target
          on target.project_id=p.project_id and target.id=p.target_synthesis_statement_id
        left join lateral (
          select r.id,r.sequence,r.state,r.title
          from synthesis_revisions r
          where r.project_id=p.project_id and r.synthesis_statement_id=p.target_synthesis_statement_id and r.finalized_at is not null
          order by r.sequence desc,r.id desc limit 1
        ) target_current on true
        left join synthesis_revisions finalized
          on finalized.project_id=p.project_id and finalized.synthesis_statement_id=p.target_synthesis_statement_id
         and finalized.id=p.finalized_synthesis_revision_id
      )
      select exists(select 1 from exact_candidate) as candidate_exists,
        (select is_valid from pinned_composition_validation limit 1) as pinned_composition_valid,
        header.*,
        details.*,
        coalesce(flags.connecting_evidence_count,'0') as connecting_evidence_count,
        coalesce(direct_counts.direct_evidence_count,'0') as direct_evidence_count,
        coalesce(flags.has_unreviewed_evidence,false) as has_unreviewed_evidence,
        coalesce(flags.has_needs_review_evidence,false) as has_needs_review_evidence,
        coalesce(flags.has_rejected_evidence,false) as has_rejected_evidence
      from candidate_header header
      left join candidate_details details on true
      left join candidate_evidence_flags flags on flags.revision_id=details.revision_id
      left join candidate_direct_evidence_counts direct_counts on direct_counts.revision_id=details.revision_id
    `));
    const row = rows(result)[0];
    if (!row) throw new DomainError("NOT_FOUND", "Synthesis preparation was not found");
    if (!Boolean(row.pinned_composition_valid)) throw new DomainError("DATABASE_CONSTRAINT", "Pinned Evidence Set composition is corrupt and cannot be used for candidate reads");
    if (!row.candidate_exists || row.revision_id == null) {
      throw new DomainError("NOT_FOUND", "Extraction revision is not a candidate in this preparation");
    }
    return {
      candidate: candidateDetailRow(row),
      header: synthesisPreparationHeaderFromRow(row, "header_"),
    };
  }

  async function readCandidateEvidencePage(
    scope: EvidenceCursor["scope"],
    projectId: string,
    preparationId: string,
    extractionRevisionId: string,
    input: SynthesisPreparationCursorPageInput,
  ): Promise<SynthesisPreparationCandidateEvidencePage> {
    ensureId(projectId);
    ensureId(preparationId);
    ensureId(extractionRevisionId);
    const pageSize = positiveInteger(input.pageSize, SYNTHESIS_PREPARATION_EVIDENCE_DEFAULT_PAGE_SIZE, SYNTHESIS_PREPARATION_EVIDENCE_MAX_PAGE_SIZE, "Evidence page size");
    const cursor = checkEvidenceCursor(decodeCursor<EvidenceCursor>(input.cursor, scope, projectId), {
      scope, preparationId, extractionRevisionId, pageSize,
    });
    const cursorPredicate = scope === "connecting-evidence"
      ? cursor ? sql`row(item.membership_order,item.membership_id,item.evidence_id) > row(${cursor.afterPosition}::integer,${cursor.afterMembershipId}::uuid,${cursor.afterEvidenceId}::uuid)` : sql`true`
      : cursor ? sql`row(item.page_number,item.evidence_created_at,item.evidence_id) > row(${cursor.afterPageNumber}::integer,${cursor.afterCreatedAt}::timestamptz,${cursor.afterEvidenceId}::uuid)` : sql`true`;
    const itemOrder = scope === "connecting-evidence"
      ? sql`item.membership_order asc,item.membership_id asc,item.evidence_id asc`
      : sql`item.page_number asc,item.evidence_created_at asc,item.evidence_id asc`;
    const result = await readOnly(db, (tx) => tx.execute(sql`
      ${exactReachableCandidateCtes(projectId, preparationId, extractionRevisionId)},
      evidence_candidates as materialized (
        select ${scope === "connecting-evidence" ? sql`pm.position as membership_order,pm.membership_id,` : sql`null::integer as membership_order,null::uuid as membership_id,`}
          e.id as evidence_id,e.paper_id,
          left(e.source_text,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.evidenceSource}) as source_preview,
          (char_length(e.source_text)>${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.evidenceSource}) as source_truncated,
          e.page_number,
          left(e.note,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.evidenceNote}) as evidence_note,
          (e.note is not null and char_length(e.note)>${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.evidenceNote}) as note_truncated,
          d.id as document_id,
          left(d.original_filename,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.evidenceFilename}) as document_original_filename,
          (d.original_filename is not null and char_length(d.original_filename)>${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.evidenceFilename}) as filename_truncated,
          coalesce(review.decision,'unreviewed') as curation_state,
          e.created_at as evidence_created_at,
          to_char(e.created_at at time zone 'UTC',${UTC_SQL_FORMAT}) as cursor_created_at
        from exact_candidate candidate
        ${scope === "connecting-evidence" ? sql`
          join pinned_members pm on pm.paper_id=candidate.paper_id
          join extraction_revision_evidence ere
            on ere.project_id=candidate.project_id and ere.paper_id=candidate.paper_id
           and ere.revision_id=candidate.revision_id and ere.evidence_id=pm.evidence_id
        ` : sql`
          join extraction_revision_evidence ere
            on ere.project_id=candidate.project_id and ere.paper_id=candidate.paper_id and ere.revision_id=candidate.revision_id
        `}
        join evidence e on e.project_id=candidate.project_id and e.paper_id=candidate.paper_id and e.id=ere.evidence_id
        left join full_text_documents d on d.project_id=e.project_id and d.id=e.full_text_document_id
        left join lateral (
          select decision from evidence_review_decisions rd
          where rd.project_id=e.project_id and rd.evidence_id=e.id
          order by rd.sequence desc,rd.id desc limit 1
        ) review on true
      ),
      page_candidates as materialized (
        select item.* from evidence_candidates item
        where ${cursorPredicate}
        order by ${itemOrder}
        limit ${pageSize + 1}
      ),
      visible_page as materialized (
        select item.* from page_candidates item
        order by ${itemOrder}
        limit ${pageSize}
      ),
      page_metadata as (
        select exists(select 1 from prep_context) as preparation_exists,
          (select is_valid from pinned_composition_validation limit 1) as pinned_composition_valid,
          exists(select 1 from exact_candidate) as candidate_exists,
          (select pinned_revision_id from prep_context limit 1) as pinned_revision_id,
          (select count(*)>${pageSize} from page_candidates) as has_more,
          (${cursor === null} or exists (
            select 1 from evidence_candidates item where ${cursor === null ? sql`true` : scope === "connecting-evidence"
              ? sql`row(item.membership_order,item.membership_id,item.evidence_id)=row(${cursor.afterPosition}::integer,${cursor.afterMembershipId}::uuid,${cursor.afterEvidenceId}::uuid)`
              : sql`row(item.page_number,item.evidence_created_at,item.evidence_id)=row(${cursor.afterPageNumber}::integer,${cursor.afterCreatedAt}::timestamptz,${cursor.afterEvidenceId}::uuid)`}
          )) as cursor_boundary_valid
      )
      select page_metadata.*,visible_page.* from page_metadata
      left join visible_page on true
      order by ${scope === "connecting-evidence" ? sql`visible_page.membership_order,visible_page.membership_id,visible_page.evidence_id` : sql`visible_page.page_number,visible_page.evidence_created_at,visible_page.evidence_id`}
    `));
    const resultRows = rows(result);
    const meta = resultRows[0];
    if (!meta?.preparation_exists) throw new DomainError("NOT_FOUND", "Synthesis preparation was not found");
    if (!Boolean(meta.pinned_composition_valid)) throw new DomainError("DATABASE_CONSTRAINT", "Pinned Evidence Set composition is corrupt and cannot be used for Evidence reads");
    if (!meta.candidate_exists) throw new DomainError("NOT_FOUND", "Extraction revision is not a candidate in this preparation");
    const compositionRevisionId = String(meta.pinned_revision_id);
    if (cursor && cursor.compositionRevisionId.toLowerCase() !== compositionRevisionId.toLowerCase()) {
      return invalidCursor("Synthesis preparation Evidence");
    }
    if (!Boolean(meta.cursor_boundary_valid)) return invalidCursor("Synthesis preparation Evidence");
    const items = resultRows.flatMap((row) => row.evidence_id == null ? [] : [evidenceFromRow(row)]);
    const hasMore = Boolean(meta.has_more);
    const last = resultRows.findLast((row) => row.evidence_id != null);
    const nextCursor = hasMore && last ? encodeCursor({
      v: 1,
      scope,
      projectId,
      preparationId,
      extractionRevisionId,
      compositionRevisionId,
      pageSize,
      ...(scope === "connecting-evidence" ? {
        afterPosition: Number(last.membership_order),
        afterMembershipId: String(last.membership_id),
        afterEvidenceId: String(last.evidence_id),
      } : {
        afterPageNumber: Number(last.page_number),
        afterCreatedAt: String(last.cursor_created_at),
        afterEvidenceId: String(last.evidence_id),
      }),
    }) : null;
    return { extractionRevisionId, items, pageSize, hasMore, nextCursor };
  }

  async function listSynthesisPreparationConnectingEvidence(
    projectId: string,
    preparationId: string,
    extractionRevisionId: string,
    input: SynthesisPreparationCursorPageInput = {},
  ): Promise<SynthesisPreparationCandidateEvidencePage> {
    return readCandidateEvidencePage("connecting-evidence", projectId, preparationId, extractionRevisionId, input);
  }

  async function listSynthesisPreparationDirectEvidence(
    projectId: string,
    preparationId: string,
    extractionRevisionId: string,
    input: SynthesisPreparationCursorPageInput = {},
  ): Promise<SynthesisPreparationCandidateEvidencePage> {
    return readCandidateEvidencePage("direct-evidence", projectId, preparationId, extractionRevisionId, input);
  }

  async function listSynthesisTargetStatementOptions(
    projectId: string,
    input: SynthesisPreparationCursorPageInput & { query?: string } = {},
  ): Promise<SynthesisTargetStatementPage> {
    ensureId(projectId);
    const query = normalizeTargetQuery(input.query);
    const pageSize = positiveInteger(input.pageSize, SYNTHESIS_TARGET_SELECTOR_DEFAULT_PAGE_SIZE, SYNTHESIS_TARGET_SELECTOR_MAX_PAGE_SIZE, "Target page size");
    const cursor = checkTargetCursor(decodeCursor<TargetCursor>(input.cursor, "synthesis-targets", projectId), { query, pageSize });
    const after = cursor === null ? sql`true` : sql`(s.created_at,s.id)<(${cursor.afterCreatedAt}::timestamptz,${cursor.afterStatementId}::uuid)`;
    const result = await readOnly(db, (tx) => tx.execute(sql`
      with page_candidates as materialized (
        select s.id as statement_id,s.created_at,
          current_revision.id as current_revision_id,current_revision.sequence as current_sequence,
          current_revision.state as current_state,
          left(current_revision.title,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.targetTitle}) as current_title,
          left(current_revision.statement_text,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.targetStatementPreview}) as statement_preview,
          to_char(s.created_at at time zone 'UTC',${UTC_SQL_FORMAT}) as cursor_created_at
        from synthesis_statements s
        left join lateral (
          select r.id,r.sequence,r.state,r.title,r.statement_text
          from synthesis_revisions r
          where r.project_id=s.project_id and r.synthesis_statement_id=s.id and r.finalized_at is not null
          order by r.sequence desc,r.id desc limit 1
        ) current_revision on true
        where s.project_id=${projectId}::uuid
          and ${after}
          and (${query === ""} or position(lower(${query}) in lower(coalesce(current_revision.title,'')||' '||coalesce(current_revision.statement_text,'')))>0)
        order by s.created_at desc,s.id desc
        limit ${pageSize + 1}
      ), visible_page as materialized (
        select * from page_candidates order by created_at desc,statement_id desc limit ${pageSize}
      ), page_meta as (
        select (select count(*)>${pageSize} from page_candidates) as has_more
      )
      select page_meta.has_more,visible_page.* from page_meta
      left join visible_page on true
      order by visible_page.created_at desc,visible_page.statement_id desc
    `));
    const resultRows = rows(result);
    const items = resultRows.flatMap((row) => row.statement_id == null ? [] : [{
      id: String(row.statement_id),
      createdAt: dateValue(row.created_at),
      currentRevision: row.current_revision_id == null ? null : {
        id: String(row.current_revision_id),
        sequence: Number(row.current_sequence),
        state: synthesisRevisionState(row.current_state) ?? "active",
        title: nullableString(row.current_title),
        statementPreview: nullableString(row.statement_preview),
      },
    }]);
    const hasMore = Boolean(resultRows[0]?.has_more);
    const last = resultRows.findLast((row) => row.statement_id != null);
    const nextCursor = hasMore && last ? encodeCursor({
      v: 1,
      scope: "synthesis-targets",
      projectId,
      pageSize,
      query,
      afterCreatedAt: String(last.cursor_created_at),
      afterStatementId: String(last.statement_id),
    }) : null;
    return { items, pageSize, hasMore, nextCursor };
  }

  async function resolveSynthesisTargetStatement(projectId: string, statementId: string | null): Promise<SynthesisTargetStatementOption | null> {
    ensureId(projectId);
    if (statementId === null) return null;
    ensureId(statementId);
    const result = await readOnly(db, (tx) => tx.execute(sql`
      select s.id as statement_id,s.created_at,
        current_revision.id as current_revision_id,current_revision.sequence as current_sequence,
        current_revision.state as current_state,
        left(current_revision.title,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.targetTitle}) as current_title,
        left(current_revision.statement_text,${SYNTHESIS_PREPARATION_READ_TEXT_LIMITS.targetStatementPreview}) as statement_preview
      from synthesis_statements s
      left join lateral (
        select r.id,r.sequence,r.state,r.title,r.statement_text
        from synthesis_revisions r
        where r.project_id=s.project_id and r.synthesis_statement_id=s.id and r.finalized_at is not null
        order by r.sequence desc,r.id desc limit 1
      ) current_revision on true
      where s.project_id=${projectId}::uuid and s.id=${statementId}::uuid
      limit 1
    `));
    const row = rows(result)[0];
    if (!row) return null;
    return {
      id: String(row.statement_id),
      createdAt: dateValue(row.created_at),
      currentRevision: row.current_revision_id == null ? null : {
        id: String(row.current_revision_id),
        sequence: Number(row.current_sequence),
        state: synthesisRevisionState(row.current_state) ?? "active",
        title: nullableString(row.current_title),
        statementPreview: nullableString(row.statement_preview),
      },
    };
  }

  return {
    listSynthesisPreparationLedger,
    getSynthesisPreparationHeader,
    listSynthesisPreparationCandidates,
    getSynthesisPreparationCandidate,
    listSynthesisPreparationConnectingEvidence,
    listSynthesisPreparationDirectEvidence,
    listSynthesisTargetStatementOptions,
    resolveSynthesisTargetStatement,
  };
}
