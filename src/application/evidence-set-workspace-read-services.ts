import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";

export const EVIDENCE_SET_MEMBER_DEFAULT_PAGE_SIZE = 50;
export const EVIDENCE_SET_MEMBER_MAX_PAGE_SIZE = 100;
export const EVIDENCE_SET_CANDIDATE_DEFAULT_PAGE_SIZE = 20;
export const EVIDENCE_SET_CANDIDATE_MAX_PAGE_SIZE = 50;
export const EVIDENCE_SET_HISTORY_DEFAULT_PAGE_SIZE = 25;
export const EVIDENCE_SET_HISTORY_MAX_PAGE_SIZE = 50;
export const EVIDENCE_SET_ANNOTATION_DEFAULT_PAGE_SIZE = 20;
export const EVIDENCE_SET_ANNOTATION_MAX_PAGE_SIZE = 50;
export const EVIDENCE_SET_FIELD_DEFAULT_PAGE_SIZE = 20;
export const EVIDENCE_SET_FIELD_MAX_PAGE_SIZE = 50;
export const EVIDENCE_SET_RELATED_DEFAULT_PAGE_SIZE = 25;
export const EVIDENCE_SET_RELATED_MAX_PAGE_SIZE = 50;
export const EVIDENCE_SET_COLLECTION_DEFAULT_PAGE_SIZE = 25;
export const EVIDENCE_SET_COLLECTION_MAX_PAGE_SIZE = 50;
export const EVIDENCE_SET_SELECTOR_DEFAULT_PAGE_SIZE = 20;
export const EVIDENCE_SET_SELECTOR_MAX_PAGE_SIZE = 50;

export const EVIDENCE_SET_TEXT_LIMITS = {
  setName: 100,
  setDescription: 500,
  memberSourcePreview: 300,
  candidateExcerpt: 80,
  paperTitle: 200,
  doi: 120,
  labelName: 80,
  labelCount: 5,
  annotationPreview: 500,
  annotationDetail: 10_000,
  extractionFieldName: 120,
  extractionFieldDescription: 300,
  relatedPaperTitle: 200,
  documentFilename: 160,
} as const;
export const EVIDENCE_SET_MEMBER_RESPONSE_BYTE_BUDGET = 512 * 1024;
export const EVIDENCE_SET_CANDIDATE_RESPONSE_BYTE_BUDGET = 256 * 1024;

type Row = Record<string, unknown>;
type CursorScope = "members" | "candidates" | "history" | "historical-members" | "annotations" | "fields" | "related" | "collection" | "selector";
type CursorData = Record<string, unknown> & {
  v: 1;
  scope: CursorScope;
  projectId: string;
  evidenceSetId?: string;
  revisionId?: string;
};

export type EvidenceSetWorkspaceSet = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type EvidenceSetWorkspaceRevision = {
  id: string;
  sequence: number;
  setOrdinal: string;
  operationKind: string;
  createdAt: Date;
  memberCount: number;
  distinctPaperCount: number;
};

export type EvidenceSetWorkspaceShell = {
  set: EvidenceSetWorkspaceSet;
  currentRevision: EvidenceSetWorkspaceRevision;
};

export type EvidenceSetWorkspaceMember = {
  membershipId: string;
  evidenceId: string;
  position: number;
  pageNumber: number;
  sourcePreview: string;
  paperId: string;
  paperTitle: string;
  publicationYear: number | null;
  fullTextDocumentId: string | null;
  documentArchivedAt: Date | null;
  documentTextExtractionId: string | null;
  extractionStartOffset: number | null;
  extractionEndOffset: number | null;
  reviewState: "unreviewed" | "needs_review" | "accepted" | "rejected";
  labels: Array<{ id: string; name: string; archivedAt: Date | null }>;
  labelCount: number;
  isUsed: boolean;
};

export type EvidenceSetWorkspacePage<T> = {
  items: T[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

type PageInput = { cursor?: string | null; pageSize?: number | string };
type RevisionPageInput = PageInput & { expectedRevisionId?: string };

function rows(value: unknown): Row[] {
  return value as unknown as Row[];
}

function ensureUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("VALIDATION_ERROR", `${label} must be a UUID`);
  }
  return value;
}

function getPageSize(value: number | string | undefined, defaultValue: number, maximum: number) {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new DomainError("VALIDATION_ERROR", "Page size must be a positive integer");
  return Math.min(parsed, maximum);
}

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : dateValue(value);
}

function encodeCursor(data: CursorData) {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

function invalidCursor(): never {
  throw new DomainError("VALIDATION_ERROR", "This Evidence Set page cursor is invalid. Return to the first page and continue from there.");
}

function decodeCursor<T extends CursorData>(value: string | null | undefined, scope: CursorScope, projectId: string, evidenceSetId?: string): T | null {
  if (!value) return null;
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return invalidCursor();
  }
  if (!parsed || typeof parsed !== "object") return invalidCursor();
  const cursor = parsed as Partial<CursorData>;
  if (cursor.v !== 1 || cursor.scope !== scope || cursor.projectId !== projectId || cursor.evidenceSetId !== evidenceSetId) return invalidCursor();
  return cursor as T;
}

function mapSet(row: Row): EvidenceSetWorkspaceSet {
  return {
    id: String(row.set_id),
    projectId: String(row.project_id),
    name: String(row.set_name),
    description: row.set_description == null ? null : String(row.set_description),
    createdAt: dateValue(row.set_created_at),
    updatedAt: dateValue(row.set_updated_at),
    archivedAt: nullableDate(row.set_archived_at),
  };
}

function mapRevision(row: Row): EvidenceSetWorkspaceRevision {
  return {
    id: String(row.revision_id),
    sequence: Number(row.revision_sequence),
    setOrdinal: String(row.set_ordinal),
    operationKind: String(row.operation_kind),
    createdAt: dateValue(row.revision_created_at),
    memberCount: Number(row.member_count),
    distinctPaperCount: Number(row.distinct_paper_count),
  };
}

function mapLabelArray(value: unknown): EvidenceSetWorkspaceMember["labels"] {
  const parsed = Array.isArray(value) ? value : typeof value === "string" ? JSON.parse(value || "[]") as unknown : [];
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const label = item as Record<string, unknown>;
    if (label.id == null || label.name == null) return [];
    return [{ id: String(label.id), name: String(label.name), archivedAt: nullableDate(label.archivedAt) }];
  });
}

function memberFromRow(row: Row): EvidenceSetWorkspaceMember | null {
  if (row.membership_id == null) return null;
  const review = String(row.review_state ?? "unreviewed");
  return {
    membershipId: String(row.membership_id),
    evidenceId: String(row.evidence_id),
    position: Number(row.position),
    pageNumber: Number(row.page_number),
    sourcePreview: String(row.source_preview ?? ""),
    paperId: String(row.paper_id),
    paperTitle: String(row.paper_title ?? "Untitled paper"),
    publicationYear: row.publication_year == null ? null : Number(row.publication_year),
    fullTextDocumentId: row.full_text_document_id == null ? null : String(row.full_text_document_id),
    documentArchivedAt: nullableDate(row.document_archived_at),
    documentTextExtractionId: row.document_text_extraction_id == null ? null : String(row.document_text_extraction_id),
    extractionStartOffset: row.extraction_start_offset == null ? null : Number(row.extraction_start_offset),
    extractionEndOffset: row.extraction_end_offset == null ? null : Number(row.extraction_end_offset),
    reviewState: review === "needs_review" || review === "accepted" || review === "rejected" ? review : "unreviewed",
    labels: mapLabelArray(row.labels),
    labelCount: Number(row.label_count ?? 0),
    isUsed: Boolean(row.is_used),
  };
}

