# ADR 0054: Scalable Manuscript ClaimRevision Placement Selection

**Status:** implemented and accepted

**Date:** 2026-10-06

**Baseline:** `v0.53.0-slice53`,
`43e9c5cf23d03f662d0dbcc91d132587c3b63d54`

**Migration:** `0040_slice54_manuscript_claim_selection` adds only the
evidence-supported project-wide candidate index. The existing Slice 52
Claim-history index remains the replacement path.

## Context

The normal manuscript route used the compatibility selector to load the
complete project-wide placeable ClaimRevision collection and embedded it in
each Section's placement form. Inline replacement forms also depended on the
complete candidate collection. Both paths transferred and rendered more
candidate text and provenance than a placement decision needs.

The released compatibility API remains available for callers and
manageable-fixture equivalence checks. The normal manuscript route instead
needs zero selector-specific reads and no candidate collection. Researcher
placement decisions still need the same eligible revisions, exact ordering,
historical active choices, and existing writer guards.

## Decision

Replace the manuscript-wide selector with two bounded browse routes:

- `/projects/[projectId]/manuscript/claim-revisions?sectionId=<sectionId>`
  validates the Project, default Manuscript, and active destination Section,
  then returns one page of project-wide placement candidates.
- `/projects/[projectId]/manuscript/placements/[placementId]/replacements`
  resolves the Project, default Manuscript, active Placement, stable Claim,
  currently placed ClaimRevision, and placed sequence from the server, then
  returns one page of higher same-Claim candidates.

The main manuscript route links to the placement browser for each Section and
to the replacement browser for a placement only when
`placement.isSuperseded && placement.claimLifecycle === "active"`. The
canonical lifecycle projection field remains `placement.claimLifecycle`; no
additional lifecycle query or lifecycle source is introduced. Withdrawn-parent
badges and warnings use that same canonical field.

Project-wide placeability remains: a revision belongs to the Project, is
finalized and active, and its stable Claim's current finalized revision is
active. Historical active revisions remain placeable, including unsupported
revisions. Eligibility does not require candidate currentness. Stable-Claim
current selection remains `ORDER BY sequence DESC LIMIT 1` with no ID
tie-breaker. Currentness remains latest revision ID equality. Supersession is
computed independently in SQL as `latest.sequence > attached.sequence`, so
tied sequences are not reported as superseded merely because another ID was
chosen as current.

Both selectors default to 20 rows, cap at 50, return no total, seek at most
`pageSize + 1` ordered candidate keys, and hydrate text only for visible rows.
The sentinel receives no text hydration. Candidate previews are capped in SQL
to 600 code points before driver transfer. Rows carry only ClaimRevision ID,
Claim ID, lossless sequence text, preview/truncation flag, current annotation,
and finalized timestamp. No support/provenance arrays or support calculation
is performed. Maximum-50 JSON DTOs are constrained to 256 KiB UTF-8.

Ordering preserves the released `sequence DESC, id ASC` order. Continuation is
equivalent to `sequence < cursor.sequence OR (sequence = cursor.sequence AND
id > cursor.id)`, implemented as separate equal-sequence and lower-sequence
seeks with only the remaining key allowance passed to the lower seek. The
final merge and ordering operate only on bounded keys. Placement and
replacement cursors are strict canonical versioned base64url JSON, at most 512
characters, and bind every selector scope field and effective page size.
BIGINT boundaries remain canonical PostgreSQL decimal strings and are never
parsed through JavaScript `Number`.

Replacement scope and identity are server-derived. The selector returns only
same-Claim finalized active revisions whose sequence is greater than the
placed sequence and whose stable Claim is currently active. Existing
`replacePlacedClaimRevisionAction` receives the expected current placement
revision identity. The writer compares candidate and old sequences as
PostgreSQL BIGINT values, preserving the Placement lock, Section lock,
same-Claim and lifecycle checks, transaction behavior, and database guard.
Existing placement actions, frozen service-factory keys, signatures,
compatibility selectors, and legacy numeric sequence DTOs remain unchanged.
New selector DTOs own their lossless sequence-string contract.

## Ordering and traversal caveat

`(sequence DESC, id ASC)` is deterministic traversal order, not a claim that
sequence allocation equals commit order. Pages are live reads across separate
requests. A lower sequence reserved earlier may commit after a later sequence
was already traversed, placing it behind the cursor. Restart at the first page
to include a late commit. For tied greatest sequences, current selection has no
ID tie-breaker; traversal uses ID only to make the page boundary deterministic.

Project-wide selection probes each candidate's stable Claim current finalized
revision. If many high-order active candidates belong to withdrawn Claims, the
database may reject many candidates before filling a page. The guarantee is
bounded key transfer, visible-only hydration, and no complete project-wide
candidate materialization. It is not a universal O(pageSize) database-work
claim. The benchmark reports rejected rows, loops, index/heap work, buffers,
and sorts for active-heavy, withdrawn-heavy, and clustered withdrawn-tail
populations.

