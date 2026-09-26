import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { evidence, fullTextDocuments, paperFullTextPreferences, documentTextExtractions, documentTextExtractionPages } from "@/db/schema";
import type { DbTransaction } from "./types";

export class EvidenceRepository {
  constructor(private readonly db: Database) {}

  async create(values: typeof evidence.$inferInsert) {
    const [item] = await this.db.insert(evidence).values(values).returning();
    return item;
  }

  async findById(projectId: string, id: string) {
    const [item] = await this.db.select().from(evidence)
      .where(and(eq(evidence.projectId, projectId), eq(evidence.id, id))).limit(1);
    return item ?? null;
  }

  async list(projectId: string) {
    return this.db.select().from(evidence)
      .where(eq(evidence.projectId, projectId)).orderBy(desc(evidence.createdAt));
  }

  async listForPaper(projectId: string, paperId: string, tx: DbTransaction | Database = this.db) {
    const rows = await tx.select({
      item: evidence,
      currentReviewDecision: sql<string | null>`(
        select review.decision
        from evidence_review_decisions as review
        where review.project_id = evidence.project_id and review.evidence_id = evidence.id
        order by review.sequence desc
        limit 1
      )`,
    }).from(evidence)
      .where(and(eq(evidence.projectId, projectId), eq(evidence.paperId, paperId)))
      .orderBy(desc(evidence.createdAt));

    return rows.map(({ item, currentReviewDecision }) => ({ ...item, currentReviewDecision }));
  }

  async countForPaper(projectId: string, paperId: string) {
    const rows = await this.db.select({ id: evidence.id }).from(evidence)
      .where(and(eq(evidence.projectId, projectId), eq(evidence.paperId, paperId))).limit(1);
    return rows.length;
  }

  async delete(projectId: string, id: string) {
    return this.db.delete(evidence)
      .where(and(eq(evidence.projectId, projectId), eq(evidence.id, id))).returning({ id: evidence.id });
  }
}

export class FullTextDocumentRepository {
  constructor(private readonly db: Database) {}

  async findById(projectId: string, id: string) {
    const [item] = await this.db.select().from(fullTextDocuments)
      .where(and(eq(fullTextDocuments.projectId, projectId), eq(fullTextDocuments.id, id), eq(fullTextDocuments.storageState, "ready"))).limit(1);
    return item ?? null;
  }

  async findAnyById(projectId: string, id: string) {
    const [item] = await this.db.select().from(fullTextDocuments)
      .where(and(eq(fullTextDocuments.projectId, projectId), eq(fullTextDocuments.id, id))).limit(1);
    return item ?? null;
  }

  async listForPaper(projectId: string, paperId: string) {
    return this.db.select().from(fullTextDocuments)
      .where(and(eq(fullTextDocuments.projectId, projectId), eq(fullTextDocuments.paperId, paperId), eq(fullTextDocuments.storageState, "ready")))
      .orderBy(desc(fullTextDocuments.createdAt));
  }

  async activeBySha(tx: DbTransaction, projectId: string, paperId: string, sha256: string) {
    const [item] = await tx.select().from(fullTextDocuments)
      .where(and(eq(fullTextDocuments.projectId, projectId), eq(fullTextDocuments.paperId, paperId), eq(fullTextDocuments.sha256, sha256), isNull(fullTextDocuments.archivedAt))).limit(1);
    return item ?? null;
  }

  async findActiveBySha(projectId: string, paperId: string, sha256: string) {
    const [item] = await this.db.select().from(fullTextDocuments)
      .where(and(eq(fullTextDocuments.projectId, projectId), eq(fullTextDocuments.paperId, paperId), eq(fullTextDocuments.sha256, sha256), isNull(fullTextDocuments.archivedAt))).limit(1);
    return item ?? null;
  }

  async listPending(projectId: string | undefined, after: { createdAt: Date; id: string } | undefined, limit: number) {
    const filters = [eq(fullTextDocuments.storageState, "pending")];
    if (projectId) filters.push(eq(fullTextDocuments.projectId, projectId));
    if (after) filters.push(or(gt(fullTextDocuments.createdAt, after.createdAt), and(eq(fullTextDocuments.createdAt, after.createdAt), gt(fullTextDocuments.id, after.id)))!);
    return this.db.select().from(fullTextDocuments)
      .where(and(...filters))
      .orderBy(asc(fullTextDocuments.createdAt), asc(fullTextDocuments.id))
      .limit(limit);
  }

