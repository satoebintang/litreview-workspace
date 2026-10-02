# ADR 0050: Scalable Interactive Review Report

**Status:** implemented and published as `v0.50.0-slice50`

**Date:** 2026-10-02

**Baseline:** `v0.49.0-slice49`, `81fb52c9ebb7cbd7ed3c60b68aa8238712c1a445`

**Published merge SHA:** `40fed15dc20699128bb1f5b7ed42833c0c087a82`

**Migration:** none; `0038` is absent.

## Context

The interactive Review Flow report previously assembled the full report
projection, including all Questions, criteria, SearchSources, SearchRuns,
reasons, and contributor rows. The full Markdown export is an audit artifact
whose complete contents and ordering must remain compatible. Interactive
summary and drilldown reads need bounds without changing released reporting
semantics or writers.

## Decision

Keep `getReviewReport()` and `serializeReviewFlowMarkdown()` as complete
compatibility APIs. Add an interactive summary, six context page types, and a
typed contributor page service. The summary derives labels, explanations,
support, and limitations through the same released presentation projection as
the full report. It uses the canonical Review Flow metrics query directly and
does not call the facade that loads the complete reason list.

The summary includes the fixed 37 metrics, overlap count, support matrix,
limitations, contextual counts, and at most ten aggregates for each reason
stage. It has no Question, criteria, source, SearchRun, or other full context
arrays. It is limited to four SELECTs and a 256 KiB UTF-8 serialized DTO.

Context pages cover active Questions, active title/abstract criteria, active
full-text criteria, SearchSources represented by SearchRuns (including
archived sources), and current title/abstract/full-text exclusion reasons.
They default to 10 rows, clamp at 25, use SQL `LIMIT pageSize + 1`, return at
most 26 rows in at most two SELECTs, and cap the serialized DTO at 128 KiB.
Question and criterion order remains `sort_order, id`; source order remains
`source_key, id`; reason order remains full criterion `text, id`. Cursors carry
full order values, even when returned text is only a preview. Reason cursors
resolve their criterion text in SQL. Context membership is live between
requests; there are no epochs or snapshots.

Contributor selectors include all 37 metric keys, five source metrics, two
reason selectors, and overlap. Pages default to 25 and clamp at 50, return no
more than 51 rows, use at most two SELECTs, and cap the UTF-8 DTO at 256 KiB.
The contract is `{ contributionTotal, items, pageSize, hasMore, nextCursor }`;
it intentionally has no exact contributor-row count. SQL computes exact
contribution totals over the full qualifying relation independently of the
page cursor. Reported-result totals and source reported-result contributions
sum `reported_result_count`; duplicate collapse sums current linked record
count minus one per Paper. All other totals count deduplicated qualifying
identities. BIGINT results remain exact in PostgreSQL and are checked against
JavaScript safe-integer bounds before conversion; overflow is an error, never
rounding. Zero-result SearchRuns remain rows with contribution zero.

Released ordering and rendering identities remain stable: SearchRuns use
`sequence, id`; RetrievedRecords and Papers use ID; dedup pairs use approved
strength rank and canonical pair order; reason pages use Paper ID. For source
`acquisitionPapers`, Paper remains identity while its display label comes from
the first currently linked RetrievedRecord by ID, preserving the released
Node grouping result. Current match, screening, full-text, retrieval, and pair
decision relations reduce to the latest event before filtering its action or
outcome.

Title/abstract reason contributors require the latest title/abstract exclude
and the exact criterion. Full-text reasons require latest title/abstract
include, latest full-text exclude, and the exact full-text criterion.
Cross-source overlap requires a currently linked Paper represented by more
than one distinct SearchSource. Historical-only acquisition links are not
overlap contributors.

The Slice 49 canonical duplicate-pair predicates and bounded pair-ID probing
are reused. The contributor relation retains canonical IDs, every matching
signal, strong-before-possible order, and all adjudication exclusions. Exact
dense totals still evaluate the output-sensitive candidate relation; bounded
page rows do not make database work O(page size).

The summary route redirects valid legacy drilldowns before reading the
summary. Selector precedence stays metric, source, title/abstract reason,
full-text reason, then overlap. Context and contributor pages do not launch
speculative contributor prefetches. Truncation indicators appear only on
interactive previews.

The released full-text retrieval selectors have a compatibility exception to
the old plan matrix: equivalence includes `kind`, and the old reader emits
`fullTextScreeningDecision` with blank `id` and `decision` for
`fullTextRetrieved` and `fullTextUnavailable`. The bounded readers preserve
that released DTO shape and use Paper ID for rendering/navigation identity.
`fullTextEligible` and `fullTextAwaiting` preserve the same blank decision
identity behavior.

## Export and migration boundary

The full report and Markdown export retain all Questions, criteria, source
history, SearchRun appendix rows, reason/context labels, and released order.
A golden fixture contains more rows than interactive page limits and checks
byte-for-byte output. The interactive summary does not truncate or replace
export behavior.

No report persistence, epochs, snapshots, or denormalized tables are added.
No migration 0038 is included. If final PostgreSQL plans show an essential
missing index, implementation must stop for an approved plan amendment before
creating a migration. Existing indexes are reused.

## Benchmark and verification evidence

Benchmark source and retained output:

```text
scripts/benchmark-review-report-read-paths.ts
docs/benchmarks/slice50-review-report-read-paths.json
```

The harness uses Node 22.13.0, PostgreSQL 16, a uniquely named disposable
database, bounded statement timeouts, and guaranteed cleanup. It records
legacy and bounded paths, first/deep pages, exact totals, DTO and driver bytes,
SELECT and returned-row counts, SQL/parameter provenance, and
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` page and total plans. It covers
practical 1k/10k/50k fact populations, large context collections, and dense
dedup cases at 250 and 1,000 records where the runtime permits. Timeouts and
skips are recorded as such, not as passes. See the JSON artifact for observed
measurements and plan details.

## Residual scalability debt

Slice 50 bounds the interactive Review Report only. Other unbounded workflow
histories, imports/intakes, manuscript/document history, and configuration
lists remain separate work. Dense unresolved-deduplication exact totals remain
output-sensitive. Interactive scalability is not complete after this slice.
