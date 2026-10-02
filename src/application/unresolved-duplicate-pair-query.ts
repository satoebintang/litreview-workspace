import { sql, type SQL } from "drizzle-orm";
import { retrievedRecordDoiComparison } from "@/db/comparison-expressions";

/**
 * Project-scoped candidate generation shared by Overview, equivalence tests,
 * and the manually invoked benchmark. UNION removes pairs supported by more
 * than one signal; the final anti-join excludes every adjudicated pair.
 */
export type CandidateSignalPredicates = { doi: SQL; sourceRecordId: SQL; titleYear: SQL; strong: SQL };
export type UnresolvedPairProbeCursor = { strengthRank: 0 | 1; leftId: string; rightId: string };

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

/**
 * Find only comparison signatures shared by at least two records. This keeps
 * sparse projects from probing every record against the whole project while
 * leaving dense groups output-sensitive.
 */
function duplicateSignatureCtes(projectId: string): SQL {
  const doiKey = (alias: string) => retrievedRecordDoiComparison(sql.raw(`${alias}.doi`));
  const titleKey = (alias: string) => sql`lower(regexp_replace(btrim(${sql.raw(`${alias}.title`)}), '[[:space:]]+', ' ', 'g'))`;
  return sql`
    doi_duplicate_keys as materialized (
      select project_id, ${doiKey("doi_rows")} as doi_key
      from retrieved_records doi_rows
      where project_id = ${projectId}::uuid and doi is not null and btrim(doi) <> ''
      group by project_id, ${doiKey("doi_rows")}
      having count(*) > 1
    ), source_record_duplicate_keys as materialized (
      select project_id, search_source_id, source_record_id
      from retrieved_records
      where project_id = ${projectId}::uuid and source_record_id is not null and btrim(source_record_id) <> ''
      group by project_id, search_source_id, source_record_id
      having count(*) > 1
    ), title_year_duplicate_keys as materialized (
      select project_id, publication_year, ${titleKey("title_rows")} as title_key
      from retrieved_records title_rows
      where project_id = ${projectId}::uuid and publication_year is not null and title is not null
      group by project_id, publication_year, ${titleKey("title_rows")}
      having count(*) > 1
    )
  `;
}

function duplicateSignatureLeftIds(projectId: string): SQL {
  const doiKey = (alias: string) => retrievedRecordDoiComparison(sql.raw(`${alias}.doi`));
  const titleKey = (alias: string) => sql`lower(regexp_replace(btrim(${sql.raw(`${alias}.title`)}), '[[:space:]]+', ' ', 'g'))`;
  return sql`
    doi_left_ids as materialized (
      select r.id from doi_duplicate_keys k join retrieved_records r
        on r.project_id = k.project_id and ${doiKey("r")} = k.doi_key
      where r.project_id = ${projectId}::uuid
    ), source_record_left_ids as materialized (
      select r.id from source_record_duplicate_keys k join retrieved_records r
        on r.project_id = k.project_id and r.search_source_id = k.search_source_id and r.source_record_id = k.source_record_id
      where r.project_id = ${projectId}::uuid
    ), title_year_left_ids as materialized (
      select r.id from title_year_duplicate_keys k join retrieved_records r
        on r.project_id = k.project_id and r.publication_year = k.publication_year and ${titleKey("r")} = k.title_key
      where r.project_id = ${projectId}::uuid
    )
  `;
}

export function unresolvedDuplicatePairCtes(projectId: string): SQL {
  return sql`
    ${duplicateSignatureCtes(projectId)},
    candidate_pairs as (
      select a.id as left_retrieved_record_id, b.id as right_retrieved_record_id
      from doi_duplicate_keys k
      join retrieved_records a on a.project_id = k.project_id and ${retrievedRecordDoiComparison(sql.raw("a.doi"))} = k.doi_key
      join retrieved_records b on b.project_id = k.project_id and a.id < b.id and ${retrievedRecordDoiComparison(sql.raw("b.doi"))} = k.doi_key
      union
      select a.id, b.id
      from source_record_duplicate_keys k
      join retrieved_records a on a.project_id = k.project_id and a.search_source_id = k.search_source_id and a.source_record_id = k.source_record_id
      join retrieved_records b on b.project_id = k.project_id and b.search_source_id = k.search_source_id and b.source_record_id = k.source_record_id and a.id < b.id
      union
      select a.id, b.id
      from title_year_duplicate_keys k
      join retrieved_records a on a.project_id = k.project_id and a.publication_year = k.publication_year and lower(regexp_replace(btrim(a.title), '[[:space:]]+', ' ', 'g')) = k.title_key
      join retrieved_records b on b.project_id = k.project_id and b.publication_year = k.publication_year and lower(regexp_replace(btrim(b.title), '[[:space:]]+', ' ', 'g')) = k.title_key and a.id < b.id
    ), latest_pair_decisions as materialized (
      select distinct on (project_id, left_retrieved_record_id, right_retrieved_record_id)
        project_id, left_retrieved_record_id, right_retrieved_record_id, decision
      from retrieved_record_deduplication_decisions
      where project_id = ${projectId}
      order by project_id, left_retrieved_record_id, right_retrieved_record_id, sequence desc, id desc
    ), unresolved_candidate_pairs as (
      select candidate_pairs.left_retrieved_record_id, candidate_pairs.right_retrieved_record_id
      from candidate_pairs
      where not exists (
        select 1
        from latest_pair_decisions d
        where d.project_id = ${projectId}
          and d.left_retrieved_record_id = candidate_pairs.left_retrieved_record_id
          and d.right_retrieved_record_id = candidate_pairs.right_retrieved_record_id
      )
    )
  `;
}

