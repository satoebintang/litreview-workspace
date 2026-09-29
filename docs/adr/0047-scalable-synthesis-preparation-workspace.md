# ADR 0047: Scalable SynthesisPreparation Workspace and Selection

**Status:** implemented for Slice 47\
**Date:** 2026-09-29\
**Baseline:** `v0.46.0-slice46` at `d34adc85e4d982ecdc74fa5fabcdd0b9668e7cb9`

## Context

The released preparation ledger loaded every Project preparation and counted
candidate revisions for each row. Its detail path materialized the complete
pinned Evidence Set membership in application memory, then loaded all selected
revisions, all candidate revisions, and connecting Evidence for every
candidate. It also read all direct Evidence and AI requests, then loaded each
AI request's full detail. The selection form submitted the full selected-ID
set and the writer diffed it against all stored selections. These read and
write costs grew with the whole Project, pinned composition, or candidate set
even when the researcher was viewing or changing one item.

The exact Project, Evidence Set, composition-revision UUID, per-Set
`set_ordinal`, and Extraction Field remain the preparation's immutable pin.
Selections are mutable working state; finalized SynthesisRevision supports are
exact immutable provenance. `sourceSetChanged` remains a current-state
annotation derived from per-Set `set_ordinal`, not global `sequence`.

## Decision

Use bounded database-backed reads for the interactive workspace while retaining
released full-workspace APIs for compatibility. The normal route flow is:

```text
Preparation ledger → exact preparation → candidate page → exact candidate
                                             ├→ connecting Evidence pages
                                             ├→ direct Evidence pages
                                             └→ one-item select/deselect
                  → lazy target Browse/Search
                  → bounded AI request history → exact AI request audit
```

The database walks and validates the exact pinned temporal composition chain.
The normal candidate and select paths never return all `M` pinned members to
Node or round-trip them through JSON. PostgreSQL still traverses pinned members
and candidate/review facts as needed; these operations are output-bounded, not
claimed to be sublinear in the composition or candidate population.

## Candidate membership, annotations, and selection

A candidate is a distinct finalized ExtractionRevision for the pinned Field
that has at least one ExtractionRevisionEvidence link to Evidence in the exact
pinned composition. Reachable candidates remain visible when their Paper is
currently excluded, their revision is superseded, or the value is cleared.
Those facts affect current selectability or warnings, not candidate membership.
Connecting Evidence is the subset linked to both the candidate and the exact
pinned composition. Direct Evidence is every Evidence item linked to the exact
revision, including Evidence outside that Set.
Candidate rows include both distinct counts: connecting Evidence in the pin
and all direct revision Evidence. The counts do not substitute for the
separately paged Evidence details.

Add eligibility preserves the released rules: same Project and Field,
finalized, not cleared, Paper currently finally included under both screening
decisions, and reachable from the exact pin. Existing selected revisions that
drift out of eligibility remain selected and removable. Unchanged selections
are not revalidated. Supersession and Evidence-curation warnings do not alone
make a candidate unselectable. Selection state, eligibility, screening state,
value state, and warnings are live annotations; the frozen preparation pin and
finalized supports do not float.

Candidate ordering preserves the six-part released order:
`min pinned membership position`, normalized Paper title, Paper ID,
ExtractionValue ID, revision sequence, revision ID. Cursors are versioned and
bound to Project, preparation, pinned composition, Field, page size, filter,
candidate snapshot time, and candidate count. The cursor carries the full sort
boundary. A first page establishes a `statement_timestamp()` candidate epoch
and computes the exact candidate count for that identity universe. Continuation
pages reuse that epoch count instead of recomputing it. Revisions finalized
after the epoch do not enter that traversal or invalidate its cursor; refreshing
from page one establishes a new epoch and recomputes the count. An invalid sort
boundary invalidates the cursor. Selection, eligibility, and warning
annotations can change between pages because they are intentionally live.
These epochs are not cross-request MVCC snapshots: a transaction that commits
after page one with a transaction timestamp at or before the epoch can become
visible on a later page.

