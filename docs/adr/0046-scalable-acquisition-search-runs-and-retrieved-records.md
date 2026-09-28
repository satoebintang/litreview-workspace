# ADR 0046: Scalable SearchRun and RetrievedRecord Review

**Status:** accepted for Slice 46 implementation
**Date:** 2026-09-28
**Baseline:** `v0.45.0-slice45` at `ecb78a86e17e5e2f5f8615e638e6631987b94811`

## Context

The released Protocol page loaded every SearchRun and used the same run-wide list to select a run for manual RetrievedRecord creation. The SearchRun page called `listRetrievedRecordProjections()`, which materialized all records for the run, current matches, complete match histories, duplicate candidates, and Paper labels. It rendered row-level PaperPickers. The normal Review Report called the full `getReviewReport()` path, materialized all run snapshots and distinct historical source labels, and rendered the complete SearchRun appendix.

The full projection and writer APIs are released compatibility contracts. The complete Markdown export is intentionally output-sized and must retain every run snapshot, every distinct historical source label, the existing metrics, and the complete immutable appendix.

## Decision

Add `createAcquisitionReadServices()` in `src/application/acquisition-read-services.ts` and wire it through `src/app/server.ts`. Keep existing acquisition writers, run-wide projection APIs, and complete reporting API unchanged for compatibility.

The interactive route flow is:

```text
Protocol → cursor-paged SearchRun ledger → exact SearchRun
         → cursor-paged RetrievedRecord ledger → exact RetrievedRecord
         → current match, bounded history/candidates, and Paper actions
```

The SearchRun detail retains the complete immutable source and query/filter/note snapshots, then renders one bounded RetrievedRecord page. The exact RetrievedRecord route validates Project, Run, and Record together, shows that record's complete persisted metadata and URL, and owns its match history, candidate list, PaperPicker, and link/unlink/relink/create actions. A detail view renders one PaperPicker branch for that record at a time. No PaperPicker is rendered in ledger rows.

Manual RetrievedRecord creation now lives on the exact SearchRun page. The server loads the SearchRun, derives `searchSourceId` from it, calls the existing validated writer, and redirects to the new exact record route. Nested match mutations verify that the Record belongs to the submitted Run before invoking the existing writer.

## Cursor and epoch contracts

All cursors are versioned, opaque to the UI, and bound to Project, the relevant Run or Record, page size, and search state. Malformed or mismatched cursors return the canonical validation message `Page link expired or invalid. Start from the first page.` They never fall back to page one.

| Read | Order and epoch | Cursor boundary |
| --- | --- | --- |
| SearchRun ledger | `sequence DESC, id DESC`; first-page Project maximum visible sequence | Project, page size, high-water sequence, last sequence/ID |
| RetrievedRecord ledger | `retrieved_at DESC NULLS LAST, id DESC NULLS LAST`; first-page database transaction timestamp applied to immutable `created_at` | Project, Run, page size, field and normalized filter, snapshot timestamp, last RetrievedAt/ID |
| Match history | `sequence ASC, id ASC`; first-page maximum event sequence for this Record | Project, Run, Record, page size, high-water sequence, last sequence/ID |
| Duplicate candidates | `Paper.created_at ASC, id ASC`; first-page Paper insertion timestamp and Project-wide visible match-event maximum sequence | Project, Run, Record, page size, both epochs, last Paper timestamp/ID |

The RetrievedRecord epoch intentionally does not use user-supplied `retrievedAt`; it can be backdated. Candidate sibling current-match state and current-Paper exclusion are both resolved at the pinned match-event high-water. This is a sequence boundary, not a cross-request MVCC snapshot. A transaction that commits late with an insertion timestamp or event sequence at or before the pinned boundary may appear on a later request. Refreshing from page one establishes new epochs.

## Bounded projections, searches, and budgets

Every page query uses `LIMIT pageSize + 1`; the extra row determines `hasMore` and is not returned. The RetrievedRecord page materializes its ordered, filtered page before computing text previews and current-match projections, so continuation reads do not expand the projection across the whole run. There is no dedicated `hasMore` query and no exact total count.

| Read | Default / maximum | First page SELECTs | Continuation SELECTs |
| --- | --- | ---: | ---: |
| SearchRun ledger | 50 / 100 | 2 (Project high-water plus page) | 1 |
| RetrievedRecord ledger | 50 / 100 | 2 (Run/epoch anchor plus page; latest matches are set-based in the page SQL) | 1 |
| Match history | 25 / 50 | 2 (Record match high-water plus page with Paper labels) | 1 |
| Duplicate candidates | 20 / 50 | 2 (Paper/match epochs plus candidate page) | 1 |
| Exact SearchRun or RetrievedRecord | one entity | 1 service read | — |

The RetrievedRecord list is SQL-capped in Unicode code points: title 200; at most three authors, 80 each; venue 100; DOI and sourceRecordId 120 each; abstract 240; raw citation 300; linked Paper title 200. The list omits URL and full fields. It returns an additional-author count. Detail reads are intentionally output-sized for one record. The benchmark checks each structural cap and a conservative worst-case JSON payload bound, as well as observed payloads.

