# ADR 0039: Evidence Workspace Scalable Reads

## Status

Accepted for Slice 39 implementation. Implementation is complete and remains
uncommitted for publication review.

## Decision

Starting from `v0.38.0-slice38` at
`80647ccc6a8a9169063f13ef956a2a2d19030c9c`, the Evidence workspace now reads a
filtered, bounded page through
`src/application/evidence-workspace-read-services.ts`. Canonical Evidence and
curation writes remain in their existing services. The old
`listEvidenceWorkspace()` contract stays available for compatibility and direct
old/new comparison; production Evidence pages no longer call it.

The core workspace projection runs in one read-only `REPEATABLE READ`
transaction. Its SELECTs are a Project-anchored filtered count, the bounded
Evidence page, one set-based current-Label read, and one set-based historical
usage read. The count returns an anchor for an existing Project with no matching
Evidence and no row for a missing Project. The page is clamped after that count;
ordering remains `Evidence.created_at ASC, Evidence.id ASC`.

Current Label state is the greatest-sequence event for each
Project × Evidence × Label pair, included only when that event is `assigned`.
The same relation serves `labelId` filtering and returned Labels, including
archived Label metadata. Historical `used_evidence` is the union of the five
released reachability paths, deduplicated only by Project × Evidence identity.
Usage filters join that canonical relation; row badges read it in one bounded
set-based query. Current review, Paper screening, Claim lifecycle, and
Extraction/Synthesis currentness do not erase historical usage.

Paper options use explicit, parameterized, case-insensitive title search, a
20-row default and 50-row maximum, and an explicit 200 Unicode code-point query
limit. Exact selected Papers resolve through a separate Project-scoped read.
The Evidence page has distinct `paperId` queue-filter and `capturePaperId`
manual-capture state. Pagination preserves all queue filters and the capture
selection; filter submission resets the page to one. The manual capture action
remains the canonical Evidence writer.

## Semantic equivalence proof

The deterministic integration fixture compares the released full projection
against the new result for each filter case, including IDs and order, Paper IDs,
review state and decision ID, warnings, ordered Label IDs, usage, provenance,
and total count.

| Released usage path | Fixture Evidence | Historical state changed afterward | Result |
|---|---|---|---|
| Evidence → ExtractionRevision | Document-backed Evidence | Evidence later rejected | Still used |
| Evidence → direct ClaimRevision support | Extracted Evidence | Claim withdrawn, Paper excluded, Evidence rejected | Still used |
| Evidence → ExtractionRevision → ClaimRevision | Extraction-backed Evidence | Extraction value superseded | Still used |
| Evidence → ExtractionRevision → SynthesisRevision | Synthesis-backed Evidence | Synthesis revision superseded | Still used |
| Evidence → ExtractionRevision → SynthesisRevision → ClaimRevision | Claim-through-synthesis Evidence | Claim retains its exact historical revision support | Still used |
| Multiple paths to one Evidence | Multi-path Evidence | Direct extraction and direct Claim support coexist | One row, boolean `used` |

The Label matrix covers never assigned, assigned, assigned→removed,
assigned→removed→assigned, archived while assigned, archived after removal,
and multiple current Labels. Its returned IDs match the released
`currentLabels()` projection. The review/provenance fixture covers unreviewed,
needs-review, accepted, and rejected latest decisions; manual, document, and
extracted Evidence; and repeated review decisions.

The count/page test covers 0, 1, 49, 50, and 51 matching Evidence, including
equal timestamps, the ID tie-breaker, page clamping, and the legacy empty-page
count defect. A separate two-connection test pauses after the count, commits a
review decision, Label assignment, and ExtractionRevision from the writer
connection, then confirms page and enrichment remain on the first snapshot. The
next request observes all three changes.

## Query-count proof

The integration instrumentation excludes postgres.js's one-time array-type
metadata lookup by warming the test connection before measurement. It measures
the Evidence projection itself; complete Label definitions, Paper search, and
exact selected-Paper resolution are separate page-composition reads.

| Returned Evidence rows | Workspace SELECTs |
|---:|---:|
| 1 | 4 |
| 25 | 4 |
| 50 | 4 |
| 100 | 4 |

The count remains four with 0 or 3 Labels per row, used or unused Evidence, and
multiple paths to the same Evidence. Empty matching pages also execute the same
four projection reads. Missing Projects return after the one Project-aware
count SELECT.

## Benchmark method and observations

`npx tsx scripts/benchmark-evidence-read-paths.ts` creates and migrates one
uniquely named PostgreSQL 16 database, seeds 1,000-, 10,000-, and 50,000-Paper/Evidence
Projects, captures SELECTs and serialized payload size, and force-drops that
database in `finally`. Each fixture mixes four current review states, three
Labels, manual/document/extracted provenance, and a 5% historical Extraction
usage path. The released workspace remains executable as the legacy comparison.
Timings are diagnostic and are not CI thresholds.

