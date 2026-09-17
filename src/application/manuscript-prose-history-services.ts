import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { DomainError } from "@/domain/errors";

type Row = Record<string, unknown>;
const rows = (value: unknown) => value as unknown as Row[];
const date = (value: unknown) => value as Date;
const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("VALIDATION_ERROR", "Identifier must be a UUID");
  }
  return value;
};

export type ProseRevisionHistoryOptions = {
  beforeSequence?: number;
  limit?: number;
};

export type ManuscriptProseRevisionHistory = {
  projectId: string;
  manuscriptId: string;
  proseBlockId: string;
  section: {
    id: string;
    title: string;
    sectionType: string;
    archivedAt: Date | null;
  };
  item: {
    id: string;
    sortOrder: number;
    createdAt: Date;
    removedAt: Date | null;
  };
  revisionCount: number;
  revisions: Array<{
    id: string;
    projectId: string;
    proseBlockId: string;
    sequence: number;
    ordinal: number;
    proseText: string;
    createdAt: Date;
    isCurrent: boolean;
  }>;
  nextBeforeSequence: number | null;
};

export type ManuscriptProseRevisionComparison = {
  projectId: string;
  manuscriptId: string;
  proseBlockId: string;
  section: ManuscriptProseRevisionHistory["section"];
  item: ManuscriptProseRevisionHistory["item"];
  left: ManuscriptProseRevisionHistory["revisions"][number];
  right: ManuscriptProseRevisionHistory["revisions"][number];
};

function mapHistoryRevision(row: Row, currentSequence: number) {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    proseBlockId: String(row.prose_block_id),
    sequence: Number(row.sequence),
    ordinal: Number(row.ordinal),
    proseText: String(row.prose_text),
    createdAt: date(row.created_at),
    isCurrent: Number(row.sequence) === currentSequence,
  };
}

/** Read-only item-level Prose history. Currentness is derived by sequence;
 * no pointer or historical comparison state is persisted. */
