# ADR 0037: Extraction Workspace Integrity and Scalable Reads

## Status

Accepted for Slice 37 implementation.

## Decision

Slice 37 preserves the Slice 36 release baseline at
474feeb72fa28369e60221464892d49f5358a8cc and combines Extraction write
serialization with bounded, set-based workspace reads. It does not change the
research model, comparison matrix, or AI orchestration.

Within an Extraction canonical-write transaction, when two or more
Extraction-domain entities require row locks, acquire them in this order:

1. Project
2. Paper
3. ExtractionField
4. ExtractionOption
5. Evidence rows in UUID ascending order

This order applies only to Extraction canonical-write transactions. It is not a
universal database lock order. Field eligibility is checked after locking the
Field. When a revision references an option, its current ownership and active
state are checked from the locked Option. Reused Evidence is deduplicated and
locked as a UUID-sorted set before AI groundings are processed in their original
order. Fresh Evidence created during acceptance has no pre-existing row to lock.

Field/Option creation, archival, and update operations share the locks needed
to serialize append order and close archive/use and definition-update/first-use
races. Both ordinary revision writes and AI acceptance use the same canonical
row-lock discipline. The locks enforce current eligibility; they do not replace
the AI request's frozen field and option definition checks, baseline revision
identity, frozen source document and text extraction/pages, grounding identity,
or expected-current-revision check.

## AI workflow lock domains and cycle review

AI orchestration retains its own workflow-specific locking domains. These
include AI request/result/decision and dispatch rows, batch and batch-item state,
Paper full-text preference rows, full-text document rows, and document text
extraction rows. Their existing workflow ordering is documented and reviewed
separately; the Extraction order above does not redefine those domains.

The Slice 37 source review traced the single-request and batch acceptance paths
where they enter the Extraction canonical-write path, and checked ordinary
Extraction writers for reverse acquisition of AI request/result/dispatch or
source-document locks. The reviewed paths have no reverse cross-domain
acquisition edge: AI acceptance enters Paper/Field/Option/Evidence after its
workflow reads, while ordinary Extraction writes do not subsequently acquire
AI workflow or document locks. AI source-document and text-extraction
coordination remains inside its own request/batch paths. The race tests cover
Field and Option archive/update interactions with ordinary and AI acceptance.

This is an Extraction-domain cycle review, not a claim that every database
transaction in the application shares one lock order. Other domains retain
their existing local orders and must be reviewed independently if a future
change makes them acquire Extraction rows in a new sequence.

## Progress read contract

The paginated progress read is a read-only REPEATABLE READ count/page pair.
Its membership is frozen against fixtures generated from the released
getProjectExtractionProgress implementation:

- included Papers are finally included under derivePaperReviewStatus;
- historical Papers are non-included Papers with the exact released legacy
  analytical-history warning;
- only active required Fields contribute to requiredFieldCount;
- only the latest finalized revision for each active Field contributes to
  completion and started state;
- present, not_reported, and not_applicable complete a required Field;
- a current cleared revision is not started;
- status and percentage use the released not_configured, complete, partial,
  and not_started rules;
- writeEligible remains finalEligibility === included.

The shared review-facts projection feeds the canonical
derivePaperReviewStatus translation. Counts, membership, review warnings,
completion counts, status, and percentage are compared on every page against
the frozen legacy fixtures before callers move to the paginated read.

## Worksheet read contract

The Paper worksheet is read in a read-only REPEATABLE READ snapshot with a
bounded statement timeout and a fixed number of SQL reads, independent of
active Field count and finalized revision history length. It returns the Paper
and current PaperReviewStatus, active Fields in the released sort order,
active and archived Options for those Fields in their released order, current
finalized revisions for active Fields, all finalized history for those Fields,
revision-to-Evidence links, current Evidence scoped in SQL by both Project and
Paper, and the Paper progress summary.

Archived Options remain available for current and historical labels. Worksheet
values remain limited to active Fields. Current revision supportStatus retains
the released grounded/ungrounded rule. Current Evidence reviewState and
curationWarning use the same latest review decision semantics as the released
Evidence service. Evidence reads never load a Project-wide set and filter by
Paper in application memory.

## Migration decision