function unresolvedPair(aliasA: string, aliasB: string, projectId: string): SQL {
  return sql`not exists (
    select 1 from retrieved_record_deduplication_decisions d
    where d.project_id = ${projectId}::uuid
      and d.left_retrieved_record_id = ${sql.raw(`${aliasA}.id`)}
      and d.right_retrieved_record_id = ${sql.raw(`${aliasB}.id`)}
  )`;
}

function perLeftSignalProbe(input: {
  signal: SQL;
  leftIds: "doi_left_ids" | "source_record_left_ids" | "title_year_left_ids";
  projectId: string;
  keyLimit: number;
  cursor: UnresolvedPairProbeCursor | null;
  rank: 0 | 1;
  excludeStrong?: SQL;
}): SQL {
  const cursor = input.cursor?.strengthRank === input.rank ? input.cursor : null;
  const leftStart = cursor ? sql`and a.id >= ${cursor.leftId}::uuid` : sql``;
  const afterPair = cursor ? sql`and (a.id, b.id) > (${cursor.leftId}::uuid, ${cursor.rightId}::uuid)` : sql``;
  const notStrong = input.excludeStrong ? sql`and not (${input.excludeStrong})` : sql``;
  return sql`
    select a.id as left_record_id, candidate.id as right_record_id
    from ${sql.raw(input.leftIds)} left_id
    join retrieved_records a on a.project_id = ${input.projectId}::uuid and a.id = left_id.id ${leftStart}
    cross join lateral (
      select b.id
      from retrieved_records b
      where b.project_id = ${input.projectId}::uuid
        and a.id < b.id
        and ${input.signal}
        ${notStrong}
        ${afterPair}
        and ${unresolvedPair("a", "b", input.projectId)}
      order by b.id asc
      limit ${input.keyLimit}
    ) candidate
    where true
  `;
}

/**
 * Shared bounded probe of unresolved canonical pair IDs. The queue and report
 * contributor reader hydrate their own small visible page from these IDs.
 */
export function unresolvedDuplicatePairProbeCtes(
  projectId: string,
  keyLimit: number,
  cursor: UnresolvedPairProbeCursor | null,
): SQL {
  const signals = deduplicationCandidateSignalPredicates();
  const strong = cursor?.strengthRank === 1 ? sql`select null::uuid as left_record_id, null::uuid as right_record_id where false` : sql`
    select left_record_id, right_record_id from (
      ${perLeftSignalProbe({ signal: signals.doi, leftIds: "doi_left_ids", projectId, keyLimit, cursor, rank: 0 })}
      union
      ${perLeftSignalProbe({ signal: signals.sourceRecordId, leftIds: "source_record_left_ids", projectId, keyLimit, cursor, rank: 0 })}
    ) strong_signal_pairs
    order by left_record_id, right_record_id
    limit ${keyLimit}
  `;
  const possibleCursor = cursor?.strengthRank === 1 ? cursor : null;
  const possibleSignal = perLeftSignalProbe({ signal: signals.titleYear, leftIds: "title_year_left_ids", projectId, keyLimit, cursor: possibleCursor, rank: 1, excludeStrong: signals.strong });
  return sql`
    ${duplicateSignatureCtes(projectId)}, ${duplicateSignatureLeftIds(projectId)}, strong_page_ids as materialized (
      ${strong}
    ), possible_signal_ids as (
      ${possibleSignal}
    ), possible_page_ids as materialized (
      select distinct left_record_id, right_record_id from possible_signal_ids
      where (select count(*) from strong_page_ids) < ${keyLimit}
      order by left_record_id, right_record_id
      limit ${keyLimit}
    ), probe_ids as (
      select 0::int as strength_rank, left_record_id, right_record_id from strong_page_ids
      union all
      select 1::int, left_record_id, right_record_id from possible_page_ids
    ), ordered_probe as materialized (
      select strength_rank, left_record_id, right_record_id
      from probe_ids order by strength_rank, left_record_id, right_record_id limit ${keyLimit}
    )
  `;
}
