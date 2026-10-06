# ADR 0052: Scalable Claim and Synthesis Detail Histories

**Status:** implemented and published as `v0.52.0-slice52`

**Published merge SHA:** `565727c039d1716baf00816dd85a2292d74dae56`

**Date:** 2026-10-03

**Baseline:** `v0.51.0-slice51`,
`128b2c91affe65fe4f0df526b76f2380c1e6c136`

**Migration:** `0038_slice52_finalized_history_keysets.sql` (approved amendment);
Stage C uses its three full-key partial indexes without planner overrides.

## Context

Claim detail, Synthesis detail, and exact SynthesisRevision pages loaded
history whose size grows with append-only activity. Compact summaries alone
were insufficient for exact audit recovery, while routing each detail page
through the existing full-history projections retained unbounded transfer and
hydration. The current revision and exact historical artifacts must remain
complete, and legacy full-return APIs continue to serve compatibility callers.

## Decision

Add bounded readers for ClaimRevision, SynthesisRevision, and
SynthesisInterpretation histories. Each stream defaults to 20 rows and is
capped at 50. The readers select `pageSize + 1` keys, return no exact total,
and derive display summaries only for the visible page. Claim and interpretation
history order is `sequence DESC, id DESC`; SynthesisRevision history preserves
`sequence ASC, id ASC`.

Cursors are canonical versioned base64url JSON capped at 512 characters. They
bind Project, exact parent identities, fixed stream type, effective page size,
and the final `(sequence, id)` key. Validation checks encoding, UTF-8, exact
keys, canonical serialization, UUIDs, parent scope, page size, and canonical
signed BIGINT decimal text before history queries. Sequence is selected as
`sequence::text` and range comparisons cast the cursor value to `bigint`.
Anchor membership and finalization are checked within the scoped history SQL;
no separate anchor query is added.

All three pages use a read-only `REPEATABLE READ` transaction. The current
ClaimRevision, SynthesisRevision, latest active ClaimRevision, and current
interpretation selectors preserve the released rule:

```sql
ORDER BY sequence DESC
LIMIT 1
```

There is no UUID tie-breaker for current selection and no sequence uniqueness
constraint. Deterministic `(sequence, id)` ordering applies only to history
traversal.

Claim history selects the page before computing per-revision metrics. Direct
Evidence, ExtractionRevision, and SynthesisRevision support totals are
aggregated independently. Citation-candidate and structurally reachable
Paper counts retain their released meanings. History DTOs contain bounded text
previews and truncation flags, lifecycle/currentness, support and Paper counts,
timestamps, and exact links; they do not contain provenance arrays.

Synthesis history selects visible revision IDs before support aggregates and
preparation metadata. Support, Paper, and Field counts preserve released
definitions. Preparation context is requested only for visible revision IDs
and uses bounded Evidence Set name previews. The lookahead row is excluded
from both support and preparation hydration.

Interpretation history selects visible snapshot IDs before counting
limitations, questions, and contradictions. It does not transfer child text
or arrays. Main Synthesis detail reads only the current interpretation fields
it displays. Exact SynthesisRevision detail uses one selected current
interpretation identity and a bounded history page.

The new exact ClaimRevision route scopes Project, Claim, and finalized
revision identity before invoking the canonical full projection. The new exact
interpretation route scopes Project, SynthesisStatement, SynthesisRevision,
and Interpretation before loading the complete snapshot. Contradiction
members resolve against the exact revision's pinned supports. Both routes
return generic not-found behavior for malformed or incorrectly scoped
identities. These exact audit artifacts remain intentionally output-sized.

Normal detail and continuation routes use the bounded readers. Existing
full-return readers, exact Claim projections, Synthesis provenance, writer
semantics, and support eligibility remain available and unchanged. Successful
writes return to the main detail route with continuation state removed.

## Query and payload bounds

The owned reader targets are at most two SELECTs for Claim history, three for
Synthesis history, and two for interpretation history. The new exact
interpretation reader uses five scoped SELECTs. Existing current provenance
and exact audit projections remain separately bounded by their established
query counts. Project layout is counted separately.