  async replacePendingStage(projectId: string, id: string, expectedStageKey: string, replacementStageKey: string) {
    const [item] = await this.db.update(fullTextDocuments)
      .set({ stagedStorageKey: replacementStageKey })
      .where(and(
        eq(fullTextDocuments.projectId, projectId),
        eq(fullTextDocuments.id, id),
        eq(fullTextDocuments.storageState, "pending"),
        eq(fullTextDocuments.stagedStorageKey, expectedStageKey),
      ))
      .returning();
    return item ?? null;
  }

  async markPendingReady(projectId: string, id: string, expectedStageKey: string) {
    const [item] = await this.db.update(fullTextDocuments)
      .set({ storageState: "ready", stagedStorageKey: null })
      .where(and(
        eq(fullTextDocuments.projectId, projectId),
        eq(fullTextDocuments.id, id),
        eq(fullTextDocuments.storageState, "pending"),
        eq(fullTextDocuments.stagedStorageKey, expectedStageKey),
      ))
      .returning();
    return item ?? null;
  }

  async create(tx: DbTransaction, values: typeof fullTextDocuments.$inferInsert) {
    const [item] = await tx.insert(fullTextDocuments).values(values).returning();
    return item;
  }

  async archive(projectId: string, id: string) {
    return this.db.update(fullTextDocuments)
      .set({ archivedAt: new Date() })
      .where(and(eq(fullTextDocuments.projectId, projectId), eq(fullTextDocuments.id, id), eq(fullTextDocuments.storageState, "ready")))
      .returning();
  }

  async getPreference(projectId: string, paperId: string) {
    const [item] = await this.db.select().from(paperFullTextPreferences)
      .where(and(eq(paperFullTextPreferences.projectId, projectId), eq(paperFullTextPreferences.paperId, paperId))).limit(1);
    return item ?? null;
  }

  async setPreference(projectId: string, paperId: string, fullTextDocumentId: string) {
    const [item] = await this.db.insert(paperFullTextPreferences)
      .values({ projectId, paperId, fullTextDocumentId })
      .onConflictDoUpdate({ target: [paperFullTextPreferences.projectId, paperFullTextPreferences.paperId], set: { fullTextDocumentId, updatedAt: new Date() } })
      .returning();
    return item;
  }

  async clearPreference(projectId: string, paperId: string) {
    return this.db.delete(paperFullTextPreferences)
      .where(and(eq(paperFullTextPreferences.projectId, projectId), eq(paperFullTextPreferences.paperId, paperId)))
      .returning();
  }
}

export class DocumentTextExtractionRepository {
  constructor(private readonly db: Database) {}

  async create(tx: DbTransaction, values: typeof documentTextExtractions.$inferInsert) {
    const [item] = await tx.insert(documentTextExtractions).values(values).returning();
    return item;
  }

  async createPages(tx: DbTransaction, values: (typeof documentTextExtractionPages.$inferInsert)[]) {
    if (!values.length) return [];
    return tx.insert(documentTextExtractionPages).values(values).returning();
  }

  async findById(projectId: string, id: string) {
    const [item] = await this.db.select().from(documentTextExtractions)
      .where(and(eq(documentTextExtractions.projectId, projectId), eq(documentTextExtractions.id, id))).limit(1);
    return item ?? null;
  }

  async listForDocument(projectId: string, fullTextDocumentId: string) {
    return this.db.select().from(documentTextExtractions)
      .where(and(eq(documentTextExtractions.projectId, projectId), eq(documentTextExtractions.fullTextDocumentId, fullTextDocumentId)))
      .orderBy(desc(documentTextExtractions.sequence));
  }

  async listPages(projectId: string, extractionId: string) {
    return this.db.select().from(documentTextExtractionPages)
      .where(and(eq(documentTextExtractionPages.projectId, projectId), eq(documentTextExtractionPages.documentTextExtractionId, extractionId)))
      .orderBy(documentTextExtractionPages.pageNumber);
  }

  async latestNonFailed(projectId: string, fullTextDocumentId: string) {
    const [item] = await this.db.select().from(documentTextExtractions)
      .where(and(
        eq(documentTextExtractions.projectId, projectId),
        eq(documentTextExtractions.fullTextDocumentId, fullTextDocumentId),
        sql`${documentTextExtractions.status} <> 'failed'`,
      ))
      .orderBy(desc(documentTextExtractions.sequence)).limit(1);
    return item ?? null;
  }
}
