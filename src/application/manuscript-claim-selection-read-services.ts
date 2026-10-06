import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";
import {
  canonicalSelectionBigint,
  canonicalSelectionUuid,
  decodePlacementSelectionCursor,
  decodeReplacementSelectionCursor,
  effectiveManuscriptClaimSelectionPageSize,
  encodePlacementSelectionCursor,
  encodeReplacementSelectionCursor,
  type PlacementSelectionCursor,
  type ReplacementSelectionCursor,
} from "./manuscript-claim-selection-cursor";

type ReadExecutor = Pick<Database, "execute">;
type RawRow = Record<string, unknown>;

export type ManuscriptClaimRevisionCandidate = {
  claimRevisionId: string;
  claimId: string;
  sequence: string;
  textPreview: string;
  textTruncated: boolean;
  isCurrent: boolean;
  finalizedAt: string;
};

export type ManuscriptClaimRevisionCandidatePage = {
  items: ManuscriptClaimRevisionCandidate[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type PlacementSelectionPage = {
  projectId: string;
  manuscript: { id: string; title: string };
  section: { id: string; title: string };
  page: ManuscriptClaimRevisionCandidatePage;
};

export type ReplacementSelectionPage = {
  projectId: string;
  manuscript: { id: string; title: string };
  placement: {
    id: string;
    sectionId: string;
    sectionTitle: string;
    claimId: string;
    claimRevisionId: string;
    sequence: string;
    claimLifecycle: "active" | "withdrawn";
  };
  page: ManuscriptClaimRevisionCandidatePage;
};

export type PlacementSelectionScope = {
  projectId: string;
  manuscriptId: string;
  manuscriptTitle: string;
  sectionId: string;
  sectionTitle: string;
};

export type ReplacementSelectionScope = {
  projectId: string;
  manuscriptId: string;
  manuscriptTitle: string;
  placementId: string;
  sectionId: string;
  sectionTitle: string;
  claimId: string;
  placedRevisionId: string;
  placedSequence: string;
  currentRevisionId: string | null;
  claimLifecycle: "active" | "withdrawn";
};

type PageRowsInput = {
  selectorType: "placement" | "replacement";
  projectId: string;
  pageSize: number;
  cursor: { selectorType: "placement" | "replacement"; lastSequence: string; lastRevisionId: string } | null;
  replacementScope?: ReplacementSelectionScope;
};

const READ_TRANSACTION = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
const READ_STATEMENT_TIMEOUT = sql`set local statement_timeout = '15000ms'`;

function rows(value: unknown): RawRow[] {
  return value as unknown as RawRow[];
}

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === 1;
}

function invalidScope(): DomainError {
  return new DomainError("NOT_FOUND", "Manuscript selection scope was not found");
}

async function withExecutor<T>(db: Database, executor: ReadExecutor | undefined, operation: (read: ReadExecutor) => Promise<T>): Promise<T> {
  const run = async (read: ReadExecutor) => {
    await read.execute(READ_STATEMENT_TIMEOUT);
    return operation(read);
  };
  if (executor) return run(executor);
  return db.transaction((tx) => run(tx), READ_TRANSACTION);
}

function currentClaimRevisionLateral(): SQL {
  return sql`join lateral (
    select current_r.id, current_r.state
    from claim_revisions current_r
    where current_r.project_id=r.project_id
      and current_r.claim_id=r.claim_id
      and current_r.finalized_at is not null
    order by current_r.sequence desc
    limit 1
  ) current_claim on true`;
}

function projectCandidateStream(projectId: string, limit: SQL, boundary: SQL): SQL {
  return sql`select r.id, r.claim_id, r.sequence, current_claim.id as current_revision_id
    from claim_revisions r
    ${currentClaimRevisionLateral()}
    where r.project_id=${projectId}::uuid
      and r.finalized_at is not null
      and r.state='active'
      and current_claim.state='active'
      ${boundary}
    order by r.sequence desc, r.id asc
    limit ${limit}`;
}

function replacementCandidateStream(scope: ReplacementSelectionScope, limit: SQL, boundary: SQL): SQL {
  return sql`select r.id, r.claim_id, r.sequence, ${scope.currentRevisionId}::uuid as current_revision_id
    from claim_revisions r
    where r.project_id=${scope.projectId}::uuid
      and r.claim_id=${scope.claimId}::uuid
      and r.finalized_at is not null
      and r.state='active'
      and r.sequence > ${scope.placedSequence}::bigint
      ${boundary}
    order by r.sequence desc, r.id asc
    limit ${limit}`;
}

function candidatePageQuery(input: PageRowsInput): SQL {
  const take = input.pageSize + 1;
  const stream = input.selectorType === "replacement" && input.replacementScope
    ? (boundary: SQL, limit: SQL) => replacementCandidateStream(input.replacementScope!, limit, boundary)
    : (boundary: SQL, limit: SQL) => projectCandidateStream(input.projectId, limit, boundary);

  if (!input.cursor) {
    const pageKeys = stream(sql``, sql`${take}`);
    return sql`with page_keys as materialized (${pageKeys}),
      page_meta as (select count(*) > ${input.pageSize} as has_more from page_keys),
      visible_keys as materialized (
        select id, claim_id, sequence, current_revision_id
        from page_keys
        order by sequence desc, id asc
        limit ${input.pageSize}
      )
      select visible.id::text as claim_revision_id,
        visible.claim_id::text as claim_id,
        visible.sequence::text as sequence,
        left(revision.claim_text, 600) as text_preview,
        (char_length(revision.claim_text) > 600) as text_truncated,
        (visible.id=visible.current_revision_id) as is_current,
        revision.finalized_at::text as finalized_at,
        page_meta.has_more
      from visible_keys visible
      join claim_revisions revision on revision.project_id=${input.projectId}::uuid and revision.id=visible.id
      cross join page_meta
      order by visible.sequence desc, visible.id asc`;
  }

  const sequence = input.cursor.lastSequence;
  const id = input.cursor.lastRevisionId;
  const equalBoundary = sql`and r.sequence=${sequence}::bigint and r.id>${id}::uuid`;
  const lowerBoundary = sql`and r.sequence<${sequence}::bigint`;
  const equalKeys = stream(equalBoundary, sql`${take}`);
  const lowerKeys = stream(lowerBoundary, sql`greatest(0, ${take} - (select count(*) from equal_keys))`);
  return sql`with equal_keys as materialized (${equalKeys}),
      lower_keys as materialized (${lowerKeys}),
      page_keys as materialized (
        select id, claim_id, sequence, current_revision_id from equal_keys
        union all
        select id, claim_id, sequence, current_revision_id from lower_keys
      ),
      page_meta as (select count(*) > ${input.pageSize} as has_more from page_keys),
      visible_keys as materialized (
        select id, claim_id, sequence, current_revision_id
        from page_keys
        order by sequence desc, id asc
        limit ${input.pageSize}
      )
      select visible.id::text as claim_revision_id,
        visible.claim_id::text as claim_id,
        visible.sequence::text as sequence,
        left(revision.claim_text, 600) as text_preview,
        (char_length(revision.claim_text) > 600) as text_truncated,
        (visible.id=visible.current_revision_id) as is_current,
        revision.finalized_at::text as finalized_at,
        page_meta.has_more
      from visible_keys visible
      join claim_revisions revision on revision.project_id=${input.projectId}::uuid and revision.id=visible.id
      cross join page_meta
      order by visible.sequence desc, visible.id asc`;
}

export function buildProjectClaimRevisionCandidatePageSql(input: {
  projectId: string;
  pageSize: number;
  cursor?: Pick<PlacementSelectionCursor, "lastSequence" | "lastRevisionId"> | null;
}): SQL {
  const cursor = input.cursor ? { selectorType: "placement" as const, lastSequence: input.cursor.lastSequence, lastRevisionId: input.cursor.lastRevisionId } : null;
  return candidatePageQuery({ selectorType: "placement", projectId: input.projectId, pageSize: input.pageSize, cursor });
}

export function buildReplacementClaimRevisionCandidatePageSql(input: {
  scope: ReplacementSelectionScope;
  pageSize: number;
  cursor?: Pick<ReplacementSelectionCursor, "lastSequence" | "lastRevisionId"> | null;
}): SQL {
  const cursor = input.cursor ? { selectorType: "replacement" as const, lastSequence: input.cursor.lastSequence, lastRevisionId: input.cursor.lastRevisionId } : null;
  return candidatePageQuery({ selectorType: "replacement", projectId: input.scope.projectId, pageSize: input.pageSize, cursor, replacementScope: input.scope });
}

function mapCandidatePage(
  resultRows: RawRow[],
  pageSize: number,
  encodeNext: (last: { sequence: string; claimRevisionId: string }) => string,
): ManuscriptClaimRevisionCandidatePage {
  const items = resultRows.map((row) => ({
    claimRevisionId: String(row.claim_revision_id),
    claimId: String(row.claim_id),
    sequence: canonicalSelectionBigint(String(row.sequence)),
    textPreview: String(row.text_preview ?? ""),
    textTruncated: bool(row.text_truncated),
    isCurrent: bool(row.is_current),
    finalizedAt: String(row.finalized_at),
  }));
  const hasMore = resultRows.length > 0 && bool(resultRows[0].has_more);
  const last = items.at(-1);
  return {
    items,
    pageSize,
    hasMore,
    nextCursor: hasMore && last ? encodeNext({ sequence: last.sequence, claimRevisionId: last.claimRevisionId }) : null,
  };
}

export function createManuscriptClaimSelectionReadServices(db: Database) {
  async function getPlacementClaimRevisionPage(
    projectIdInput: string,
    sectionIdInput: string,
    options: { pageSize?: number; cursor?: string | null } = {},
    executor?: ReadExecutor,
  ): Promise<PlacementSelectionPage> {
    const projectId = canonicalSelectionUuid(projectIdInput);
    const sectionId = canonicalSelectionUuid(sectionIdInput);
    const pageSize = effectiveManuscriptClaimSelectionPageSize(options.pageSize);
    return withExecutor(db, executor, async (read) => {
      const scope = rows(await read.execute(sql`
        select p.id::text as project_id, m.id::text as manuscript_id, left(m.title, 600) as manuscript_title,
          s.id::text as section_id, left(s.title, 600) as section_title
        from projects p
        join manuscripts m on m.project_id=p.id and m.is_default=true
        join manuscript_sections s on s.project_id=p.id and s.manuscript_id=m.id
          and s.id=${sectionId}::uuid and s.archived_at is null
        where p.id=${projectId}::uuid
        limit 1
      `))[0];
      if (!scope) throw invalidScope();
      const manuscriptId = canonicalSelectionUuid(String(scope.manuscript_id));
      const cursor = decodePlacementSelectionCursor(options.cursor, { projectId, manuscriptId, sectionId, pageSize });
      const pageRows = rows(await read.execute(buildProjectClaimRevisionCandidatePageSql({
        projectId,
        pageSize,
        cursor: cursor ? { lastSequence: cursor.lastSequence, lastRevisionId: cursor.lastRevisionId } : null,
      })));
      const page = mapCandidatePage(pageRows, pageSize, (last) => encodePlacementSelectionCursor({
        v: 1,
        selectorType: "placement",
        projectId,
        manuscriptId,
        sectionId,
        pageSize,
        lastSequence: last.sequence,
        lastRevisionId: last.claimRevisionId,
      }));
      return {
        projectId,
        manuscript: { id: manuscriptId, title: String(scope.manuscript_title) },
        section: { id: sectionId, title: String(scope.section_title) },
        page,
      };
    });
  }

  async function getPlacementReplacementClaimRevisionPage(
    projectIdInput: string,
    placementIdInput: string,
    options: { pageSize?: number; cursor?: string | null } = {},
    executor?: ReadExecutor,
  ): Promise<ReplacementSelectionPage> {
    const projectId = canonicalSelectionUuid(projectIdInput);
    const placementId = canonicalSelectionUuid(placementIdInput);
    const pageSize = effectiveManuscriptClaimSelectionPageSize(options.pageSize);
    return withExecutor(db, executor, async (read) => {
      const row = rows(await read.execute(sql`
        select p.id::text as project_id, m.id::text as manuscript_id, left(m.title, 600) as manuscript_title,
          placement.id::text as placement_id, placement.section_id::text as section_id,
          left(section.title, 600) as section_title, placement.claim_id::text as claim_id,
          placement.claim_revision_id::text as placed_revision_id,
          placed.sequence::text as placed_sequence,
          current_claim.id::text as current_revision_id,
          current_claim.state as claim_lifecycle
        from projects p
        join manuscripts m on m.project_id=p.id and m.is_default=true
        join manuscript_claim_placements placement on placement.project_id=p.id
          and placement.manuscript_id=m.id and placement.id=${placementId}::uuid
          and placement.removed_at is null
        join manuscript_sections section on section.project_id=p.id and section.manuscript_id=m.id
          and section.id=placement.section_id and section.archived_at is null
        join claims stable_claim on stable_claim.project_id=p.id and stable_claim.id=placement.claim_id
        join claim_revisions placed on placed.project_id=p.id and placed.claim_id=placement.claim_id
          and placed.id=placement.claim_revision_id
        left join lateral (
          select current_r.id, current_r.state
          from claim_revisions current_r
          where current_r.project_id=p.id and current_r.claim_id=placement.claim_id
            and current_r.finalized_at is not null
          order by current_r.sequence desc
          limit 1
        ) current_claim on true
        where p.id=${projectId}::uuid
        limit 1
      `))[0];
      if (!row) throw invalidScope();
      const scope: ReplacementSelectionScope = {
        projectId,
        manuscriptId: canonicalSelectionUuid(String(row.manuscript_id)),
        manuscriptTitle: String(row.manuscript_title),
        placementId: canonicalSelectionUuid(String(row.placement_id)),
        sectionId: canonicalSelectionUuid(String(row.section_id)),
        sectionTitle: String(row.section_title),
        claimId: canonicalSelectionUuid(String(row.claim_id)),
        placedRevisionId: canonicalSelectionUuid(String(row.placed_revision_id)),
        placedSequence: canonicalSelectionBigint(String(row.placed_sequence)),
        currentRevisionId: row.current_revision_id == null ? null : canonicalSelectionUuid(String(row.current_revision_id)),
        claimLifecycle: String(row.claim_lifecycle) === "active" ? "active" : "withdrawn",
      };
      const cursor = decodeReplacementSelectionCursor(options.cursor, {
        projectId,
        manuscriptId: scope.manuscriptId,
        placementId,
        claimId: scope.claimId,
        placedRevisionId: scope.placedRevisionId,
        placedSequence: scope.placedSequence,
        pageSize,
      });
      const pageRows = scope.claimLifecycle === "active" && scope.currentRevisionId !== null
        ? rows(await read.execute(buildReplacementClaimRevisionCandidatePageSql({
            scope,
            pageSize,
            cursor: cursor ? { lastSequence: cursor.lastSequence, lastRevisionId: cursor.lastRevisionId } : null,
          })))
        : [];
      const page = mapCandidatePage(pageRows, pageSize, (last) => encodeReplacementSelectionCursor({
        v: 1,
        selectorType: "replacement",
        projectId,
        manuscriptId: scope.manuscriptId,
        placementId,
        claimId: scope.claimId,
        placedRevisionId: scope.placedRevisionId,
        placedSequence: scope.placedSequence,
        pageSize,
        lastSequence: last.sequence,
        lastRevisionId: last.claimRevisionId,
      }));
      return {
        projectId,
        manuscript: { id: scope.manuscriptId, title: scope.manuscriptTitle },
        placement: {
          id: placementId,
          sectionId: scope.sectionId,
          sectionTitle: scope.sectionTitle,
          claimId: scope.claimId,
          claimRevisionId: scope.placedRevisionId,
          sequence: scope.placedSequence,
          claimLifecycle: scope.claimLifecycle,
        },
        page,
      };
    });
  }

  return { getPlacementClaimRevisionPage, getPlacementReplacementClaimRevisionPage };
}

export type ManuscriptClaimSelectionReadServices = ReturnType<typeof createManuscriptClaimSelectionReadServices>;