Slice 37 adds no migration and does not create migration 0033. The final
decision is based on EXPLAIN (ANALYZE, BUFFERS) for the actual progress and
worksheet SQL at 50,000 Papers, plus timing and row-count observations at
1,000, 10,000, and 50,000 Papers. Existing indexes are retained unless a
material query plan demonstrates an essential missing index. The 50,000-Paper
plans below use existing project/Paper, review-sequence, current-revision,
revision-Evidence, and latest-Evidence-review indexes for their corresponding
lookups. They do not identify a specific missing lookup index. Several exact
progress count/page plans spill sort/hash work to PostgreSQL temporary files;
that bounded membership-sort cost is recorded as a remaining query-plan
observation, not treated as proof that a new index is beneficial. No migration
was added.

## Benchmark method

Run npx tsx scripts/benchmark-extraction-read-paths.ts against PostgreSQL 16 with a role
permitted to create and drop a database. The script creates one uniquely named
disposable database, applies the checked-in migration set, seeds all fixtures
there, and drops only that database in finally. Seed statements have a
600-second timeout; benchmark reads and EXPLAIN use a 120-second timeout, and
lock waits are capped at five seconds. `EXTRACTION_READ_BENCHMARK_PAPERS` and
`EXTRACTION_READ_BENCHMARK_FIELDS` may narrow an investigative rerun; the
release evidence run covers all nine combinations of 1,000/10,000/50,000
Papers and 10/50/100 active Fields.

Each project has 20 finalized history rows per target active Field, archived
and active single-select options, current and historical revision Evidence
links, four Paper Evidence items spanning accepted/needs_review/rejected/
unreviewed states, and one Evidence row per project Paper. Every seeded Paper
is a progress member: all but one are finally included, and one has the
released legacy analytical-history warning. This exercises membership counts
and page queries at each catalog size.

The benchmark executes the released project-progress and worksheet-related
service calls, then the new paginated progress and set-based worksheet
services. When the released project-progress call completes within its bounded
legacy time budget, it compares its counts and (for the 1,000-Paper case) full
membership against the new pages. The released implementation may time out at
larger memberships; its timeout and captured work are reported without
preventing the bounded path from running. The released worksheet comparison
checks Field and Option ordering, archived Option rows, current revision
identity, every finalized history row and Evidence link, current Paper
Evidence review state and warnings, reviewStatus, and progress math. Frozen
integration fixtures remain the authoritative old/new progress membership
and per-Paper semantics check across all pages. The benchmark reports SELECT
counts separately from transaction setup commands, rows, serialized payload
bytes, and wall time.
For the 50,000-Paper cases it captures EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
for every material SELECT emitted by the new progress and worksheet reads.
Timings are observations, not pass/fail thresholds. Legacy progress uses a
15-second wall budget, except for the 1,000-Paper/10-Field full-membership
equivalence case, which has a 30-second budget; legacy worksheet uses a
60-second budget. Each legacy path runs in its own child process with a
single-connection client pointed only at the generated benchmark database and a
unique PostgreSQL `application_name`. On timeout, the parent terminates the
child, terminates only sessions in that database with that application name,
and waits for the tagged sessions and process to exit before continuing.
Timed-out worker counters are sampled every 250 statements and the JSON labels
the last checkpoint as a lower bound; completed counts are exact. The benchmark
and worker connections each use one connection so session-level statement and
lock timeouts cover every measured query. The measurement run used Node
24.19.0 because the configured Node 22.13.0 runtime was unavailable; timings
are diagnostic and should be compared on the release runtime before treating
small differences as material.

## Benchmark observations

The clean PostgreSQL 16 run covered all nine Paper/Field combinations. The
legacy progress path completed only for 1,000 Papers/10 Fields; it matched the
new counts and all 1,000 Paper IDs across the 20 pages. At that size the first
page used two SELECTs and the remaining 19 pages used 38 SELECTs. The bounded
progress path used exactly two SELECTs in every scenario. The new worksheet
used exactly nine SELECTs in every scenario, independent of Field count and
history length. All nine old/new worksheet equivalence comparisons passed for
Field and Option order, archived Options, current finalized revision identity,
all finalized history and Evidence links, current Evidence review facts,
reviewStatus, and progress.