Text fields use SQL previews: Claim text 448 code points, Claim note 256,
Synthesis title 96, statement 320, Synthesis note 160, preparation Evidence
Set name 64, interpretation summary 448, and interpretation note 256.
Historical full values remain available from exact routes. The target maximum
history DTO is 256 KiB of UTF-8 JSON at page size 50; rows are never dropped
dynamically to meet the budget.

These limits bound transferred rows and nested DTOs. PostgreSQL work for
page-scoped support aggregation can still grow with the number of exact
supports attached to visible revisions. A keyset page does not by itself
prove bounded candidate generation or index efficiency.

## Consistency and migration boundary

Each request has an internally consistent read-only `REPEATABLE READ`
snapshot. There are no cross-request epochs or frozen membership. Sequence
allocation remains reservation order, so late-committing lower-sequence rows
may require a traversal restart to observe.

The initial implementation added no migration because the existing
scope/sequence indexes appeared potentially sufficient. Final application
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` at 50k rows disproved that: deep
pages scanned about half of each parent history because those indexes ended
at `sequence`, while traversal ordered by `(sequence, id)`. Under the approved
amendment, migration 0038 adds only these partial B-tree indexes:

- `claim_revisions_project_claim_sequence_id_idx` on
  `(project_id, claim_id, sequence, id)` where `finalized_at IS NOT NULL`;
- `synthesis_revisions_project_statement_sequence_id_idx` on
  `(project_id, synthesis_statement_id, sequence, id)` where
  `finalized_at IS NOT NULL`;
- `synthesis_interpretations_project_revision_sequence_id_idx` on
  `(project_id, synthesis_revision_id, sequence, id)` where
  `finalized_at IS NOT NULL`.

The three-stage benchmark separates the index and query-shape results. Stage A
used the initial sequence-only index set and showed roughly 25,000 heap rows
read for 50 deep-page results. Stage B preserved the original
`page_candidates` SQL shape with migration 0038: its same-database paired
plans selected the new full-key indexes but still processed 25,000 index and
heap rows. After a separately approved application query rewrite, stage C
kept migration 0038 and all three indexes installed, used the default planner
settings, and explained the exact `page_keys` SELECT emitted by each current
reader. Each final plan reads 51 index entries, performs 51 heap fetches or
visits, and returns 50 rows. This stage meets the deep-page candidate-work
target for the measured query shape. This benchmark did not alter the
migration, indexes, or application source. No sequence uniqueness, cache,
epoch, or denormalized history table is added.

## Verification and remaining scalability work

Focused cursor, route-contract, integration, and Playwright coverage is part
of this slice. Integration fixtures compare all three bounded streams across
multiple pages with their legacy semantic readers on manageable unique-sequence
histories, including membership, order, support metrics, and interpretation
child counts. Tied page-boundary traversal is checked for Claim, Synthesis, and
Interpretation without asserting which tied event wins current selection.
Exact route DTOs preserve BIGINT sequences beyond JavaScript's safe integer
range as decimal strings. Max-50 DTO tests cover preview truncation, nulls,
JSON-escaped control characters, and a 256 KiB UTF-8 JSON ceiling. Exact
artifacts are checked independently from history summaries.

**Stage A — initial sequence-only indexes.** The original pre-index run used
Node 22.13.0 and PostgreSQL 16.15. It recorded 53/53 measurements and 37/39
application-query plans; the two no-SELECT interpretation-support plans were
explicitly skipped. Its 50k deep plans used bitmap access, visiting 50,002
Claim, 49,671 Synthesis, and 50,002 interpretation index entries, then about
25,000 heap rows per stream; the top-N sorts consequently considered about
25,000 candidates to return 50. The largest bounded history-page DTO was
34,659 bytes. That evidence showed bounded output but candidate work far above
page size, supporting the then-current no-migration verdict. The exact
pre-index artifact remains byte-for-byte preserved at
[`slice52-claim-synthesis-history-read-paths-pre-index.json`](../benchmarks/slice52-claim-synthesis-history-read-paths-pre-index.json)
(SHA-256 `f45f0eb906118bc4e613441f1feaf85396934026ca0a0b675656a026819b06c0`).

**Stage B — migration 0038 with the original query shape.** The approved
amendment added migration 0038 with only these three partial full-key indexes:
`claim_revisions_project_claim_sequence_id_idx`,
`synthesis_revisions_project_statement_sequence_id_idx`, and
`synthesis_interpretations_project_revision_sequence_id_idx`. The historical
Stage B run recorded 53/53 measurements and 45 plan entries (43 completed,
two explicitly skipped because the fixtures emitted no interpretation-support
SELECT). All three 50k paired comparisons reused the exact application SQL
and bound parameters from their deep-page measurements. Within each pair, SQL
and parameter SHA-256 fingerprints match; the complete SQL and parameters
remain in the preserved pair object. Each state had exactly 50,000 finalized
rows per parent. The analyzed relation estimates and heap pages matched
between states (`61,000` rows per table; 2,019 Claim, 2,714 Synthesis, and
2,467 interpretation heap pages). The comparison temporarily dropped and
restored only the three 0038 indexes in its disposable database; the catalog
definitions before and after matched exactly.

| Stream | Without 0038: access, index rows, heap rows | With 0038: access, index rows, heap rows | Heap filter removals before / after | Shared hits/reads before / after | Temp read/write | Execution ms before / after |
| --- | --- | --- | --- | --- | --- | --- |
| Claim | Bitmap Index Scan on `claim_revisions_project_claim_sequence_idx`; 49,134; 25,000 | Bitmap Index Scan on `claim_revisions_project_claim_sequence_id_idx`; 25,000; 25,000 | 1 / 0 | 1,275/0; 482/239 | 0/0 | 19.699 / 22.258 |
| Synthesis | Bitmap Index Scan on `synthesis_revisions_project_statement_sequence_idx`; 25,001; 25,000 | Bitmap Index Scan on `synthesis_revisions_project_statement_sequence_id_idx`; 25,000; 25,000 | 1 / 0 | 903/0; 815/2 | 0/0 | 16.889 / 15.782 |
| Interpretation | Bitmap Index Scan on `synthesis_interpretations_project_revision_sequence_idx`; 49,134; 25,000 | Bitmap Index Scan on `synthesis_interpretations_project_revision_sequence_id_idx`; 25,000; 25,000 | 1 / 0 | 1,438/0; 584/238 | 0/0 | 20.423 / 18.382 |

With 0038 present in Stage B, each deep-page bitmap index condition includes
both parent scope and the full `(sequence, id)` cursor range, but the plans
still build bitmaps for 25,000 entries and visit 25,000 heap rows to return 50.
The page Top-N sorts still considered about 25,000 heap candidates before
returning 50. Stage B's historical `sortInputRows` fields are preserved as
captured; the prior summarizer summed all listed child-plan rows, including
EXPLAIN `InitPlan`/`SubPlan` rows, so they are not reported as actual input
counts for an individual Sort. The Stage B sort and buffer details remain in
the preserved historical pair object; these results are retained as the reason
the query shape was revisited.

**Stage C — migration 0038 with the bounded page-key query shape.** The
complete rerun retained all 53 measurements (53 completed), with 52 plan
entries (50 completed, two explicit no-SELECT skips) and four completed
Stage C final-application plans. The skipped labels are
`exact-interpretation-support-resolution-1000` and
`exact-interpretation-support-resolution-50000`; neither is counted as a pass.
The full-key index inventory was read from PostgreSQL after applying migration
0038, with bitmap, index, sequential-scan, and sort planner settings all `on`.
No index DDL was run in Stage C. Each deep-plan SQL string and parameter array
was captured from the actual 50k application read and matched to the current
source function. Interpretation uses two application SELECTs: the first
validates scope/current/anchor and selects at most 51 page keys; the second
hydrates the first 50 IDs and computes their child counts.

| Stage C application SELECT | Access path | Key rows; heap work; returned | Filter removals | Sort nodes | Shared buffers (query; index node) | Temp blocks | Planning/execution ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claim `claimHistoryPageQuery` | Index Only Scan on `claim_revisions_project_claim_sequence_id_idx` | 51; 51 heap fetches; 50 | 0 | 6; page 51, outer 50, four inactive branches 0 | 291/0; 6/0 | 0/0 | 4.096 / 1.412 |
| Synthesis `synthesisHistoryPageQuery` | Index Only Scan on `synthesis_revisions_project_statement_sequence_id_idx` | 51; 51 heap fetches; 50 | 0 | 3 | 347/0; 6/0 | 0/0 | 0.533 / 1.461 |
| Interpretation `interpretationHistoryScopeAndPageKeysQuery` | Index Scan on `synthesis_interpretations_project_revision_sequence_id_idx` | 51; 51 heap visits; 51 page keys | 0 | 1; page 51 | 20/0; 5/0 | 0/0 | 1.154 / 0.403 |
| Interpretation `interpretationHistoryHydrationQuery` | Contradictions: Index Only Scan on `synthesis_interpretation_contradictions_interpretation_idx`; limitations/questions: Seq Scan | 50 visible IDs; contradiction 0 heap fetches; 50 hydrated | Limitations 100; questions 100 | 4 | 570/0; contradiction index node 50/0 | 0/0 | 0.737 / 1.458 |

The three page-key index conditions contain the complete project/parent scope
and directional `(sequence, id)` cursor boundary. Each stops after 51 keys;
there is no full-tail sort or history scan. Claim and Synthesis hydrate 50
visible rows after key selection. The Interpretation page-key query returns 51
keys, while its separate hydration query returns 50 rows. Sorts use in-memory
quicksort; no temporary I/O occurred. The two 100-row limitation/question
relations were scanned once each and filtered against the bound visible-ID
array; the 500-row contradiction relation used its existing index. Thus child
counts are scoped to visible interpretations, while this run does not prove
index-bounded physical work for a larger limitation/question table. The largest
history-page DTO in Stage C was 34,663 UTF-8 bytes. Synthesis visible-support
aggregation used `synthesis_revision_supports_project_synthesis_revision_idx`
for 50 probes, with no support heap tuples on this deep page. The 1k, 10k, and 50k
populations, tie-group cases, support cardinalities, exact routes, and detail
reads are retained in the complete evidence. Eight legacy full-history cases
were explicitly skipped; the 10k legacy interpretation projection was sampled
once and completed. The page-key work criterion is met for this measured Stage
C query shape; timing values are diagnostic only.

The Stage A, B, and C runs use different disposable database names, so their
deterministic project-scoped UUID bind values differ. The Stage B paired plans
remove that comparison confound within each before/after pair. The final
artifact retains Stage A's path and hash, Stage B's old-query plans and paired
comparison object with SQL and parameters, and Stage C's full measurements and
exact final-query plans. The complete plan trees, query text, parameters,
hashes, statistics, and cleanup proof are in
[`slice52-claim-synthesis-history-read-paths.json`](../benchmarks/slice52-claim-synthesis-history-read-paths.json).
The Stage C runner dropped and verified absence of only its run-owned
disposable database; the PostgreSQL container remained running and healthy,
and its persistent volume was preserved. Stage A's pre-index artifact was
hash-verified unchanged after the run.

Independent Luna/max review and Sol/high specialist acceptance both returned
ACCEPT after the Stage C buffer counts in this ADR and CONTEXT were reconciled
with the final artifact. No material findings remain. The implementation was
accepted for publication.

Compatibility full-history methods remain unbounded by design. Exact audit
views scale with the size of the requested artifact. Support aggregation
candidate work can grow with visible support cardinality. The measured
limitation/question child-count scans read their whole 100-row relations even
though only visible interpretation IDs contribute to counts; the benchmark
does not establish the planner's choice for larger child relations. Live
traversal has no frozen cross-request membership. These are the remaining
costs and consistency limits of this design.

## Scope exclusions

Slice 52 does not change Claim or Synthesis writes, support selection,
eligibility, preparation semantics, interpretation authoring, citation
semantics, current-state tie behavior, or compatibility API shapes. The
approved migration adds only the three indexes listed above. Slice 53 has not
started.
