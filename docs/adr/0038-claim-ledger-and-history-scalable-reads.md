# ADR 0038: Claim Ledger and History Scalable Reads

## Status

Accepted for Slice 38 implementation.

## Decision

Starting from `v0.37.0-slice37` at
`9e468264c852471d1de9e2407d8ed2b6223bf958`, Slice 38 adds compact SQL read
models for the Project-wide Claim ledger and Claim history. The existing Claim
service remains authoritative for writes and exact full provenance. Existing
`listClaims()`, `getClaimHistory()`, and `getClaimRevision()` contracts remain
available to compatibility and downstream consumers.

The ledger selects the highest-sequence finalized revision per Claim, preserves
ordering by revision sequence descending and Claim ID ascending, and excludes
anomalous Claims without a finalized revision. Its two reads run in a read-only
`REPEATABLE READ` transaction. The aggregate query starts from `projects`, so
an existing empty Project returns aggregate zeros while an absent Project has no
anchor row. The bounded page contains no Evidence text, nested provenance,
document metadata, or citation paths.

Typed support counts come from the three exact ClaimRevision support tables and
are aggregated independently before they are combined. `supported` means an
active revision with at least one typed support; withdrawn rows have withdrawn
lifecycle and do not count as active unsupported Claims.

The workspace citation total preserves released UI semantics: sum each current
ClaimRevision's distinct reachable Paper count. A Paper reachable from three
Claims contributes three to the workspace total. Citation and structural Paper
relations remain independent. Citation paths are direct Evidence, an exact
ExtractionRevision with Evidence, or an exact SynthesisRevision through an
exact ExtractionRevision with Evidence. Structural paths also include exact
ExtractionRevisions and exact synthesis-to-extraction targets without Evidence.
Each relation deduplicates Paper identity within a ClaimRevision, never by DOI,
and reads immutable support paths without current Evidence review, screening,
or target-freshness filters.

Claim history summaries use only immutable ClaimRevision and exact typed support
snapshots. Later rejection, exclusion, or target supersession does not rewrite
historical support status or citation/structural counts. The detail page loads
the current revision with full provenance. When the current revision is
withdrawn, it also loads the latest prior active revision with full provenance
for the existing explicit reactivation context. All other history remains
compact. Reactivation eligibility and selection behavior are unchanged.

Direct Evidence link/unlink shortcuts read only the current revision identity,
lifecycle, text, note, and exact typed support IDs. Those IDs are advisory input
to the existing immutable snapshot writer. Its stable Claim lock,
expected-current check, canonical support validation, and write behavior remain
authoritative; concurrent revisions continue to fail through the optimistic
check.

The Claims workspace consumes database-filtered pages of 50 rows, Project-wide
state counts, and a filtered X–Y of Z range. Filter links reset to page one.
Filter and page links carry active interpretation and synthesis context so
ledger navigation does not detach the interpretation form.

## Migration decision

Slice 38 creates no migration and does not create `0033`. Existing indexes are
retained unless actual `EXPLAIN (ANALYZE, BUFFERS)` evidence identifies a
material deficiency that an appropriate index solves. A sequential scan or
temporary sort/hash spill alone does not justify a schema amendment. If such an
essential missing index is demonstrated, stop and request an approved migration
amendment before creating it.

The 50,000-Claim plans use the existing per-Claim revision-sequence index and
the existing Project/revision support indexes for current-revision and exact
support lookups. Full scans of the Project's Claim/support relations are needed
to derive Project-wide counts and exact path relations. The observed temp sort
and hash work is bounded by that full-corpus aggregation; the plans do not show
a missing lookup that an additional index would remove. No migration is
indicated.

## Metric-equivalence fixture

The new current and history metrics were compared directly with the released
`getClaimRevision()` and `getClaimHistory()` projections. The mixed-support
fixture yields this exact matrix:

| Metric | Released full projection | Compact read model | Fixture evidence |
|---|---:|---:|---|
| Direct Evidence supports | 2 | 2 | Two direct Evidence IDs |
| ExtractionRevision supports | 2 | 2 | Two exact extraction IDs |
| SynthesisRevision supports | 1 | 1 | One exact synthesis ID |
| Total typed supports | 5 | 5 | Sum of the three support tables |
| Support status | `supported` | `supported` | Active revision with five supports |
| Citation candidates | 2 | 2 | Paper A has three paths; Paper C has one |
| Structural distinct Papers | 3 | 3 | Includes Paper B reached only by an extraction without Evidence |
| Workspace citation total before withdrawal | 4 | 4 | Paper A contributes once to each of three Claims; Paper C once |

The fixture also rejects Evidence, excludes Paper A, and supersedes extraction
and synthesis targets after the snapshot. Historical metric values stay equal
to the released exact-revision projection. Unsupported and withdrawn rows,
empty Projects, cross-Project IDs, and 0/1/49/50/51 page boundaries are covered
separately. Seven focused integration tests pass, including the inter-SELECT
repeatable-read race and the targeted-support-read/concurrent-write rejection.

