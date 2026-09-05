import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { claimEvidence, claims, evidence, papers, projects, screeningCriteria, screeningDecisions } from "@/db/schema";

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

export class ScreeningCriterionRepository {
  constructor(private readonly db: Database) {}

  async create(values: typeof screeningCriteria.$inferInsert) {
    const [criterion] = await this.db.insert(screeningCriteria).values(values).returning();
    return criterion;
  }

  async findById(projectId: string, id: string) {
    const [criterion] = await this.db.select().from(screeningCriteria).where(and(
      eq(screeningCriteria.projectId, projectId), eq(screeningCriteria.id, id),
    )).limit(1);
    return criterion ?? null;
  }

  async list(projectId: string, includeArchived = false) {
    return this.db.select().from(screeningCriteria).where(and(
      eq(screeningCriteria.projectId, projectId),
      includeArchived ? undefined : sql`${screeningCriteria.archivedAt} is null`,
    )).orderBy(screeningCriteria.sortOrder);
  }

  async archive(projectId: string, id: string) {
    return this.db.update(screeningCriteria).set({ archivedAt: new Date() }).where(and(
      eq(screeningCriteria.projectId, projectId), eq(screeningCriteria.id, id),
    )).returning();
  }
}

export class ScreeningDecisionRepository {
  constructor(private readonly db: Database) {}

  async create(values: typeof screeningDecisions.$inferInsert) {
    const [decision] = await this.db.insert(screeningDecisions).values(values).returning();
    return decision;
  }

  async currentForPaper(projectId: string, paperId: string) {
    const [decision] = await this.db.select().from(screeningDecisions).where(and(
      eq(screeningDecisions.projectId, projectId),
      eq(screeningDecisions.paperId, paperId),
      eq(screeningDecisions.stage, "title_abstract"),
    )).orderBy(desc(screeningDecisions.sequence)).limit(1);
    return decision ?? null;
  }

  async listForPaper(projectId: string, paperId: string) {
    return this.db.select().from(screeningDecisions).where(and(
      eq(screeningDecisions.projectId, projectId), eq(screeningDecisions.paperId, paperId),
      eq(screeningDecisions.stage, "title_abstract"),
    )).orderBy(screeningDecisions.sequence);
  }

  async countForPaper(projectId: string, paperId: string) {
    const rows = await this.db.select({ id: screeningDecisions.id }).from(screeningDecisions).where(and(
      eq(screeningDecisions.projectId, projectId), eq(screeningDecisions.paperId, paperId),
    )).limit(1);
    return rows.length;
  }

  async listPapersWithCurrentState(projectId: string) {
    const rows = await this.db.execute(sql`
      select
        p.id, p.project_id, p.title, p.authors, p.publication_year, p.venue, p.doi,
        p.abstract, p.bibliographic_note, p.created_at, p.updated_at,
        d.id as decision_id, d.sequence as decision_sequence, d.stage as decision_stage,
        d.decision as decision_value, d.exclusion_criterion_id, d.exclusion_criterion_type,
        d.note as decision_note, d.created_at as decision_created_at
      from papers p
      left join lateral (
        select * from screening_decisions sd
        where sd.project_id = p.project_id and sd.paper_id = p.id and sd.stage = 'title_abstract'
        order by sd.sequence desc limit 1
      ) d on true
      where p.project_id = ${projectId}
      order by p.created_at asc, p.id asc
    `);
    return rows.map((row) => {
      const item = row as Record<string, unknown>;
      const decision = item.decision_id ? {
        id: String(item.decision_id), sequence: Number(item.decision_sequence), projectId: String(item.project_id),
        paperId: String(item.id), stage: item.decision_stage as "title_abstract",
        decision: item.decision_value as "include" | "exclude" | "maybe",
        exclusionCriterionId: item.exclusion_criterion_id ? String(item.exclusion_criterion_id) : null,
        exclusionCriterionType: item.exclusion_criterion_type as "exclusion" | null,
        note: item.decision_note ? String(item.decision_note) : null,
        createdAt: item.decision_created_at as Date,
      } : null;
      const state = decision ? ({ include: "included", exclude: "excluded", maybe: "maybe" }[decision.decision]) : "unscreened";
      return {
        id: String(item.id), projectId: String(item.project_id), title: String(item.title),
        authors: (item.authors as string[]) ?? [], publicationYear: item.publication_year as number | null,
        venue: item.venue as string | null, doi: item.doi as string | null,
        abstract: item.abstract as string | null, bibliographicNote: item.bibliographic_note as string | null,
        createdAt: item.created_at as Date, updatedAt: item.updated_at as Date,
        screeningState: state as "unscreened" | "included" | "excluded" | "maybe", currentDecision: decision,
      };
    });
  }
}
