import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { papers, projects } from "@/db/schema";
import type { DbTransaction } from "./types";

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  async create(values: typeof projects.$inferInsert) {
    const [project] = await this.db.insert(projects).values(values).returning();
    return project;
  }

  async findById(id: string) {
    const [project] = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return project ?? null;
  }
}

export class PaperRepository {
  constructor(private readonly db: Database) {}

  async create(values: typeof papers.$inferInsert) {
    const [paper] = await this.db.insert(papers).values(values).returning();
    return paper;
  }

  async findById(projectId: string, id: string) {
    const [paper] = await this.db.select().from(papers)
      .where(and(eq(papers.projectId, projectId), eq(papers.id, id))).limit(1);
    return paper ?? null;
  }

  async findForUpdate(tx: DbTransaction, projectId: string, id: string) {
    const [paper] = await tx.select().from(papers)
      .where(and(eq(papers.projectId, projectId), eq(papers.id, id))).for("update").limit(1);
    return paper ?? null;
  }

  async lockManyForUpdate(tx: DbTransaction, projectId: string, ids: string[]) {
    if (!ids.length) return [];
    return tx.select().from(papers)
      .where(and(eq(papers.projectId, projectId), sql`${papers.id} in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`))
      .orderBy(papers.id).for("update");
  }

  async list(projectId: string) {
    return this.db.select().from(papers)
      .where(eq(papers.projectId, projectId)).orderBy(desc(papers.createdAt));
  }

  async delete(projectId: string, id: string) {
    return this.db.delete(papers)
      .where(and(eq(papers.projectId, projectId), eq(papers.id, id))).returning({ id: papers.id });
  }
}