## Migration decision

Migration 0040 contains exactly one structural index:
`claim_revisions_project_active_sequence_order_idx` on
`(project_id, sequence DESC, id ASC) WHERE finalized_at IS NOT NULL AND
state='active'`. This is the project-wide mixed-order candidate index measured
against the final application page SQL. Replacement selection retains the
Slice 52 partial Claim-history index
`(project_id, claim_id, sequence, id) WHERE finalized_at IS NOT NULL`; no
active Claim-scoped index is added. There is no sequence uniqueness,
denormalized lifecycle, eligibility cache/table, search index, or migration
0041.

The disposable PostgreSQL 16 benchmark captured first/deep/final 50k page SQL
for both selectors and ran `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` before
and after each candidate index. Sort cardinality below is estimated Sort
output rows / actual immediate tuple-producing child rows. The project index
removes the large planned Incremental Sort estimates and reduces index/filter
work, although Incremental Sort already consumed about one page of actual rows
under the benchmark row goal:

| Project page | Before sort estimate/input | After sort estimate/input | Before/after execution ms | Index entries before/after | Filter removals before/after |
| --- | ---: | ---: | ---: | ---: | ---: |
| First | 43,198 / 52 | 51 / 51 | 10.849 / 9.660 | 7,654 / 5,152 | 5,052 / 2,551 |
| Deep | 9,006 / 52 | 870 / 51 | 2.736 / 1.243 | 155 / 152 | 1 / 0 |
| Final | 7,020 / 50 | 673 / 50 | 1.244 / 0.831 | 151 / 150 | 1 / 0 |

The replacement candidate index did not establish structural need. With the
Slice 52 path, first/deep/final actual sort inputs were 52/52/50 and estimated
index entries were 102/102/100; with the trial active mixed-direction index,
they were 51/51/50 and 101/101/100. Timings were mixed (0.941/1.371/0.968 ms
before, 1.075/0.825/0.992 ms after). The project index is therefore the only
index in 0040.

## Scope boundaries and residual debt

Snapshot creation logic, exact reads, and snapshot history/listing remain out of
scope. Snapshot capture consumes the shared working manuscript projection, so
future captures also observe the corrected SQL `isSuperseded` flag; existing
immutable snapshots and their stored contents are untouched. This change does
not alter manuscript composition semantics, bibliography semantics, prose
editing, editorial review, or exact placed Claim content.
Search is excluded. Snapshot history paging remains residual debt.

The bounded selector guarantee is limited to the two new candidate browsers
and removal of selector-specific reads from the main manuscript route. It does
not claim that the complete manuscript artifact is universally bounded: exact
placed Claim content, support/provenance, bibliography, and composition reads
remain governed by their existing contracts.

## Verification record

Under Node 22.13.0 and PostgreSQL 16, the disposable benchmark passed 21/21
project profiles, 3/3 replacement profiles, and 72/72 page runs. The page
queries used 144 SELECTs across 288 statements and returned 3,222 driver rows
in total (maximum 51 per page); the original profile-run DTO maximum was
132,019 UTF-8 bytes. A separate stress run used 40,000-codepoint manuscript
and Section titles and 50-row pages for both selectors; SQL returned at most
600 code points per scope title, and the maximum DTO was 136,975 UTF-8 bytes.
The combined maximum remained below 256 KiB. Every profile page matched its
direct-SQL oracle, no sentinel was hydrated, and cleanup verified that the
run-owned database was dropped. The
compatibility full selector ran for 16 manageable populations through 10k;
eight 50k runs were safety-skipped. Exact SQL expectations passed for BIGINT
values beyond `Number.MAX_SAFE_INTEGER` without using the numeric legacy
oracle. The complete query, EXPLAIN, payload, legacy, BIGINT, and cleanup
records are in
[`docs/benchmarks/slice54-manuscript-claim-selection-read-paths.json`](../benchmarks/slice54-manuscript-claim-selection-read-paths.json).

Withdrawal rejection remains selectivity-dependent. In the 50k benchmark,
the withdrawn-heavy first page examined an estimated 67,654 index entries and
removed 45,052 rows; the clustered-withdrawn-tail first page examined 10,154
and removed 10,000; zero-eligible pages examined 75,000 and removed 50,000.
These figures prohibit a strict O(pageSize) database-work claim for adverse
parent distributions. Accepted verification passed typecheck, zero-warning
lint, `db:check`, production build, 130 unit-test files / 834 tests, 81
integration-test files / 507 tests, focused Playwright 1/1, and full serial
Playwright 68/68. Independent Luna/max review and Sol/high acceptance completed
before publication.