The recursive SQL walk follows order-version links active at the pinned
`set_ordinal` using half-open validity intervals. It checks the stored member
count, active and walked membership uniqueness, head, terminal tail, null tail
link, and valid Evidence references. Corrupt chains fail closed. Candidate
membership and exact count are derived in PostgreSQL. Three indexed latest
screening/retrieval probes are performed for candidate Papers; the query
materializes the reachable candidate universe once and restricts Evidence
aggregates and connecting/direct counts to the visible candidate page.

## Bounded reads

| Read | Default / maximum and order | Result boundary |
| --- | --- | --- |
| Preparation ledger | 50 / 100; `created_at DESC, id DESC` | One page plus `hasMore`; selected counts are aggregated only for visible rows |
| Candidate ledger | 50 / 100; six-part released order above | One page plus `hasMore`; exact candidate count is computed in PostgreSQL; Evidence counts are aggregated only for visible rows |
| Connecting Evidence | 25 / 50; pinned membership position, membership ID, Evidence ID | Page for one exact candidate in the pinned composition |
| Direct Evidence | 25 / 50; page number, creation time, Evidence ID | Page for one exact candidate, including Evidence outside the pin |
| Target statements | 20 / 50; `created_at DESC, id DESC` | Explicit Browse/Search; query capped at 200 Unicode code points |
| AI request history | 25 / 50; `created_at DESC, id DESC` | Compact history rows; exact frozen manifest loads only on its nested route |

The preparation ledger computes `sourceSetChanged` only for visible rows by
comparing the pinned and latest per-Set `set_ordinal`. This is a live
annotation; it does not alter the exact pinned composition.

Exact candidate detail returns its preparation header and candidate in one
SELECT. Each requested connecting or direct Evidence page uses one additional
SELECT, for three SELECTs when the route loads both lists.

Text previews are capped in SQL: ledger title/note at 120/200 characters,
candidate title/value at 160/240, Evidence source/note at 2,000/400, Evidence
filename at 160, and target title/statement preview at 160/240. Exact Evidence
view links retain the existing route for full source text. Target selection
preserves the existing same-Project target set, including statements without a
finalized revision and statements in withdrawn or other states. Exact current
target resolution is available independently of browsing.

## One-item writes, concurrency, and finalization

Interactive selection uses exact select-one and deselect-one actions. Both
serialize on the active preparation row. Add checks for an existing selection
before eligibility so an unchanged drifted selection is a no-op; new additions
validate canonical eligibility and pinned reachability. Duplicate additions
and absent removals are idempotent. Removal does not require current
eligibility. The released full-set replacement service remains available to
compatibility callers but is absent from the interactive route.

The preparation lock serializes disjoint and duplicate selection changes,
metadata updates, abandonment, finalization, and AI begin. A finalization or
abandonment that wins the lock makes later mutations fail the active-state
check; earlier committed mutations are visible to finalization. AI begin freezes
the exact selection and its manifest under the same preparation lock. Existing
lock order for finalization remains preparation, supporting Papers in UUID
order, then target SynthesisStatement. No optimistic whole-set version token
was added.

Finalization still reads and revalidates exactly `S` selected supports, locks
their Papers in UUID order, writes exact support edges, and relies on existing
deferred database equality constraints. It does not resolve all `M` pinned
members or scan all `C` candidate rows. Application support-set equality uses a
linear Set comparison instead of quadratic repeated `includes()` checks. Zero
support finalization remains valid.

## AI history and target picker

AI history is a bounded page with exact nested request detail. The history page
does not issue one detail query per request. Exact detail validates Project,
preparation, and request ownership together. AI generation uses only selected
supports and their connecting Evidence from the exact pin without transferring
the full composition to Node. Request manifest and source-state-hash semantics,
provider limits, grounding, acceptance checks, and frozen behavior after later
selection changes remain unchanged.