| Evidence/Paper rows | New workspace: SELECTs / wall / payload | Released workspace: SELECTs / wall / payload | New Paper search: SELECTs / rows / payload | All-Paper read: rows / payload |
|---:|---:|---:|---:|---:|
| 1,000 | 4 / 47.75 ms / 45,007 B | 102 / 301.35 ms / 44,830 B | 2 / 20 / 3,120 B | 1,000 / 350,001 B |
| 10,000 | 4 / 189.62 ms / 44,957 B | 102 / 529.58 ms / 44,779 B | 2 / 20 / 3,122 B | 10,000 / 3,500,001 B |
| 50,000 | 4 / 249.72 ms / 44,900 B | 102 / 734.57 ms / 44,721 B | 2 / 20 / 3,123 B | 50,000 / 17,500,001 B |

The legacy 50-row page uses 102 SELECTs: Project check + page query + 50
per-row Label queries + 50 per-row usage queries. A composition with the four
core reads, complete Label definitions, initial Paper search, and both exact
selected-Paper reads uses 10 SELECTs; those eight page-composition reads are
outside the four-SELECT core invariant. At 50,000 rows, the all-Paper read took
385.05 ms in this run; the bounded Paper search took 30.19 ms and returned the
same 20-row/3,123-byte shape measured at smaller sizes.

## EXPLAIN and migration decision

The script captures `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the unfiltered
count/page, set-based Label and usage projection, Label-filtered count/page,
used and unused count/page, Paper search count/page, and exact Paper lookup at
50,000 rows. This was a warm-cache local run with zero shared-read blocks.

| Query | Execution | Plan observations |
|---|---:|---|
| Filtered count, all | 62.20 ms | Project primary-key lookup, existing review sequence index, one Evidence scan; no temp spill. |
| Bounded Evidence page, all | 167.20 ms | Existing Evidence/review lookups plus Project Paper and document scans; no temp spill. |
| Current Label projection | 20.80 ms | Scans 26,308 project Label events and 3 Label definitions; incremental sort, no temp spill. |
| Historical usage projection | 2.80 ms | Scans 2,500 ExtractionRevision/Evidence links; existing support indexes serve the other four empty paths. |
| Label-filtered count/page | 203.44 / 171.12 ms | Uses existing Label pair and Label lookup indexes; the filtered count also scans the Project Evidence set. |
| Used count/page | 71.07 / 86.76 ms | Builds 2,500 distinct used Evidence identities, then filters/joins; the page reports 422 temp-read and 422 temp-written blocks. |
| Unused count/page | 73.57 / 157.85 ms | Same canonical relation; page reports 423 temp-read and 590 temp-written blocks. |
| Paper search count/page | 29.24 / 0.12 ms | Exact substring count scans the 50,000 Paper rows; bounded page uses `papers_project_created_at_idx`. |
| Exact Paper resolution | 0.12 ms | Uses an existing Paper identity index. |

Project-wide filtered counts and literal substring counts must visit their
Project rows. The bounded page and exact selected-Paper reads use existing
indexes. The small usage-page temp spills and full-corpus scans do not identify
an essential missing lookup index. No migration is indicated; the migration
tail remains `0032_hot_path_hardening.sql`, and `0033` was not created. The
warm-cache measurements are not a substitute for production workload sizing.

## Production caller and release audit

Direct source search found no production Evidence page/component call to
`listEvidenceWorkspace()`, no all-Papers selector in the Evidence workspace,
and no per-row `currentLabels()` or usage read there. Manual capture from both
the Evidence workspace and a FullTextDocument page submits `capturePaperId`;
the queue filter alone submits `paperId`. Other `listPapers()` calls remain in
their unrelated Paper, protocol, deduplication, and import routes. The
compatibility workspace method remains available for the semantic fixture.

Migration SQL, snapshots, and journal are unchanged from the published
baseline; no dependency or lockfile change was made. The source explicitly
keeps Evidence research semantics, provenance, storage state machine, and later
slices out of scope.

## Final implementation gate

| Gate | Result |
|---|---|
| `npm test` | Pass: 92 files, 609 tests |
| `npm run test:integration` | Pass: 59 files, 356 tests, run separately |
| `npx playwright test --workers=1 --retries=0` | Pass: 44 browser tests |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm run db:check` | Pass |
| `npm run build` | Pass |
| `git diff --check` | Pass |
| Dependency audit | Existing baseline: 9 advisories (7 moderate, 2 high, 0 critical); dependency files unchanged |

Verification ran on Node `v26.4.0`; `package.json` pins Node `22.13.0`
exactly. `npm ci` emitted an `EBADENGINE` warning, though the local checks above
completed successfully. The pinned Node runtime was not available for a second
verification run.

The work remains uncommitted on `master` at the published baseline
`80647ccc6a8a9169063f13ef956a2a2d19030c9c`. `origin/master` and
`v0.38.0-slice38` resolve to the same commit. No Slice 39 migration or `0033`
artifact exists. Protected remote CI was not run because this implementation
must stop before commit or PR creation for publication review.

## Scope exclusions

Slice 39 adds no migration, Evidence semantic change, downstream provenance
change, storage state machine, caching infrastructure, or Slice 40 work.
