/* eslint-disable @typescript-eslint/no-explicit-any */
import { asc, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { retrievedRecordDeduplicationDecisions } from "@/db/schema";

type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class DeduplicationDecisionRepository {
  constructor(private readonly db: Database) {}

  async insert(values: typeof retrievedRecordDeduplicationDecisions.$inferInsert, tx: any = this.db) {
    const [row] = await tx.insert(retrievedRecordDeduplicationDecisions).values(values).returning();
    return row;
  }

  async history(projectId: string, leftId: string, rightId: string, tx: any = this.db) {
    return tx.select().from(retrievedRecordDeduplicationDecisions)
      .where(sql`${retrievedRecordDeduplicationDecisions.projectId} = ${projectId} and ${retrievedRecordDeduplicationDecisions.leftRetrievedRecordId} = ${leftId} and ${retrievedRecordDeduplicationDecisions.rightRetrievedRecordId} = ${rightId}`)
      .orderBy(asc(retrievedRecordDeduplicationDecisions.sequence));
  }

  async latest(projectId: string, leftId: string, rightId: string, tx: any = this.db) {
    const rows = await tx.execute(sql`
      select id, sequence, project_id, left_retrieved_record_id, right_retrieved_record_id, decision, note, created_at
      from retrieved_record_deduplication_decisions
      where project_id = ${projectId} and left_retrieved_record_id = ${leftId} and right_retrieved_record_id = ${rightId}
      order by sequence desc limit 1
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  async lockPair(tx: DbTransaction, projectId: string, leftId: string, rightId: string) {
    const rows = await tx.execute(sql`
      select id from retrieved_records
      where project_id = ${projectId} and id in (${leftId}, ${rightId})
      order by id for update
    `);
    return rows as unknown as Record<string, unknown>[];
  }

  async listCandidates(projectId: string, includeReviewed = false, tx: any = this.db) {
    return tx.execute(sql`
      with candidate_reasons as (
        select a.project_id, a.id as left_record_id, b.id as right_record_id, 'normalized_doi'::text as reason, 1::int as reason_order
        from retrieved_records a join retrieved_records b on b.project_id = a.project_id and a.id < b.id
        where a.project_id = ${projectId}
          and a.doi is not null and b.doi is not null and btrim(a.doi) <> '' and btrim(b.doi) <> ''
          and btrim(lower(regexp_replace(regexp_replace(btrim(a.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))) = btrim(lower(regexp_replace(regexp_replace(btrim(b.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))
        union all
        select a.project_id, a.id, b.id, 'same_source_record_id'::text, 2::int
        from retrieved_records a join retrieved_records b on b.project_id = a.project_id and a.id < b.id
          and b.search_source_id = a.search_source_id and b.source_record_id = a.source_record_id
        where a.project_id = ${projectId} and a.source_record_id is not null and b.source_record_id is not null
          and btrim(a.source_record_id) <> '' and btrim(b.source_record_id) <> ''
        union all
        select a.project_id, a.id, b.id, 'normalized_title_year'::text, 3::int
        from retrieved_records a join retrieved_records b on b.project_id = a.project_id and a.id < b.id
        where a.project_id = ${projectId} and a.publication_year is not null and a.publication_year = b.publication_year
          and btrim(a.title) <> '' and btrim(b.title) <> ''
          and lower(regexp_replace(btrim(a.title), '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(btrim(b.title), '[[:space:]]+', ' ', 'g'))
      ), pairs as (
        select project_id, left_record_id, right_record_id,
          array_agg(reason order by reason_order) as reasons,
          case when bool_or(reason_order = 1 or reason_order = 2) then 'strong'::text else 'possible'::text end as strength
        from candidate_reasons group by project_id, left_record_id, right_record_id
      ), latest_decisions as (
        select distinct on (project_id, left_retrieved_record_id, right_retrieved_record_id)
          project_id, left_retrieved_record_id, right_retrieved_record_id, decision, note, sequence, created_at
        from retrieved_record_deduplication_decisions
        where project_id = ${projectId}
        order by project_id, left_retrieved_record_id, right_retrieved_record_id, sequence desc
      ), latest_matches as (
        select distinct on (project_id, retrieved_record_id)
          project_id, retrieved_record_id, paper_id, action
        from retrieved_record_matches
        where project_id = ${projectId}
        order by project_id, retrieved_record_id, sequence desc
      )
      select p.project_id, p.left_record_id, p.right_record_id, p.reasons, p.strength,
        ld.decision, ld.note as decision_note, ld.sequence as decision_sequence, ld.created_at as decision_created_at,
        a.title as left_title, a.authors as left_authors, a.doi as left_doi, a.source_record_id as left_source_record_id,
        a.search_run_id as left_search_run_id, a.search_source_id as left_search_source_id, a.publication_year as left_publication_year,
        b.title as right_title, b.authors as right_authors, b.doi as right_doi, b.source_record_id as right_source_record_id,
        b.search_run_id as right_search_run_id, b.search_source_id as right_search_source_id, b.publication_year as right_publication_year,
        lm.paper_id as left_paper_id, rm.paper_id as right_paper_id
      from pairs p
      join retrieved_records a on a.project_id = p.project_id and a.id = p.left_record_id
      join retrieved_records b on b.project_id = p.project_id and b.id = p.right_record_id
      left join latest_decisions ld on ld.project_id = p.project_id and ld.left_retrieved_record_id = p.left_record_id and ld.right_retrieved_record_id = p.right_record_id
      left join latest_matches lm on lm.project_id = p.project_id and lm.retrieved_record_id = p.left_record_id and lm.action = 'linked'
      left join latest_matches rm on rm.project_id = p.project_id and rm.retrieved_record_id = p.right_record_id and rm.action = 'linked'
      ${includeReviewed ? sql`` : sql`where ld.decision is null`}
      order by (case when p.strength = 'strong' then 0 else 1 end), p.left_record_id, p.right_record_id
    `);
  }

  async pair(projectId: string, leftId: string, rightId: string, tx: any = this.db) {
    const rows = await tx.execute(sql`
      with latest_decision as (
        select distinct on (project_id, left_retrieved_record_id, right_retrieved_record_id) *
        from retrieved_record_deduplication_decisions
        where project_id = ${projectId} and left_retrieved_record_id = ${leftId} and right_retrieved_record_id = ${rightId}
        order by project_id, left_retrieved_record_id, right_retrieved_record_id, sequence desc
      ), latest_matches as (
        select distinct on (project_id, retrieved_record_id) project_id, retrieved_record_id, paper_id, action
        from retrieved_record_matches where project_id = ${projectId} and retrieved_record_id in (${leftId}, ${rightId})
        order by project_id, retrieved_record_id, sequence desc
      )
      select a.id as left_record_id, a.title as left_title, a.authors as left_authors, a.abstract as left_abstract,
        a.doi as left_doi, a.source_record_id as left_source_record_id, a.search_run_id as left_search_run_id,
        a.search_source_id as left_search_source_id, a.publication_year as left_publication_year,
        b.id as right_record_id, b.title as right_title, b.authors as right_authors, b.abstract as right_abstract,
        b.doi as right_doi, b.source_record_id as right_source_record_id, b.search_run_id as right_search_run_id,
        b.search_source_id as right_search_source_id, b.publication_year as right_publication_year,
        ld.id as decision_id, ld.sequence as decision_sequence, ld.decision, ld.note as decision_note, ld.created_at as decision_created_at,
        lm.paper_id as left_paper_id, rm.paper_id as right_paper_id
      from retrieved_records a join retrieved_records b on a.project_id=b.project_id and a.id=${leftId} and b.id=${rightId}
      left join latest_decision ld on true
      left join latest_matches lm on lm.retrieved_record_id = a.id and lm.action = 'linked'
      left join latest_matches rm on rm.retrieved_record_id = b.id and rm.action = 'linked'
      where a.project_id = ${projectId}
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  async flowSummary(projectId: string, tx: any = this.db) {
    const rows = await tx.execute(sql`
      with latest_matches as (
        select distinct on (project_id, retrieved_record_id) project_id, retrieved_record_id, paper_id, action
        from retrieved_record_matches where project_id = ${projectId}
        order by project_id, retrieved_record_id, sequence desc
      ), current_screening as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision, exclusion_criterion_id
        from screening_decisions where project_id = ${projectId}
        order by project_id, paper_id, sequence desc
      ), current_decisions as (
        select distinct on (project_id, left_retrieved_record_id, right_retrieved_record_id)
          project_id, left_retrieved_record_id, right_retrieved_record_id, decision
        from retrieved_record_deduplication_decisions where project_id = ${projectId}
        order by project_id, left_retrieved_record_id, right_retrieved_record_id, sequence desc
      ), candidate_pairs as (
        select count(*)::int as count from (
          select a.id, b.id from retrieved_records a join retrieved_records b on b.project_id=a.project_id and a.id < b.id
          left join current_decisions d on d.project_id=a.project_id and d.left_retrieved_record_id=a.id and d.right_retrieved_record_id=b.id
          where a.project_id=${projectId} and d.decision is null and (
            (a.doi is not null and b.doi is not null and btrim(a.doi)<>'' and btrim(b.doi)<>'' and btrim(lower(regexp_replace(regexp_replace(btrim(a.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i')))=btrim(lower(regexp_replace(regexp_replace(btrim(b.doi), '^https?://(dx\\.)?doi\\.org/', '', 'i'), '^doi:[[:space:]]*', '', 'i'))))
            or (a.source_record_id is not null and b.source_record_id is not null and btrim(a.source_record_id)<>'' and btrim(b.source_record_id)<>'' and a.search_source_id=b.search_source_id and a.source_record_id=b.source_record_id)
            or (a.publication_year is not null and a.publication_year=b.publication_year and lower(regexp_replace(btrim(a.title), '[[:space:]]+', ' ', 'g'))=lower(regexp_replace(btrim(b.title), '[[:space:]]+', ' ', 'g')))
          )
        ) q
      ), paper_classification as (
        select p.id,
          exists (select 1 from latest_matches lm where lm.project_id=p.project_id and lm.paper_id=p.id and lm.action='linked') as current_acquisition,
          exists (select 1 from retrieved_record_matches hm where hm.project_id=p.project_id and hm.paper_id=p.id and hm.action='linked') as historical_acquisition
        from papers p where p.project_id=${projectId}
      )
      select
        (select count(*)::int from search_runs where project_id=${projectId}) as distinct_search_runs,
        coalesce((select sum(reported_result_count)::int from search_runs where project_id=${projectId}),0)::int as reported_results_total,
        (select count(*)::int from retrieved_records where project_id=${projectId}) as retrieved_records,
        (select count(distinct search_source_id)::int from search_runs where project_id=${projectId}) as distinct_sources,
        (select count(*)::int from latest_matches where project_id=${projectId} and action='linked') as currently_resolved_records,
        (select count(*)::int from retrieved_records r where r.project_id=${projectId} and not exists (select 1 from latest_matches lm where lm.project_id=r.project_id and lm.retrieved_record_id=r.id and lm.action='linked')) as unresolved_records,
        (select count from candidate_pairs) as unresolved_duplicate_pairs,
        (select count(*)::int from current_decisions where project_id=${projectId} and decision='same_work') as same_work_decision_pairs,
        (select count(*)::int from current_decisions where project_id=${projectId} and decision='different_work') as different_work_decision_pairs,
        (select count(*)::int from paper_classification where current_acquisition) as acquisition_derived_papers,
        ((select count(*)::int from latest_matches where project_id=${projectId} and action='linked') - (select count(*)::int from paper_classification where current_acquisition))::int as duplicate_records_collapsed,
        (select count(*)::int from papers where project_id=${projectId}) as papers_in_screening_population,
        (select count(*)::int from papers p where p.project_id=${projectId} and not exists (select 1 from current_screening s where s.project_id=p.project_id and s.paper_id=p.id)) as unscreened,
        (select count(*)::int from current_screening where project_id=${projectId} and decision='include') as included,
        (select count(*)::int from current_screening where project_id=${projectId} and decision='exclude') as excluded,
        (select count(*)::int from current_screening where project_id=${projectId} and decision='maybe') as maybe,
        (select count(*)::int from paper_classification where historical_acquisition and not current_acquisition) as historical_acquisition_only_papers,
        (select count(*)::int from paper_classification where not historical_acquisition) as manual_papers
    `);
    return (rows as unknown as Record<string, unknown>[])[0] ?? null;
  }

  async exclusionReasons(projectId: string, tx: any = this.db) {
    return tx.execute(sql`
      with current_screening as (
        select distinct on (project_id, paper_id) project_id, paper_id, exclusion_criterion_id
        from screening_decisions where project_id=${projectId} order by project_id, paper_id, sequence desc
      )
      select s.exclusion_criterion_id, c.text, count(*)::int as count
      from current_screening s join screening_criteria c on c.project_id=s.project_id and c.id=s.exclusion_criterion_id
      where s.project_id=${projectId} and s.exclusion_criterion_id is not null
      group by s.exclusion_criterion_id, c.text order by c.text, s.exclusion_criterion_id
    `);
  }

  async contributors(projectId: string, metric: string, tx: any = this.db) {
    const queries: Record<string, any> = {
      unresolvedDuplicatePairs: this.listCandidates(projectId, false, tx),
      currentlyResolvedRecords: tx.execute(sql`select retrieved_record_id, paper_id from (select distinct on (m.retrieved_record_id) m.retrieved_record_id, m.paper_id, m.action from retrieved_record_matches m where m.project_id=${projectId} order by m.retrieved_record_id, m.sequence desc) current where action='linked'`),
      acquisitionDerivedPapers: tx.execute(sql`select distinct m.paper_id from retrieved_record_matches m where m.project_id=${projectId} and m.action='linked' and not exists (select 1 from retrieved_record_matches newer where newer.project_id=m.project_id and newer.retrieved_record_id=m.retrieved_record_id and newer.sequence>m.sequence)`),
      historicalAcquisitionOnlyPapers: tx.execute(sql`with current as (select distinct on (m.retrieved_record_id) m.retrieved_record_id, m.paper_id, m.action from retrieved_record_matches m where m.project_id=${projectId} order by m.retrieved_record_id, m.sequence desc) select distinct historical.paper_id from retrieved_record_matches historical where historical.project_id=${projectId} and historical.action='linked' and not exists (select 1 from current where current.action='linked' and current.paper_id=historical.paper_id)`),
      manualPapers: tx.execute(sql`select p.id from papers p where p.project_id=${projectId} and not exists (select 1 from retrieved_record_matches m where m.project_id=p.project_id and m.paper_id=p.id and m.action='linked')`),
    };
    if (!(metric in queries)) throw new Error(`Unknown review-flow metric: ${metric}`);
    return queries[metric];
  }
}