The browser test seeds 52 current Claims and verifies the database-derived
counts (52 all, 1 supported, 51 unsupported), a 50-row first page, page-two
range, filter reset, and interpretation/synthesis context preservation while
the interpretation form remains active.

## Benchmark method

`npm run benchmark:claim-read-paths` uses PostgreSQL 16 and a role permitted to
create and drop a uniquely named disposable database. It migrates and seeds
1,000, 10,000, and 50,000 Claims with mixed exact direct Evidence, extraction,
structural-only extraction, and synthesis support paths. It also seeds
single-Claim histories with 1, 50, 500, and 1,000 revisions. The benchmark
records statement and SELECT counts, materialized rows/supports, serialized
payload bytes, wall time, old/new aggregate equivalence when the legacy read
completes, and bounded legacy timeouts. Legacy calls run in a tagged isolated
worker; timeout cleanup terminates only its sessions in the disposable
benchmark database.

At each Claim size it captures `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for
the ledger aggregate and page queries. At each history size it captures the
history-summary plan. Timings are diagnostic observations rather than release
thresholds.

## Benchmark observations

The completed run used PostgreSQL 16 and dropped its uniquely named disposable
database. Ledger SELECT count stayed at two and returned 50 rows at every size.
The three-statement service total includes transaction setup. Each page payload
contains compact rows and project-wide counts, not full provenance.

| Current Claims requested | New ledger wall time | Rows / payload | Aggregate counts (all / supported / unsupported / withdrawn) | Citation total | Legacy `listClaims()` |
|---:|---:|---:|---|---:|---|
| 1,000 | 91.3 ms | 50 / 27,718 B | 1,000 / 657 / 343 / 0 | 571 | Timed out at 20.2 s; at least 4,400 SELECTs observed |
| 10,000 | 368.9 ms | 50 / 27,873 B | 10,000 / 6,572 / 3,428 / 0 | 5,714 | Timed out at 20.2 s; at least 15,000 SELECTs observed |
| 50,000 | 2,652.5 ms | 50 / 27,878 B | 50,004 / 32,858 / 17,143 / 3 | 28,572 | Timed out at 20.3 s; at least 54,600 SELECTs observed |

The 50,000-Claim Project has four auxiliary history Claims, explaining the
50,004 total. Because all legacy ledger workers reached their wall budget, the
large-corpus aggregate comparison is unavailable; the deterministic fixture
matrix above remains the old/new semantic comparison.

| History revisions | Compact summary: wall / SELECTs / rows / payload | Legacy full history: wall / SELECTs / payload | Summary metrics equal | Detail full-revision hydrations | Detail composition: wall / SELECTs / payload |
|---:|---|---|---|---:|---|
| 1 | 15.8 ms / 2 / 1 / 508 B | 119.8 ms / 7 / 832 B | Yes | 1 | 45.7 ms / 9 / 1,403 B |
| 50 | 19.4 ms / 2 / 50 / 25,956 B | 634.6 ms / 154 / 31,278 B | Yes | 2 | 81.2 ms / 17 / 27,690 B |
| 500 | 42.3 ms / 2 / 500 / 260,855 B | 6,944.6 ms / 1,504 / 312,077 B | Yes | 2 | 86.4 ms / 17 / 262,593 B |
| 1,000 | 64.1 ms / 2 / 1,000 / 522,854 B | 14,267.9 ms / 3,004 / 625,076 B | Yes | 2 | 112.6 ms / 17 / 524,594 B |

`getLatestActiveClaimRevisionId()` is one SELECT. The one-revision detail case
has an active current revision and hydrates it once; the 50/500/1,000-revision
cases have a withdrawn current revision and hydrate only that revision plus
the latest prior active revision. History SELECT count remains two at every
history length; full provenance work in detail remains bounded to one or two
revisions.

Actual `EXPLAIN (ANALYZE, BUFFERS)` timings for aggregate/page were 16.4/24.5 ms
at 1,000 Claims, 150.8/216.2 ms at 10,000, and 956.5/1,259.3 ms at 50,000.
The first two sizes had no temp spill. At 50,000, the aggregate plan reported
node totals of 64,388 temp-read and 8,025 temp-written blocks; the page plan
reported 97,674 temp-read and 10,352 temp-written blocks. All plans reported
zero shared-read blocks in this warm-cache run. History-summary plan execution
was 1.0, 4.0, 27.7, and 40.1 ms for 1/50/500/1,000 revisions, with no temp
spill. Existing revision-sequence and Project/revision-support indexes appear
in the plans. The full scans and 50,000-Claim spill are recorded; neither
identifies an essential missing index, so the explicit migration gate remains
closed and `0033` was not created.

## Scope exclusions

Slice 38 adds no migration, Claim write semantic change, support eligibility
change, citation semantic change, support-picker redesign, or later-slice work.
