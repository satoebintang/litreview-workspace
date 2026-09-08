/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { papers, projects, researchQuestions, retrievedRecordMatches, retrievedRecords, searchRuns, searchSources, searchStrategies } from "@/db/schema";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class ResearchQuestionRepository {
  constructor(private readonly db: Database) {}
  async create(values: typeof researchQuestions.$inferInsert, tx: any = this.db) { const [row] = await tx.insert(researchQuestions).values(values).returning(); return row; }
  async findById(projectId: string, id: string, tx: any = this.db) { const [row] = await tx.select().from(researchQuestions).where(and(eq(researchQuestions.projectId, projectId), eq(researchQuestions.id, id))).limit(1); return row ?? null; }
  async list(projectId: string, includeArchived = false, tx: any = this.db) { return tx.select().from(researchQuestions).where(and(eq(researchQuestions.projectId, projectId), includeArchived ? undefined : sql`${researchQuestions.archivedAt} is null`)).orderBy(asc(researchQuestions.sortOrder), asc(researchQuestions.id)); }
  async update(projectId: string, id: string, values: Partial<typeof researchQuestions.$inferInsert>, tx: any = this.db) { const [row] = await tx.update(researchQuestions).set({ ...values, updatedAt: new Date() }).where(and(eq(researchQuestions.projectId, projectId), eq(researchQuestions.id, id))).returning(); return row ?? null; }
  async archive(projectId: string, id: string, tx: any = this.db) { return this.update(projectId, id, { archivedAt: new Date() }, tx); }
}

export class SearchSourceRepository {
  constructor(private readonly db: Database) {}
  async create(values: typeof searchSources.$inferInsert, tx: any = this.db) { const [row] = await tx.insert(searchSources).values(values).returning(); return row; }
  async findById(projectId: string, id: string, tx: any = this.db) { const [row] = await tx.select().from(searchSources).where(and(eq(searchSources.projectId, projectId), eq(searchSources.id, id))).limit(1); return row ?? null; }
  async list(projectId: string, includeArchived = false, tx: any = this.db) { return tx.select().from(searchSources).where(and(eq(searchSources.projectId, projectId), includeArchived ? undefined : sql`${searchSources.archivedAt} is null`)).orderBy(asc(searchSources.createdAt), asc(searchSources.id)); }
  async update(projectId: string, id: string, values: Partial<typeof searchSources.$inferInsert>, tx: any = this.db) { const [row] = await tx.update(searchSources).set({ ...values, updatedAt: new Date() }).where(and(eq(searchSources.projectId, projectId), eq(searchSources.id, id))).returning(); return row ?? null; }
  async archive(projectId: string, id: string, tx: any = this.db) { return this.update(projectId, id, { archivedAt: new Date() }, tx); }
}

export class SearchStrategyRepository {
  constructor(private readonly db: Database) {}
  async create(values: typeof searchStrategies.$inferInsert, tx: any = this.db) { const [row] = await tx.insert(searchStrategies).values(values).returning(); return row; }
  async findById(projectId: string, id: string, tx: any = this.db) { const [row] = await tx.select().from(searchStrategies).where(and(eq(searchStrategies.projectId, projectId), eq(searchStrategies.id, id))).limit(1); return row ?? null; }
  async list(projectId: string, includeArchived = false, tx: any = this.db) { return tx.select().from(searchStrategies).where(and(eq(searchStrategies.projectId, projectId), includeArchived ? undefined : sql`${searchStrategies.archivedAt} is null`)).orderBy(desc(searchStrategies.createdAt), desc(searchStrategies.id)); }
  async update(projectId: string, id: string, values: Partial<typeof searchStrategies.$inferInsert>, tx: any = this.db) { const [row] = await tx.update(searchStrategies).set({ ...values, updatedAt: new Date() }).where(and(eq(searchStrategies.projectId, projectId), eq(searchStrategies.id, id))).returning(); return row ?? null; }
  async archive(projectId: string, id: string, tx: any = this.db) { return this.update(projectId, id, { archivedAt: new Date() }, tx); }
}

