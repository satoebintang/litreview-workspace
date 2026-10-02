# ADR 0049: Scalable Deduplication Queue

**Status:** implemented and published as `v0.49.0-slice49`

**Date:** 2026-10-01

**Implementation baseline:** `v0.48.0-slice48`, `baa45e4732c68b56b09517bd5d8df961c13a6518`

**Implementation-time state:** the accepted implementation was initially an uncommitted working tree.

**Published release:** `v0.49.0-slice49`

**Merge SHA:** `81fb52c9ebb7cbd7ed3c60b68aa8238712c1a445`

## Context

The released Deduplication queue assembled and sorted the complete Project-wide
candidate relation, hydrated full RetrievedRecords, resolved mappings, and
returned every unresolved pair. Exact-pair inspection and decision history also
used full compatibility reads. The interactive queue needs bounded keyset
pages while preserving the released candidate membership, pair reasons,
researcher decisions, mapping state, and exact audit behavior.

## Decision

Keep the released full-return candidate and history APIs as compatibility
readers. The normal queue uses a dedicated bounded reader and does not call
`listDeduplicationQueue()` or `getReviewFlowSummary()`. The exact pair page can
still open any two distinct same-Project RetrievedRecords, including a pair
that was never a candidate or has already been adjudicated. It does not require
current queue membership.

Factor the released DOI, sourceRecordId, and title/year comparisons into one
shared SQL predicate helper. The compatibility candidate reader, unresolved
pair CTE, bounded queue, and Review Flow unresolved-pair count consume those
predicates. In particular, the title/year comparison retains the released
behavior for blank titles when years match. Candidate reasons are emitted once
in DOI, sourceRecordId, then title/year order; any DOI or sourceRecordId match
makes the pair strong, while title/year alone makes it possible. Canonical pair
IDs always satisfy `leftId < rightId`, and every adjudicated pair is excluded
from the unresolved queue.

The bounded queue uses page size 25 by default and clamps at 50. For `K = P +
1`, it probes at most K ordered right-side IDs per left record and signal. It
applies the all-history adjudication exclusion before local limits; the
possible branch excludes strong pairs before its local limit. Signal overlap
is deduplicated before each rank's global page boundary. Strong and possible
ranks are kept separate so a strong cursor continues strong first and starts
possible at its beginning only when strong is exhausted. A possible cursor
skips strong and continues possible after its own pair boundary. The next
cursor is based on the final visible row and its actual rank.

Rich queue hydration occurs after the bounded pair-ID probe and only for
visible pairs. It returns the two compact record projections, complete ordered
reasons, and strength. SQL caps titles at 230 code points, the first three
authors joined at 230, DOI at 200, and sourceRecordId at 160. It returns no
abstract, full author array, metadata, decision history, or match history.
Current mapping is computed set-wise from latest `RetrievedRecordMatch`
events for visible record IDs only. The latest event is selected before its
linked/unlinked action is interpreted. The queue returns no exact unresolved
total. A read-only `REPEATABLE READ` request uses a Project scope SELECT and a
bounded page SELECT; the page result is capped at 512 KiB. The maximum cursor
length is 256 characters.

Queue cursors are live keyset boundaries bound to version, Project, the `all`
filter, page size, rank, and canonical pair IDs. Each request has its own
read-only snapshot; the cursor carries no epoch or high-water mark. Membership
changes between requests are live: insertion before the boundary is omitted
from a continuation, insertion after it may appear, and adjudication removes a
pair from later pages.

Decision history pages default to 20 and clamp at 50, ordered by ascending
sequence then ID, with no exact total. SQL returns a 600-code-point note
preview and `noteTruncated`, and the serialized page is capped at 256 KiB.
History cursors are bound to Project, canonical pair, page size, and the
lossless sequence/ID boundary; maximum cursor length is 512 characters.
PostgreSQL BIGINT `sequence` values are selected as text and remain canonical
decimal strings through cursor encoding and comparison (`sequence > $cursor::bigint`).
No cursor boundary passes through JavaScript `Number`. Full notes remain
unbounded by the application and are available only through one exact
Project/pair/decision event read. Wrong Project or pair scope returns the same
not-found-style error without resolving a decision ID by itself.

Writers keep their existing locking, validation, Paper mapping behavior,
append-only event histories, transactions, rollback, and consistency triggers.
The Review Flow still computes its exact unresolved count and now consumes the
same shared candidate predicates as the queue and compatibility readers.

## Physical design and migration

Reuse the released comparison, decision-history, and match-history indexes.
No migration is required or authorized for this slice; there is no `0038`.
PostgreSQL candidate generation remains output-sensitive. The top-K identity
probe limits rows carried into deduplication and hydration; it does not make
dense database work O(P). A dense Project can still require PostgreSQL to
evaluate a quadratic candidate universe. If final PostgreSQL plans show that
an additional index is essential, stop for a plan amendment instead of adding
a migration silently.

## Scalability closeout

**Scalability work is not complete after Slice 49.** Remaining ranked debt is
Review Report contributor paging, workflow histories, imports/intakes,
manuscript/document histories, Protocol/report context, and configuration
lists. Those areas are explicitly deferred and are not part of this ADR's
implementation.

## Verification evidence

The retained PostgreSQL 16 / Node 22.13 benchmark is
`docs/benchmarks/slice49-deduplication-read-paths.json`. Its provenance
records the implementation-time baseline and uncommitted state at the time of
measurement; those historical fields are retained and are not release-time
evidence. The published merge SHA is recorded above. The benchmark exercises sparse 1k/10k/50k records, moderate
overlap, dense 1k records (499,500 candidate pairs), long decision history,
and varied mappings. Queue and history cases capture the SQL generated by the
application builders with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, measured
row/loop/index/sort/temp data, driver row counts, payload sizes, and SELECT
counts. The benchmark does not create a 50k dense fixture.

The independent Luna/max review and final broad verification gates are
reported by the Slice 49 integration handoff after implementation review.
