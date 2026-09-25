import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { evidence, extractionFields, extractionOptions, extractionValues, extractionValueRevisions, extractionRevisionEvidence } from "@/db/schema";
import type { DbTransaction } from "./types";

export class ExtractionFieldRepository {
  constructor(private readonly db: Database) {}
  async create(tx: DbTransaction, values: typeof extractionFields.$inferInsert) { const [row] = await tx.insert(extractionFields).values(values).returning(); return row; }
  async findById(projectId: string, id: string) { const [row] = await this.db.select().from(extractionFields).where(and(eq(extractionFields.projectId, projectId), eq(extractionFields.id, id))).limit(1); return row ?? null; }
  async findForUpdate(tx: DbTransaction, projectId: string, id: string) { const [row] = await tx.select().from(extractionFields).where(and(eq(extractionFields.projectId, projectId), eq(extractionFields.id, id))).for("update").limit(1); return row ?? null; }
  async list(projectId: string, includeArchived = false) { return this.db.select().from(extractionFields).where(and(eq(extractionFields.projectId, projectId), includeArchived ? undefined : sql`${extractionFields.archivedAt} is null`)).orderBy(extractionFields.sortOrder, extractionFields.id); }
  async nextSortOrder(tx: DbTransaction, projectId: string) { const [row] = await tx.select({ maxSortOrder: sql<number | null>`max(${extractionFields.sortOrder})` }).from(extractionFields).where(eq(extractionFields.projectId, projectId)); return (row?.maxSortOrder ?? -1) + 1; }
  async update(tx: DbTransaction, projectId: string, id: string, values: Partial<typeof extractionFields.$inferInsert>) { return tx.update(extractionFields).set({ ...values, updatedAt: new Date() }).where(and(eq(extractionFields.projectId, projectId), eq(extractionFields.id, id))).returning(); }
  async archive(tx: DbTransaction, projectId: string, id: string) { return this.update(tx, projectId, id, { archivedAt: new Date() }); }
  async countValues(tx: DbTransaction, projectId: string, fieldId: string) { const rows = await tx.select({ id: extractionValues.id }).from(extractionValues).where(and(eq(extractionValues.projectId, projectId), eq(extractionValues.fieldId, fieldId))).limit(1); return rows.length; }
}

export class ExtractionOptionRepository {
  constructor(private readonly db: Database) {}
  async create(tx: DbTransaction, values: typeof extractionOptions.$inferInsert) { const [row] = await tx.insert(extractionOptions).values(values).returning(); return row; }
  async findById(projectId: string, id: string) { const [row] = await this.db.select().from(extractionOptions).where(and(eq(extractionOptions.projectId, projectId), eq(extractionOptions.id, id))).limit(1); return row ?? null; }
  async findForUpdate(tx: DbTransaction, projectId: string, id: string) { const [row] = await tx.select().from(extractionOptions).where(and(eq(extractionOptions.projectId, projectId), eq(extractionOptions.id, id))).for("update").limit(1); return row ?? null; }
  async listForField(projectId: string, fieldId: string, includeArchived = false) { return this.db.select().from(extractionOptions).where(and(eq(extractionOptions.projectId, projectId), eq(extractionOptions.fieldId, fieldId), includeArchived ? undefined : sql`${extractionOptions.archivedAt} is null`)).orderBy(extractionOptions.sortOrder, extractionOptions.id); }
  async nextSortOrder(tx: DbTransaction, projectId: string, fieldId: string) { const [row] = await tx.select({ maxSortOrder: sql<number | null>`max(${extractionOptions.sortOrder})` }).from(extractionOptions).where(and(eq(extractionOptions.projectId, projectId), eq(extractionOptions.fieldId, fieldId))); return (row?.maxSortOrder ?? -1) + 1; }
  async update(tx: DbTransaction, projectId: string, id: string, values: Partial<typeof extractionOptions.$inferInsert>) { return tx.update(extractionOptions).set({ ...values, updatedAt: new Date() }).where(and(eq(extractionOptions.projectId, projectId), eq(extractionOptions.id, id))).returning(); }
  async archive(tx: DbTransaction, projectId: string, id: string) { return this.update(tx, projectId, id, { archivedAt: new Date() }); }
  async countRevisions(projectId: string, optionId: string) { const rows = await this.db.select({ id: extractionValueRevisions.id }).from(extractionValueRevisions).where(and(eq(extractionValueRevisions.projectId, projectId), eq(extractionValueRevisions.optionId, optionId))).limit(1); return rows.length; }
}

/**
 * Locks existing Evidence used by a canonical Extraction write in UUID order.
 * The returned rows are read from the same transaction that owns these locks.
 */
