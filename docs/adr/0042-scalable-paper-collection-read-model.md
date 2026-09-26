# ADR 0042: Scalable Paper Collection Read Model

## Status

Accepted for Slice 42 implementation. The implementation is complete and
remains uncommitted on the verified Slice 41 baseline for review.

## Decision

Starting from `v0.41.0-slice41` at
`cd02cf85c778f822b160c09f0617b85aff5d9e0d`, the canonical
`/projects/{projectId}/papers` workspace reads a bounded Paper page through
`src/application/paper-collection-read-services.ts`. The read service is
exposed as `paperCollectionReadServices` from `src/app/server.ts`.

Each `PaperCollectionRow` contains only `id`, `projectId`, `title`, `authors`,
`publicationYear`, `venue`, `doi`, `createdAt`, `updatedAt`, and
`screeningState`. It omits abstracts, bibliographic notes, decision objects and
notes, and downstream review data. Exact Paper and Screen links continue to
use `paper.id`.

The read runs in one read-only `REPEATABLE READ` transaction. Its first SELECT
anchors `count(papers.id)` at the Project: an existing Project with no Papers
has a count row, while a missing Project has no count row and returns `null`
without a page SELECT. Successful reads for an existing Project use exactly
two core SELECTs: the count and one page query. Transaction setup is outside
that core SELECT budget.

The page query selects and limits Paper rows in a CTE before performing one
lateral latest-decision lookup per selected Paper in the same SQL statement.
The badge uses only the greatest title/abstract decision by
`sequence DESC, id DESC`: no decision is `unscreened`; `include`, `exclude`,
and `maybe` map to `included`, `excluded`, and `maybe`. Retrieval, full-text,
eligibility, and review-status facts do not affect this badge.

Rows order by `created_at DESC, id DESC` in both the limited Paper query and
the outer result. Page values that are invalid, non-positive, fractional, or
not safe integers normalize to page one; a valid page past the end clamps to
the last page. `pageSize` defaults to 50 for invalid, non-positive, or
non-safe-integer values and clamps values above 100 to 100. The interactive
workspace always requests 50. An empty Project returns page one, zero total
pages, `from = to = 0`, and no navigation.

The UI reads `?page=n`, omits `page=1` from links, announces the range and
current page, and uses accessible Previous/Next links with disabled boundary
controls. A successful manual Paper creation returns to page one. The
acceptance requirement is that the new Paper is visible according to the
defined `created_at DESC, id DESC` ordering; page one is not an invariant for a
new Paper tied with more than 50 Papers at the exact same timestamp.
Acquisition cards, manual duplicate review, intake boundaries, badge meaning,
`addPaper()`, and `writePaper()` remain unchanged.

## Compatibility and remaining caller debt

The collection page no longer calls `listPapers()` or
`listScreeningPapers()`. Both services and their repositories remain available
for specialized callers and old/new comparison. The remaining interactive
`listPapers()` callers are documented follow-up scalability debt:

- Deduplication resolution.
- Bibliographic-import correction.
- PDF-intake matching.
- Protocol-run linking and relinking.

Full-project BibTeX export remains intentionally unbounded and complete. This
slice does not change screening queues, Paper detail, duplicate candidate
matching, or Evidence Set reads.

## Semantic and pagination proof

The integration suite compares the compact projection with the released Paper
plus screening projections for identity, displayed metadata, and all four
badges. It covers latest-decision transitions `include → maybe`,
`maybe → exclude`, and `exclude → include`, as well as a Paper with retrieval,
full-text screening, a stored document, Evidence, and Extraction history. That
downstream history does not change the title/abstract badge.

Boundary coverage includes missing and empty Projects; Paper totals 0, 1, 49,
50, 51, 100, and 101; invalid and large pages; invalid, non-positive,
non-safe, and over-maximum page sizes; equal timestamps across page boundaries;
repeated reads; exact row keys; and bounded payload fields. A coordinated
two-connection test pauses after the aggregate, commits a Paper insert or a
newer screening decision from the writer connection, and resumes the read.
Both the count and page retain the original snapshot, while a later read sees
the committed change. Query instrumentation confirms two core SELECTs for
existing Projects at page sizes 1, 25, 50, and 100, with one SELECT for a
missing Project.

