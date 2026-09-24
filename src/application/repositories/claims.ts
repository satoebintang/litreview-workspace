import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import type { DbTransaction } from "./types";

export class ClaimRepository {
  constructor(private readonly db: Database) {}

  async create(values: { projectId: string }) {
    const rows = await this.db.execute(sql`insert into claims (project_id) values (${values.projectId}) returning id, project_id, created_at`);
    const row = (rows as unknown as Record<string, unknown>[])[0];
    return row ? { id: String(row.id), projectId: String(row.project_id), claimText: "", createdAt: row.created_at as Date, updatedAt: row.created_at as Date } : null;
  }

  async findById(projectId: string, id: string) {
    const rows = await this.db.execute(sql`select id, project_id, created_at from claims where project_id=${projectId} and id=${id} limit 1`);
    const row = (rows as unknown as Record<string, unknown>[])[0];
    return row ? { id: String(row.id), projectId: String(row.project_id), claimText: "", createdAt: row.created_at as Date, updatedAt: row.created_at as Date } : null;
  }

  async list(projectId: string) {
    const rows = await this.db.execute(sql`select id, project_id, created_at from claims where project_id=${projectId} order by created_at desc`);
    return (rows as unknown as Record<string, unknown>[]).map((row) => ({ id: String(row.id), projectId: String(row.project_id), claimText: "", createdAt: row.created_at as Date, updatedAt: row.created_at as Date }));
  }

  async delete(projectId: string, id: string) {
    return this.db.execute(sql`delete from claims where project_id=${projectId} and id=${id} returning id`);
  }
}

/**
 * Revision-aware Claim persistence.  These methods intentionally use the
 * database column contract instead of the legacy mutable ClaimEvidence join;
 * keeping the implementation here also gives the service one place to apply
 * the row lock used for revision allocation.
 */
export class ClaimRevisionRepository {
  constructor(private readonly db: Database) {}