AI begin checks the selected-support count with an ordered compact-ID query
limited to `maxSupports + 1` before hydrating extraction text, researcher notes,
Paper fields, Evidence source text, or pinned context. Zero or more than 20
selections are rejected on that preflight; one through 20 proceed to bounded
support and source construction. Source order is pinned membership position,
page number, Evidence ID, then selection support ordinal as a deterministic
tie-break when the same Evidence supports multiple selected revisions. The same
tie-break is used to assign request-wide source order and to reconstruct stored
detail; each support's source ordinal and manifest/hash inputs retain their
existing shape.

History order is `created_at DESC, id DESC`; the key-page query spells this as
`DESC NULLS LAST` to match PostgreSQL's physical index order. The request keys
and `pageSize + 1` limit are selected before joining one-page request/result/
decision details. Migration `0036` adds the matching index
`(project_id, preparation_id, created_at DESC, id DESC)`. Paired PostgreSQL 16
`EXPLAIN ANALYZE` evidence below shows the exact query moving from a parallel
request-table scan of 50,001 rows to a 26-row index-only scan.

## Measured behavior and migration evidence

The retained benchmark JSON records `nodeVersion: "v22.13.0"`,
`postgresServerVersion: "16.15"`, and `postgresServerVersionNum: 160015`,
queried from the benchmark database with `SHOW server_version` and
`SHOW server_version_num`. The full 50k fixture run was generated at
`2026-09-29T15:43:08.826Z`; the separate final-query 20-support AI-context and
EXPLAIN capture was generated at `2026-09-29T15:56:34.053Z` and records the
same runtime metadata. The generated fixtures contained 1k, 10k, and 50k
candidates, ledger preparations, and target statements. Full legacy-workspace
comparison ran at the practical 1k and 10k sizes, where first-page identity,
ordering, and live annotation parity passed. Evidence, selected-support
context, runtime provenance, and EXPLAIN plans are retained in
`docs/benchmarks/slice47-synthesis-preparation-read-paths.json`.

| Population / operation | Result |
| --- | --- |
| Candidate first page, 50 rows | 1k: 58.19 ms / 32,578 bytes; 10k: 425.45 ms / 32,692 bytes; 50k: 2,745.07 ms / 32,580 bytes |
| Candidate continuation, 50 rows | 1k: 47.91 ms / 32,620 bytes; 10k: 357.29 ms / 32,723 bytes; 50k: 2,876.90 ms / 32,622 bytes |
| Candidate page 10 at 50k | 2,072.18 ms / 32,818 bytes |
| Legacy full-workspace comparison | 1k: 323.72 ms / 1,954,674 bytes; 10k: 19,926.74 ms / 19,204,809 bytes. Bounded first-page identity, order, and live annotation parity passed at both sizes. The 50k old path was skipped because it materializes all candidate, Evidence, and composition objects in Node. |
| 50k selected filter | 50 rows from 50,000 candidates and 500 stored selections; 32,932 bytes |
| 50k preparation ledger | 50 rows; 17.33 ms / 54,675 bytes; two SELECTs for the Project probe and bounded page |
| 50k target Browse | 20 options; 10.19 ms / 6,044 bytes; target Search returned zero matches in 164.83 ms / 60 bytes |
| AI history, 25 rows | 1k: 9.25 ms; 10k: 14.92 ms; 50k: 35.01 ms / 12,414 bytes; one SELECT per page |
| One-item selection / deselection at 50k | Select: 39.27 ms, 3 SELECT + 1 INSERT + 1 UPDATE. Deselect: 16.80 ms, 1 SELECT + 1 DELETE + 1 UPDATE. |
| Dense candidate Evidence pages at 50k | 51 pinned and 54 direct Evidence per candidate. Connecting first/deep EXPLAIN plans returned 25/1 rows in 1,110.62/1,072.13 ms. Direct first/deep plans returned 25/4 rows in 965.40/1,109.07 ms. Each page uses one SELECT. |

