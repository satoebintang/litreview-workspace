# ADR 0045: Scalable Evidence Set Composition and Workspace

## Status

Implemented and locally verified in the Slice 45 worktree from the released
Slice 44 baseline `14e31cc948ebe6894864a310120e0b6d55089ac6`. Migration
`0034_evidence_set_composition_timeline` replaces runtime full snapshots with
versioned temporal singly linked composition. The full unit/integration gates,
focused and serial Playwright runs, final-source benchmark, and independent
review passed. The work remains uncommitted at the publication checkpoint.
Benchmark details and retained plans are in
[`slice45-evidence-set-composition.json`](../benchmarks/slice45-evidence-set-composition.json).

## Decision

Evidence Set identity and membership identities remain stable. Each Set has one
immutable empty `created` revision. Every later composition revision identifies
its exact predecessor and carries an immutable per-Set `set_ordinal`, root, tail,
member count, distinct-Paper count, operation, and changed target metadata. The
released globally generated `sequence` remains unchanged for existing and future
rows. Temporal validity, latest-revision selection, and history pagination use
`set_ordinal`; SynthesisPreparation and other pinned consumers continue to use
the exact revision UUID.

### Global sequence compatibility

The released revision `sequence` is an identity-generated global number, and
its values are externally visible in revision summaries. The caller and schema
audit found no production, database, or test behavior that compares `sequence`
across Sets; relevant comparisons are Set-local. The design nevertheless
preserves the global allocator and all displayed values to avoid introducing a
future numbering change. `set_ordinal` is backfilled deterministically from
existing per-Set `sequence ASC` and is allocated as the immediate successor
while holding the Set lock. No existing revision UUID or pinned reference is
rewritten.

### Temporal storage and migration

`evidence_set_memberships` retains one stable row for each Evidence/Set pair,
including after removal. `evidence_set_membership_order_versions` records each
membership's successor and half-open ordinal interval. A change closes the old
version at the new revision ordinal and opens its replacement at that same
ordinal. Removed memberships close their interval; re-addition reuses the stable
membership ID and starts a new interval. The per-Paper active counter table
supports distinct-Paper summaries and candidate exclusion without enumerating
the current composition.

Migration `0034` retains the old snapshot table while assigning ordinals,
reconstructing summaries and order intervals, and checking each historical
revision against its exact old ordered membership list. The old snapshot source
and guards are removed only after those equivalence assertions complete. The
forward fixture covers all revisions including arbitrary reorder, archive state,
and pre-existing exact SynthesisPreparation pins; migration failure rolls back
without moving the migration journal. Fresh and populated `0033` migration proof
is recorded by the Slice 45 migration tests.

### Database guarantees and writer cost

Revisions form a linear per-Set predecessor chain. The insert guard assigns the
next ordinal from the locked latest revision and validates the exact predecessor,
root/tail/count transition, target, neighboring links, and relevant Paper
counter. Temporal rows permit only guarded same-Set close-and-replace operations:
closed interval boundaries are immutable, reopening and backdating are rejected,
and a closure must be authorized by its same-transaction immediate successor.
For ordinary `added`, `readded`, `removed`, and `moved` transitions, validation
checks only the event's indexed target neighborhood and summary metadata. It does
not enumerate active memberships or replay history. The explicit legacy
`reordered` compatibility operation remains O(N) and is not used by the
interactive workspace. No PostgreSQL extension was added.

Ordinary operations change a fixed number of tuples independent of active Set
size. Expected structural maxima are 6 for first-ever add to a non-empty Set, 5
for re-add, 5 for remove, and 7 for a one-step move. The benchmark records
actual membership/revision/order-version/counter tuple deltas for each operation
at 1k, 10k, and 50k members, plus SQL statement and returned-row counts.

### Bounded workspace reads

Current composition and exact historical composition use cursor pages of 50 by
default and 100 maximum. The cursor is bound to the Set and exact revision; a
stale current cursor does not continue against a newer composition. Candidate
search is explicit, Project-scoped, excludes active members in SQL, returns 20
by default and 50 maximum, and accepts at most 200 Unicode code points. History
returns summary pages of 25 by default and 50 maximum with a stable high-water
ordinal. Exact pinned enumeration resolves only the requested immutable revision
UUID and never rewrites composition. Its recursive walk is bounded by the
selected revision's `member_count`; it does not build a growing path array. The
50k read completed with 50,000 rows. This full-result read is intentionally
output-sized; interactive current and historical routes remain page-bounded.

The interactive SQL bounds all unbounded text projections in the workspace
service: Evidence Set names to 100 Unicode code points and descriptions to 500;
member source previews to 300; candidate excerpts to 80; Paper titles to 200;
DOIs to 120; label names to 80 with at most five labels; annotation previews to
500 and annotation details to 10,000; ExtractionField names to 120 and
descriptions to 300; related Paper titles to 200; and document filenames to
160. Candidate queries are capped at 200 Unicode code points. Page sizes are
bounded per read contract, and the benchmark records returned rows, UTF-8
request/response bytes, and observed projection maxima. Full source text and
annotation content remain available from the appropriate detail routes.

