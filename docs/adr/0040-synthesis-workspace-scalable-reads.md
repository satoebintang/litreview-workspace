# ADR 0040: Synthesis Workspace Scalable Reads

## Status

Accepted for Slice 40 implementation. Implementation is complete and remains
uncommitted for publication review.

## Decision

Starting from `v0.39.0-slice39` at
`7e32efe65e66ed6eb75cecf2b0d9fae24a76fd13`, the ordinary Synthesis workspace
uses bounded projections from
`src/application/synthesis-read-services.ts`. Existing canonical Synthesis
writers, `getCurrentSynthesis()`, exact revision and interpretation views, and
their full provenance remain unchanged. The existing full-read services stay
available for compatibility and old/new equivalence checks.

The dashboard selects an active Extraction Field, reads a bounded comparison
page and complete state summary in two reads, and reads a compact paginated
Synthesis ledger in two reads. Count/page pairs use one read-only
`REPEATABLE READ` snapshot. The matrix orders Papers by creation time and ID;
the ledger keeps current finalized-revision order. Matrix rows contain exact
ExtractionRevision identity and value data plus Evidence-link counts, not
Evidence provenance. The ledger contains compact finalized revision data and
exact support counts, not nested provenance.

The matrix selection is a `Set<ExtractionRevisionId>`. Its hidden inputs submit
those exact IDs while display labels remain client context. Page and search
changes do not replace a selected historical ID with the current revision for
the same Paper and Field. The canonical Synthesis writer remains the authority
for submitted-ID validation.

The detail page keeps the current revision's full provenance and current
interpretation unchanged. Other finalized history is a compact summary with
complete exact support summaries, fetched in two set-based reads. Support
ordering preserves the released repository order:
`support.created_at ASC, ExtractionRevision ID ASC`. Bulk preparation metadata
is loaded in one read. Targeted edit context is one set-based read for all
exact Paper/Field/revision targets.

Edit carry-forward uses the shared Paper review facts and
`derivePaperReviewStatus()` path. An exact support is eligible for the new
revision only when canonical `finalEligibility` is `included`, the exact
ExtractionRevision is finalized, and its state is not `cleared`. Field archival
does not invalidate an exact existing support or prevent its carry-forward
when those conditions hold. An archived Field does suppress current-revision
replacement controls. Replacement otherwise requires canonical final
inclusion, a different current revision, and a non-cleared current value.

The released ledger uses an inner lateral join to the latest finalized
SynthesisRevision. The new ledger retains that behavior: a stable
`synthesis_statements` row with no finalized revision remains absent.

## Semantic equivalence proof

The integration fixture compares new and released projections by identity,
ordering, values, state metrics, and support context.

| Projection | Equivalence coverage | Result |
|---|---|---|
| Field comparison matrix | Active and archived Fields; missing/current extraction; present, not-reported, not-applicable, cleared; text, numeric, boolean, and select values; archived select option; Evidence counts; support/selectability; title-abstract and full-text inclusion/exclusion | Matches legacy Paper order, current revision IDs/sequences, display values, support status, selectability, field metadata, and full-population state counts |
| Synthesis ledger | Supported, unsupported, withdrawn; multiple exact supports across Papers and Fields; stable current revisions; complete summary counts; anomalous stable statement with no finalized revision | Matches `listProjectSynthesis()` order and values; anomalous no-finalized statement is absent |
| Compact history | Multiple finalized revisions, exact support snapshots, historical select option after archival, and later current ExtractionRevision | Matches legacy revision and support order, values, support status/counts, and currentness; Evidence passages are not hydrated |
| Preparation context | Multiple revision IDs with or without preparation metadata | Matches legacy exact preparation metadata in a single bulk read |

History support ordering is asserted directly against the released full
provenance order for every revision in the fixture. It is not reordered by
Paper title, Field, ExtractionRevision sequence, or currentness.

The cross-page browser fixture selects 50 exact IDs, changes pages, keeps the
first selected revision after a later revision supersedes it, and submits
selections spanning 51, 120, and 250 IDs. The persisted
Synthesis support set exactly matches the 250 submitted IDs.

The edit-context regression proves both user-approved semantic boundaries:

