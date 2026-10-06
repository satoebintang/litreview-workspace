# ADR 0053: Scalable Extraction Revision Histories and Exact Audit

**Status:** ACCEPT; independent Luna/max review complete; Sol/high specialist acceptance complete; accepted for publication; implementation remains uncommitted until publication

**Date:** 2026-10-05

**Baseline:** `v0.52.0-slice52`,
`565727c039d1716baf00816dd85a2292d74dae56`

**Migration:** `0039_slice53_finalized_extraction_history_keysets.sql`

## Context

The normal Paper Extraction worksheet previously loaded every finalized
`ExtractionRevision` for every active Field, grouped the rows into per-Field
history arrays, selected current state from the last array element, and
hydrated linked Evidence for all historical revisions. That made ordinary
worksheet reads grow with revision depth and historical Evidence membership.
Researchers still need a complete current editing artifact and exact immutable
audit for older revisions.

## Decision

Keep `/projects/[projectId]/extraction/[paperId]` as a current-only worksheet.
It reads active Fields and their ordered Options, stable slot identity, one
greatest-sequence finalized revision per Field, the complete current typed
value/note, selected Option identity and label, current Evidence links,
grounding, and lossless sequence text. Current revisions are chosen set-wise
with `ORDER BY sequence DESC LIMIT 1` and no UUID tie-breaker. Current Evidence
hydration receives only those selected revision IDs. The worksheet no longer
returns complete history arrays.

Add a bounded Field history route at
`/projects/[projectId]/extraction/[paperId]/fields/[fieldId]/history` and an
exact revision audit route at
`/projects/[projectId]/extraction/[paperId]/fields/[fieldId]/revisions/[revisionId]`.
History defaults to 20 rows, caps at 50, has no exact total, and traverses by
`sequence DESC, id DESC`. Its canonical base64url cursor is capped at 512
characters and binds version, Project, Paper, Field, stable slot, stream,
effective page size, sequence text, and revision ID. Cursor BIGINT values stay
decimal strings and are compared as PostgreSQL `bigint`.

History traversal is live across page requests, not an MVCC commit-order
snapshot. A transaction can reserve a lower sequence and commit after a higher
sequence has already been traversed, placing that revision behind the cursor.
Restart traversal from the first page to include a revision that commits late.

History SQL validates scope/current/cursor anchor first, selects at most
`pageSize + 1` ordered keys in a materialized CTE, then hydrates and counts
Evidence only for the first `pageSize` visible revisions. The continuation
uses the direct tuple predicate
`(sequence, id) < ($sequence::bigint, $revision_id::uuid)`. The sentinel is
never hydrated or counted. Compact summaries cap text values at 448 code
points, notes at 192, Option labels at 500, and Field names at 500; the maximum
50-row JSON DTO must stay within 256 KiB UTF-8 without dropping rows.

Exact reads bind Project → Paper → Field → stable ExtractionValue slot →
finalized ExtractionRevision. They return the full immutable typed value,
researcher note, Field/type, selected Option identity/label and archival state,
timestamps, exact Evidence membership/content, and current/superseded status.
Evidence preserves the released `pageNumber ASC, createdAt ASC` order without
an ID tie-breaker. Historical reads do not require current Paper inclusion or
an active Field/Option; archived Fields and Options remain auditable by their
original identities and labels.

Migration 0039 adds only
`extraction_value_revisions_project_paper_field_sequence_id_idx` on
`(project_id, paper_id, field_id, sequence, id) WHERE finalized_at IS NOT NULL`.
The existing current-state and other indexes remain. No uniqueness constraint
or direction-specific duplicate index is added.

## Boundedness and residual debt

The accepted guarantee is:

> Complete historical ExtractionRevision streams and historical
> revision-Evidence hydration are no longer materialized by the normal
> worksheet.

The Paper Evidence picker remains unchanged and unbounded by explicit
decision. This ADR does not claim that the entire extraction worksheet is
universally bounded. Active Field and Option catalogs remain separate
configuration growth. Current and exact artifact reads may scale with their
exact Evidence support size. Compatibility APIs such as
`getPaperExtraction()` and `getExtractionValueHistory()` remain available with
their existing full-return contracts; writers are not redesigned.

## Verification record

The final disposable benchmark ran with Node 22.13.0 and PostgreSQL 16.15,
applied migrations through 0039, completed 22/22 measurements and 14/14
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans, and verified database cleanup.
For the 50k-revision deep continuation, PostgreSQL used a backward Index Scan
through `extraction_value_revisions_project_paper_field_sequence_id_idx` with
the direct `(sequence, id)` tuple range. It examined 51 index entries and
visited 51 heap rows for the 51 page keys; there was no oversized sort or temp
I/O. First, deep, and final pages at 1k, 10k, and 50k revisions each used two
owned SELECTs and returned 51 driver rows. The exact read used two SELECTs and
returned 11 rows on the ten-support benchmark fixture. The safe-sequence 1k
legacy equivalence check matched all 1,000 rows across 20 pages.

Worksheet cohorts verified isolated active Field counts of 1, 10, and 50.
Across total worksheet histories of 10, 10k, and 100k revisions, the current
worksheet read returned seven SELECTs, 77 driver rows, and a 41,589-byte DTO
for each cohort, with five Paper Evidence rows and 50 current-revision Evidence
links. Separate Evidence cohorts returned 0, 50, and 500 current-revision
links for 0, 5, and 50 Paper Evidence rows. These measurements keep the
deferred unbounded Paper Evidence picker visible as residual debt. Wall-clock
times are diagnostic only. Full plans, statement/row/byte accounting, sort and
buffer details, and cleanup evidence are in
`docs/benchmarks/slice53-extraction-history-read-paths.json`.

Independent Luna/max review is complete with ACCEPT, and Sol/high specialist
acceptance is complete. The implementation is accepted for publication. The
implementation remains uncommitted until publication.