### SynthesisPreparation compatibility

The exact pinned composition revision UUID remains authoritative. Later Set
changes do not alter candidate population for an existing preparation; later
additions are excluded and later removals remain reachable from the older pinned
revision. Finalization still enforces exact support equality, and historical
SynthesisRevision context and AI source guards resolve through the same
revision-UUID resolver. Pinned enumeration is an output-sized read and never
causes a composition rewrite; final-source verification completed the 50k
exact-revision read.

## Benchmark method and results

The retained benchmark script creates a uniquely named disposable PostgreSQL 16
database, migrates it through `0034`, bulk-establishes fixture compositions with
USER triggers disabled only inside fixture transactions, then re-enables every
guard before measuring ordinary service writers and reads. It exercises member
sizes 1k/10k/50k, history depths 10/100/1k, add/remove/re-add/move, current and
candidate first/deep pages, history first/deep pages, exact historical pages,
and exact pinned enumeration. Writer tuple changes are computed from relevant
table deltas; SQL rows returned are counted at the Drizzle execute boundary.
The old Slice 44 snapshot comparison is limited to practical sizes and reports
the released representation's full N-member read and N+1-row append structure;
it does not attempt a quadratic 50k legacy guarded mutation. Wall times are
diagnostic only and have no release threshold.

The retained run used Node `22.13.0` and PostgreSQL `16.15`; the script dropped
its disposable database before writing the evidence. At each member size (1k,
10k, and 50k), measured tuple changes were 6 for first-ever add to a non-empty
Set, 5 for remove, 5 for re-add, and 7 for one-step move. The top-level SELECT
counts were 5/6/5/5 and statement counts were 10/10/9/12 in the same operation
order. These meet the plan's add/remove limit of six SELECTs and move limit of
five. Database rows returned were 7/9/7/9. Request bodies were 113 bytes except
move at 132 bytes; writer responses ranged from 514 to 766 bytes. Tuple,
statement, and SELECT counts stayed constant across N. Captured trigger
definitions show fixed target/neighborhood lookups in ordinary
added/readded/removed/moved branches; only `reordered` scans the active Set.

Current and exact historical first/deep pages each returned 50 rows from one
statement, with response sizes around 39.4 KB and source previews capped at 300
code points. Candidate pages returned 20 candidates plus one `hasMore` row from
one statement, about 6.45 KB, with 80-code-point excerpts. The benchmark
asserts exact deep-page Evidence IDs after an anchor within an equal-timestamp
group: all 1k/10k/50k seeded candidates shared the timestamp, and each expected
20-ID page matched the returned IDs under `(created_at,id)` order. At 50k the
candidate EXPLAIN used Evidence and Paper sequential scans and temporary sort
blocks; the first-page plan took 233 ms with 1,368 temp blocks read and 10,259
written, and the deep-page plan took 81 ms with 1,344 read and 4,945 written.
These are diagnostic measurements, not timing thresholds. At history depth 1k,
first and deep pages returned 26 rows for a 25-row page plus continuation,
using one statement each. Exact historical page EXPLAINs at 50k returned 50
rows in about 2.2 and 2.9 ms.

Exact pinned enumeration returned 1k rows/171,894 bytes, 10k rows/1,728,895
bytes, and 50k rows/8,688,895 bytes in one statement each; measured service
times were about 25/144/910 ms. The 50k `EXPLAIN (ANALYZE, BUFFERS, FORMAT
JSON)` returned 50,000 rows in about 601 ms, with 587,012 shared hits, 12,993
shared reads, and 992 temporary blocks read/994 written. The final SQL walks at
most the selected revision's `member_count` links and carries no growing path
array. Timing is diagnostic only; full pinned enumeration remains output-sized
and is not used by interactive pages.

The Slice 44 SQL-shape comparator returned 1,001 rows/270,159 bytes and wrote
1,002 rows for one append at 1k. At 10k it returned 10,001 rows/2,699,160 bytes
and wrote 10,002 rows; that append used 50,005 parameters and 689,086 SQL bytes.
The 50k write comparator was skipped because its 250,005 parameters exceed
PostgreSQL's 65,535 parameter limit. This comparison excludes legacy guards and
is a structural comparison, not a second migration benchmark.

`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans cover current first/deep pages,
candidate first/deep pages, exact historical first/deep pages, history first
and deep at depth 1k, and exact pinned enumeration at both 10k and 50k. All 12
plan entries completed. Exact SQL, plan rows, buffers, request/response sizes,
tuple deltas, and limitations are retained in the JSON artifact.

## Consequences

Ordinary Set edits no longer copy or send the active membership array. History is
reconstructed exactly from immutable temporal versions, and downstream pins
remain stable. The runtime model adds temporal rows proportional to actual link
changes across revisions. The full reorder compatibility API remains an
intentional O(N) boundary; interactive routes use only bounded page and
one-step mutation APIs. Historical backfill is allowed to scan all legacy
snapshots because it runs once in the forward migration.