export class SearchRunRepository {
  constructor(private readonly db: Database) {}
  async create(values: typeof searchRuns.$inferInsert, tx: any = this.db) { const [row] = await tx.insert(searchRuns).values(values).returning(); return row; }
  async findById(projectId: string, id: string, tx: any = this.db) { const [row] = await tx.select().from(searchRuns).where(and(eq(searchRuns.projectId, projectId), eq(searchRuns.id, id))).limit(1); return row ?? null; }
  async list(projectId: string, tx: any = this.db) { return tx.select().from(searchRuns).where(eq(searchRuns.projectId, projectId)).orderBy(desc(searchRuns.sequence)); }
}

export class RetrievedRecordRepository {
  constructor(private readonly db: Database) {}
  async create(values: typeof retrievedRecords.$inferInsert, tx: any = this.db) { const [row] = await tx.insert(retrievedRecords).values(values).returning(); return row; }
  async findById(projectId: string, id: string, tx: any = this.db) { const [row] = await tx.select().from(retrievedRecords).where(and(eq(retrievedRecords.projectId, projectId), eq(retrievedRecords.id, id))).limit(1); return row ?? null; }
  async list(projectId: string, runId?: string, tx: any = this.db) { return tx.select().from(retrievedRecords).where(and(eq(retrievedRecords.projectId, projectId), runId ? eq(retrievedRecords.searchRunId, runId) : undefined)).orderBy(desc(retrievedRecords.retrievedAt), desc(retrievedRecords.id)); }
  async currentMatch(tx: DbTransaction | Database, projectId: string, recordId: string) {
    const rows = await tx.execute(sql`select id, sequence, project_id, retrieved_record_id, paper_id, action, created_at from retrieved_record_matches where project_id=${projectId} and retrieved_record_id=${recordId} order by sequence desc limit 1`);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }
  async matchHistory(projectId: string, recordId: string, tx = this.db) {
    return tx.select().from(retrievedRecordMatches).where(and(eq(retrievedRecordMatches.projectId, projectId), eq(retrievedRecordMatches.retrievedRecordId, recordId))).orderBy(asc(retrievedRecordMatches.sequence));
  }
  async currentMatchesForRun(projectId: string, runId: string) {
    return this.db.execute(sql`select distinct on (m.retrieved_record_id) m.id, m.sequence, m.project_id, m.retrieved_record_id, m.paper_id, m.action, m.created_at from retrieved_record_matches m join retrieved_records r on r.project_id=m.project_id and r.id=m.retrieved_record_id where m.project_id=${projectId} and r.search_run_id=${runId} order by m.retrieved_record_id, m.sequence desc`);
  }
  async matchHistoryForRun(projectId: string, runId: string) {
    return this.db.execute(sql`select m.id, m.sequence, m.project_id, m.retrieved_record_id, m.paper_id, m.action, m.created_at from retrieved_record_matches m join retrieved_records r on r.project_id=m.project_id and r.id=m.retrieved_record_id where m.project_id=${projectId} and r.search_run_id=${runId} order by m.retrieved_record_id, m.sequence`);
  }
  async duplicateCandidatesForRun(projectId: string, runId: string) {
    return this.db.execute(sql`select r.id as retrieved_record_id, p.* from retrieved_records r join papers p on p.project_id=r.project_id where r.project_id=${projectId} and r.search_run_id=${runId} and ((r.doi is not null and p.doi is not null and btrim(lower(regexp_replace(regexp_replace(btrim(r.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))=btrim(lower(regexp_replace(regexp_replace(btrim(p.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))) or (r.publication_year is not null and lower(regexp_replace(btrim(r.title), '[[:space:]]+', ' ', 'g'))=lower(regexp_replace(btrim(p.title), '[[:space:]]+', ' ', 'g')) and r.publication_year=p.publication_year) or (r.source_record_id is not null and exists (select 1 from retrieved_records sibling join retrieved_record_matches sm on sm.project_id=sibling.project_id and sm.retrieved_record_id=sibling.id and sm.action='linked' where sibling.project_id=r.project_id and sibling.id<>r.id and sibling.search_source_id=r.search_source_id and sibling.source_record_id=r.source_record_id and sm.paper_id=p.id and not exists (select 1 from retrieved_record_matches newer where newer.project_id=sm.project_id and newer.retrieved_record_id=sm.retrieved_record_id and newer.sequence>sm.sequence)))) order by r.id, p.created_at, p.id`);
  }
  async insertMatch(values: typeof retrievedRecordMatches.$inferInsert, tx = this.db) { const [row] = await tx.insert(retrievedRecordMatches).values(values).returning(); return row; }
  async lockForUpdate(tx: DbTransaction, projectId: string, id: string) {
    const rows = await tx.execute(sql`select id, project_id from retrieved_records where project_id=${projectId} and id=${id} for update`);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }
  async duplicateCandidates(projectId: string, record: { id: string; doi: string | null; title: string; publicationYear: number | null; sourceRecordId?: string | null }, tx = this.db) {
    return tx.execute(sql`
      select p.id, p.project_id, p.title, p.authors, p.publication_year, p.venue, p.doi, p.abstract, p.bibliographic_note, p.created_at, p.updated_at
      from papers p
      where p.project_id=${projectId} and (
         (${record.doi}::text is not null and btrim(${record.doi}::text) <> '' and p.doi is not null and btrim(p.doi) <> '' and btrim(lower(regexp_replace(regexp_replace(btrim(p.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))) = btrim(lower(regexp_replace(regexp_replace(btrim(${record.doi}::text), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))))
        or (${record.publicationYear}::int is not null and lower(regexp_replace(btrim(p.title), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(btrim(${record.title}::text), '[[:space:]]+', ' ', 'g')) and p.publication_year = ${record.publicationYear}::int)
        or (${record.sourceRecordId ?? null}::text is not null and exists (
          select 1 from retrieved_records sibling
          join retrieved_record_matches sibling_match on sibling_match.project_id=sibling.project_id and sibling_match.retrieved_record_id=sibling.id and sibling_match.action='linked'
          where sibling.project_id=${projectId} and sibling.id <> ${record.id}
            and sibling.search_source_id=(select search_source_id from retrieved_records where project_id=${projectId} and id=${record.id})
            and sibling.source_record_id=${record.sourceRecordId ?? null}::text and sibling_match.paper_id=p.id
            and not exists (select 1 from retrieved_record_matches newer where newer.project_id=sibling_match.project_id and newer.retrieved_record_id=sibling_match.retrieved_record_id and newer.sequence>sibling_match.sequence)
        ))
      )
      order by p.created_at, p.id
    `);
  }
  async paperProvenance(projectId: string, paperId: string, tx = this.db) {
    return tx.execute(sql`
      select rr.id as retrieved_record_id, rr.search_run_id, rr.search_source_id, rr.source_record_id,
        rr.title, rr.authors, rr.abstract, rr.doi, rr.url, rr.publication_year, rr.venue, rr.raw_citation,
        rr.retrieved_at, rr.created_at as retrieved_record_created_at,
        sr.executed_at, sr.source_key_snapshot, sr.source_display_name_snapshot,
        sr.query_text, sr.filters_text_snapshot, sr.reported_result_count, sr.notes as search_run_notes
      from retrieved_records rr
      join search_runs sr on sr.project_id = rr.project_id and sr.id = rr.search_run_id
      join retrieved_record_matches m on m.project_id = rr.project_id and m.retrieved_record_id = rr.id and m.paper_id = ${paperId} and m.action = 'linked'
      where rr.project_id = ${projectId}
        and not exists (
          select 1 from retrieved_record_matches newer
          where newer.project_id = m.project_id and newer.retrieved_record_id = m.retrieved_record_id and newer.sequence > m.sequence
        )
      order by sr.executed_at, rr.created_at, rr.id
    `);
  }
}

export type AcquisitionDbTransaction = DbTransaction;
export { projects, papers };
