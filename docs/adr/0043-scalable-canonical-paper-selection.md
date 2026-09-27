# ADR 0043: Scalable Canonical Paper Selection

## Status

Implemented for Slice 43 review; changes remain uncommitted on the verified
`v0.42.0-slice42` baseline.

## Decision

Starting from `v0.42.0-slice42` at
`c3e4873051592af8a8134148d9991a6440524d0f`, canonical Paper selection uses the
Project-scoped read model in
`src/application/paper-selection-read-services.ts`, exposed as
`paperSelectionReadServices` from `src/app/server.ts`. A Paper option contains
only `id`, `title`, `authors`, `publicationYear`, and `doi`.

Search defaults to 20 results and clamps at 50. A trimmed query may contain at
most 200 Unicode code points and matches a literal, case-insensitive title
substring. `%`, `_`, and other characters are not interpreted as patterns.
Rows order by `created_at DESC, id DESC`. One optional `excludePaperId`
expresses the current product rule that selection excludes at most one Paper.

For an existing Project, count and page use exactly two SELECTs in one
read-only `REPEATABLE READ` transaction. The count is Project-anchored; a
missing Project is reported distinctly, while an existing Project with no
eligible Papers returns an empty page. Exact lookup uses one Project-scoped
SELECT and returns no option for an unavailable or foreign-Project ID.

Batch lookup has no arbitrary supplied-ID or distinct-ID cap. One JSONB input
parameter feeds a requested-ID relation with ordinality. SQL deduplicates by
first occurrence, left-joins Papers with the Project predicate, returns
explicit null options for missing or foreign-Project IDs, and preserves the
requested order in one SELECT. Empty input returns an empty result without a
database query.

`PaperPicker` starts with no search results. A query is loaded only after the
user clicks Browse/Search Papers or submits a nonempty query with Enter; focus
alone never loads data. Required selection is caller-controlled and optional
by default. A required picker blocks an empty form submission, while
`disableSubmitUntilSelection` is available for relink actions that must remain
disabled until a valid different Paper has been selected. The selected exact
Paper remains independent of the current result page.

## Callers and compatibility

- Deduplication uses exact option lookup for any current mapping and the
  generic picker for same-work resolution and different-work correction.
- PDF intake uses the generic picker to match an existing Paper.
- Protocol run linking and relinking use the generic picker. Current and
  historical linked Paper IDs are batch-resolved in one set-based read for
  display names. Retrieved-record projections, history, and duplicate
  candidate behavior remain unchanged.
- Bibliographic import uses the generic picker for resolved correction and
  the explicitly cleared retarget state. An ordinary unresolved imported
  record still receives only its computed candidate list; it has no
  Project-wide search path. Existing actions, submitted field names, and
  writer-side validation remain authoritative.
- Evidence search and exact lookup delegate to the generic implementation
  through the existing Evidence interfaces. `capturePaperId` and the Evidence
  filter's `paperId` remain independent.

The four interactive `listPapers()` consumers have been removed from app
routes. Full-project BibTeX export and specialized application, benchmark,
and test callers retain their existing complete semantics. No write behavior,
Paper identity, or append-only history behavior changes.

## Query-plan and migration decision

`npm run benchmark:paper-selection-read-paths` seeds PostgreSQL 16 with 1,000,
10,000, and 50,000 Papers and compares the legacy full collection with lazy
search, exact lookup, and a 100-ID batch. It captures serialized payload,
returned rows, core SELECT count, elapsed time, and `EXPLAIN (ANALYZE,
BUFFERS)` at 50,000 Papers. Timings are local diagnostics, not CI thresholds.