| Existing exact support | Historical rendering | Carry-forward | Replacement control |
|---|---|---|---|
| Full-text Paper later excluded | Remains visible | Not eligible because canonical final eligibility is `excluded` | Disabled/absent |
| Exact finalized support from archived Field; non-cleared and currently included Paper | Remains visible | Eligible by exact ID | Absent because Field is archived |
| Exact support whose latest value was cleared | Remains visible | Exact old support remains eligible | No cleared replacement |
| Active Field with a newer non-cleared current revision and included Paper | Remains visible | Exact support remains eligible | Current replacement is available |

The detail page loads the FT-excluded historical support and archived-Field
support without throwing. Exact historical IDs stay visible even when current
eligibility or Field state changes.

## Query-count proof

Query-count assertions warm the test connection first to exclude postgres.js's
one-time array-type lookup. Counts below refer to the read-model SELECTs.

| Read model | SELECTs | Scaling proof |
|---|---:|---|
| Comparison count/summary plus bounded page | 2 | Page sizes 1, 25, 50, and 100; same count at 51 Papers |
| Ledger count plus bounded page | 2 | Page sizes 1, 50, and 100 |
| Complete compact history plus set-based exact supports | 2 | 1, 50, 500, and 1,000 revisions |
| Bulk preparation context for revision IDs | 1 | Empty, one, and full-history ID sets |
| Targeted edit context | 1 | 1, 25, 100, and benchmarked through 1,000 targets |

A separate two-connection test commits review and ledger changes after the
first count SELECT and verifies that the matching page remains on the original
snapshot. A later request observes the committed changes.

## Benchmark method and observations

`npx tsx scripts/benchmark-synthesis-read-paths.ts` creates, migrates, and force-drops a
uniquely named PostgreSQL 16 database. It seeds 1,000, 10,000, and 50,000
Papers, extraction revisions, and Synthesis statements; compares the bounded
reads with released full projections; captures returned rows, query counts,
serialized payloads, and `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`; and measures
history and edit-context sizes of 1, 50, 500, and 1,000. The synthetic
population has one current finalized extraction per Paper and one finalized
Synthesis statement per Paper. Timings are local warm-cache observations, not
CI thresholds.

| Population | Matrix legacy: SELECTs / wall / rows / payload | Matrix bounded: SELECTs / wall / rows / payload | Ledger legacy: SELECTs / wall / rows / payload | Ledger bounded: SELECTs / wall / rows / payload | Old/new equivalent |
|---:|---|---|---|---|---|
| 1,000 | 4 / 160.0 ms / 1,000 / 1,339,787 B | 2 / 62.4 ms / 50 / 35,009 B | 3 / 136.5 ms / 1,000 / 656,787 B | 2 / 140.4 ms / 50 / 27,202 B | Yes |
| 10,000 | 4 / 468.1 ms / 10,000 / 13,419,896 B | 2 / 156.5 ms / 50 / 35,074 B | 3 / 189.7 ms / 10,000 / 6,589,896 B | 2 / 63.5 ms / 50 / 27,353 B | Yes |
| 50,000 | 4 / 2,572.3 ms / 50,000 / 67,188,895 B | 2 / 1,065.6 ms / 50 / 35,122 B | 3 / 1,161.5 ms / 50,000 / 33,038,895 B | 2 / 357.6 ms / 50 / 27,403 B | Yes |

| History revisions | Legacy: SELECTs / wall / rows / payload | Compact: SELECTs / wall / revisions and supports / payload | Equivalent |
|---:|---|---|---|
| 1 | 5 / 17.9 ms / 1 / 2,121 B | 2 / 12.8 ms / 1 and 1 / 1,065 B | Yes |
| 50 | 5 / 19.9 ms / 50 / 106,042 B | 2 / 12.6 ms / 50 and 50 / 53,242 B | Yes |
| 500 | 5 / 37.3 ms / 500 / 1,060,893 B | 2 / 20.7 ms / 500 and 500 / 532,893 B | Yes |
| 1,000 | 5 / 67.9 ms / 1,000 / 2,121,894 B | 2 / 34.0 ms / 1,000 and 1,000 / 1,065,894 B | Yes |

The separate bulk-preparation-context read stayed at one SELECT for every
history size. Its synthetic revisions had no preparation row, so each returned
context set was empty.