The Playwright fixture checks the 50-row page, range, current-page
announcement, keyboard pagination, disabled boundaries, badge, exact Paper and
Screen links, and export of a Paper beyond page one. It returns to page one
before manual Paper creation, submits the new Paper there, and confirms the
successful creation flow remains on page one. Existing manual duplicate-review
coverage remains in place.

## Benchmark method and observations

`npm run benchmark:paper-collection-read-paths` creates and migrates one
uniquely named PostgreSQL 16 database, seeds Projects with 1,000, 10,000, and
50,000 Papers, and force-drops the database in `finally`. One quarter of each
population is unscreened; each other Paper has an initial and a current
title/abstract decision across include, exclude, and maybe. The benchmark
compares released `listPapers()` plus `listScreeningPapers()` and their Node
Map with the count plus 50-row page. It reports Paper and decision counts,
SELECTs, rows returned, Paper objects materialized, serialized bytes, and wall
time. A PostgreSQL statement timeout bounds legacy reads; no timeout occurred
in this run. Timings are local diagnostics, not CI thresholds.

| Papers / decisions | Legacy: SELECTs / DB rows / Paper objects / payload / wall | Bounded: SELECTs / DB rows / Paper objects / payload / wall |
|---:|---|---|
| 1,000 / 1,500 | 4 / 2,002 / 2,000 / 1,989,167 B / 56.94 ms | 2 / 51 / 50 / 17,860 B / 13.86 ms |
| 10,000 / 15,000 | 4 / 20,002 / 20,000 / 19,980,157 B / 260.77 ms | 2 / 51 / 50 / 18,062 B / 21.73 ms |
| 50,000 / 75,000 | 4 / 100,002 / 100,000 / 100,172,196 B / 1,280.28 ms | 2 / 51 / 50 / 18,210 B / 24.79 ms |

At 50,000 Papers, the last 50-row page (offset 49,950) returned 50 rows in
74.96 ms. `EXPLAIN (ANALYZE, BUFFERS)` for the Project-aware count took 12.97
ms and scanned all 50,000 Project Papers, as the exact total requires. The
first bounded page took 0.40 ms; its Paper scan used
`papers_project_created_at_idx`, and its lateral lookups used
`screening_decisions_project_paper_sequence_idx`. The isolated latest-decision
lookup used the same screening index and took 0.16 ms. These were warm-cache
plans with zero shared-read blocks.

The deep-offset plan took 54.39 ms and scanned/sorted all 50,000 Papers before
returning the requested final 50. It used an external merge sort and reported
845 temp-read and 846 temp-written blocks. This is work inherent to the deep
OFFSET page in this fixture; it does not show that the existing first-page
Paper or per-Paper decision lookup index is missing. The first-page
ID tie-breaker uses a bounded incremental sort with no temp spill. The count's
Project-wide scan is required by the exact-count contract. No essential
missing index was demonstrated, so no migration amendment was needed and
`0034` was not created.

## Caller and migration audit

The production Papers page has no direct collection use of either unbounded
list method after this change. The four interactive consumers listed above
remain explicit follow-up work, while complete BibTeX export remains exempt.
Migration SQL, snapshots, and journal are unchanged from the verified Slice 41
baseline; the migration tail remains
`0033_storage_materialization_recovery`. No `0034` SQL or snapshot exists.

## Verification

| Gate | Result |
|---|---|
| Focused integration suite | Pass: 8 tests |
| Benchmark | Pass: PostgreSQL 16, 1k/10k/50k; EXPLAIN captured; no timeout |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm test -- --reporter=dot` | Pass: 96 files, 649 tests |
| `npm run test:integration` | Pass: 63 files, 393 tests |
| `npm run build` | Pass |
| `npx playwright test --workers=1 --retries=0` | Pass: 47 tests |
| `npm run db:check` | Pass |
| `git diff --check` | Pass |
| `npm audit` | Reports 9 dependency advisories (7 moderate, 2 high); no dependency changes were made |

`npm ci` also reported an engine mismatch because this environment runs Node
26.4.0 while the repository pins Node 22.13.0. The full local gates above
completed successfully under that environment. The `package-lock.json` is
unchanged.

The work must stop uncommitted on the verified Slice 41 baseline. Do not
create a branch, migration, commit, pull request, tag, push, publication, or
Slice 43 work.
