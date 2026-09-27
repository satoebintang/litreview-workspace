# ADR 0044: Scalable Title/Abstract Screening Reads

## Status

Implemented for Slice 44 review from approved baseline
fb51abb3502ed37e5ee6abd1e130a639dd873a4e. The PostgreSQL 16 benchmark and
50,000-Paper plans completed on Node 22.13.0. The plans showed no essential
missing lookup or ordering index, so no 0034 migration was created.

## Decision

The title/abstract screening dashboard and Paper detail navigation use the
Project-scoped read model in
src/application/screening-read-services.ts, exposed as screeningReadServices
from src/app/server.ts. The dashboard queue returns only id, title, authors,
publicationYear, and screeningState. Per-Paper abstract, DOI, criteria, current
decision, and full screening history remain in the existing detail service.

The queue derives each Paper's current state from its latest title/abstract
decision ordered by sequence descending and id descending. No decision means
unscreened; include, exclude, and maybe map to their corresponding queue states.
Counts, selected-state count, and the independent Start screening target come
from a Project-anchored aggregate. Start screening chooses the first unscreened
Paper in created_at ascending, id ascending order, falling back to the first
Paper in that order. It does not materialize an ID array.

For an existing Project, the queue performs exactly two core SELECTs in one
read-only REPEATABLE READ transaction: the aggregate and the bounded page.
Only the page crosses into application memory. The aggregate returns one row
for an existing Project, including an empty Project. A missing Project is
reported as PROJECT_NOT_FOUND after the aggregate and before the page SELECT.
Queue rows are ordered by created_at ascending, id ascending.

The queue defaults to 50 rows and clamps the page size at 100. Invalid state
normalizes to all and resets the page to 1. Invalid, non-positive, or unsafe
page numbers normalize to 1; invalid page sizes normalize to 50. A page beyond
the end clamps to the last page. Empty results use page 1, zero total pages,
and zero from/to bounds.

Detail navigation uses one Project-anchored SELECT. It resolves only the
requested Paper's one-based position and immediate previous/next Paper across
all Project Papers, regardless of screening state. UUID validation occurs
before SQL. A malformed Project or Paper identifier raises canonical
VALIDATION_ERROR without a query. A valid but nonexistent Project raises
PROJECT_NOT_FOUND. For an existing Project, a missing or foreign-Project Paper
returns null so the route can use notFound(). The target-based query uses the
existing Project/created_at Paper index and does not rank every Project Paper.

## Caller audit and compatibility

| Caller or dependency | Classification | Slice 44 result |
|---|---|---|
| projects/[projectId]/screening/page.tsx | Production dashboard | Replaced the Project-wide full-list read with the bounded queue. |
| projects/[projectId]/screening/[paperId]/page.tsx | Production detail navigation | Replaced the full-list read with exact Paper navigation; getPaperScreening still supplies detail and history. |
| screening-services.ts listScreeningPapers | Compatibility application API | Retained unchanged for callers that need the complete list. |
| extraction-services.ts getProjectExtractionProgress | Other production dependency | Retained. Extraction progress still derives canonical final eligibility from all current title/abstract states and is outside this slice. |
| screening integration tests and Paper Collection equivalence tests | Test callers | Retained; listScreeningPapers remains the released-path semantic oracle. |
| benchmark-paper-collection-read-paths.ts | Existing benchmark | Retained as the prior comparison. |
| slice35-v034-api.json | Architecture compatibility fixture | Retained with the legacy service export. |

A tracked-source search and direct reads found only the two screening routes
above using listScreeningPapers in production. The code graph had no recorded
caller edges for the method and relevant paths were marked metadata_changed,
so the caller conclusion is based on the source search and review, not graph
absence.

No decision writer, criteria rule, Paper ownership rule, history behavior, or
downstream eligibility rule changes in this slice.

## Evidence Set scaling is deferred

Evidence Set scaling spans more than the size of a displayed list. The current
readCurrentSnapshot operation loads the latest immutable composition revision
and every active member. getEvidenceSet then enriches those Evidence members
and reads composition history for display. The detail page renders all active
members and every composition snapshot. Its reorder form contains one hidden
Evidence ID per active member and submits the full sequence.

Each add, remove, or reorder operation reads the complete current composition,
constructs the complete next membership sequence, and appends a new immutable
composition snapshot containing that sequence. Paginating the detail page
alone would leave full membership input, full next-snapshot writes, and
historical composition reads unbounded. A separate design must address those
read, browser input/rendering, immutable-write, and history requirements while
preserving exact composition history. Slice 44 does not change Evidence Set
reads, forms, membership writes, or snapshots.

## Benchmark and index decision

The final diagnostic benchmark ran with Node 22.13.0 against PostgreSQL 16.15,
using isolated disposable databases at 1,000, 10,000, and 50,000 Papers. Each
workload has 25% unscreened, 25% included, 25% excluded, and 25% maybe Papers.
Each decided Paper has an initial maybe decision and a later current decision.
The run compares legacy `listScreeningPapers` with all-state, filtered included,
deep, empty-Project, and zero-match filtered pages, then first, middle, and last
navigation. Each SQL shape was warmed once before measurement.