| Papers | Read | Core SELECTs | Rows returned | Serialized bytes | Wall time |
|---:|---|---:|---:|---:|---:|
| 1,000 | Legacy `listPapers()` | 2 | 1,000 | 842,680 | 24.67 ms |
| 1,000 | Empty search page | 2 | 21 | 3,503 | 9.37 ms |
| 1,000 | Title search | 2 | 2 | 288 | 8.97 ms |
| 1,000 | Exact lookup | 1 | 1 | 171 | 3.09 ms |
| 1,000 | 100-ID batch | 1 | 100 | 22,904 | 5.40 ms |
| 10,000 | Legacy `listPapers()` | 2 | 10,000 | 8,466,683 | 132.10 ms |
| 10,000 | Empty search page | 2 | 21 | 3,585 | 11.77 ms |
| 10,000 | Title search | 2 | 2 | 292 | 13.28 ms |
| 10,000 | Exact lookup | 1 | 1 | 175 | 2.73 ms |
| 10,000 | 100-ID batch | 1 | 100 | 23,304 | 3.65 ms |
| 50,000 | Legacy `listPapers()` | 2 | 50,000 | 42,466,683 | 588.24 ms |
| 50,000 | Empty search page | 2 | 21 | 3,643 | 20.19 ms |
| 50,000 | Title search | 2 | 2 | 292 | 39.93 ms |
| 50,000 | Exact lookup | 1 | 1 | 175 | 2.84 ms |
| 50,000 | 100-ID batch | 1 | 100 | 23,601 | 3.21 ms |

At 50,000 Papers, a page rendering 50 legacy full-corpus selectors can produce
up to 2,500,000 Paper `<option>` elements from one 50,000-Paper collection
read. The new repeated picker serializes zero search-result options initially;
if all 50 pickers are explicitly activated, their default first pages contain
at most 1,000 result options combined.

At 50,000 Papers, the exact-count SELECT scanned the Project's Papers and took
10.93 ms. The page query used `papers_project_created_at_idx` plus incremental
sort and returned 20 in 0.15 ms. Exact lookup used `papers_pkey` and took
0.05 ms. Batch lookup used one SQL statement, the JSON function scan and
`papers_pkey` index, and took 0.72 ms for 100 IDs. Plans were warm-cache with
no shared reads or temp spill. These plans show no essential missing index; no
migration was added.

## Semantic and route proof

Integration coverage checks the five-field projection, default and maximum
page sizes, query normalization and Unicode length, literal wildcard handling,
stable order, exact count/page snapshot behavior, single-ID exclusion,
Project boundaries, empty and missing Projects, exact lookup, batch
first-occurrence ordering and explicit nulls, an uncapped 1,001-distinct-ID
batch, and a coordinated two-connection repeatable-read snapshot.

The route contract test prevents the four migrated app routes from returning
to `listPapers()`, protects the unresolved bibliographic-import candidate-only
rule, and checks that the legacy shared-mapping correction picker remains
Project-wide, excludes the shared Paper, and requires a target. That recovery
panel handles historically inconsistent mappings; current PostgreSQL
constraints reject creating a new `different_work` pair with one shared Paper.
Browser coverage exercises Evidence, dedup same-work resolution, protocol
link/relink, PDF intake, cleared-import retargeting and complete BibTeX export,
plus explicit lazy activation and keyboard selection across 50 pickers. The
writer actions remain unchanged.

## Verification

| Gate | Result |
|---|---|
| Benchmark | Pass on Node 22.13.0 with PostgreSQL 16 at 1k/10k/50k; reports rendered `<option>` element aggregates, batch of 100, and all 50k EXPLAIN plans |
| `npm run typecheck` | Pass on Node 22.13.0 |
| `npm run lint` | Pass on Node 22.13.0 |
| `npm run db:check` | Pass on Node 22.13.0 |
| `npm run test:integration` | Pass on Node 22.13.0: 63 files, 395 tests |
| Full Vitest | Pass on Node 22.13.0: 97 files, 655 tests |
| Paper-selection route contract | Pass on Node 22.13.0: 4 tests; included in the full Vitest run |
| Full serial Playwright | Pass on Node 22.13.0: 50 tests with `--workers=1 --retries=0` |
| `npm run build` | Pass on Node 22.13.0 |
| `git diff --check` | Pass |
| `npm audit` | 9 inherited advisories (7 moderate, 2 high); no dependency changes or remediation in Slice 43 |

Hosted CI and release actions are outside this local Slice 43 checkpoint.
