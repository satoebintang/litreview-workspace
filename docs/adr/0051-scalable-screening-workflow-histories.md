# ADR 0051: Scalable Screening and Full-Text Workflow Histories

**Status:** accepted for publication

**Date:** 2026-10-02

**Baseline:** `v0.50.0-slice50`, `40fed15dc20699128bb1f5b7ed42833c0c087a82`

**Migration:** none; migration `0038` is absent.

## Context

The title/abstract decision, full-text decision, and full-text retrieval
histories are append-only ledgers that previously loaded every event into the
normal detail routes. Those routes need bounded first pages and independent
continuations while preserving full-return compatibility APIs, released writer
semantics, historical criterion references, and complete audit recovery.

## Decision

Normal screening detail routes use `screeningHistoryReadServices`. All three
histories default to 20 rows and cap at 50, select `pageSize + 1`, and order by
`sequence ASC, id ASC`. They return no exact history total. Full-text decision
and retrieval histories have independent page and cursor state; continuing one
stream does not query the other.

Cursors bind the version, Project, Paper, fixed history type, effective page
size, and last event's sequence and ID. The encoded token is canonical,
base64url JSON capped at 512 characters. Sequence values are selected as
`sequence::text`, validated as canonical PostgreSQL BIGINT decimal strings,
and compared with BIGINT casts. The cursor anchor is checked against the same
Project, Paper, and fixed stream before it is used as a range boundary. Stream
selection uses fixed SQL branches and never accepts a table name from the
cursor.

Current state preserves the released rule: select the row with the greatest
sequence using `ORDER BY sequence DESC LIMIT 1`, with no ID tie-breaker. This
is separate from deterministic history traversal order. Duplicate sequence
values are not prohibited; history pages use ID to order ties, but do not
establish a new current-state winner among tied events.

Each service request uses a read-only `REPEATABLE READ` transaction. There are
no epochs or frozen history snapshots. Sequence is an operational reservation
order, not commit order: if a lower sequence is reserved early, a higher
sequence commits first, a client traverses past it, and the lower sequence
commits later, restarting may be required to observe that late event.

Detail responses include bounded first pages and compact current-state fields
only. Current notes and retrieval source references are not hydrated to decide
state. A current event beyond page one remains represented in current state
and links to its exact audit route. Full-text detail embeds two separate first
pages: decision history and retrieval-attempt history.

History SQL applies output caps before transfer: decision notes 600 Unicode
code points, criterion text 128, retrieval notes 384, and retrieval
`sourceReference` 384. DTOs return truncation flags. Historical values are not
rewritten; exact-event reads bind Project, Paper, event ID, and fixed history
type, restore complete values, and return a generic not-found error for wrong
scope. Exact Paper abstract, authors, DOI, and other Paper fields remain
complete. Slice 51 bounds growing histories rather than every Paper or
configuration field.

Criteria remain referenced records rather than event snapshots. Criterion
archival changes archival state without rewriting historical decision
identity. Title/abstract history retains its historical criterion presentation;
full-text history retains its archived-criterion annotation. Active criterion
form catalogs remain outside this slice and may still be unbounded.

Retrieval current state remains greatest sequence, independently of
researcher-supplied `attemptedAt`; `everRetrieved` remains true if any
historical attempt was retrieved. A later pending or unavailable attempt may
be current while `everRetrieved` remains true.

Successful writes remain append-only and keep their existing transaction,
locking, gates, triggers, exclusion validation, and error behavior. The
three writer functions and legacy full-return readers remain unchanged. Their
successful redirects go to the main detail/page-one route.

## Query and payload budgets

Core owned SELECT targets are title/abstract detail 4, full-text detail 4,
retrieval detail 2, standalone history at most 2, and exact-event read at most
2. Project layout reads are counted separately. No read count scales with
history length or returned page rows.

A maximum 50-row history page must serialize to no more than 256 KiB of UTF-8
JSON. Both first-20 full-text history envelopes together must serialize to no
more than 256 KiB. Rows are never removed dynamically to satisfy a payload
limit. These are DTO and query-count bounds; they do not establish that all
PostgreSQL work is O(page size). The `everRetrieved` probe uses the existing
Project/Paper attempt index but may scan all attempts when no success exists;
the benchmark measures no-success, early-success, and late-success cases.
Previewing and exact reads can also incur TOAST/text costs that depend on field
size.

## Benchmark and migration boundary

The benchmark harness and retained PostgreSQL 16 evidence are:

```text
scripts/benchmark-screening-history-read-paths.ts
docs/benchmarks/slice51-screening-history-read-paths.json
```

The harness exercises 1k, 10k, and 50k events per Paper and records bounded
first/deep/final pages, exact events, normal details, full-text two-stream
detail, long history text, practical legacy full-history comparisons, and
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans. It uses a uniquely named
disposable database and checks cleanup. The plans inspect the existing
`(project_id, paper_id, sequence)` indexes, deep range reads and sequence/ID
tie sorting, limited-page criterion joins, current-state probes,
`everRetrieved` with no/early/late success, and preview/exact text access.

Existing history indexes are reused. There are no snapshots, epochs,
replacement history tables, denormalized persistence, or sequence uniqueness
constraints. If final SQL plans demonstrate a structural index deficiency,
implementation stops for a plan amendment before any migration is added.

## Residual scalability debt

Legacy compatibility APIs still return full histories by design and remain
available to non-normalized callers. Active criterion catalogs and exact Paper
content fields remain unbounded. Live history traversal can require a restart
to see a late-committing lower sequence, because sequence allocation does not
freeze cross-request membership. The `everRetrieved` existence check can do
work proportional to retrieval-history length, particularly when there is no
retrieved outcome or the first success is late. Other workflow histories
remain separate bounded-read work.
