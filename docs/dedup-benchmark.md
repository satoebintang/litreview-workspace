# Deduplication query benchmark

The benchmark is a manual PostgreSQL 16 diagnostic. After adding the script
registration below, run `npm run benchmark:dedup`. It requires a nonblank
`DATABASE_URL` whose role can create and drop a disposable database. The script
migrates that database, seeds synthetic records, prints timings and
`EXPLAIN (ANALYZE, BUFFERS)` plans for the released and indexed query shapes,
then drops the database in its cleanup path.

Required `package.json` registration for the integration lead:

```json
"benchmark:dedup": "tsx scripts/benchmark-dedup.ts"
```

The sparse cases run at 1,000, 10,000, and 50,000 records. A separate overlap
case checks that one pair matching all three signals is emitted once. The
bounded dense DOI case uses 1,000 records, which produces 499,500 candidate
pairs. The script analyzes the seeded tables before measuring. The released
all-pairs count is skipped at 50,000 records, while its `EXPLAIN ANALYZE` still
runs with a 30-second statement timeout and reports a timeout as a result.
The indexed query has a 120-second statement timeout. Neither limit is a CI
timing threshold.

The harness also records cost-only `EXPLAIN (FORMAT TEXT)` plans for both
queries at every size. These planner plans remain available when the released
query's bounded `EXPLAIN ANALYZE` times out. PostgreSQL estimated costs below
are planner units, not milliseconds.

Read `N` as retrieved-record count and `M` as the actual candidate-pair count
before decision-history exclusion. Candidate generation is output-sensitive:
the objective is work close to indexed matching plus candidate output. A dense
key still emits every matching pair; 10,000 records sharing one key imply
about 50 million pairs. The benchmark makes no linear-time claim.

## Result snapshot

This run used PostgreSQL 16 and Node 22.13.0. Counts below are wall time for
the count query; planner costs are the total estimated costs from the old and
indexed cost-only plans.

| Distribution | N | M | Indexed count | Released count | Planner cost, released → indexed |
|---|---:|---:|---:|---:|---:|
| Sparse | 1,000 | 500 | 20.61 ms | 1,085.92 ms | 31,330 → 514 |
| Sparse | 10,000 | 5,000 | 128.15 ms | timed out at 30 s | 3,089,153 → 10,367 |
| Sparse | 50,000 | 25,000 | 561.98 ms | not run | 45,428,141 → 242,189 |

At 1,000 records, PostgreSQL plans the released query as a nested loop that
walks record pairs and applies the combined OR predicate. The indexed query
uses three matching branches, then removes overlapping pairs and excludes
decision history. Its small-table plan uses sequential scans, sorting, and
hashing. At 10,000 and 50,000 records, the DOI branch uses
`retrieved_records_project_doi_comparison_idx`; PostgreSQL plans the
source-record branch as a hash join for these seeded distributions and the
title/year branch as a merge join. The released plan remains a nested loop
with the OR predicate. The released `EXPLAIN ANALYZE` timed out at 10,000 and
50,000 records; its cost-only plan was still captured. The 50,000-record old
count was not run.

The separate 1,000-record overlap case had `M=500` and returned the expected
450 unresolved pairs after history exclusion: 31.74 ms indexed versus
2,894.49 ms released. In the dense DOI diagnostic, `M=499,500`; indexed took
1,659.23 ms and released took 848.39 ms. This dense result demonstrates the
output-sensitive limit: producing a genuinely large pair set can dominate
runtime.