  async findForUpdate(tx: DbTransaction, projectId: string, claimId: string) {
    const rows = await tx.execute(sql`
      select id, project_id, created_at
      from claims
      where project_id=${projectId} and id=${claimId}
      for update
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  async createClaim(tx: DbTransaction, projectId: string) {
    const rows = await tx.execute(sql`
      insert into claims (project_id) values (${projectId})
      returning id, project_id, created_at
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  async createDraft(tx: DbTransaction, values: {
    projectId: string; claimId: string; state: "active" | "withdrawn";
    claimText: string | null; researcherNote: string | null;
  }) {
    const rows = await tx.execute(sql`
      insert into claim_revisions (project_id, claim_id, state, claim_text, researcher_note)
      values (${values.projectId}, ${values.claimId}, ${values.state}, ${values.claimText}, ${values.researcherNote})
      returning id, sequence, project_id, claim_id, state, claim_text, researcher_note, created_at, finalized_at
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  async finalize(tx: DbTransaction, projectId: string, id: string) {
    const rows = await tx.execute(sql`
      update claim_revisions
      set finalized_at=coalesce(finalized_at, now())
      where project_id=${projectId} and id=${id} and finalized_at is null
      returning id, sequence, project_id, claim_id, state, claim_text, researcher_note, created_at, finalized_at
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  async current(projectId: string, claimId: string) {
    const rows = await this.db.execute(sql`
      select id, sequence, project_id, claim_id, state, claim_text, researcher_note, created_at, finalized_at
      from claim_revisions
      where project_id=${projectId} and claim_id=${claimId} and finalized_at is not null
      order by sequence desc limit 1
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  async history(projectId: string, claimId: string) {
    const rows = await this.db.execute(sql`
      select id, sequence, project_id, claim_id, state, claim_text, researcher_note, created_at, finalized_at
      from claim_revisions
      where project_id=${projectId} and claim_id=${claimId} and finalized_at is not null
      order by sequence asc
    `);
    return rows as unknown as Record<string, unknown>[];
  }

  async listCurrent(projectId: string) {
    const rows = await this.db.execute(sql`
        select c.id as claim_id, c.project_id, c.created_at as claim_created_at,
        r.id as revision_id, r.sequence, r.claim_id, r.state, r.claim_text, r.researcher_note,
        r.created_at, r.finalized_at
      from claims c
      join lateral (
        select r.* from claim_revisions r
        where r.project_id=c.project_id and r.claim_id=c.id and r.finalized_at is not null
        order by r.sequence desc limit 1
      ) r on true
      where c.project_id=${projectId}
      order by r.sequence desc, c.id
    `);
    return rows as unknown as Record<string, unknown>[];
  }
}

export class ClaimRevisionSupportRepository {
  constructor(private readonly db: Database) {}

  async createEvidence(tx: DbTransaction, values: { projectId: string; claimRevisionId: string; evidenceId: string; }) {
    const rows = await tx.execute(sql`
      insert into claim_revision_evidence_supports (project_id, claim_revision_id, evidence_id)
      values (${values.projectId}, ${values.claimRevisionId}, ${values.evidenceId})
      returning project_id, claim_revision_id, evidence_id, created_at
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  async createExtraction(tx: DbTransaction, values: { projectId: string; claimRevisionId: string; extractionRevisionId: string; }) {
    const rows = await tx.execute(sql`
      insert into claim_revision_extraction_supports (project_id, claim_revision_id, extraction_revision_id)
      values (${values.projectId}, ${values.claimRevisionId}, ${values.extractionRevisionId})
      returning project_id, claim_revision_id, extraction_revision_id, created_at
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  async createSynthesis(tx: DbTransaction, values: { projectId: string; claimRevisionId: string; synthesisRevisionId: string; }) {
    const rows = await tx.execute(sql`
      insert into claim_revision_synthesis_supports (project_id, claim_revision_id, synthesis_revision_id)
      values (${values.projectId}, ${values.claimRevisionId}, ${values.synthesisRevisionId})
      returning project_id, claim_revision_id, synthesis_revision_id, created_at
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  async listForRevision(projectId: string, claimRevisionId: string) {
    const evidenceRows = await this.db.execute(sql`
      select s.project_id, s.claim_revision_id, s.evidence_id, s.created_at as support_created_at,
        e.*, p.id as paper_id_value, p.title as paper_title, p.authors,
        p.publication_year, p.venue, p.doi, p.abstract, p.bibliographic_note,
        p.created_at as paper_created_at, p.updated_at as paper_updated_at
      from claim_revision_evidence_supports s
      join evidence e on e.project_id=s.project_id and e.id=s.evidence_id
      join papers p on p.project_id=e.project_id and p.id=e.paper_id
      where s.project_id=${projectId} and s.claim_revision_id=${claimRevisionId}
      order by s.created_at, s.evidence_id
    `);
    const extractionRows = await this.db.execute(sql`
      select s.project_id, s.claim_revision_id, s.extraction_revision_id, s.created_at as support_created_at,
        r.id as revision_id, r.sequence as revision_sequence, r.paper_id, r.field_id, r.extraction_value_id,
        r.field_type, r.value_state, r.text_value, r.number_value, r.boolean_value, r.option_id,
        r.researcher_note as revision_note, r.created_at as revision_created_at, r.finalized_at as revision_finalized_at,
        p.id as paper_id_value, p.title as paper_title, p.authors, p.publication_year, p.venue, p.doi,
        p.abstract, p.bibliographic_note, p.created_at as paper_created_at, p.updated_at as paper_updated_at,
        f.id as field_id_value, f.name as field_name, f.description as field_description,
        f.field_type as field_type_value, f.required, f.sort_order, f.created_at as field_created_at,
        f.updated_at as field_updated_at, f.archived_at as field_archived_at,
        coalesce((select sd.decision from screening_decisions sd where sd.project_id=r.project_id and sd.paper_id=r.paper_id and sd.stage='title_abstract' order by sd.sequence desc limit 1), 'unscreened') as screening_state,
        not exists (select 1 from extraction_value_revisions newer where newer.project_id=r.project_id and newer.extraction_value_id=r.extraction_value_id and newer.finalized_at is not null and newer.sequence > r.sequence) as is_current_extraction_revision
      from claim_revision_extraction_supports s
      join extraction_value_revisions r on r.project_id=s.project_id and r.id=s.extraction_revision_id
      join papers p on p.project_id=r.project_id and p.id=r.paper_id
      join extraction_fields f on f.project_id=r.project_id and f.id=r.field_id
      where s.project_id=${projectId} and s.claim_revision_id=${claimRevisionId}
      order by s.created_at, s.extraction_revision_id
    `);
    const synthesisRows = await this.db.execute(sql`
      select s.project_id, s.claim_revision_id, s.synthesis_revision_id, s.created_at as support_created_at,
        r.id as revision_id, r.sequence, r.synthesis_statement_id, r.state, r.title, r.statement_text,
        r.researcher_note, r.created_at, r.finalized_at,
        st.created_at as statement_created_at,
        (not exists (select 1 from synthesis_revisions newer where newer.project_id=r.project_id and newer.synthesis_statement_id=r.synthesis_statement_id and newer.finalized_at is not null and newer.sequence > r.sequence)) as is_current_synthesis_revision,
        (select st2.state from synthesis_revisions st2 where st2.project_id=r.project_id and st2.synthesis_statement_id=r.synthesis_statement_id and st2.finalized_at is not null order by st2.sequence desc limit 1) as current_statement_state
      from claim_revision_synthesis_supports s
      join synthesis_revisions r on r.project_id=s.project_id and r.id=s.synthesis_revision_id
      join synthesis_statements st on st.project_id=r.project_id and st.id=r.synthesis_statement_id
      where s.project_id=${projectId} and s.claim_revision_id=${claimRevisionId}
      order by s.created_at, s.synthesis_revision_id
    `);
    return {
      evidence: evidenceRows as unknown as Record<string, unknown>[],
      extraction: extractionRows as unknown as Record<string, unknown>[],
      synthesis: synthesisRows as unknown as Record<string, unknown>[],
    };
  }
}