| Papers | Fields | Released progress | New progress page | Released worksheet | New worksheet |
| ---: | ---: | --- | --- | --- | --- |
| 1,000 | 10 | 13,496 ms / 5,026 SELECTs, complete | 34.8 ms / 2 SELECTs | 1,016 ms / 318 SELECTs | 68.0 ms / 9 SELECTs |
| 1,000 | 50 | 15 s timeout; ≥4,500 SELECTs at last checkpoint | 55.0 ms / 2 SELECTs | 5,244 ms / 1,558 SELECTs | 110 ms / 9 SELECTs |
| 1,000 | 100 | 15 s timeout; ≥4,000 SELECTs at last checkpoint | 32.2 ms / 2 SELECTs | 10,392 ms / 3,108 SELECTs | 128 ms / 9 SELECTs |
| 10,000 | 10 | 15 s timeout; ≥13,250 SELECTs at last checkpoint | 122 ms / 2 SELECTs | 1,157 ms / 318 SELECTs | 41.4 ms / 9 SELECTs |
| 10,000 | 50 | 15 s timeout; ≥14,500 SELECTs at last checkpoint | 105 ms / 2 SELECTs | 5,937 ms / 1,558 SELECTs | 81.2 ms / 9 SELECTs |
| 10,000 | 100 | 15 s timeout; ≥14,000 SELECTs at last checkpoint | 89.3 ms / 2 SELECTs | 9,196 ms / 3,108 SELECTs | 106 ms / 9 SELECTs |
| 50,000 | 10 | 15 s timeout; ≥50,500 SELECTs at last checkpoint | 1,089 ms / 2 SELECTs | 1,913 ms / 318 SELECTs | 57.9 ms / 9 SELECTs |
| 50,000 | 50 | 15 s timeout; ≥52,000 SELECTs at last checkpoint | 730 ms / 2 SELECTs | 6,533 ms / 1,558 SELECTs | 98.4 ms / 9 SELECTs |
| 50,000 | 100 | 15 s timeout; ≥52,000 SELECTs at last checkpoint | 493 ms / 2 SELECTs | 10,662 ms / 3,108 SELECTs | 141 ms / 9 SELECTs |

The released worksheet SELECT count scales with active Fields: 318, 1,558,
and 3,108 SELECTs at 10, 50, and 100 Fields. It also reads every project
Evidence row before filtering to the target Paper; the 50,000-Paper fixture
returned 50,003 project rows to obtain four Paper Evidence rows. The set-based
worksheet returned those same four Paper rows with nine SELECTs. The timeouts
in the table are intentional bounded outcomes, not equivalence failures. For
each timeout, the isolated worker and its tagged PostgreSQL sessions were
terminated before the new progress read continued. Timed-out counters are
lower bounds sampled at the last 250-statement checkpoint, not exact totals.

All 33 EXPLAIN (ANALYZE, BUFFERS) plans completed across the three 50,000-Paper
cases: two progress SELECTs and nine worksheet SELECTs per Field count. The
plans used existing project/Paper/review-sequence/current-revision/Evidence
indexes for their selective lookups. Full membership still scans the seeded
50,000-Paper and review-fact population where every row participates in exact
counts and ordering; Field and Option catalog scans remained small. Four
progress statements reported temporary sort/hash I/O:

- 50,000 Papers/10 Fields, progress page SELECT 2: 858 blocks read, 859 written;
  471 ms execution and 328 shared-buffer read blocks.
- 50,000 Papers/50 Fields, progress page SELECT 2: 858 blocks read, 859 written;
  487 ms execution and 1,991 shared-buffer read blocks.
- 50,000 Papers/100 Fields, progress count SELECT 1: 906 blocks read, 908
  written; 235 ms execution and 1,595 shared-buffer read blocks.
- 50,000 Papers/100 Fields, progress page SELECT 2: 2,266 blocks read, 2,270
  written; 683 ms execution and 6,335 shared-buffer read blocks.

PostgreSQL blocks are 8 KiB. The largest observed temporary write/read was about
17.7 MiB; the largest shared-buffer read count was about 49.5 MiB. The progress
count and page remain fixed at two SELECTs and completed in 32–1,089 ms across
the matrix. These plans show a measurable sort/hash spill at 50,000 Papers, but
do not isolate a missing index that would remove it. Slice 37 therefore adds no
index or migration 0033; any later query/work_mem tuning should be evaluated
against these captured plans and the release runtime.

## Release artifact verification

The baseline contains 33 SQL migration files, 33 journal entries, and 29
checked-in snapshots (63 artifacts including the journal). Slice 37 adds no
migration, journal entry, or snapshot. Exact worktree-to-baseline comparison
found three SQL files and seven snapshots with CRLF worktree line endings while
their baseline blobs use LF. All 63 artifacts match the baseline byte-for-byte
after CRLF-to-LF normalization; the journal and other artifacts match as raw
bytes. The line-ending variants predate this Slice 37 run and were preserved.
