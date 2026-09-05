import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { claimEvidence, claims, evidence, papers, projects, screeningCriteria, screeningDecisions, extractionFields, extractionOptions, extractionValues, extractionValueRevisions, extractionRevisionEvidence, synthesisStatements, synthesisRevisions, synthesisRevisionSupports } from "@/db/schema";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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

export class ExtractionFieldRepository {
  constructor(private readonly db: Database) {}
  async create(values: typeof extractionFields.$inferInsert) { const [row] = await this.db.insert(extractionFields).values(values).returning(); return row; }
  async findById(projectId: string, id: string) { const [row] = await this.db.select().from(extractionFields).where(and(eq(extractionFields.projectId, projectId), eq(extractionFields.id, id))).limit(1); return row ?? null; }
  async list(projectId: string, includeArchived = false) { return this.db.select().from(extractionFields).where(and(eq(extractionFields.projectId, projectId), includeArchived ? undefined : sql`${extractionFields.archivedAt} is null`)).orderBy(extractionFields.sortOrder, extractionFields.id); }
  async update(projectId: string, id: string, values: Partial<typeof extractionFields.$inferInsert>) { return this.db.update(extractionFields).set({ ...values, updatedAt: new Date() }).where(and(eq(extractionFields.projectId, projectId), eq(extractionFields.id, id))).returning(); }
  async archive(projectId: string, id: string) { return this.update(projectId, id, { archivedAt: new Date() }); }
  async countValues(projectId: string, fieldId: string) { const rows = await this.db.select({ id: extractionValues.id }).from(extractionValues).where(and(eq(extractionValues.projectId, projectId), eq(extractionValues.fieldId, fieldId))).limit(1); return rows.length; }
}

export class ExtractionOptionRepository {
  constructor(private readonly db: Database) {}
  async create(values: typeof extractionOptions.$inferInsert) { const [row] = await this.db.insert(extractionOptions).values(values).returning(); return row; }
  async findById(projectId: string, id: string) { const [row] = await this.db.select().from(extractionOptions).where(and(eq(extractionOptions.projectId, projectId), eq(extractionOptions.id, id))).limit(1); return row ?? null; }
  async listForField(projectId: string, fieldId: string, includeArchived = false) { return this.db.select().from(extractionOptions).where(and(eq(extractionOptions.projectId, projectId), eq(extractionOptions.fieldId, fieldId), includeArchived ? undefined : sql`${extractionOptions.archivedAt} is null`)).orderBy(extractionOptions.sortOrder, extractionOptions.id); }
  async update(projectId: string, id: string, values: Partial<typeof extractionOptions.$inferInsert>) { return this.db.update(extractionOptions).set({ ...values, updatedAt: new Date() }).where(and(eq(extractionOptions.projectId, projectId), eq(extractionOptions.id, id))).returning(); }
  async archive(projectId: string, id: string) { return this.update(projectId, id, { archivedAt: new Date() }); }
  async countRevisions(projectId: string, optionId: string) { const rows = await this.db.select({ id: extractionValueRevisions.id }).from(extractionValueRevisions).where(and(eq(extractionValueRevisions.projectId, projectId), eq(extractionValueRevisions.optionId, optionId))).limit(1); return rows.length; }
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

export class SynthesisStatementRepository {
  constructor(private readonly db: Database) {}

  async create(projectId: string) {
    const [row] = await this.db.insert(synthesisStatements).values({ projectId }).returning();
    return row;
  }

  async findById(projectId: string, id: string) {
    const [row] = await this.db.select().from(synthesisStatements).where(and(eq(synthesisStatements.projectId, projectId), eq(synthesisStatements.id, id))).limit(1);
    return row ?? null;
  }

  async findForUpdate(tx: DbTransaction, projectId: string, id: string) {
    const [row] = await tx.select().from(synthesisStatements).where(and(eq(synthesisStatements.projectId, projectId), eq(synthesisStatements.id, id))).for("update").limit(1);
    return row ?? null;
  }

  async list(projectId: string) {
    return this.db.select().from(synthesisStatements).where(eq(synthesisStatements.projectId, projectId)).orderBy(desc(synthesisStatements.createdAt));
  }
}

export class SynthesisRevisionRepository {
  constructor(private readonly db: Database) {}

  async createDraft(tx: DbTransaction, values: typeof synthesisRevisions.$inferInsert) {
    const [row] = await tx.insert(synthesisRevisions).values({ ...values, finalizedAt: null }).returning();
    return row;
  }