Selection write counts are Drizzle service-level statements; PostgreSQL
trigger-internal statements are not included.

The post-integrity-guard AI-context-only run used exactly 20 selected supports
from a 50k-member pinned composition. AI begin took 553.273 ms (7 SELECT and
41 INSERT service statements) and returned 20 supports and 20 sources with
complete coverage. Support/source counts, every source-text hash, source
manifest hash, and source-state hash all matched persisted values. The
selected-support preflight plan returned 20 compact identity/order rows in
0.093 ms. The final pinned-source context plan executed in 312.157 ms while
walking 50,054 temporal members in PostgreSQL. Its root plan reports 503
temporary reads and 504 writes from an external sort; this is database-side
spill, and no pinned member was transferred to Node as an intermediate
collection.

The candidate universe is derived once in PostgreSQL; the candidate plans use
indexed temporal successor, membership, revision/Evidence, Paper, latest
screening/retrieval, selection, and Evidence-review lookups. At 50k, first-page,
continuation, page-10, and selected-filter `EXPLAIN ANALYZE` executions took
2,304.915, 2,384.483, 2,656.418, and 3,247.123 ms. Their root nodes reported
3,981/6,319, 2,938/6,319, 3,034/6,319, and 3,981/5,009 temporary read/write
blocks. Summed across plan nodes, temporary reads/writes were 66,062/145,408
for the first page, 61,622/145,407 for continuation, 61,910/145,407 for page
10, and 66,062/127,068 for selected filter. The
plans confirm bounded output and also show substantial PostgreSQL temporary
I/O at 50k; API wall times above are fixture measurements, not latency
guarantees.

The exact one-revision reachability query took 0.394 ms, touched 32 shared
buffer blocks, and used indexed Evidence/revision, stable membership, and
temporal-active-membership lookups with no temporary I/O. It does not recurse
through the composition head or return `M` pinned members. The ledger page
plan, captured after the Project-existence probe, returned 50 rows in 1.576 ms
after 2.270 ms planning with no temporary I/O, using the existing ordered
preparation index. Target Browse executed in 0.391 ms under `EXPLAIN`; target
Search executed in 226.769 ms for the zero-match fixture. Dense Evidence page
plans' summed temporary I/O was 38,815 reads / 60,999 writes for each
connecting page and 36,010 reads / 65,141 writes for each direct page. Those
plans include database work beyond each returned page size.

The pre-index AI history plan took 19.761 ms and scanned 50,001 request rows
through a parallel sequential scan and gather/sort. With the exact proposed
index simulated in the disposable benchmark database, the request-key CTE
used an `Index Only Scan` on
`ai_synthesis_requests_project_preparation_created_id_idx`, returning the 26
history keys required for 25 visible rows plus `hasMore`, in 1.393 ms. The
post-index service read returned 25 compact rows in 8.537 ms / 12,414 bytes
with one SELECT. The single additive migration
`0036_ai_synthesis_preparation_history.sql` is supported by this paired plan
evidence:

```sql
CREATE INDEX "ai_synthesis_requests_project_preparation_created_id_idx"
ON "ai_synthesis_requests"
USING btree ("project_id", "preparation_id", "created_at" DESC NULLS LAST, "id" DESC NULLS LAST);
```

Fresh migration and forward upgrade from exact Slice 46 tail `0035` both
passed. `db:check` passed, the full migration chain ends at id 37 with the
0036 hash, and no earlier migration or lockfile changed. The migration tests
confirm the index is absent at the Slice 46 tail and present after 0036.

## Compatibility and deferred work

Released full-workspace and full-set replacement APIs remain available for
compatibility and intentional output-sized consumers. The regular interactive
preparation routes use only the bounded read and one-item write APIs.

Research Question matrix and detail/coverage scaling, Review Report
contributor scaling, unrelated Project configuration-list scaling, dependency
upgrades, advisory remediation, and Slice 48 work are outside this decision.
