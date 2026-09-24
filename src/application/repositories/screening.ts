import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { screeningCriteria, screeningDecisions, fullTextScreeningCriteria, fullTextScreeningDecisions, fullTextRetrievalAttempts } from "@/db/schema";
import type { DbTransaction } from "./types";

export class ScreeningCriterionRepository {
  constructor(private readonly db: Database) {}

  async create(values: typeof screeningCriteria.$inferInsert) {
    const [criterion] = await this.db.insert(screeningCriteria).values(values).returning();
    return criterion;
  }

  async findById(projectId: string, id: string, tx: DbTransaction | Database = this.db) {
    const [criterion] = await tx.select().from(screeningCriteria).where(and(
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

  async create(values: typeof screeningDecisions.$inferInsert, tx: DbTransaction = this.db as unknown as DbTransaction) {
    const [decision] = await tx.insert(screeningDecisions).values(values).returning();
    return decision;
  }

  async currentForPaper(projectId: string, paperId: string, tx: DbTransaction | Database = this.db) {
    const [decision] = await tx.select().from(screeningDecisions).where(and(
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

  async listForPaperWithCriteria(projectId: string, paperId: string) {
    const rows = await this.db.select({ decision: screeningDecisions, exclusionCriterion: screeningCriteria })
      .from(screeningDecisions)
      .leftJoin(screeningCriteria, and(
        eq(screeningCriteria.projectId, screeningDecisions.projectId),
        eq(screeningCriteria.id, screeningDecisions.exclusionCriterionId),
      ))
      .where(and(
        eq(screeningDecisions.projectId, projectId), eq(screeningDecisions.paperId, paperId),
        eq(screeningDecisions.stage, "title_abstract"),
      ))
      .orderBy(screeningDecisions.sequence);
    return rows.map(({ decision, exclusionCriterion }) => ({ ...decision, exclusionCriterion }));
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

export class FullTextScreeningCriterionRepository {
  constructor(private readonly db: Database) {}

  async create(values: typeof fullTextScreeningCriteria.$inferInsert) {
    const [criterion] = await this.db.insert(fullTextScreeningCriteria).values(values).returning();
    return criterion;
  }

  async findById(projectId: string, id: string, tx: DbTransaction | Database = this.db) {
    const [criterion] = await tx.select().from(fullTextScreeningCriteria).where(and(
      eq(fullTextScreeningCriteria.projectId, projectId), eq(fullTextScreeningCriteria.id, id),
    )).limit(1);
    return criterion ?? null;
  }

  async list(projectId: string, includeArchived = false) {
    return this.db.select().from(fullTextScreeningCriteria).where(and(
      eq(fullTextScreeningCriteria.projectId, projectId),
      includeArchived ? undefined : sql`${fullTextScreeningCriteria.archivedAt} is null`,
    )).orderBy(fullTextScreeningCriteria.sortOrder, fullTextScreeningCriteria.id);
  }

  async archive(projectId: string, id: string) {
    return this.db.update(fullTextScreeningCriteria).set({ archivedAt: new Date() }).where(and(
      eq(fullTextScreeningCriteria.projectId, projectId), eq(fullTextScreeningCriteria.id, id),
    )).returning();
  }
}

export class FullTextScreeningDecisionRepository {
  constructor(private readonly db: Database) {}

  async create(values: typeof fullTextScreeningDecisions.$inferInsert, tx: DbTransaction = this.db as unknown as DbTransaction) {
    const [decision] = await tx.insert(fullTextScreeningDecisions).values(values).returning();
    return decision;
  }

  async currentForPaper(projectId: string, paperId: string, tx: DbTransaction | Database = this.db) {
    const [decision] = await tx.select().from(fullTextScreeningDecisions).where(and(
      eq(fullTextScreeningDecisions.projectId, projectId), eq(fullTextScreeningDecisions.paperId, paperId),
    )).orderBy(desc(fullTextScreeningDecisions.sequence)).limit(1);
    return decision ?? null;
  }

  async listForPaper(projectId: string, paperId: string, tx: DbTransaction | Database = this.db) {
    return tx.select().from(fullTextScreeningDecisions).where(and(
      eq(fullTextScreeningDecisions.projectId, projectId), eq(fullTextScreeningDecisions.paperId, paperId),
    )).orderBy(fullTextScreeningDecisions.sequence);
  }

  async listForPaperWithCriteria(projectId: string, paperId: string) {
    const rows = await this.db.select({ decision: fullTextScreeningDecisions, exclusionCriterion: fullTextScreeningCriteria })
      .from(fullTextScreeningDecisions)
      .leftJoin(fullTextScreeningCriteria, and(
        eq(fullTextScreeningCriteria.projectId, fullTextScreeningDecisions.projectId),
        eq(fullTextScreeningCriteria.id, fullTextScreeningDecisions.exclusionCriterionId),
      ))
      .where(and(
        eq(fullTextScreeningDecisions.projectId, projectId), eq(fullTextScreeningDecisions.paperId, paperId),
      ))
      .orderBy(fullTextScreeningDecisions.sequence);
    return rows.map(({ decision, exclusionCriterion }) => ({ ...decision, exclusionCriterion }));
  }
}

export class FullTextRetrievalAttemptRepository {
  constructor(private readonly db: Database) {}

  async create(values: typeof fullTextRetrievalAttempts.$inferInsert, tx: DbTransaction = this.db as unknown as DbTransaction) {
    const [attempt] = await tx.insert(fullTextRetrievalAttempts).values(values).returning();
    return attempt;
  }

  async currentForPaper(projectId: string, paperId: string, tx: DbTransaction | Database = this.db) {
    const [attempt] = await tx.select().from(fullTextRetrievalAttempts).where(and(
      eq(fullTextRetrievalAttempts.projectId, projectId), eq(fullTextRetrievalAttempts.paperId, paperId),
    )).orderBy(desc(fullTextRetrievalAttempts.sequence)).limit(1);
    return attempt ?? null;
  }

  async listForPaper(projectId: string, paperId: string, tx: DbTransaction | Database = this.db) {
    return tx.select().from(fullTextRetrievalAttempts).where(and(
      eq(fullTextRetrievalAttempts.projectId, projectId), eq(fullTextRetrievalAttempts.paperId, paperId),
    )).orderBy(fullTextRetrievalAttempts.sequence);
  }

  async hasAnyForPaper(projectId: string, paperId: string, tx: DbTransaction | Database = this.db) {
    const rows = await tx.select({ id: fullTextRetrievalAttempts.id }).from(fullTextRetrievalAttempts).where(and(
      eq(fullTextRetrievalAttempts.projectId, projectId), eq(fullTextRetrievalAttempts.paperId, paperId),
    )).limit(1);
    return rows.length > 0;
  }

  async everRetrievedForPaper(projectId: string, paperId: string, tx: DbTransaction | Database = this.db) {
    const rows = await tx.select({ id: fullTextRetrievalAttempts.id }).from(fullTextRetrievalAttempts).where(and(
      eq(fullTextRetrievalAttempts.projectId, projectId), eq(fullTextRetrievalAttempts.paperId, paperId),
      eq(fullTextRetrievalAttempts.outcome, "retrieved"),
    )).limit(1);
    return rows.length > 0;
  }
}

export class PaperReviewRepository {
  constructor(private readonly db: Database) {}

  async list(projectId: string, tx: DbTransaction | Database = this.db) {
    return tx.execute(sql`
      with latest_title_abstract as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from screening_decisions
        where project_id=${projectId} and stage='title_abstract'
        order by project_id, paper_id, sequence desc
      ), latest_full_text as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from full_text_screening_decisions
        where project_id=${projectId}
        order by project_id, paper_id, sequence desc
      ), latest_retrieval as (
        select distinct on (project_id, paper_id) project_id, paper_id, outcome
        from full_text_retrieval_attempts
        where project_id=${projectId}
        order by project_id, paper_id, sequence desc
      ), retrieval_history as (
        select distinct project_id, paper_id
        from full_text_retrieval_attempts
        where project_id=${projectId}
      ), retrieval_success as (
        select distinct project_id, paper_id
        from full_text_retrieval_attempts
        where project_id=${projectId} and outcome='retrieved'
      ), analytical_history as (
        select distinct project_id, paper_id
        from extraction_value_revisions
        where project_id=${projectId} and finalized_at is not null
      )
      select p.id as paper_id, p.project_id, ta.decision as title_abstract_decision,
        ft.decision as full_text_decision,
        lr.outcome as full_text_retrieval_state,
        (rh.paper_id is not null) as has_full_text_retrieval_attempts,
        (rs.paper_id is not null) as ever_retrieved,
        (ah.paper_id is not null) as has_analytical_history
      from papers p
      left join latest_title_abstract ta on ta.project_id=p.project_id and ta.paper_id=p.id
      left join latest_full_text ft on ft.project_id=p.project_id and ft.paper_id=p.id
      left join latest_retrieval lr on lr.project_id=p.project_id and lr.paper_id=p.id
      left join retrieval_history rh on rh.project_id=p.project_id and rh.paper_id=p.id
      left join retrieval_success rs on rs.project_id=p.project_id and rs.paper_id=p.id
      left join analytical_history ah on ah.project_id=p.project_id and ah.paper_id=p.id
      where p.project_id=${projectId}
      order by p.id
    `);
  }

  async find(projectId: string, paperId: string, tx: DbTransaction | Database = this.db) {
    const rows = await tx.execute(sql`
      with latest_title_abstract as (
        select decision
        from screening_decisions
        where project_id=${projectId} and paper_id=${paperId} and stage='title_abstract'
        order by sequence desc
        limit 1
      ), latest_full_text as (
        select decision
        from full_text_screening_decisions
        where project_id=${projectId} and paper_id=${paperId}
        order by sequence desc
        limit 1
      ), latest_retrieval as (
        select outcome
        from full_text_retrieval_attempts
        where project_id=${projectId} and paper_id=${paperId}
        order by sequence desc
        limit 1
      ), retrieval_history as (
        select exists(select 1 from full_text_retrieval_attempts where project_id=${projectId} and paper_id=${paperId}) as has_full_text_retrieval_attempts
      ), retrieval_success as (
        select exists(select 1 from full_text_retrieval_attempts where project_id=${projectId} and paper_id=${paperId} and outcome='retrieved') as ever_retrieved
      ), analytical_history as (
        select exists (
          select 1 from extraction_value_revisions
          where project_id=${projectId} and paper_id=${paperId} and finalized_at is not null
        ) as has_analytical_history
      )
      select
        (select decision from latest_title_abstract) as title_abstract_decision,
        (select decision from latest_full_text) as full_text_decision,
        (select outcome from latest_retrieval) as full_text_retrieval_state,
        (select has_full_text_retrieval_attempts from retrieval_history) as has_full_text_retrieval_attempts,
        (select ever_retrieved from retrieval_success) as ever_retrieved,
        (select has_analytical_history from analytical_history) as has_analytical_history
      from papers p
      where p.project_id=${projectId} and p.id=${paperId}
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }
}