  async finalize(tx: DbTransaction, projectId: string, id: string) {
    const [row] = await tx.update(synthesisRevisions).set({ finalizedAt: new Date() }).where(and(eq(synthesisRevisions.projectId, projectId), eq(synthesisRevisions.id, id))).returning();
    return row ?? null;
  }

  async current(projectId: string, statementId: string) {
    const [row] = await this.db.select().from(synthesisRevisions).where(and(eq(synthesisRevisions.projectId, projectId), eq(synthesisRevisions.synthesisStatementId, statementId), sql`${synthesisRevisions.finalizedAt} is not null`)).orderBy(desc(synthesisRevisions.sequence)).limit(1);
    return row ?? null;
  }

  async history(projectId: string, statementId: string) {
    return this.db.select().from(synthesisRevisions).where(and(eq(synthesisRevisions.projectId, projectId), eq(synthesisRevisions.synthesisStatementId, statementId), sql`${synthesisRevisions.finalizedAt} is not null`)).orderBy(synthesisRevisions.sequence);
  }

  async list(projectId: string) {
    return this.db.select().from(synthesisRevisions).where(and(eq(synthesisRevisions.projectId, projectId), sql`${synthesisRevisions.finalizedAt} is not null`)).orderBy(desc(synthesisRevisions.sequence));
  }

  async listCurrentWithStatements(projectId: string) {
    return this.db.execute(sql`
      select s.id as statement_id, s.project_id, s.created_at as statement_created_at,
        r.id as revision_id, r.sequence, r.synthesis_statement_id, r.state, r.title,
        r.statement_text, r.researcher_note, r.created_at, r.finalized_at
      from synthesis_statements s
      join lateral (
        select r.* from synthesis_revisions r
        where r.project_id=s.project_id and r.synthesis_statement_id=s.id and r.finalized_at is not null
        order by r.sequence desc limit 1
      ) r on true
      where s.project_id=${projectId}
      order by r.sequence desc, s.id
    `);
  }
}

export class SynthesisRevisionSupportRepository {
  constructor(private readonly db: Database) {}

  async createMany(tx: DbTransaction, projectId: string, synthesisRevisionId: string, extractionRevisionIds: string[]) {
    if (!extractionRevisionIds.length) return [];
    return tx.insert(synthesisRevisionSupports).values(extractionRevisionIds.map((extractionRevisionId) => ({ projectId, synthesisRevisionId, extractionRevisionId }))).returning();
  }

  async list(projectId: string, synthesisRevisionId: string) {
    return this.db.select().from(synthesisRevisionSupports).where(and(eq(synthesisRevisionSupports.projectId, projectId), eq(synthesisRevisionSupports.synthesisRevisionId, synthesisRevisionId)));
  }

  async listForRevisions(projectId: string, revisionIds: string[]) {
    if (!revisionIds.length) return [];
    return this.db.select().from(synthesisRevisionSupports).where(and(eq(synthesisRevisionSupports.projectId, projectId), sql`${synthesisRevisionSupports.synthesisRevisionId} in ${sql.join(revisionIds.map((id) => sql`${id}::uuid`), sql`, `)}`));
  }

  async listWithProvenance(projectId: string, synthesisRevisionId: string) {
    return this.db.execute(sql`
      select s.project_id, s.synthesis_revision_id, s.extraction_revision_id, s.created_at as support_created_at,
        r.id as revision_id, r.sequence as revision_sequence, r.paper_id, r.field_id, r.extraction_value_id,
        r.field_type, r.value_state, r.text_value, r.number_value, r.boolean_value, r.option_id,
        r.researcher_note as revision_note, r.created_at as revision_created_at, r.finalized_at as revision_finalized_at,
        p.id as paper_id_value, p.title as paper_title, p.authors, p.publication_year, p.venue, p.doi,
        p.abstract, p.bibliographic_note, p.created_at as paper_created_at, p.updated_at as paper_updated_at,
        f.id as field_id_value, f.name as field_name, f.description as field_description,
        f.field_type as field_type_value, f.required, f.sort_order, f.created_at as field_created_at,
        f.updated_at as field_updated_at, f.archived_at as field_archived_at,
        exists(select 1 from extraction_values ev join extraction_value_revisions cr on cr.project_id=ev.project_id and cr.extraction_value_id=ev.id and cr.finalized_at is not null
          where ev.project_id=r.project_id and ev.id=r.extraction_value_id and cr.sequence > r.sequence) as has_newer_revision
      from synthesis_revision_supports s
      join extraction_value_revisions r on r.project_id=s.project_id and r.id=s.extraction_revision_id
      join papers p on p.project_id=r.project_id and p.id=r.paper_id
      join extraction_fields f on f.project_id=r.project_id and f.id=r.field_id
      where s.project_id=${projectId} and s.synthesis_revision_id=${synthesisRevisionId}
      order by s.created_at, s.extraction_revision_id
    `);
  }