function expectRevisionCursor(cursor: CursorData | null, revisionId: string) {
  if (cursor && cursor.revisionId !== revisionId) return invalidCursor();
}

export function createEvidenceSetWorkspaceReadServices(db: Database) {
  async function getEvidenceSetWorkspace(projectId: string, evidenceSetId: string): Promise<EvidenceSetWorkspaceShell> {
    ensureUuid(projectId, "Project");
    ensureUuid(evidenceSetId, "Evidence Set");
    const result = rows(await db.execute(sql`
      select s.id as set_id, s.project_id,
        left(s.name, ${EVIDENCE_SET_TEXT_LIMITS.setName}) as set_name,
        left(s.description, ${EVIDENCE_SET_TEXT_LIMITS.setDescription}) as set_description,
        s.created_at as set_created_at, s.updated_at as set_updated_at, s.archived_at as set_archived_at,
        r.id as revision_id, r.sequence as revision_sequence, r.set_ordinal::text as set_ordinal,
        r.operation_kind, r.created_at as revision_created_at, r.member_count, r.distinct_paper_count
      from evidence_sets s
      join lateral (
        select id, sequence, set_ordinal, operation_kind, created_at, member_count, distinct_paper_count
        from evidence_set_composition_revisions
        where project_id=s.project_id and evidence_set_id=s.id
        order by set_ordinal desc limit 1
      ) r on true
      where s.project_id=${projectId} and s.id=${evidenceSetId}
      limit 1
    `));
    const row = result[0];
    if (!row) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set does not belong to this project");
    return { set: mapSet(row), currentRevision: mapRevision(row) };
  }

  async function listEvidenceSetCollectionPage(projectId: string, input: PageInput & { query?: string; visibility?: "all" | "active" | "archived" } = {}): Promise<EvidenceSetWorkspacePage<{
    set: EvidenceSetWorkspaceSet;
    memberCount: number;
    distinctPaperCount: number;
    curationCounts: { unreviewed: number; needsReview: number; rejected: number };
  }> & { totals: { active: number; archived: number }; query: string; visibility: "all" | "active" | "archived" }> {
    ensureUuid(projectId, "Project");
    const pageSize = getPageSize(input.pageSize, EVIDENCE_SET_COLLECTION_DEFAULT_PAGE_SIZE, EVIDENCE_SET_COLLECTION_MAX_PAGE_SIZE);
    const query = (input.query ?? "").trim();
    if ([...query].length > 200) throw new DomainError("VALIDATION_ERROR", "Evidence Set search is limited to 200 Unicode code points");
    const visibility = input.visibility ?? "all";
    if (visibility !== "all" && visibility !== "active" && visibility !== "archived") throw new DomainError("VALIDATION_ERROR", "Evidence Set visibility filter is invalid");
    const cursor = decodeCursor<CursorData & { archived: boolean; nameKey: string; setId: string; query: string; visibility: string }>(input.cursor, "collection", projectId);
    if (cursor && (typeof cursor.archived !== "boolean" || typeof cursor.nameKey !== "string" || typeof cursor.setId !== "string" || cursor.query !== query || cursor.visibility !== visibility)) return invalidCursor();
    if (cursor) ensureUuid(cursor.setId, "Evidence Set");
    const result = rows(await db.execute(sql`
      with totals as (
        select count(*) filter (where archived_at is null)::integer as active_total,
          count(*) filter (where archived_at is not null)::integer as archived_total
        from evidence_sets where project_id=${projectId}
      ), page as (
        select s.id as set_id, s.project_id,
          left(s.name, ${EVIDENCE_SET_TEXT_LIMITS.setName}) as set_name,
          lower(s.name) as name_key,
          left(s.description, ${EVIDENCE_SET_TEXT_LIMITS.setDescription}) as set_description,
          s.created_at as set_created_at, s.updated_at as set_updated_at, s.archived_at as set_archived_at,
          r.id as revision_id, r.member_count, r.distinct_paper_count
        from evidence_sets s
        join lateral (
          select id, member_count, distinct_paper_count
          from evidence_set_composition_revisions
          where project_id=s.project_id and evidence_set_id=s.id
          order by set_ordinal desc limit 1
        ) r on true
        where s.project_id=${projectId}
          and (${visibility === "all"} or (${visibility === "active"} and s.archived_at is null) or (${visibility === "archived"} and s.archived_at is not null))
          and (${query === ""} or strpos(lower(s.name),lower(${query}))>0 or strpos(lower(coalesce(s.description,'')),lower(${query}))>0)
          and (${cursor === null} or (s.archived_at is not null, lower(s.name), s.id) > (${cursor?.archived ?? false}, ${cursor?.nameKey ?? ""}, ${cursor?.setId ?? "00000000-0000-4000-8000-000000000000"}::uuid))
        order by s.archived_at is not null, lower(s.name), s.id
        limit ${pageSize + 1}
      ), visible_page as (
        select * from page order by set_archived_at is not null,name_key,set_id limit ${pageSize}
      ), review_counts as (
        select p.set_id,
          count(m.id) filter (where latest.decision is null)::integer as unreviewed_count,
          count(m.id) filter (where latest.decision='needs_review')::integer as needs_review_count,
          count(m.id) filter (where latest.decision='rejected')::integer as rejected_count
        from visible_page p
        left join evidence_set_composition_revisions r on r.project_id=p.project_id and r.evidence_set_id=p.set_id and r.id=p.revision_id
        left join evidence_set_membership_order_versions ov on ov.project_id=p.project_id and ov.evidence_set_id=p.set_id
          and ov.valid_from_ordinal <= r.set_ordinal and (ov.valid_to_ordinal is null or r.set_ordinal < ov.valid_to_ordinal)
        left join evidence_set_memberships m on m.project_id=ov.project_id and m.evidence_set_id=ov.evidence_set_id and m.id=ov.membership_id
        left join lateral (
          select d.decision from evidence_review_decisions d
          where d.project_id=m.project_id and d.evidence_id=m.evidence_id
          order by d.sequence desc limit 1
        ) latest on true
        group by p.set_id
      )
      select p.*, coalesce(rc.unreviewed_count, 0)::integer as unreviewed_count,
        coalesce(rc.needs_review_count, 0)::integer as needs_review_count,
        coalesce(rc.rejected_count, 0)::integer as rejected_count,
        (select count(*) > ${pageSize} from page) as has_more,
        t.active_total,t.archived_total
      from totals t left join visible_page p on true left join review_counts rc on rc.set_id=p.set_id
      order by p.set_archived_at is not null, p.name_key, p.set_id
    `));
    const hasMore = Boolean(result[0]?.has_more);
    const visible = result.filter((row) => row.set_id != null);
    const items = visible.map((row) => ({
      set: mapSet(row),
      memberCount: Number(row.member_count),
      distinctPaperCount: Number(row.distinct_paper_count),
      curationCounts: {
        unreviewed: Number(row.unreviewed_count),
        needsReview: Number(row.needs_review_count),
        rejected: Number(row.rejected_count),
      },
    }));
    const last = visible.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({
      v: 1, scope: "collection", projectId,
      archived: last.set_archived_at != null,
      nameKey: String(last.name_key),
      setId: String(last.set_id),
      query, visibility,
    }) : null;
    return { items, pageSize, hasMore, nextCursor, query, visibility, totals: { active: Number(result[0]?.active_total ?? 0), archived: Number(result[0]?.archived_total ?? 0) } };
  }

  async function listActiveEvidenceSetOptions(projectId: string, input: PageInput & { query?: string } = {}): Promise<EvidenceSetWorkspacePage<{
    set: EvidenceSetWorkspaceSet;
    currentRevisionId: string;
    memberCount: number;
    distinctPaperCount: number;
  }> & { query: string; totals: { active: number } }> {
    ensureUuid(projectId, "Project");
    const pageSize = getPageSize(input.pageSize, EVIDENCE_SET_SELECTOR_DEFAULT_PAGE_SIZE, EVIDENCE_SET_SELECTOR_MAX_PAGE_SIZE);
    const query = (input.query ?? "").trim();
    if ([...query].length > 200) throw new DomainError("VALIDATION_ERROR", "Evidence Set search is limited to 200 Unicode code points");
    const cursor = decodeCursor<CursorData & { nameKey: string; setId: string; query: string }>(input.cursor, "selector", projectId);
    if (cursor && (typeof cursor.nameKey !== "string" || typeof cursor.setId !== "string" || cursor.query !== query)) return invalidCursor();
    if (cursor) ensureUuid(cursor.setId, "Evidence Set");
    const result = rows(await db.execute(sql`
      with totals as (
        select count(*)::integer as active_total
        from evidence_sets
        where project_id=${projectId} and archived_at is null
      ), page as (
        select s.id as set_id, s.project_id,
          left(s.name, ${EVIDENCE_SET_TEXT_LIMITS.setName}) as set_name,
          lower(s.name) as name_key,
          left(s.description, ${EVIDENCE_SET_TEXT_LIMITS.setDescription}) as set_description,
          s.created_at as set_created_at, s.updated_at as set_updated_at, s.archived_at as set_archived_at,
          r.id as revision_id,r.member_count,r.distinct_paper_count
        from evidence_sets s
        join lateral (
          select id,member_count,distinct_paper_count
          from evidence_set_composition_revisions
          where project_id=s.project_id and evidence_set_id=s.id
          order by set_ordinal desc limit 1
        ) r on true
        where s.project_id=${projectId} and s.archived_at is null
          and (${query === ""} or strpos(lower(s.name),lower(${query}))>0 or strpos(lower(coalesce(s.description,'')),lower(${query}))>0)
          and (${cursor === null} or (lower(s.name), s.id) > (${cursor?.nameKey ?? ""}, ${cursor?.setId ?? "00000000-0000-4000-8000-000000000000"}::uuid))
        order by lower(s.name), s.id
        limit ${pageSize + 1}
      ), visible_page as (
        select * from page order by name_key,set_id limit ${pageSize}
      )
      select p.*, t.active_total,
        (select count(*) > ${pageSize} from page) as has_more
      from totals t left join visible_page p on true
      order by p.name_key,p.set_id
    `));
    const hasMore = Boolean(result[0]?.has_more);
    const visible = result.filter((row) => row.set_id != null);
    const items = visible.map((row) => ({ set: mapSet(row), currentRevisionId: String(row.revision_id), memberCount: Number(row.member_count), distinctPaperCount: Number(row.distinct_paper_count) }));
    const last = visible.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({
      v: 1, scope: "selector", projectId, nameKey: String(last.name_key), setId: String(last.set_id), query,
    }) : null;
    return { items, pageSize, hasMore, nextCursor, query, totals: { active: Number(result[0]?.active_total ?? 0) } };
  }

  async function listCurrentMembersPage(projectId: string, evidenceSetId: string, input: RevisionPageInput = {}) {
    ensureUuid(projectId, "Project"); ensureUuid(evidenceSetId, "Evidence Set");
    const pageSize = getPageSize(input.pageSize, EVIDENCE_SET_MEMBER_DEFAULT_PAGE_SIZE, EVIDENCE_SET_MEMBER_MAX_PAGE_SIZE);
    const cursor = decodeCursor<CursorData & { afterMembershipId: string }>(input.cursor, "members", projectId, evidenceSetId);
    if (cursor && typeof cursor.afterMembershipId !== "string") return invalidCursor();
    if (cursor) ensureUuid(cursor.afterMembershipId, "Membership");
    const expectedRevisionId = ensureUuid(input.expectedRevisionId ?? "", "Composition revision");
    expectRevisionCursor(cursor, expectedRevisionId);
    const result = rows(await db.execute(sql`
      with recursive latest_revision as (
        select r.id, r.project_id, r.evidence_set_id, r.sequence, r.set_ordinal, r.operation_kind,
          r.created_at, r.member_count, r.distinct_paper_count, r.head_membership_id
        from evidence_set_composition_revisions r
        where r.project_id=${projectId} and r.evidence_set_id=${evidenceSetId}
        order by r.set_ordinal desc limit 1
      ), cursor_link as (
        select v.membership_id, v.next_membership_id
        from latest_revision r
        join evidence_set_membership_order_versions v on v.project_id=r.project_id and v.evidence_set_id=r.evidence_set_id
          and v.membership_id=${cursor?.afterMembershipId ?? null}::uuid
          and v.valid_from_ordinal <= r.set_ordinal and (v.valid_to_ordinal is null or r.set_ordinal < v.valid_to_ordinal)
      ), state as (
        select r.*,
          r.id=${expectedRevisionId}::uuid as revision_matches,
          (${cursor === null} or c.membership_id is not null) as cursor_valid,
          case when ${cursor === null} then r.head_membership_id else c.next_membership_id end as start_membership_id
        from latest_revision r left join cursor_link c on true
      ), walk(position, membership_id, next_membership_id, evidence_id) as (
        select 1, v.membership_id, v.next_membership_id, m.evidence_id
        from state s
        join evidence_set_membership_order_versions v on v.project_id=s.project_id and v.evidence_set_id=s.evidence_set_id
          and v.membership_id=s.start_membership_id
          and v.valid_from_ordinal <= s.set_ordinal and (v.valid_to_ordinal is null or s.set_ordinal < v.valid_to_ordinal)
        join evidence_set_memberships m on m.project_id=v.project_id and m.evidence_set_id=v.evidence_set_id and m.id=v.membership_id
        where s.revision_matches and s.cursor_valid and s.start_membership_id is not null
        union all
        select w.position + 1, v.membership_id, v.next_membership_id, m.evidence_id
        from walk w
        join latest_revision r on true
        join evidence_set_membership_order_versions v on v.project_id=r.project_id and v.evidence_set_id=r.evidence_set_id
          and v.membership_id=w.next_membership_id
          and v.valid_from_ordinal <= r.set_ordinal and (v.valid_to_ordinal is null or r.set_ordinal < v.valid_to_ordinal)
        join evidence_set_memberships m on m.project_id=v.project_id and m.evidence_set_id=v.evidence_set_id and m.id=v.membership_id
        where w.next_membership_id is not null and w.position < ${pageSize + 1}
      ), visible as (
        select * from walk where position <= ${pageSize}
      ), current_review as (
        select distinct on (d.project_id, d.evidence_id) d.project_id, d.evidence_id, d.decision
        from evidence_review_decisions d join visible w on w.evidence_id=d.evidence_id
        where d.project_id=${projectId}
        order by d.project_id, d.evidence_id, d.sequence desc
      ), current_label_events as (
        select distinct on (le.project_id, le.evidence_id, le.label_id)
          le.project_id, le.evidence_id, le.label_id, le.event
        from evidence_label_events le join visible w on w.evidence_id=le.evidence_id
        where le.project_id=${projectId}
        order by le.project_id, le.evidence_id, le.label_id, le.sequence desc
      ), label_counts as (
        select cle.evidence_id, count(*)::integer as label_count
        from current_label_events cle where cle.event='assigned' group by cle.evidence_id
      ), label_values as (
        select top_labels.evidence_id, json_agg(json_build_object(
          'id', top_labels.id, 'name', top_labels.name, 'archivedAt', top_labels.archived_at
        ) order by top_labels.name_key, top_labels.id) as labels
        from (
          select cle.evidence_id, l.id, left(l.name, ${EVIDENCE_SET_TEXT_LIMITS.labelName}) as name,
            lower(l.name) as name_key, l.archived_at,
            row_number() over (partition by cle.evidence_id order by lower(l.name), l.id) as label_position
          from current_label_events cle join evidence_labels l on l.project_id=cle.project_id and l.id=cle.label_id
          where cle.event='assigned'
        ) top_labels
        where top_labels.label_position <= ${EVIDENCE_SET_TEXT_LIMITS.labelCount}
        group by top_labels.evidence_id
      )
      select s.id as revision_id, s.sequence as revision_sequence, s.set_ordinal::text as set_ordinal,
        s.operation_kind, s.created_at as revision_created_at, s.member_count, s.distinct_paper_count,
        s.revision_matches, s.cursor_valid,
        w.position, w.membership_id, w.evidence_id, e.page_number,
        left(e.source_text, ${EVIDENCE_SET_TEXT_LIMITS.memberSourcePreview}) as source_preview,
        e.paper_id, left(p.title, ${EVIDENCE_SET_TEXT_LIMITS.paperTitle}) as paper_title, p.publication_year,
        e.full_text_document_id, d.archived_at as document_archived_at,
        e.document_text_extraction_id, e.extraction_start_offset, e.extraction_end_offset,
        coalesce(cr.decision, 'unreviewed') as review_state,
        coalesce(lv.labels, '[]'::json) as labels, coalesce(lc.label_count, 0)::integer as label_count,
        (exists(select 1 from extraction_revision_evidence x where x.project_id=e.project_id and x.evidence_id=e.id)
          or exists(select 1 from claim_revision_evidence_supports x where x.project_id=e.project_id and x.evidence_id=e.id)
          or exists(select 1 from claim_revision_extraction_supports x join extraction_revision_evidence y on y.project_id=x.project_id and y.revision_id=x.extraction_revision_id where x.project_id=e.project_id and y.evidence_id=e.id)
          or exists(select 1 from synthesis_revision_supports x join extraction_revision_evidence y on y.project_id=x.project_id and y.revision_id=x.extraction_revision_id where x.project_id=e.project_id and y.evidence_id=e.id)
          or exists(select 1 from claim_revision_synthesis_supports x join synthesis_revision_supports y on y.project_id=x.project_id and y.synthesis_revision_id=x.synthesis_revision_id join extraction_revision_evidence z on z.project_id=y.project_id and z.revision_id=y.extraction_revision_id where x.project_id=e.project_id and z.evidence_id=e.id)) as is_used,
        exists(select 1 from walk more where more.position > ${pageSize}) as has_more
      from state s left join visible w on true
      left join evidence e on e.project_id=${projectId} and e.id=w.evidence_id
      left join papers p on p.project_id=e.project_id and p.id=e.paper_id
      left join full_text_documents d on d.project_id=e.project_id and d.paper_id=e.paper_id and d.id=e.full_text_document_id
      left join current_review cr on cr.project_id=e.project_id and cr.evidence_id=e.id
      left join label_counts lc on lc.evidence_id=e.id
      left join label_values lv on lv.evidence_id=e.id
      order by w.position
    `));
    const first = result[0];
    if (!first) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set does not belong to this project");
    const revision = mapRevision(first);
    if (!Boolean(first.revision_matches)) return { revision, cursorStatus: "stale" as const, pageSize, hasMore: false, items: [] as EvidenceSetWorkspaceMember[], nextCursor: null };
    if (!Boolean(first.cursor_valid)) return invalidCursor();
    const items = result.flatMap((row) => {
      const item = memberFromRow(row);
      return item ? [item] : [];
    });
    const hasMore = Boolean(first.has_more);
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({
      v: 1, scope: "members", projectId, evidenceSetId, revisionId: revision.id, afterMembershipId: last.membershipId,
    }) : null;
    return { revision, cursorStatus: "current" as const, pageSize, hasMore, items, nextCursor };
  }

  async function searchEvidenceSetCandidates(projectId: string, evidenceSetId: string, input: RevisionPageInput & { query?: string }) {
    ensureUuid(projectId, "Project"); ensureUuid(evidenceSetId, "Evidence Set");
    const pageSize = getPageSize(input.pageSize, EVIDENCE_SET_CANDIDATE_DEFAULT_PAGE_SIZE, EVIDENCE_SET_CANDIDATE_MAX_PAGE_SIZE);
    const query = (input.query ?? "").trim();
    if ([...query].length > 200) throw new DomainError("VALIDATION_ERROR", "Candidate search is limited to 200 Unicode code points");
    const expectedRevisionId = ensureUuid(input.expectedRevisionId ?? "", "Composition revision");
    const cursor = decodeCursor<CursorData & { createdAt: string; evidenceId: string; query: string }>(input.cursor, "candidates", projectId, evidenceSetId);
    if (cursor && (typeof cursor.createdAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.createdAt)
      || Number.isNaN(Date.parse(cursor.createdAt))
      || typeof cursor.evidenceId !== "string" || cursor.query !== query)) return invalidCursor();
    if (cursor) {
      ensureUuid(cursor.evidenceId, "Evidence");
      expectRevisionCursor(cursor, expectedRevisionId);
    }
    const result = rows(await db.execute(sql`
      with current_revision as (
        select r.id, r.set_ordinal
        from evidence_set_composition_revisions r
        where r.project_id=${projectId} and r.evidence_set_id=${evidenceSetId}
        order by r.set_ordinal desc limit 1
      ), candidate_page as (
        select e.id as evidence_id, e.project_id, e.paper_id, e.page_number,
          to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_cursor,
          left(e.source_text, ${EVIDENCE_SET_TEXT_LIMITS.candidateExcerpt}) as excerpt,
          left(p.title, ${EVIDENCE_SET_TEXT_LIMITS.paperTitle}) as paper_title,
          left(p.doi, ${EVIDENCE_SET_TEXT_LIMITS.doi}) as doi
        from current_revision r
        join evidence e on e.project_id=${projectId}
        join papers p on p.project_id=e.project_id and p.id=e.paper_id
        where r.id=${expectedRevisionId}::uuid
          and ((${query}='') or strpos(lower(coalesce(p.title,'')), lower(${query})) > 0 or strpos(lower(coalesce(p.doi,'')), lower(${query})) > 0)
          and (${cursor === null} or (e.created_at, e.id) > (${cursor?.createdAt ?? "2000-01-01T00:00:00.000Z"}::timestamptz, ${cursor?.evidenceId ?? "00000000-0000-4000-8000-000000000000"}::uuid))
          and not exists (
            select 1 from evidence_set_memberships m
            join evidence_set_membership_order_versions v on v.project_id=m.project_id and v.evidence_set_id=m.evidence_set_id and v.membership_id=m.id
              and v.valid_from_ordinal <= r.set_ordinal and (v.valid_to_ordinal is null or r.set_ordinal < v.valid_to_ordinal)
            where m.project_id=e.project_id and m.evidence_set_id=${evidenceSetId} and m.evidence_id=e.id
          )
        order by e.created_at, e.id
        limit ${pageSize + 1}
      )
      select (select id from current_revision) as current_revision_id,
        candidate_page.evidence_id, candidate_page.project_id, candidate_page.paper_id,
        candidate_page.page_number, candidate_page.created_at_cursor, candidate_page.excerpt,
        candidate_page.paper_title, candidate_page.doi
      from candidate_page
      union all
      select r.id, null::uuid, null::uuid, null::uuid, null::integer, null::text, null::text, null::text, null::text
      from current_revision r where not exists (select 1 from candidate_page)
    `));
    const currentRevisionId = result[0]?.current_revision_id == null ? null : String(result[0].current_revision_id);
    if (!currentRevisionId) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set does not belong to this project");
    if (currentRevisionId !== expectedRevisionId) return { revisionId: currentRevisionId, cursorStatus: "stale" as const, pageSize, query, items: [], hasMore: false, nextCursor: null };
    const visibleRows = result.filter((row) => row.evidence_id != null);
    const hasMore = visibleRows.length > pageSize;
    const visible = visibleRows.slice(0, pageSize);
    const items = visible.map((row) => ({
      evidenceId: String(row.evidence_id), paperId: String(row.paper_id), pageNumber: Number(row.page_number),
      excerpt: String(row.excerpt ?? ""), paperTitle: String(row.paper_title ?? "Untitled paper"),
      doi: row.doi == null ? null : String(row.doi),
    }));
    const last = items.at(-1);
    const lastRow = visible.at(-1);
    const nextCursor = hasMore && last && lastRow ? encodeCursor({
      v: 1, scope: "candidates", projectId, evidenceSetId, revisionId: expectedRevisionId,
      createdAt: String(lastRow.created_at_cursor), evidenceId: last.evidenceId, query,
    }) : null;
    return { revisionId: currentRevisionId, cursorStatus: "current" as const, pageSize, query, items, hasMore, nextCursor };
  }

  async function listCompositionHistoryPage(projectId: string, evidenceSetId: string, input: PageInput = {}) {
    ensureUuid(projectId, "Project"); ensureUuid(evidenceSetId, "Evidence Set");
    const pageSize = getPageSize(input.pageSize, EVIDENCE_SET_HISTORY_DEFAULT_PAGE_SIZE, EVIDENCE_SET_HISTORY_MAX_PAGE_SIZE);
    const cursor = decodeCursor<CursorData & { highWaterOrdinal: string; beforeOrdinal: string }>(input.cursor, "history", projectId, evidenceSetId);
    if (cursor && (!/^\d+$/.test(cursor.highWaterOrdinal) || !/^\d+$/.test(cursor.beforeOrdinal))) return invalidCursor();
    const result = rows(await db.execute(sql`
      with latest_revision as (
        select latest.set_ordinal::text as set_ordinal from evidence_set_composition_revisions latest
        where latest.project_id=${projectId} and latest.evidence_set_id=${evidenceSetId}
        order by latest.set_ordinal desc limit 1
      ), bounds as (
        select coalesce(${cursor?.highWaterOrdinal ?? null}::text, (select set_ordinal from latest_revision)) as high_water,
          ${cursor?.beforeOrdinal ?? null}::text as before_ordinal
      ), page as (
        select r.id, r.sequence, r.set_ordinal::text as set_ordinal, r.operation_kind, r.created_at,
          r.member_count, r.distinct_paper_count
        from evidence_set_composition_revisions r cross join bounds b
        where r.project_id=${projectId} and r.evidence_set_id=${evidenceSetId}
          and r.set_ordinal <= b.high_water::bigint
          and (b.before_ordinal is null or r.set_ordinal < b.before_ordinal::bigint)
        order by r.set_ordinal desc limit ${pageSize + 1}
      )
      select (select high_water from bounds) as high_water, page.* from page
      union all
      select (select high_water from bounds), null::uuid, null::bigint, null::text, null::text, null::timestamptz, null::integer, null::integer
      where not exists (select 1 from page)
    `));
    const highWaterOrdinal = String(result[0]?.high_water ?? "");
    if (!/^\d+$/.test(highWaterOrdinal)) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set does not belong to this project");
    const historyRows = result.filter((row) => row.id != null);
    const hasMore = historyRows.length > pageSize;
    const visible = historyRows.slice(0, pageSize);
    const items = visible.map((row) => ({
      revisionId: String(row.id), sequence: Number(row.sequence), setOrdinal: String(row.set_ordinal),
      operationKind: String(row.operation_kind), createdAt: dateValue(row.created_at),
      memberCount: Number(row.member_count), distinctPaperCount: Number(row.distinct_paper_count),
    }));
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({
      v: 1, scope: "history", projectId, evidenceSetId,
      highWaterOrdinal, beforeOrdinal: last.setOrdinal,
    }) : null;
    return { items, pageSize, hasMore, nextCursor, highWaterOrdinal };
  }

  async function listRevisionMembersPage(projectId: string, evidenceSetId: string, revisionId: string, input: PageInput = {}) {
    ensureUuid(projectId, "Project"); ensureUuid(evidenceSetId, "Evidence Set"); ensureUuid(revisionId, "Composition revision");
    const pageSize = getPageSize(input.pageSize, EVIDENCE_SET_MEMBER_DEFAULT_PAGE_SIZE, EVIDENCE_SET_MEMBER_MAX_PAGE_SIZE);
    const cursor = decodeCursor<CursorData & { afterMembershipId: string }>(input.cursor, "historical-members", projectId, evidenceSetId);
    if (cursor && (typeof cursor.afterMembershipId !== "string" || cursor.revisionId !== revisionId)) return invalidCursor();
    if (cursor) ensureUuid(cursor.afterMembershipId, "Membership");
    const result = rows(await db.execute(sql`
      with recursive revision as (
        select r.id, r.project_id, r.evidence_set_id, r.sequence, r.set_ordinal, r.operation_kind,
          r.created_at, r.member_count, r.distinct_paper_count, r.head_membership_id
        from evidence_set_composition_revisions r
        where r.project_id=${projectId} and r.evidence_set_id=${evidenceSetId} and r.id=${revisionId}::uuid
      ), cursor_link as (
        select v.membership_id, v.next_membership_id
        from revision r join evidence_set_membership_order_versions v on v.project_id=r.project_id and v.evidence_set_id=r.evidence_set_id
          and v.membership_id=${cursor?.afterMembershipId ?? null}::uuid
          and v.valid_from_ordinal <= r.set_ordinal and (v.valid_to_ordinal is null or r.set_ordinal < v.valid_to_ordinal)
      ), state as (
        select r.*, (${cursor === null} or c.membership_id is not null) as cursor_valid,
          case when ${cursor === null} then r.head_membership_id else c.next_membership_id end as start_membership_id
        from revision r left join cursor_link c on true
      ), walk(position, membership_id, next_membership_id, evidence_id) as (
        select 1, v.membership_id, v.next_membership_id, m.evidence_id
        from state s join evidence_set_membership_order_versions v on v.project_id=s.project_id and v.evidence_set_id=s.evidence_set_id
          and v.membership_id=s.start_membership_id
          and v.valid_from_ordinal <= s.set_ordinal and (v.valid_to_ordinal is null or s.set_ordinal < v.valid_to_ordinal)
        join evidence_set_memberships m on m.project_id=v.project_id and m.evidence_set_id=v.evidence_set_id and m.id=v.membership_id
        where s.cursor_valid and s.start_membership_id is not null
        union all
        select w.position + 1, v.membership_id, v.next_membership_id, m.evidence_id
        from walk w join revision r on true
        join evidence_set_membership_order_versions v on v.project_id=r.project_id and v.evidence_set_id=r.evidence_set_id
          and v.membership_id=w.next_membership_id
          and v.valid_from_ordinal <= r.set_ordinal and (v.valid_to_ordinal is null or r.set_ordinal < v.valid_to_ordinal)
        join evidence_set_memberships m on m.project_id=v.project_id and m.evidence_set_id=v.evidence_set_id and m.id=v.membership_id
        where w.next_membership_id is not null and w.position < ${pageSize + 1}
      ), visible as (select * from walk where position <= ${pageSize}),
      current_review as (
        select distinct on (d.project_id, d.evidence_id) d.project_id, d.evidence_id, d.decision
        from evidence_review_decisions d join visible w on w.evidence_id=d.evidence_id
        where d.project_id=${projectId} order by d.project_id,d.evidence_id,d.sequence desc
      ), current_label_events as (
        select distinct on (le.project_id,le.evidence_id,le.label_id) le.project_id,le.evidence_id,le.label_id,le.event
        from evidence_label_events le join visible w on w.evidence_id=le.evidence_id
        where le.project_id=${projectId} order by le.project_id,le.evidence_id,le.label_id,le.sequence desc
      ), label_counts as (
        select evidence_id,count(*)::integer as label_count from current_label_events where event='assigned' group by evidence_id
      ), label_values as (
        select t.evidence_id,json_agg(json_build_object('id',t.id,'name',t.name,'archivedAt',t.archived_at) order by t.name_key,t.id) as labels
        from (
          select cle.evidence_id,l.id,left(l.name,${EVIDENCE_SET_TEXT_LIMITS.labelName}) as name,lower(l.name) as name_key,l.archived_at,
            row_number() over (partition by cle.evidence_id order by lower(l.name),l.id) as label_position
          from current_label_events cle join evidence_labels l on l.project_id=cle.project_id and l.id=cle.label_id
          where cle.event='assigned'
        ) t where t.label_position <= ${EVIDENCE_SET_TEXT_LIMITS.labelCount} group by t.evidence_id
      )
      select s.id as revision_id, s.sequence as revision_sequence, s.set_ordinal::text as set_ordinal,
        s.operation_kind, s.created_at as revision_created_at, s.member_count, s.distinct_paper_count,
        s.cursor_valid, w.position, w.membership_id, w.evidence_id, e.page_number,
        left(e.source_text,${EVIDENCE_SET_TEXT_LIMITS.memberSourcePreview}) as source_preview,
        e.paper_id,left(p.title,${EVIDENCE_SET_TEXT_LIMITS.paperTitle}) as paper_title,p.publication_year,
        e.full_text_document_id,d.archived_at as document_archived_at,e.document_text_extraction_id,
        e.extraction_start_offset,e.extraction_end_offset,coalesce(cr.decision,'unreviewed') as review_state,
        coalesce(lv.labels,'[]'::json) as labels,coalesce(lc.label_count,0)::integer as label_count,
        (exists(select 1 from extraction_revision_evidence x where x.project_id=e.project_id and x.evidence_id=e.id)
          or exists(select 1 from claim_revision_evidence_supports x where x.project_id=e.project_id and x.evidence_id=e.id)
          or exists(select 1 from claim_revision_extraction_supports x join extraction_revision_evidence y on y.project_id=x.project_id and y.revision_id=x.extraction_revision_id where x.project_id=e.project_id and y.evidence_id=e.id)
          or exists(select 1 from synthesis_revision_supports x join extraction_revision_evidence y on y.project_id=x.project_id and y.revision_id=x.extraction_revision_id where x.project_id=e.project_id and y.evidence_id=e.id)
          or exists(select 1 from claim_revision_synthesis_supports x join synthesis_revision_supports y on y.project_id=x.project_id and y.synthesis_revision_id=x.synthesis_revision_id join extraction_revision_evidence z on z.project_id=y.project_id and z.revision_id=y.extraction_revision_id where x.project_id=e.project_id and z.evidence_id=e.id)) as is_used,
        exists(select 1 from walk more where more.position>${pageSize}) as has_more
      from state s left join visible w on true
      left join evidence e on e.project_id=${projectId} and e.id=w.evidence_id
      left join papers p on p.project_id=e.project_id and p.id=e.paper_id
      left join full_text_documents d on d.project_id=e.project_id and d.paper_id=e.paper_id and d.id=e.full_text_document_id
      left join current_review cr on cr.project_id=e.project_id and cr.evidence_id=e.id
      left join label_counts lc on lc.evidence_id=e.id left join label_values lv on lv.evidence_id=e.id
      order by w.position
    `));
    const first = result[0];
    if (!first) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set composition revision does not exist in this project");
    if (!Boolean(first.cursor_valid)) return invalidCursor();
    const revision = mapRevision(first);
    const items = result.flatMap((row) => { const item = memberFromRow(row); return item ? [item] : []; });
    const hasMore = Boolean(first.has_more);
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({
      v: 1, scope: "historical-members", projectId, evidenceSetId, revisionId, afterMembershipId: last.membershipId,
    }) : null;
    return { revision, pageSize, hasMore, items, nextCursor };
  }

  async function listAnnotationsPage(projectId: string, evidenceSetId: string, input: PageInput = {}) {
    ensureUuid(projectId, "Project"); ensureUuid(evidenceSetId, "Evidence Set");
    const pageSize = getPageSize(input.pageSize, EVIDENCE_SET_ANNOTATION_DEFAULT_PAGE_SIZE, EVIDENCE_SET_ANNOTATION_MAX_PAGE_SIZE);
    const cursor = decodeCursor<CursorData & { highWater: string; beforeSequence: string }>(input.cursor, "annotations", projectId, evidenceSetId);
    if (cursor && (!/^\d+$/.test(cursor.highWater) || !/^\d+$/.test(cursor.beforeSequence))) return invalidCursor();
    const result = rows(await db.execute(sql`
      with bounds as (
        select coalesce(${cursor?.highWater ?? null}::text, (
          select max(sequence)::text from evidence_set_annotations where project_id=${projectId} and evidence_set_id=${evidenceSetId}
        )) as high_water,
        ${cursor?.beforeSequence ?? null}::text as before_sequence
      ), page as (
        select a.id,a.sequence,a.created_at,left(a.body,${EVIDENCE_SET_TEXT_LIMITS.annotationPreview}) as body_preview,
          char_length(a.body)::integer as body_codepoint_length
        from evidence_set_annotations a cross join bounds b
        where a.project_id=${projectId} and a.evidence_set_id=${evidenceSetId}
          and a.sequence <= coalesce(b.high_water::bigint,0)
          and (b.before_sequence is null or a.sequence < b.before_sequence::bigint)
        order by a.sequence desc limit ${pageSize + 1}
      )
      select (select high_water from bounds) as high_water,page.* from page
      union all
      select (select high_water from bounds),null::uuid,null::bigint,null::timestamptz,null::text,null::integer
      where not exists(select 1 from page)
    `));
    const highWater = result[0]?.high_water == null ? "0" : String(result[0].high_water);
    const annotationRows = result.filter((row) => row.id != null);
    const hasMore = annotationRows.length > pageSize;
    const visible = annotationRows.slice(0,pageSize);
    const items = visible.map((row) => ({
      id: String(row.id), sequence: Number(row.sequence), createdAt: dateValue(row.created_at),
      bodyPreview: String(row.body_preview ?? ""), bodyCodePointLength: Number(row.body_codepoint_length),
    }));
    const last = visible.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({
      v:1,scope:"annotations",projectId,evidenceSetId,highWater,beforeSequence:String(last.sequence),
    }) : null;
    return { items,pageSize,hasMore,nextCursor,highWater };
  }

  async function getAnnotationDetail(projectId: string, evidenceSetId: string, annotationId: string) {
    ensureUuid(projectId,"Project");ensureUuid(evidenceSetId,"Evidence Set");ensureUuid(annotationId,"Annotation");
    const result=rows(await db.execute(sql`
      select id,sequence,created_at,left(body,${EVIDENCE_SET_TEXT_LIMITS.annotationDetail}) as body,
        char_length(body)::integer as body_codepoint_length
      from evidence_set_annotations where project_id=${projectId} and evidence_set_id=${evidenceSetId} and id=${annotationId} limit 1
    `));
    if (!result[0]) throw new DomainError("NOT_FOUND","Evidence Set annotation does not exist");
    return { id:String(result[0].id),sequence:Number(result[0].sequence),createdAt:dateValue(result[0].created_at),body:String(result[0].body),bodyCodePointLength:Number(result[0].body_codepoint_length) };
  }

  async function listSynthesisFieldOptionsPage(projectId: string, evidenceSetId: string, input: RevisionPageInput = {}) {
    ensureUuid(projectId, "Project"); ensureUuid(evidenceSetId, "Evidence Set");
    const pageSize = getPageSize(input.pageSize, EVIDENCE_SET_FIELD_DEFAULT_PAGE_SIZE, EVIDENCE_SET_FIELD_MAX_PAGE_SIZE);
    const expectedRevisionId = ensureUuid(input.expectedRevisionId ?? "", "Composition revision");
    const cursor = decodeCursor<CursorData & { sortOrder: number; fieldId: string }>(input.cursor, "fields", projectId, evidenceSetId);
    if (cursor && (!Number.isInteger(cursor.sortOrder) || typeof cursor.fieldId !== "string")) return invalidCursor();
    if (cursor) { ensureUuid(cursor.fieldId, "Extraction field"); expectRevisionCursor(cursor, expectedRevisionId); }
    const result = rows(await db.execute(sql`
      with latest_revision as (
        select id,sequence,set_ordinal,operation_kind,created_at,member_count,distinct_paper_count
        from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${evidenceSetId}
        order by set_ordinal desc limit 1
      ), eligible_field_ids as (
        select distinct er.field_id
        from latest_revision r
        join evidence_set_membership_order_versions ov on ov.project_id=${projectId} and ov.evidence_set_id=${evidenceSetId}
          and ov.valid_from_ordinal<=r.set_ordinal and (ov.valid_to_ordinal is null or r.set_ordinal<ov.valid_to_ordinal)
        join evidence_set_memberships m on m.project_id=ov.project_id and m.evidence_set_id=ov.evidence_set_id and m.id=ov.membership_id
        join extraction_revision_evidence ere on ere.project_id=m.project_id and ere.evidence_id=m.evidence_id
        join extraction_value_revisions er on er.project_id=ere.project_id and er.id=ere.revision_id and er.finalized_at is not null
        where r.id=${expectedRevisionId}::uuid
      ), page_ids as (
        select f.id as field_id,f.project_id,left(f.name,${EVIDENCE_SET_TEXT_LIMITS.extractionFieldName}) as field_name,
          left(f.description,${EVIDENCE_SET_TEXT_LIMITS.extractionFieldDescription}) as field_description,
          f.field_type,f.required,f.sort_order,f.created_at as field_created_at,f.updated_at as field_updated_at,f.archived_at as field_archived_at
        from eligible_field_ids eligible join extraction_fields f on f.project_id=${projectId} and f.id=eligible.field_id and f.archived_at is null
        where (${cursor===null} or (f.sort_order,f.id)>(${cursor?.sortOrder??0},${cursor?.fieldId??"00000000-0000-4000-8000-000000000000"}::uuid))
        order by f.sort_order,f.id limit ${pageSize+1}
      ), visible_fields as (
        select * from page_ids order by sort_order,field_id limit ${pageSize}
      ), field_counts as (
        select vf.field_id,count(distinct er.id)::integer as candidate_revision_count,count(distinct er.paper_id)::integer as candidate_paper_count
        from visible_fields vf
        join latest_revision r on r.id=${expectedRevisionId}::uuid
        join evidence_set_membership_order_versions ov on ov.project_id=${projectId} and ov.evidence_set_id=${evidenceSetId}
          and ov.valid_from_ordinal<=r.set_ordinal and (ov.valid_to_ordinal is null or r.set_ordinal<ov.valid_to_ordinal)
        join evidence_set_memberships m on m.project_id=ov.project_id and m.evidence_set_id=ov.evidence_set_id and m.id=ov.membership_id
        join extraction_revision_evidence ere on ere.project_id=m.project_id and ere.evidence_id=m.evidence_id
        join extraction_value_revisions er on er.project_id=ere.project_id and er.id=ere.revision_id and er.finalized_at is not null and er.field_id=vf.field_id
        group by vf.field_id
      )
      select r.id as revision_id,r.sequence as revision_sequence,r.set_ordinal::text as set_ordinal,r.operation_kind,
        r.created_at as revision_created_at,r.member_count,r.distinct_paper_count,
        vf.field_id,vf.project_id,vf.field_name,vf.field_description,vf.field_type,vf.required,vf.sort_order,
        vf.field_created_at,vf.field_updated_at,vf.field_archived_at,fc.candidate_revision_count,fc.candidate_paper_count,
        ((select count(*) from page_ids)>${pageSize}) as has_more
      from latest_revision r left join visible_fields vf on true left join field_counts fc on fc.field_id=vf.field_id
      union all
      select null::uuid,null::bigint,null::text,null::text,null::timestamptz,null::integer,null::integer,
        null::uuid,null::uuid,null::text,null::text,null::text,null::boolean,null::integer,null::timestamptz,null::timestamptz,null::timestamptz,null::integer,null::integer,false
      where not exists(select 1 from latest_revision)
    `));
    const first = result[0];
    if (!first?.revision_id) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set composition revision does not exist in this project");
    const revision = { id: String(first.revision_id), sequence: Number(first.revision_sequence), setOrdinal: String(first.set_ordinal),
      operationKind: String(first.operation_kind), createdAt: dateValue(first.revision_created_at), memberCount: Number(first.member_count), distinctPaperCount: Number(first.distinct_paper_count) };
    if (revision.id !== expectedRevisionId) return { revision, cursorStatus: "stale" as const, pageSize, items: [], hasMore: false, nextCursor: null };
    const visible = result.filter((row) => row.field_id != null);
    const hasMore = Boolean(first.has_more);
    const items = visible.map((row) => ({
      field: { id: String(row.field_id), projectId: String(row.project_id), name: String(row.field_name),
        description: row.field_description == null ? null : String(row.field_description), fieldType: String(row.field_type),
        required: Boolean(row.required), sortOrder: Number(row.sort_order), createdAt: dateValue(row.field_created_at),
        updatedAt: dateValue(row.field_updated_at), archivedAt: nullableDate(row.field_archived_at) },
      candidateRevisionCount: Number(row.candidate_revision_count ?? 0), candidatePaperCount: Number(row.candidate_paper_count ?? 0),
    }));
    const last = visible.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ v: 1, scope: "fields", projectId, evidenceSetId, revisionId: expectedRevisionId,
      sortOrder: Number(last.sort_order), fieldId: String(last.field_id) }) : null;
    return { revision, cursorStatus: "current" as const, pageSize, items, hasMore, nextCursor };
  }

  async function listRelatedExtractionRevisionsPage(projectId: string, evidenceSetId: string, input: RevisionPageInput = {}) {
    ensureUuid(projectId, "Project"); ensureUuid(evidenceSetId, "Evidence Set");
    const pageSize = getPageSize(input.pageSize, EVIDENCE_SET_RELATED_DEFAULT_PAGE_SIZE, EVIDENCE_SET_RELATED_MAX_PAGE_SIZE);
    const expectedRevisionId = ensureUuid(input.expectedRevisionId ?? "", "Composition revision");
    const cursor = decodeCursor<CursorData & { sequence: number; afterRevisionId: string }>(input.cursor, "related", projectId, evidenceSetId);
    if (cursor && (!Number.isInteger(cursor.sequence) || typeof cursor.afterRevisionId !== "string")) return invalidCursor();
    if (cursor) { ensureUuid(cursor.afterRevisionId, "Extraction revision"); expectRevisionCursor(cursor, expectedRevisionId); }
    const result = rows(await db.execute(sql`
      with latest_revision as (
        select id,set_ordinal from evidence_set_composition_revisions where project_id=${projectId} and evidence_set_id=${evidenceSetId}
        order by set_ordinal desc limit 1
      ), page as (
        select er.id,er.sequence,er.project_id,er.paper_id,er.field_id,left(ef.name,${EVIDENCE_SET_TEXT_LIMITS.extractionFieldName}) as field_name,
          er.value_state,er.finalized_at,left(p.title,${EVIDENCE_SET_TEXT_LIMITS.relatedPaperTitle}) as paper_title,
          exists(select 1 from extraction_value_revisions newer where newer.project_id=er.project_id and newer.extraction_value_id=er.extraction_value_id
            and newer.finalized_at is not null and newer.sequence>er.sequence) as has_newer
        from latest_revision r
        join extraction_value_revisions er on er.project_id=${projectId}
        join extraction_fields ef on ef.project_id=er.project_id and ef.id=er.field_id
        join papers p on p.project_id=er.project_id and p.id=er.paper_id
        where r.id=${expectedRevisionId}::uuid
          and exists(
            select 1 from extraction_revision_evidence ere
            join evidence_set_memberships m on m.project_id=ere.project_id and m.evidence_id=ere.evidence_id and m.evidence_set_id=${evidenceSetId}
            join evidence_set_membership_order_versions ov on ov.project_id=m.project_id and ov.evidence_set_id=m.evidence_set_id and ov.membership_id=m.id
              and ov.valid_from_ordinal<=r.set_ordinal and (ov.valid_to_ordinal is null or r.set_ordinal<ov.valid_to_ordinal)
            where ere.project_id=er.project_id and ere.revision_id=er.id
          )
          and (${cursor === null} or (er.sequence,er.id)>(${cursor?.sequence ?? 0},${cursor?.afterRevisionId ?? "00000000-0000-4000-8000-000000000000"}::uuid))
        order by er.sequence,er.id limit ${pageSize+1}
      )
      select r.id as revision_id,r.id as latest_revision_id,page.* from latest_revision r left join page on true
      union all
      select null::uuid,null::uuid,null::uuid,null::bigint,null::uuid,null::uuid,null::uuid,null::text,null::text,null::timestamptz,null::text,null::boolean
      where not exists(select 1 from latest_revision)
    `));
    const first = result[0];
    if (!first?.latest_revision_id) throw new DomainError("CROSS_PROJECT_REFERENCE", "Evidence Set does not belong to this project");
    const revisionId = String(first.latest_revision_id);
    if (revisionId !== expectedRevisionId) return { revisionId, cursorStatus: "stale" as const, pageSize, items: [], hasMore: false, nextCursor: null };
    const pageRows = result.filter((row) => row.id != null);
    const hasMore = pageRows.length > pageSize;
    const visible = pageRows.slice(0, pageSize);
    const items = visible.map((row) => ({ id: String(row.id), sequence: Number(row.sequence), paperId: String(row.paper_id), fieldId: String(row.field_id),
      fieldName: String(row.field_name), paperTitle: String(row.paper_title), valueState: String(row.value_state),
      finalizedAt: nullableDate(row.finalized_at), isCurrent: !Boolean(row.has_newer) }));
    const last = visible.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ v: 1, scope: "related", projectId, evidenceSetId, revisionId: expectedRevisionId,
      sequence: Number(last.sequence), afterRevisionId: String(last.id) }) : null;
    return { revisionId, cursorStatus: "current" as const, pageSize, items, hasMore, nextCursor };
  }

  return {
    getEvidenceSetWorkspace,
    listEvidenceSetCollectionPage,
    listActiveEvidenceSetOptions,
    listCurrentMembersPage,
    searchEvidenceSetCandidates,
    listCompositionHistoryPage,
    listRevisionMembersPage,
    listAnnotationsPage,
    getAnnotationDetail,
    listSynthesisFieldOptionsPage,
    listRelatedExtractionRevisionsPage,
  };
}
