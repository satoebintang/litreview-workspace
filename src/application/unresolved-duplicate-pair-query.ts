import { sql, type SQL } from "drizzle-orm";
import { retrievedRecordDoiComparison } from "@/db/comparison-expressions";

/**
 * Project-scoped candidate generation shared by Overview, equivalence tests,
 * and the manually invoked benchmark. UNION removes pairs supported by more
 * than one signal; the final anti-join excludes every adjudicated pair.
 */
export function unresolvedDuplicatePairCtes(projectId: string): SQL {
  return sql`
    candidate_pairs as (
      select a.id as left_retrieved_record_id, b.id as right_retrieved_record_id
      from retrieved_records a
      join retrieved_records b on b.project_id = a.project_id and a.id < b.id
      where a.project_id = ${projectId}
        and a.doi is not null and b.doi is not null
        and btrim(a.doi) <> '' and btrim(b.doi) <> ''
        and ${retrievedRecordDoiComparison(sql.raw("a.doi"))} = ${retrievedRecordDoiComparison(sql.raw("b.doi"))}

      union

      select a.id as left_retrieved_record_id, b.id as right_retrieved_record_id
      from retrieved_records a
      join retrieved_records b
        on b.project_id = a.project_id
        and b.search_source_id = a.search_source_id
        and b.source_record_id = a.source_record_id
      where a.project_id = ${projectId}
        and a.id < b.id
        and a.source_record_id is not null and b.source_record_id is not null
        and btrim(a.source_record_id) <> '' and btrim(b.source_record_id) <> ''

      union

      select a.id as left_retrieved_record_id, b.id as right_retrieved_record_id
      from retrieved_records a
      join retrieved_records b on b.project_id = a.project_id and a.id < b.id
      where a.project_id = ${projectId}
        and a.publication_year is not null
        and b.publication_year = a.publication_year
        and lower(regexp_replace(btrim(a.title), '[[:space:]]+', ' ', 'g'))
          = lower(regexp_replace(btrim(b.title), '[[:space:]]+', ' ', 'g'))
    ), unresolved_candidate_pairs as (
      select candidate_pairs.left_retrieved_record_id, candidate_pairs.right_retrieved_record_id
      from candidate_pairs
      where not exists (
        select 1
        from retrieved_record_deduplication_decisions d
        where d.project_id = ${projectId}
          and d.left_retrieved_record_id = candidate_pairs.left_retrieved_record_id
          and d.right_retrieved_record_id = candidate_pairs.right_retrieved_record_id
      )
    )
  `;
}