  async listWithProvenanceForRevisions(projectId: string, synthesisRevisionIds: string[]) {
    if (!synthesisRevisionIds.length) return [];
    return this.db.execute(sql`
      select s.project_id, s.synthesis_revision_id, s.extraction_revision_id, s.created_at as support_created_at,
        r.id as revision_id, r.sequence as revision_sequence, r.paper_id, r.field_id, r.extraction_value_id,
        r.field_type, r.value_state, r.text_value, r.number_value, r.boolean_value, r.option_id,
        r.researcher_note as revision_note, r.created_at as revision_created_at, r.finalized_at as revision_finalized_at,
        p.id as paper_id_value, p.title as paper_title, p.authors, p.publication_year, p.venue, p.doi,
        p.abstract, p.bibliographic_note, p.created_at as paper_created_at, p.updated_at as paper_updated_at,
        f.id as field_id_value, f.name as field_name, f.description as field_description,
        f.field_type as field_type_value, f.required, f.sort_order, f.created_at as field_created_at,
        f.updated_at as field_updated_at, f.archived_at as field_archived_at,
        exists(select 1 from extraction_value_revisions cr
          where cr.project_id=r.project_id and cr.extraction_value_id=r.extraction_value_id
            and cr.finalized_at is not null and cr.sequence > r.sequence) as has_newer_revision
      from synthesis_revision_supports s
      join synthesis_revisions sr on sr.project_id=s.project_id and sr.id=s.synthesis_revision_id and sr.finalized_at is not null
      join extraction_value_revisions r on r.project_id=s.project_id and r.id=s.extraction_revision_id and r.finalized_at is not null
      join papers p on p.project_id=r.project_id and p.id=r.paper_id
      join extraction_fields f on f.project_id=r.project_id and f.id=r.field_id
      where s.project_id=${projectId} and s.synthesis_revision_id in (${sql.join(synthesisRevisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by s.synthesis_revision_id, s.created_at, s.extraction_revision_id
    `);
  }

  async listEvidenceForRevisions(projectId: string, revisionIds: string[]) {
    if (!revisionIds.length) return [];
    return this.db.execute(sql`
      select l.project_id, l.revision_id, e.id, e.paper_id, e.source_text, e.page_number, e.note, e.created_at, e.updated_at
      from extraction_revision_evidence l join evidence e on e.project_id=l.project_id and e.paper_id=l.paper_id and e.id=l.evidence_id
      where l.project_id=${projectId} and l.revision_id in (${sql.join(revisionIds.map((id) => sql`${id}::uuid`), sql`, `)})
      order by l.revision_id, e.page_number, e.created_at
    `);
  }

  async listComparison(projectId: string, fieldId: string) {
    return this.db.execute(sql`
      select p.id as paper_id, p.project_id, p.title, p.authors, p.publication_year, p.venue, p.doi,
        p.abstract, p.bibliographic_note, p.created_at as paper_created_at, p.updated_at as paper_updated_at,
        f.id as field_id, f.name as field_name, f.description as field_description, f.field_type,
        f.required, f.sort_order, f.created_at as field_created_at, f.updated_at as field_updated_at, f.archived_at as field_archived_at,
        r.id as revision_id, r.sequence as revision_sequence, r.extraction_value_id, r.value_state,
        r.text_value, r.number_value, r.boolean_value, r.option_id, o.label as option_label, r.researcher_note, r.created_at as revision_created_at, r.finalized_at,
        exists(select 1 from extraction_revision_evidence erel where erel.project_id=r.project_id and erel.revision_id=r.id) as has_evidence
      from papers p
      join lateral (select d.decision from screening_decisions d where d.project_id=p.project_id and d.paper_id=p.id and d.stage='title_abstract' order by d.sequence desc limit 1) sd on sd.decision='include'
      join extraction_fields f on f.project_id=p.project_id and f.id=${fieldId} and f.archived_at is null
      left join extraction_values v on v.project_id=p.project_id and v.paper_id=p.id and v.field_id=f.id
      left join lateral (select r.* from extraction_value_revisions r where r.project_id=p.project_id and r.extraction_value_id=v.id and r.finalized_at is not null order by r.sequence desc limit 1) r on true
      left join extraction_options o on o.project_id=r.project_id and o.id=r.option_id
      where p.project_id=${projectId}
      order by p.created_at, p.id
    `);
  }
}
