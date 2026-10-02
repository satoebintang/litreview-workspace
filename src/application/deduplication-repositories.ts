/* eslint-disable @typescript-eslint/no-explicit-any */
import { asc, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { retrievedRecordDeduplicationDecisions } from "@/db/schema";
import { deduplicationCandidateSignalPredicates, unresolvedDuplicatePairCtes } from "./unresolved-duplicate-pair-query";

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
    const signals = deduplicationCandidateSignalPredicates();
    return tx.execute(sql`
      with pairs as (
        select a.project_id, a.id as left_record_id, b.id as right_record_id,
          array_remove(array[
            case when ${signals.doi} then 'normalized_doi'::text end,
            case when ${signals.sourceRecordId} then 'same_source_record_id'::text end,
            case when ${signals.titleYear} then 'normalized_title_year'::text end
          ], null::text) as reasons,
          case when ${signals.strong} then 'strong'::text else 'possible'::text end as strength
        from retrieved_records a join retrieved_records b on b.project_id = a.project_id and a.id < b.id
        where a.project_id = ${projectId}
          and ((${signals.doi}) or (${signals.sourceRecordId}) or (${signals.titleYear}))
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
      ${includeReviewed ? sql`` : sql`where not exists (
        select 1 from retrieved_record_deduplication_decisions d
        where d.project_id = p.project_id and d.left_retrieved_record_id = p.left_record_id and d.right_retrieved_record_id = p.right_record_id
      )`}
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
      with latest_matches as materialized (
        select distinct on (project_id, retrieved_record_id) project_id, retrieved_record_id, paper_id, action
        from retrieved_record_matches where project_id = ${projectId}
        order by project_id, retrieved_record_id, sequence desc, id desc
      ), current_screening as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision, exclusion_criterion_id
        from screening_decisions where project_id = ${projectId} and stage = 'title_abstract'
        order by project_id, paper_id, sequence desc, id desc
      ), current_full_text as (
        select distinct on (project_id, paper_id) project_id, paper_id, decision
        from full_text_screening_decisions where project_id = ${projectId}
        order by project_id, paper_id, sequence desc, id desc
      ), current_retrieval as (
        select distinct on (project_id, paper_id) project_id, paper_id, outcome
        from full_text_retrieval_attempts where project_id = ${projectId}
        order by project_id, paper_id, sequence desc, id desc
      ), current_decisions as (
        select distinct on (project_id, left_retrieved_record_id, right_retrieved_record_id)
          project_id, left_retrieved_record_id, right_retrieved_record_id, decision
        from retrieved_record_deduplication_decisions where project_id = ${projectId}
        order by project_id, left_retrieved_record_id, right_retrieved_record_id, sequence desc, id desc
      ), ${unresolvedDuplicatePairCtes(projectId)}, paper_classification as (
        select p.id, current_acquisition.paper_id is not null as current_acquisition,
          historical_acquisition.paper_id is not null as historical_acquisition
        from papers p
        left join (select distinct project_id, paper_id from latest_matches where action='linked') current_acquisition
          on current_acquisition.project_id=p.project_id and current_acquisition.paper_id=p.id
        left join (select distinct project_id, paper_id from retrieved_record_matches where project_id=${projectId} and action='linked') historical_acquisition
          on historical_acquisition.project_id=p.project_id and historical_acquisition.paper_id=p.id
        where p.project_id=${projectId}
      ), run_metrics as (
        select count(*) as distinct_search_runs, coalesce(sum(reported_result_count), 0) as reported_results_total,
          count(distinct search_source_id) as distinct_sources
        from search_runs where project_id=${projectId}
      ), record_metrics as (
        select count(*) as retrieved_records,
          count(*) filter (where lm.action='linked') as currently_resolved_records,
          count(*) filter (where lm.action is distinct from 'linked') as unresolved_records
        from retrieved_records r left join latest_matches lm
          on lm.project_id=r.project_id and lm.retrieved_record_id=r.id
        where r.project_id=${projectId}
      ), pair_decision_metrics as (
        select count(*) filter (where decision='same_work') as same_work_decision_pairs,
          count(*) filter (where decision='different_work') as different_work_decision_pairs
        from current_decisions where project_id=${projectId}
      ), paper_metrics as (
        select count(*) as papers_in_screening_population,
          count(*) filter (where current_acquisition) as acquisition_derived_papers,
          count(*) filter (where historical_acquisition and not current_acquisition) as historical_acquisition_only_papers,
          count(*) filter (where not historical_acquisition) as manual_papers
        from paper_classification
      ), screening_metrics as (
        select count(*) filter (where s.paper_id is null) as unscreened,
          count(*) filter (where s.decision='include') as included,
          count(*) filter (where s.decision='exclude') as excluded,
          count(*) filter (where s.decision='maybe') as maybe
        from papers p left join current_screening s on s.project_id=p.project_id and s.paper_id=p.id
        where p.project_id=${projectId}
      ), retrieval_history as materialized (
        select project_id, paper_id, bool_or(outcome='retrieved') as ever_retrieved
        from full_text_retrieval_attempts where project_id=${projectId}
        group by project_id, paper_id
      ), full_text_metrics as (
        select count(*) filter (where s.decision='include') as full_text_eligible,
          count(*) filter (where s.decision='include') as full_text_retrieval_eligible,
          count(*) filter (where s.decision='include' and f.paper_id is null) as full_text_awaiting,
          count(*) filter (where s.decision='include' and f.decision in ('include','exclude','maybe')) as full_text_assessed,
          count(*) filter (where s.decision='include' and f.decision='include') as full_text_included,
          count(*) filter (where s.decision='include' and f.decision='exclude') as full_text_excluded,
          count(*) filter (where s.decision='include' and f.decision='maybe') as full_text_maybe,
          count(*) filter (where f.paper_id is not null and coalesce(s.decision, '') <> 'include') as full_text_conflicts,
          count(*) filter (where s.decision='include' and f.decision='include') as finally_included,
          count(*) filter (where s.decision='include' and h.paper_id is null) as full_text_not_sought,
          count(*) filter (where s.decision='include' and r.outcome='pending') as full_text_retrieval_pending,
          count(*) filter (where s.decision='include' and r.outcome='retrieved') as full_text_retrieved,
          count(*) filter (where s.decision='include' and r.outcome='unavailable') as full_text_unavailable,
          count(*) filter (where s.decision='include' and h.paper_id is not null) as full_text_sought,
          count(*) filter (where h.ever_retrieved) as full_text_ever_retrieved,
          count(*) filter (where h.paper_id is not null) as full_text_ever_sought,
          count(*) filter (where h.paper_id is not null and coalesce(s.decision, '') <> 'include') as full_text_retrieval_conflicts
        from papers p
        left join current_screening s on s.project_id=p.project_id and s.paper_id=p.id
        left join current_full_text f on f.project_id=p.project_id and f.paper_id=p.id
        left join current_retrieval r on r.project_id=p.project_id and r.paper_id=p.id
        left join retrieval_history h on h.project_id=p.project_id and h.paper_id=p.id
        where p.project_id=${projectId}
      ), legacy_full_text_without_retrieval as (
        select count(*) as count
        from (select distinct project_id, paper_id from full_text_screening_decisions where project_id=${projectId}) f
        where not exists (select 1 from retrieval_history h where h.project_id=f.project_id and h.paper_id=f.paper_id)
      ), legacy_analysis_awaiting_full_text as (
        select count(*) as count
        from (select distinct project_id, paper_id from extraction_value_revisions where project_id=${projectId} and finalized_at is not null) e
        where not exists (select 1 from current_full_text f where f.project_id=e.project_id and f.paper_id=e.paper_id)
      )
      select
        run_metrics.distinct_search_runs::text as distinct_search_runs,
        run_metrics.reported_results_total::text as reported_results_total,
        record_metrics.retrieved_records::text as retrieved_records,
        run_metrics.distinct_sources::text as distinct_sources,
        record_metrics.currently_resolved_records::text as currently_resolved_records,
        record_metrics.unresolved_records::text as unresolved_records,
        (select count(*)::text from unresolved_candidate_pairs) as unresolved_duplicate_pairs,
        pair_decision_metrics.same_work_decision_pairs::text as same_work_decision_pairs,
        pair_decision_metrics.different_work_decision_pairs::text as different_work_decision_pairs,
        paper_metrics.acquisition_derived_papers::text as acquisition_derived_papers,
        (record_metrics.currently_resolved_records - paper_metrics.acquisition_derived_papers)::text as duplicate_records_collapsed,
        paper_metrics.papers_in_screening_population::text as papers_in_screening_population,
        screening_metrics.unscreened::text as unscreened,
        screening_metrics.included::text as included,
        screening_metrics.excluded::text as excluded,
        screening_metrics.maybe::text as maybe,
        full_text_metrics.full_text_eligible::text as full_text_eligible,
        full_text_metrics.full_text_retrieval_eligible::text as full_text_retrieval_eligible,
        full_text_metrics.full_text_awaiting::text as full_text_awaiting,
        full_text_metrics.full_text_assessed::text as full_text_assessed,
        full_text_metrics.full_text_included::text as full_text_included,
        full_text_metrics.full_text_excluded::text as full_text_excluded,
        full_text_metrics.full_text_maybe::text as full_text_maybe,
        full_text_metrics.full_text_conflicts::text as full_text_conflicts,
        full_text_metrics.finally_included::text as finally_included,
        legacy_analysis_awaiting_full_text.count::text as legacy_analysis_awaiting_full_text,
        full_text_metrics.full_text_not_sought::text as full_text_not_sought,
        full_text_metrics.full_text_retrieval_pending::text as full_text_retrieval_pending,
        full_text_metrics.full_text_retrieved::text as full_text_retrieved,
        full_text_metrics.full_text_unavailable::text as full_text_unavailable,
        full_text_metrics.full_text_sought::text as full_text_sought,
        full_text_metrics.full_text_ever_sought::text as full_text_ever_sought,
        full_text_metrics.full_text_ever_retrieved::text as full_text_ever_retrieved,
        legacy_full_text_without_retrieval.count::text as legacy_full_text_without_retrieval,
        full_text_metrics.full_text_retrieval_conflicts::text as full_text_retrieval_conflicts,
        paper_metrics.historical_acquisition_only_papers::text as historical_acquisition_only_papers,
        paper_metrics.manual_papers::text as manual_papers
      from run_metrics cross join record_metrics cross join pair_decision_metrics cross join paper_metrics
      cross join screening_metrics cross join full_text_metrics cross join legacy_analysis_awaiting_full_text
      cross join legacy_full_text_without_retrieval
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
      fullTextNotSought: tx.execute(sql`select p.id, p.title from papers p join (select distinct on (project_id,paper_id) project_id,paper_id,decision from screening_decisions where project_id=${projectId} and stage='title_abstract' order by project_id,paper_id,sequence desc) s on s.project_id=p.project_id and s.paper_id=p.id where p.project_id=${projectId} and s.decision='include' and not exists (select 1 from full_text_retrieval_attempts r where r.project_id=p.project_id and r.paper_id=p.id)`),
      fullTextRetrievalPending: tx.execute(sql`select p.id, p.title from papers p join (select distinct on (project_id,paper_id) project_id,paper_id,decision from screening_decisions where project_id=${projectId} and stage='title_abstract' order by project_id,paper_id,sequence desc) s on s.project_id=p.project_id and s.paper_id=p.id join (select distinct on (project_id,paper_id) project_id,paper_id,outcome from full_text_retrieval_attempts where project_id=${projectId} order by project_id,paper_id,sequence desc) r on r.project_id=p.project_id and r.paper_id=p.id where p.project_id=${projectId} and s.decision='include' and r.outcome='pending'`),
      fullTextRetrieved: tx.execute(sql`select p.id, p.title from papers p join (select distinct on (project_id,paper_id) project_id,paper_id,decision from screening_decisions where project_id=${projectId} and stage='title_abstract' order by project_id,paper_id,sequence desc) s on s.project_id=p.project_id and s.paper_id=p.id join (select distinct on (project_id,paper_id) project_id,paper_id,outcome from full_text_retrieval_attempts where project_id=${projectId} order by project_id,paper_id,sequence desc) r on r.project_id=p.project_id and r.paper_id=p.id where p.project_id=${projectId} and s.decision='include' and r.outcome='retrieved'`),
      fullTextUnavailable: tx.execute(sql`select p.id, p.title from papers p join (select distinct on (project_id,paper_id) project_id,paper_id,decision from screening_decisions where project_id=${projectId} and stage='title_abstract' order by project_id,paper_id,sequence desc) s on s.project_id=p.project_id and s.paper_id=p.id join (select distinct on (project_id,paper_id) project_id,paper_id,outcome from full_text_retrieval_attempts where project_id=${projectId} order by project_id,paper_id,sequence desc) r on r.project_id=p.project_id and r.paper_id=p.id where p.project_id=${projectId} and s.decision='include' and r.outcome='unavailable'`),
      fullTextEverSought: tx.execute(sql`select distinct p.id, p.title from papers p join full_text_retrieval_attempts r on r.project_id=p.project_id and r.paper_id=p.id where p.project_id=${projectId} order by p.id`),
      fullTextEverRetrieved: tx.execute(sql`select distinct p.id, p.title from papers p join full_text_retrieval_attempts r on r.project_id=p.project_id and r.paper_id=p.id where p.project_id=${projectId} and r.outcome='retrieved' order by p.id`),
      legacyFullTextWithoutRetrieval: tx.execute(sql`select distinct p.id, p.title from papers p join full_text_screening_decisions f on f.project_id=p.project_id and f.paper_id=p.id where p.project_id=${projectId} and not exists (select 1 from full_text_retrieval_attempts r where r.project_id=p.project_id and r.paper_id=p.id) order by p.id`),
      fullTextRetrievalConflicts: tx.execute(sql`select distinct p.id, p.title from papers p join full_text_retrieval_attempts r on r.project_id=p.project_id and r.paper_id=p.id left join (select distinct on (project_id,paper_id) project_id,paper_id,decision from screening_decisions where project_id=${projectId} and stage='title_abstract' order by project_id,paper_id,sequence desc) s on s.project_id=p.project_id and s.paper_id=p.id where p.project_id=${projectId} and coalesce(s.decision,'') <> 'include' order by p.id`),
    };
    if (!(metric in queries)) throw new Error(`Unknown review-flow metric: ${metric}`);
    return queries[metric];
  }
}