SELECT count comes from the executed SQL. Returned database rows are counted
by postgres.js result-row instrumentation during each measured service call.
Payload bytes are UTF-8 JSON sizes of each service result. Wall times are local
diagnostics, not latency thresholds. The retained [benchmark evidence JSON](../benchmarks/slice44-screening-read-paths.json)
records the exact Node and PostgreSQL server versions, complete raw EXPLAIN
plans, and `droppedOwnBenchmarkDatabase: true`.

| Papers | Read | SELECTs | Database rows | Payload bytes | Wall time |
|---:|---|---:|---:|---:|---:|
| 1,000 | Legacy `listScreeningPapers` | 2 | 1,001 | 1,138,457 | 23.22 ms |
| 1,000 | All-state queue page | 2 | 51 | 7,939 | 15.96 ms |
| 1,000 | Filtered included page | 2 | 51 | 8,016 | 15.26 ms |
| 1,000 | Deep all-state page | 2 | 51 | 8,063 | 21.54 ms |
| 1,000 | Empty-Project page | 2 | 1 | 221 | 12.67 ms |
| 1,000 | Zero-match filtered page | 2 | 1 | 226 | 12.84 ms |
| 1,000 | First / middle / last navigation | 1 each | 1 each | 157 / 193 / 160 | 4.06 / 4.67 / 5.02 ms |
| 10,000 | Legacy `listScreeningPapers` | 2 | 10,001 | 11,433,444 | 227.17 ms |
| 10,000 | All-state queue page | 2 | 51 | 7,946 | 61.82 ms |
| 10,000 | Filtered included page | 2 | 51 | 8,023 | 56.40 ms |
| 10,000 | Deep all-state page | 2 | 51 | 8,173 | 85.62 ms |
| 10,000 | Empty-Project page | 2 | 1 | 221 | 15.17 ms |
| 10,000 | Zero-match filtered page | 2 | 1 | 226 | 11.23 ms |
| 10,000 | First / middle / last navigation | 1 each | 1 each | 158 / 195 / 162 | 5.50 / 6.60 / 9.65 ms |
| 50,000 | Legacy `listScreeningPapers` | 2 | 50,001 | 57,305,483 | 1,115.32 ms |
| 50,000 | All-state queue page | 2 | 51 | 7,951 | 314.11 ms |
| 50,000 | Filtered included page | 2 | 51 | 8,029 | 293.96 ms |
| 50,000 | Deep all-state page | 2 | 51 | 8,278 | 527.98 ms |
| 50,000 | Empty-Project page | 2 | 1 | 221 | 13.75 ms |
| 50,000 | Zero-match filtered page | 2 | 1 | 226 | 9.13 ms |
| 50,000 | First / middle / last navigation | 1 each | 1 each | 158 / 196 / 162 | 11.14 / 18.28 / 28.23 ms |

The 50,000-Paper run captured full `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
output for the aggregate, all-state page, filtered page, deep page, and each
navigation position. The following table summarizes the measured plans:

| 50,000-Paper plan | Execution time | Observed access path and buffers |
|---|---:|---|
| Aggregate counts and Start target | 318.90 ms | 50,000-Paper sequential scan and 50,000 latest-decision lookups through `screening_decisions_project_paper_sequence_idx`; 230,546 shared hits, zero shared reads, and 798 temp blocks read/written. |
| All-state bounded page | 0.43 ms | `papers_project_created_at_idx` and `screening_decisions_project_paper_sequence_idx`; 239 shared hits, no temp blocks. |
| Filtered included bounded page | 1.16 ms | Same Paper and decision indexes; 201 ordered Paper candidates were read to return 50 included Papers, with 150 removed by the state filter; 928 shared hits, no temp blocks. |
| Deep all-state page | 289.16 ms | Parallel sequential scan plus external merge sort for OFFSET 49,950; latest-state lookups use `screening_decisions_project_paper_sequence_idx`; 225,000 shared hits on decision lookups, 747 temp blocks read and 748 written. |
| First navigation | 10.70 ms | Project primary-key anchor and `papers_project_id_id_unique` target lookup; `papers_project_created_at_idx` for position/neighbors; exact count scans 50,000 Papers; 5,563 shared hits, no temp blocks. |
| Middle navigation | 19.41 ms | Same access paths; exact count scans 50,000 Papers; 8,055 shared hits, no temp blocks. |
| Last navigation | 31.02 ms | Same access paths; exact count scans 50,000 Papers; 10,550 shared hits, no temp blocks. |

The aggregate's temp blocks come from its exact whole-Project current-state
calculation. Deep OFFSET work scans and sorts the full Paper corpus while
resolving latest state for traversed rows. Navigation's exact total count also
scans the Project Papers, while position and neighbor lookups use the existing
ordering index. The existing decision index serves latest-state lookups, the
Paper ordering index serves queue ordering and navigation, and the target
lookup uses the Paper/Project uniqueness index. These plans show no essential
missing lookup or ordering index; no `0034` migration was created.
## Remaining boundaries

Per-Paper screening history and Project criteria lists remain complete reads.
The legacy listScreeningPapers API remains available for compatibility and
non-route callers. Evidence Set scaling remains a separate slice. Full-text
screening and retrieval, Paper Review projections, Paper Collection reads,
decision writers, and Slice 45 are outside this decision.
