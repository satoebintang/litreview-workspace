import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";

import { DomainError } from "@/domain/errors";

type Executor = Pick<Database, "execute">;
type Row = Record<string, unknown>;

const rows = (value: unknown) => value as unknown as Row[];

export type ActiveSectionItem = {
  id: string;
  sortOrder: number;
};

export type SectionBlockPlan = {
  projectId: string;
  manuscriptId: string;
  sectionId: string;
  insertAt: number;
  activeItemCount: number;
  proseText?: string;
  claimRevisionIds: readonly string[];
};

export type SectionBlockWriteResult = {
  proseItem: Row | null;
  proseBlock: Row | null;
  placements: Row[];
};

/**
 * The transaction writer owns only the SectionItem ordering mechanics. Callers
 * must perform ownership, eligibility, duplicate, and anchor validation before
 * calling writeSectionBlock. The Section row is the serialization boundary.
 */
export async function lockSection(executor: Executor, projectId: string, manuscriptId: string, sectionId: string) {
  await executor.execute(sql`select id from manuscript_sections where project_id=${projectId} and manuscript_id=${manuscriptId} and id=${sectionId} for update`);
}

export async function loadActiveSectionItems(executor: Executor, projectId: string, manuscriptId: string, sectionId: string): Promise<ActiveSectionItem[]> {
  return rows(await executor.execute(sql`select id, sort_order from manuscript_section_items where project_id=${projectId} and manuscript_id=${manuscriptId} and section_id=${sectionId} and removed_at is null order by sort_order, id`))
    .map((row) => ({ id: String(row.id), sortOrder: Number(row.sort_order) }));
}

export function planSectionBlock(input: {
  projectId: string;
  manuscriptId: string;
  sectionId: string;
  activeItems: readonly ActiveSectionItem[];
  position?: number;
  proseText?: string;
  claimRevisionIds?: readonly string[];
}): SectionBlockPlan {
  const claimRevisionIds = [...(input.claimRevisionIds ?? [])];
  if (new Set(claimRevisionIds).size !== claimRevisionIds.length) {
    throw new DomainError("VALIDATION_ERROR", "ClaimRevision IDs must be unique");
  }
  const blockSize = (input.proseText === undefined ? 0 : 1) + claimRevisionIds.length;
  if (blockSize === 0) throw new DomainError("VALIDATION_ERROR", "Section block cannot be empty");
  const insertAt = input.position ?? input.activeItems.length;
  if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > input.activeItems.length) {
    throw new DomainError("VALIDATION_ERROR", "Item position is outside the active Section range");
  }
  return {
    projectId: input.projectId,
    manuscriptId: input.manuscriptId,
    sectionId: input.sectionId,
    insertAt,
    activeItemCount: input.activeItems.length,
    proseText: input.proseText,
    claimRevisionIds,
  };
}

export async function writeSectionBlock(executor: Executor, plan: SectionBlockPlan): Promise<SectionBlockWriteResult> {
  const blockSize = (plan.proseText === undefined ? 0 : 1) + plan.claimRevisionIds.length;
  if (blockSize === 0) throw new DomainError("VALIDATION_ERROR", "Section block cannot be empty");
  if (plan.insertAt < 0 || plan.insertAt > plan.activeItemCount) {
    throw new DomainError("VALIDATION_ERROR", "Item position is outside the active Section range");
  }

  if (plan.insertAt < plan.activeItemCount) {
    await executor.execute(sql`update manuscript_section_items set sort_order=sort_order + ${blockSize} where project_id=${plan.projectId} and manuscript_id=${plan.manuscriptId} and section_id=${plan.sectionId} and removed_at is null and sort_order >= ${plan.insertAt}`);
  }

  let proseItem: Row | null = null;
  let proseBlock: Row | null = null;
  let offset = 0;
  if (plan.proseText !== undefined) {
    proseItem = rows(await executor.execute(sql`insert into manuscript_section_items (project_id, manuscript_id, section_id, item_type, sort_order) values (${plan.projectId}, ${plan.manuscriptId}, ${plan.sectionId}, 'prose', ${plan.insertAt}) returning id, project_id, manuscript_id, section_id, item_type, sort_order, created_at, removed_at`))[0] ?? null;
    if (!proseItem) throw new DomainError("DATABASE_CONSTRAINT", "Prose SectionItem could not be created");
    proseBlock = rows(await executor.execute(sql`insert into manuscript_prose_blocks (id, project_id, manuscript_id, section_id, section_item_id, item_type, text) values (${proseItem.id}, ${plan.projectId}, ${plan.manuscriptId}, ${plan.sectionId}, ${proseItem.id}, 'prose', ${plan.proseText}) returning id, project_id, section_item_id, text, created_at, updated_at`))[0] ?? null;
    if (!proseBlock) throw new DomainError("DATABASE_CONSTRAINT", "Prose block could not be created");
    offset = 1;
  }

  const placements: Row[] = [];
  for (const [index, claimRevisionId] of plan.claimRevisionIds.entries()) {
    const placement = rows(await executor.execute(sql`insert into manuscript_claim_placements (project_id, manuscript_id, section_id, claim_id, claim_revision_id) select ${plan.projectId}, ${plan.manuscriptId}, ${plan.sectionId}, claim_id, ${claimRevisionId} from claim_revisions where project_id=${plan.projectId} and id=${claimRevisionId} returning id, project_id, manuscript_id, section_id, claim_id, claim_revision_id, created_at, removed_at`))[0];
    if (!placement) throw new DomainError("DATABASE_CONSTRAINT", "Claim placement could not be created");
    await executor.execute(sql`insert into manuscript_section_items (id, project_id, manuscript_id, section_id, item_type, sort_order) values (${placement.id}, ${plan.projectId}, ${plan.manuscriptId}, ${plan.sectionId}, 'claim', ${plan.insertAt + offset + index})`);
    await executor.execute(sql`insert into manuscript_section_item_claims (section_item_id, project_id, manuscript_id, section_id, item_type, placement_id) values (${placement.id}, ${plan.projectId}, ${plan.manuscriptId}, ${plan.sectionId}, 'claim', ${placement.id})`);
    placements.push(placement);
  }

  return { proseItem, proseBlock, placements };
}
