import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { synthesisStatements, synthesisRevisions, synthesisRevisionSupports } from "@/db/schema";
import type { DbTransaction } from "./types";

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

  async findFinalizedById(projectId: string, statementId: string, revisionId: string) {
    const [row] = await this.db.select().from(synthesisRevisions).where(and(
      eq(synthesisRevisions.projectId, projectId),
      eq(synthesisRevisions.synthesisStatementId, statementId),
      eq(synthesisRevisions.id, revisionId),
      sql`${synthesisRevisions.finalizedAt} is not null`,
    )).limit(1);
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
      select l.project_id, l.revision_id, e.*
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
      join lateral (select d.decision from full_text_screening_decisions d where d.project_id=p.project_id and d.paper_id=p.id order by d.sequence desc limit 1) ft on ft.decision='include'
      join extraction_fields f on f.project_id=p.project_id and f.id=${fieldId} and f.archived_at is null
      left join extraction_values v on v.project_id=p.project_id and v.paper_id=p.id and v.field_id=f.id
      left join lateral (select r.* from extraction_value_revisions r where r.project_id=p.project_id and r.extraction_value_id=v.id and r.finalized_at is not null order by r.sequence desc limit 1) r on true
      left join extraction_options o on o.project_id=r.project_id and o.id=r.option_id
      where p.project_id=${projectId}
      order by p.created_at, p.id
    `);
  }
}
