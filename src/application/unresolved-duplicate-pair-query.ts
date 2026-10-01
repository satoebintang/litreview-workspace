import { sql, type SQL } from "drizzle-orm";
import { retrievedRecordDoiComparison } from "@/db/comparison-expressions";

/**
 * Project-scoped candidate generation shared by Overview, equivalence tests,
 * and the manually invoked benchmark. UNION removes pairs supported by more
 * than one signal; the final anti-join excludes every adjudicated pair.
 */
export type CandidateSignalPredicates = { doi: SQL; sourceRecordId: SQL; titleYear: SQL; strong: SQL };

/**
 * Released duplicate signals shared by bounded and compatibility readers.
 * Aliases are internal SQL identifiers selected by this module's callers.
 */
export function deduplicationCandidateSignalPredicates(leftAlias = "a", rightAlias = "b"): CandidateSignalPredicates {
  const left = (column: string) => sql.raw(`${leftAlias}.${column}`);
  const right = (column: string) => sql.raw(`${rightAlias}.${column}`);
  const doi = sql`
    ${left("doi")} is not null and ${right("doi")} is not null
    and btrim(${left("doi")}) <> '' and btrim(${right("doi")}) <> ''
    and ${retrievedRecordDoiComparison(left("doi"))} = ${retrievedRecordDoiComparison(right("doi"))}
  `;
  const sourceRecordId = sql`
    ${left("source_record_id")} is not null and ${right("source_record_id")} is not null
    and btrim(${left("source_record_id")}) <> '' and btrim(${right("source_record_id")}) <> ''
    and ${left("search_source_id")} = ${right("search_source_id")}
    and ${left("source_record_id")} = ${right("source_record_id")}
  `;
  const titleYear = sql`
    ${left("publication_year")} is not null
    and ${right("publication_year")} = ${left("publication_year")}
    and lower(regexp_replace(btrim(${left("title")}), '[[:space:]]+', ' ', 'g'))
      = lower(regexp_replace(btrim(${right("title")}), '[[:space:]]+', ' ', 'g'))
  `;
  return { doi, sourceRecordId, titleYear, strong: sql`coalesce((${doi}) or (${sourceRecordId}), false)` };
}

export function unresolvedDuplicatePairCtes(projectId: string): SQL {
  const signals = deduplicationCandidateSignalPredicates();
  return sql`
    candidate_pairs as (
      select a.id as left_retrieved_record_id, b.id as right_retrieved_record_id
      from retrieved_records a
      join retrieved_records b on b.project_id = a.project_id and a.id < b.id
      where a.project_id = ${projectId}
        and ((${signals.doi}) or (${signals.sourceRecordId}) or (${signals.titleYear}))
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