Search supports only exact normalized title (maximum 1,000 Unicode code points), normalized DOI (maximum 2,000), and case-sensitive exact sourceRecordId (maximum 2,000). The DOI maximum is a new read-search input bound; stored DOI validation is unchanged. Longer stored values remain available in the ledger/detail but cannot be submitted as search terms beyond this bound. There is no fuzzy, substring, scored, or ranked search.

## Acquisition semantics

The new reader preserves SearchRun sequence order, RetrievedRecord `retrievedAt` order, Project/Run/SearchSource ownership, and latest-event current-match semantics. Existing writer locking, validation, append-only event behavior, atomic relink, canonical Paper identity, and Paper creation are unchanged.

Duplicate candidates preserve the released DOI normalization, normalized title plus equal non-null year, and stable SearchSource UUID plus exact case-sensitive sourceRecordId on another record currently linked to that Paper. The candidate page is bounded and ordered by Paper creation time/ID. The exact detail view excludes the currently linked Paper using the same match epoch. After an `unlinked` event, that Paper may reappear if another candidate signal still matches. The legacy `findRetrievedRecordDuplicateCandidates()` retains its released latest-unlinked behavior, including exclusion of the Paper named by the latest unlinked event. The legacy run-wide projection is unchanged.

## Review Report split

The normal report page now calls `getInteractiveReviewReport()`, which reuses the released metric and limitation builder but loads compact source aggregates, not the complete SearchRun array or historical label arrays. Each stable SearchSource keeps exact counts, current configuration, the earliest observed distinct historical snapshot pair, and the count of distinct historical pairs. The full immutable appendix is replaced by an aggregate acquisition summary and a link to Protocol browsing.

The explicit export route remains `getReviewReport()` followed by `serializeReviewFlowMarkdown()`. It still emits the complete SearchRun appendix and full historical label pairs. The normal-page/report split is covered by route contracts and integration regressions.

Contributor drilldowns may still return large contributor sets; they remain a documented reporting-scaling debt outside this acquisition-focused slice. SearchSource, SearchStrategy, Research Question, and screening-criteria configuration lists also remain unbounded by this decision. SynthesisPreparation candidate/history reads and the ResearchQuestion matrix remain deferred to Slice 47.

## Migration and benchmark evidence

The planning scratch EXPLAIN used a temporary table and was not sufficient to authorize an index. The final application page SQL from `buildRetrievedRecordPageQuery()` was captured and benchmarked at 1k, 10k, and 50k records, with equal base retrieved timestamps, explicit linked/unlinked/relinked rows, a 26-event history, 25 DOI candidates, and title/year and stable source-record sibling signals. The benchmark migrated a unique disposable PostgreSQL 16.15 database through the project migrations, then captured the exact page SQL with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` before and after dropping/recreating the migration index against identical seeded data. The retained SQL has parameter shapes only; numeric values and literals inside plan expressions are redacted, while structural plan counters remain intact.

At 50k, before the index, the first page used a parallel sequential scan and sort; its RetrievedRecord scan read 50,004 qualifying rows across three workers and used 10,167 shared-hit buffers. The deep continuation scanned 49,955 rows and removed 11,081 additional rows before sorting. After `0035`, both first and deep pages used `retrieved_records_project_run_order_idx`; each ordered index scan read exactly 51 rows (`pageSize + 1`), with 52 shared hits plus 2 reads for the first page and 54 shared hits plus 1 read for the continuation. The benchmark guard counts actual rows plus filtered rows across all loops, and the measured continuation had 51 actual rows, one loop, and zero filtered rows. This structural change supports:

`drizzle/0035_retrieved_record_run_order.sql`

The non-unique index is `(project_id, search_run_id, retrieved_at DESC NULLS LAST, id DESC NULLS LAST)`. The two ordering columns are non-null, so explicit null ordering preserves the released order while matching Drizzle's index definition. Prior migrations were not edited. Retained SQL, parameter shapes, plans, payloads, and workload results are in `docs/benchmarks/slice46-acquisition-read-paths.json`.

Measured service budgets were two SELECTs for SearchRun and RetrievedRecord first pages, one SELECT for each continuation, one SELECT for exact detail, and two SELECTs for first-page match history and duplicate candidates. Default 50-row ledger pages returned 50 items; the maximum record page returned 100. Observed 50-row RetrievedRecord ledger payloads ranged from 50,340 to 52,684 UTF-8 bytes; the 100-row payload was 103,399 bytes. The legacy full projection returned 1,003 rows in 1.59 seconds at the 1k fixture and 10,003 rows in 3.37 seconds at the 10k fixture, crossing 1,273 and 12,535 driver rows respectively and producing 3,393,954 and 33,935,174 payload bytes. Wall time is diagnostic, not an acceptance threshold.