export function createManuscriptProseHistoryServices(db: Database) {
  async function requireManuscript(projectId: string, manuscriptId: string) {
    uuid(projectId);
    uuid(manuscriptId);
    const row = rows(await db.execute(sql`
      select id from manuscripts
      where project_id=${projectId} and id=${manuscriptId}
      limit 1
    `))[0];
    if (!row) throw new DomainError("CROSS_PROJECT_REFERENCE", "Manuscript does not belong to this project");
  }

  async function loadContext(projectId: string, manuscriptId: string, proseBlockId: string) {
    const row = rows(await db.execute(sql`
      select p.id as prose_block_id, p.project_id, p.manuscript_id,
             i.id as item_id, i.sort_order, i.created_at as item_created_at,
             i.removed_at, s.id as section_id, s.title as section_title,
             s.section_type, s.archived_at
      from manuscript_prose_blocks p
      join manuscript_section_items i
        on i.project_id=p.project_id and i.manuscript_id=p.manuscript_id
       and i.section_id=p.section_id and i.id=p.section_item_id and i.item_type='prose'
      join manuscript_sections s
        on s.project_id=p.project_id and s.manuscript_id=p.manuscript_id and s.id=p.section_id
      where p.project_id=${projectId} and p.manuscript_id=${manuscriptId} and p.id=${proseBlockId}
      limit 1
    `))[0];
    if (!row) throw new DomainError("NOT_FOUND", "Prose block was not found");
    return {
      projectId,
      manuscriptId,
      proseBlockId,
      section: {
        id: String(row.section_id),
        title: String(row.section_title),
        sectionType: String(row.section_type),
        archivedAt: row.archived_at == null ? null : date(row.archived_at),
      },
      item: {
        id: String(row.item_id),
        sortOrder: Number(row.sort_order),
        createdAt: date(row.item_created_at),
        removedAt: row.removed_at == null ? null : date(row.removed_at),
      },
    };
  }

  async function getProseRevisionHistory(projectId: string, manuscriptId: string, proseBlockId: string, options: ProseRevisionHistoryOptions = {}): Promise<ManuscriptProseRevisionHistory> {
    await requireManuscript(projectId, manuscriptId);
    uuid(proseBlockId);
    const context = await loadContext(projectId, manuscriptId, proseBlockId);
    const limit = options.limit === undefined ? 50 : options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError("VALIDATION_ERROR", "History limit must be between 1 and 100");
    if (options.beforeSequence !== undefined && (!Number.isInteger(options.beforeSequence) || options.beforeSequence < 1)) {
      throw new DomainError("VALIDATION_ERROR", "History cursor must be a positive sequence");
    }
    const [countRow, currentRow, revisionRows] = await Promise.all([
      db.execute(sql`select count(*)::int as revision_count from manuscript_prose_revisions where project_id=${projectId} and prose_block_id=${proseBlockId}`),
      db.execute(sql`select sequence from manuscript_prose_revisions where project_id=${projectId} and prose_block_id=${proseBlockId} order by sequence desc limit 1`),
      db.execute(sql`
        select r.id, r.project_id, r.prose_block_id, r.sequence, r.prose_text, r.created_at,
               (select count(*)::int
                from manuscript_prose_revisions before_r
                where before_r.project_id=r.project_id
                  and before_r.prose_block_id=r.prose_block_id
                  and before_r.sequence <= r.sequence) as ordinal
        from manuscript_prose_revisions r
        where r.project_id=${projectId} and r.prose_block_id=${proseBlockId}
          ${options.beforeSequence === undefined ? sql`` : sql`and r.sequence < ${options.beforeSequence}`}
        order by r.sequence desc
         limit ${limit + 1}
      `),
    ]);
    const revisionCount = Number(rows(countRow)[0]?.revision_count ?? 0);
    const currentSequence = Number(rows(currentRow)[0]?.sequence ?? 0);
    const fetched = rows(revisionRows);
    const hasMore = fetched.length > limit;
    const revisions = fetched.slice(0, limit).map((row) => mapHistoryRevision(row, currentSequence));
    return {
      ...context,
      revisionCount,
      revisions,
      nextBeforeSequence: hasMore && revisions.length > 0 ? revisions[revisions.length - 1].sequence : null,
    };
  }

  async function getProseRevisionComparison(projectId: string, manuscriptId: string, proseBlockId: string, leftRevisionId: string, rightRevisionId: string): Promise<ManuscriptProseRevisionComparison> {
    await requireManuscript(projectId, manuscriptId);
    uuid(proseBlockId);
    uuid(leftRevisionId);
    uuid(rightRevisionId);
    const context = await loadContext(projectId, manuscriptId, proseBlockId);
    const revisionRows = rows(await db.execute(sql`
      select r.id, r.project_id, r.prose_block_id, r.sequence, r.prose_text, r.created_at,
             (select count(*) from manuscript_prose_revisions before_r
              where before_r.project_id=r.project_id and before_r.prose_block_id=r.prose_block_id
                and before_r.sequence <= r.sequence)::int as ordinal
      from manuscript_prose_revisions r
      where r.project_id=${projectId} and r.prose_block_id=${proseBlockId}
        and r.id in (${leftRevisionId}::uuid, ${rightRevisionId}::uuid)
      order by r.sequence
    `));
    if (revisionRows.length !== 2 || !revisionRows.some((row) => String(row.id) === leftRevisionId) || !revisionRows.some((row) => String(row.id) === rightRevisionId)) {
      throw new DomainError("CROSS_PROJECT_REFERENCE", "Both Prose revisions must belong to the same Prose block");
    }
    const currentSequence = Number(rows(await db.execute(sql`select sequence from manuscript_prose_revisions where project_id=${projectId} and prose_block_id=${proseBlockId} order by sequence desc limit 1`))[0]?.sequence ?? 0);
    const mapped = new Map(revisionRows.map((row) => [String(row.id), mapHistoryRevision(row, currentSequence)]));
    return { ...context, left: mapped.get(leftRevisionId)!, right: mapped.get(rightRevisionId)! };
  }

  return { getProseRevisionHistory, getProseRevisionComparison };
}