| Exact edit targets | SELECTs | Returned contexts | Wall time | Payload |
|---:|---:|---:|---:|---:|
| 1 | 1 | 1 | 10.6 ms | 702 B |
| 50 | 1 | 50 | 21.3 ms | 35,051 B |
| 500 | 1 | 500 | 293.3 ms | 350,501 B |
| 1,000 | 1 | 1,000 | 915.0 ms | 701,001 B |

All synthetic old/new matrix, `present` state-count, ledger, and history
comparisons completed and matched. At 50,000 Papers the matrix summary and page
plans executed in 844.3 ms and 719.3 ms, respectively. Both visit the Project's
review and extraction facts to derive complete eligibility and state counts.
The page plan reports 15,380 temp-read and 19,024 temp-written blocks; the
summary plan reports no temp blocks. Existing Paper, review-decision,
ExtractionValue, and current ExtractionRevision indexes appear in these plans.
The full-population reads are required by the dashboard's complete count
contract.

The 50,000-row ledger count and page plans executed in 196.2 ms and 205.1 ms,
with zero temporary blocks and zero shared-read blocks. They use the existing
`synthesis_revisions_project_statement_sequence_idx` and exact revision
lookups. The statement scan visits the Project population, and the support
relation scan is over the bounded page; no missing exact lookup was identified.

At 1,000 edit targets, the plan completed in 1,240.2 ms with zero temporary
blocks and zero shared-read blocks. It uses existing Paper, Extraction Field,
ExtractionValue, and ExtractionRevision indexes. Shared canonical review-fact
relations use sequential scans and return 1,000 matching rows from each
synthetic relation, with 60,000 nonmatching rows removed across the benchmark
Projects. Existing project/Paper/sequence indexes are present but were not
selected for these scans. At 1,000 history revisions, the revision and support
plans completed in 4.7 ms and 5.9 ms, with no temp spill or shared reads. The
existing revision-sequence and exact revision indexes are used; the support
table scan is scoped to that exact Synthesis.

The full-population scans and matrix page aggregation reflect the required
Project-wide snapshot and counts. The decision and retrieval indexes exist;
their sequential plan at this 61,000-row synthetic scale does not demonstrate
that adding a new index would materially improve this workload. Ledger,
history, and exact ExtractionRevision lookups use existing indexes. No plan
demonstrates a material missing index. No migration is indicated. Migration
`0033` was not created.

## Production caller and artifact audit

The ordinary Synthesis dashboard calls the bounded comparison and ledger
services. Ordinary Synthesis detail calls compact history summaries, bulk
preparation context, and targeted edit context while retaining the current
revision's full provenance and interpretation data. The exact revision and
interpretation audit route is unchanged. Direct source search found no
ordinary-dashboard/detail call to the full matrix, full Synthesis ledger, or
full Synthesis history methods. A remaining `listProjectSynthesis()` call in
the Synthesis preparation workspace is outside this ordinary-workspace slice.

No migration SQL, migration snapshot, or journal change was made. Migration
`0032_hot_path_hardening.sql` matches published baseline blob
`1d36750ff0f4943af67e6d0fcbc55e34a61c31b8`. No package manifest,
dependency, lockfile, or migration artifact changed. There is no `0033` file.

## Final implementation gate

| Gate | Result |
|---|---|
| Focused integration read-model tests | Pass: 6 tests |
| Focused Slice 40 browser regressions | Pass: 2 tests, including 51/120/250 exact-ID selection |
| `npm test` | Pass: 93 files, 616 tests |
| `npm run test:integration` | Pass: 60 files, 363 tests, run separately |
| `npx playwright test --workers=1 --retries=0` | Pass: 46 browser tests |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm run db:check` | Pass |
| `npm run build` | Pass |
| `git diff --check` | Pass |
| Dependency audit | Existing baseline: 9 advisories (7 moderate, 2 high, 0 critical); dependency files unchanged |

The work must remain uncommitted on `master` at
`7e32efe65e66ed6eb75cecf2b0d9fae24a76fd13`. `origin/master` and
`v0.39.0-slice39` must resolve to that same commit. Protected remote CI is not
run before publication review. No branch, commit, PR, tag, push, `0033`, or
Slice 41 work is part of this implementation.

## Scope exclusions

Slice 40 adds no migration, Synthesis writer change, Synthesis support semantic
change, interpretation change, or modification to exact revision provenance.
It does not change the separate Synthesis preparation workspace or begin Slice
41.
