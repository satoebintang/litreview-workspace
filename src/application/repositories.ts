import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { claimEvidence, claims, evidence, papers, projects } from "@/db/schema";

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

  async list(projectId: string) {
    return this.db.select().from(papers)
      .where(eq(papers.projectId, projectId)).orderBy(desc(papers.createdAt));
  }

  async delete(projectId: string, id: string) {
    return this.db.delete(papers)
      .where(and(eq(papers.projectId, projectId), eq(papers.id, id))).returning({ id: papers.id });
  }
}

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

export class ClaimRepository {
  constructor(private readonly db: Database) {}

  async create(values: typeof claims.$inferInsert) {
    const [claim] = await this.db.insert(claims).values(values).returning();
    return claim;
  }

  async findById(projectId: string, id: string) {
    const [claim] = await this.db.select().from(claims)
      .where(and(eq(claims.projectId, projectId), eq(claims.id, id))).limit(1);
    return claim ?? null;
  }

  async list(projectId: string) {
    return this.db.select().from(claims)
      .where(eq(claims.projectId, projectId)).orderBy(desc(claims.createdAt));
  }

  async delete(projectId: string, id: string) {
    return this.db.delete(claims)
      .where(and(eq(claims.projectId, projectId), eq(claims.id, id))).returning({ id: claims.id });
  }
}

export class ClaimEvidenceRepository {
  constructor(private readonly db: Database) {}

  async find(projectId: string, claimId: string, evidenceId: string) {
    const [link] = await this.db.select().from(claimEvidence).where(and(
      eq(claimEvidence.projectId, projectId),
      eq(claimEvidence.claimId, claimId),
      eq(claimEvidence.evidenceId, evidenceId),
    )).limit(1);
    return link ?? null;
  }

  async listForClaim(projectId: string, claimId: string) {
    return this.db.select().from(claimEvidence).where(and(
      eq(claimEvidence.projectId, projectId), eq(claimEvidence.claimId, claimId),
    )).orderBy(desc(claimEvidence.createdAt));
  }

  async countForEvidence(projectId: string, evidenceId: string) {
    const rows = await this.db.select({ claimId: claimEvidence.claimId }).from(claimEvidence)
      .where(and(eq(claimEvidence.projectId, projectId), eq(claimEvidence.evidenceId, evidenceId))).limit(1);
    return rows.length;
  }

  async create(values: typeof claimEvidence.$inferInsert) {
    const [link] = await this.db.insert(claimEvidence).values(values).returning();
    return link;
  }

  async delete(projectId: string, claimId: string, evidenceId: string) {
    return this.db.delete(claimEvidence).where(and(
      eq(claimEvidence.projectId, projectId),
      eq(claimEvidence.claimId, claimId),
      eq(claimEvidence.evidenceId, evidenceId),
    )).returning({ claimId: claimEvidence.claimId });
  }
}