export async function lockExtractionEvidenceRowsForUpdate(tx: DbTransaction, projectId: string, evidenceIds: string[]) {
  const locked: (typeof evidence.$inferSelect)[] = [];
  const canonicalEvidenceIds = [...new Set(evidenceIds.map((evidenceId) => evidenceId.toLowerCase()))].sort();
  for (const evidenceId of canonicalEvidenceIds) {
    const [row] = await tx.select().from(evidence)
      .where(and(eq(evidence.projectId, projectId), eq(evidence.id, evidenceId)))
      .for("update").limit(1);
    if (row) locked.push(row);
  }
  return locked;
}

export class ExtractionValueRepository {
  constructor(private readonly db: Database) {}
  async findSlot(projectId: string, paperId: string, fieldId: string) { const [row] = await this.db.select().from(extractionValues).where(and(eq(extractionValues.projectId, projectId), eq(extractionValues.paperId, paperId), eq(extractionValues.fieldId, fieldId))).limit(1); return row ?? null; }
  async createSlot(values: typeof extractionValues.$inferInsert) { const [row] = await this.db.insert(extractionValues).values(values).returning(); return row; }
  async listForPaper(projectId: string, paperId: string) { return this.db.select().from(extractionValues).where(and(eq(extractionValues.projectId, projectId), eq(extractionValues.paperId, paperId))); }
  async updateTimestamp(projectId: string, id: string) { return this.db.update(extractionValues).set({ updatedAt: new Date() }).where(and(eq(extractionValues.projectId, projectId), eq(extractionValues.id, id))).returning(); }
}

export class ExtractionRevisionRepository {
  constructor(private readonly db: Database) {}
  async create(values: typeof extractionValueRevisions.$inferInsert) { const [row] = await this.db.insert(extractionValueRevisions).values(values).returning(); return row; }
  async finalize(projectId: string, id: string) { const [row] = await this.db.update(extractionValueRevisions).set({ finalizedAt: new Date() }).where(and(eq(extractionValueRevisions.projectId, projectId), eq(extractionValueRevisions.id, id))).returning(); return row; }
  async current(projectId: string, extractionValueId: string) { const [row] = await this.db.select().from(extractionValueRevisions).where(and(eq(extractionValueRevisions.projectId, projectId), eq(extractionValueRevisions.extractionValueId, extractionValueId), sql`${extractionValueRevisions.finalizedAt} is not null`)).orderBy(desc(extractionValueRevisions.sequence)).limit(1); return row ?? null; }
  async list(projectId: string, extractionValueId: string) { return this.db.select().from(extractionValueRevisions).where(and(eq(extractionValueRevisions.projectId, projectId), eq(extractionValueRevisions.extractionValueId, extractionValueId), sql`${extractionValueRevisions.finalizedAt} is not null`)).orderBy(extractionValueRevisions.sequence); }
}

export class ExtractionRevisionEvidenceRepository {
  constructor(private readonly db: Database) {}
  async create(values: typeof extractionRevisionEvidence.$inferInsert) { const [row] = await this.db.insert(extractionRevisionEvidence).values(values).returning(); return row; }
  async listForRevision(projectId: string, paperId: string, revisionId: string) { return this.db.select({ link: extractionRevisionEvidence, item: evidence }).from(extractionRevisionEvidence).innerJoin(evidence, and(eq(evidence.projectId, extractionRevisionEvidence.projectId), eq(evidence.paperId, extractionRevisionEvidence.paperId), eq(evidence.id, extractionRevisionEvidence.evidenceId))).where(and(eq(extractionRevisionEvidence.projectId, projectId), eq(extractionRevisionEvidence.paperId, paperId), eq(extractionRevisionEvidence.revisionId, revisionId))).orderBy(evidence.pageNumber, evidence.createdAt); }
  async listForRevisions(projectId: string, paperId: string, revisionIds: string[]) { if (!revisionIds.length) return []; return this.db.select({ link: extractionRevisionEvidence, item: evidence }).from(extractionRevisionEvidence).innerJoin(evidence, and(eq(evidence.projectId, extractionRevisionEvidence.projectId), eq(evidence.paperId, extractionRevisionEvidence.paperId), eq(evidence.id, extractionRevisionEvidence.evidenceId))).where(and(eq(extractionRevisionEvidence.projectId, projectId), eq(extractionRevisionEvidence.paperId, paperId), sql`${extractionRevisionEvidence.revisionId} in ${sql.join(revisionIds.map((id) => sql`${id}::uuid`), sql`, `)}`)).orderBy(extractionRevisionEvidence.revisionId, evidence.pageNumber, evidence.createdAt); }
}
