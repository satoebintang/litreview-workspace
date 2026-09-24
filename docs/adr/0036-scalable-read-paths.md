# ADR 0036: Scalable Read Paths and Bounded Selection

## Status

Accepted for Slice 36 implementation.

## Decision

Project-wide full-text queues and Claim support selection use bounded PostgreSQL reads. Queue filters, state counts, ordering, and pagination run in SQL. Each queue count/page pair shares a read-only `REPEATABLE READ` transaction, derives all queue predicates from one review-facts projection, and applies `derivePaperReviewStatus()` only to the returned page. Queue pages default to 50 rows, cap at 100, and use stable `created_at DESC, id DESC` ordering.

Claim support searches return one compact kind-specific page and its database-derived total count. Each count/page pair also shares a read-only `REPEATABLE READ` transaction. Search pages default to 20 rows and cap at 50. Search text is bounded and literal. Existing canonical Claim writes keep their eligibility revalidation.

Title/abstract and full-text decision histories join their exact criteria in one history query, including archived criteria. Exact finalized SynthesisRevision lookup is constrained by project, statement, revision ID, and finalized state. The Claim picker’s exact-ID eligibility check is set-based per support kind, so its SQL statement count does not scale with selected support count.

The compact SynthesisRevision result has precise counts:

- `observationCount` is the number of `synthesis_revision_supports` rows for that exact revision.
- `evidencePathCount` is the number of `extraction_revision_evidence` links reachable through those support rows. A shared Evidence identity is counted once per support path; this is not a distinct-Evidence count.

Evidence search includes `accepted`, `needs_review`, and `unreviewed` Evidence, and excludes `rejected`. ExtractionRevision search includes finalized, non-cleared revisions whose Paper is currently finally included; superseded revisions remain selectable. SynthesisRevision search includes exact finalized active revisions only while the statement’s current finalized revision is active; superseded active revisions remain selectable.

## User-visible behavior

The only approved queue-classification change is retrieval `all` membership:

```text
current title/abstract-included retrieval queue
UNION
historical retrieval conflicts
```

Therefore a Paper with retrieval history and a current title/abstract decision of `exclude`, `maybe`, or no decision appears in both retrieval `all` and `conflict`, and contributes to both counts. State-specific operational queues are unchanged. Full-text queue classification, counts, and membership are unchanged.

Selected support IDs are independent of the current search and page. Ineligible historical supports remain visible in the saved snapshot with an explanation, but are not carried forward. An exact synthesis revision requested by ID is selected only when currently eligible. Reactivation does not select historical supports implicitly.

## Benchmark method

Run `npm exec -- tsx scripts/benchmark-read-paths.ts` with PostgreSQL 16 and a `DATABASE_URL` role permitted to create and drop a disposable database. The script migrates a uniquely named database, seeds all fixtures there, and drops it in `finally`. Fixture statements have a separate 600-second bound; measured reads and `EXPLAIN` use a 120-second statement bound, and lock waits are capped at 5 seconds. The measured-read limit is restored immediately after each scenario is seeded. `READ_PATHS_BENCHMARK_SIZES` can select a comma-separated subset of `1000,10000,50000` when rerunning only one size.

At each of 1,000, 10,000, and 50,000 Papers, the fixture builds project-scoped queue facts, evidence review states, two ExtractionRevisions per Paper linked to the same Evidence, and active/withdrawn synthesis revisions with two support paths per active revision. It also seeds 500 criterion-linked exclusion events plus a final current include for one Paper at 50,000 rows, then archives those criteria. This provides a high-history joined-read comparison while using valid append/finalize order and database guards.

The harness measures the released unbounded queue and Claim catalog APIs against the new 50-row pages. It reports total counts, returned row counts, serialized payload bytes, wall time, and application SELECT counts. Each new queue and Claim search uses two SELECTs (count and page) in its read-only `REPEATABLE READ` transaction. Drizzle also logs the transaction’s `SET TRANSACTION` setup command; the report lists that separately, so the logger sees three entries while the operation issues two SELECTs. The JSON output includes `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans for the actual captured queue and Claim count/page SQL at all three sizes, plus criterion-history joins and exact finalized-revision lookup at 50,000.

For criterion history, the benchmark executes the former query-plus-one-criterion-lookup-per-exclusion pattern against 502-row histories and measures those statements. It compares that observed reference count with the current joined detail read. For Claim catalogs, it checks each new total against the released API where that API completes. Integration tests separately verify Claim ID-set equivalence and page stability.

## Benchmark observations

The recorded run environment was PostgreSQL 16 and pinned Node.js 22.13.0. Timings below are local diagnostic observations, not performance thresholds. The final-code full run completed the 1,000-, 10,000-, and 50,000-Paper scenarios, emitted all ten queue/Claim plans per size plus the two history-join plans and exact-revision plan, and dropped its disposable database. The JSON output retains the full plan trees; the tables below omit fixture IDs.

For each queue cell, values are `legacy rows / payload bytes / wall ms → paged total / 50 returned / payload bytes / wall ms`.

| Papers | Retrieval all | Retrieval conflict | Full-text all |
|---:|---|---|---|
| 1,000 | 600 / 380,238 / 53.7 → 900 / 50 / 32,971 / 31.8 | 300 / 207,168 / 37.6 → 300 / 50 / 34,740 / 28.8 | 900 / 587,405 / 24.4 → 900 / 50 / 32,986 / 30.3 |
| 10,000 | 6,000 / 3,808,339 / 457.7 → 9,000 / 50 / 33,029 / 288.3 | 3,000 / 2,074,668 / 363.8 → 3,000 / 50 / 34,798 / 238.9 | 9,000 / 5,883,006 / 363.7 → 9,000 / 50 / 33,045 / 323.6 |
| 50,000 | 30,000 / 19,068,339 / 859.9 → 45,000 / 50 / 33,082 / 612.0 | 15,000 / 10,386,668 / 759.4 → 15,000 / 50 / 34,853 / 617.2 | 45,000 / 29,455,006 / 704.9 → 45,000 / 50 / 33,099 / 630.3 |

The retrieval `all` count adds exactly the conflict count at each size (300, 3,000, and 15,000); the old operational and conflict results were both available for those comparisons. Full-text all-state totals and state counts matched the unbounded reference at all three sizes. All legacy queue measurements completed; no queue read timed out or failed in the successful runs. Each legacy queue call logged three SELECTs; each paged queue call logged two SELECTs plus the transaction setup command.

The fixture models released Claim eligibility with one Evidence per Paper (25% accepted, 25% needs review, 25% unreviewed, 25% rejected), two finalized ExtractionRevisions per Paper, and one synthesis revision per Paper (90% active, 10% withdrawn). Every active synthesis revision has two support paths to its Paper’s two ExtractionRevisions; both ExtractionRevisions point to the same Evidence. This yields 1,800 / 18,000 / 90,000 synthesis support rows, and deliberately distinguishes support-path counts from distinct Evidence IDs.

For each Claim cell, legacy values are `rows / payload bytes / wall ms` and page values are `total / 50 returned / payload bytes / wall ms`.

| Papers | Kind | Legacy unbounded catalog | Bounded page |
|---:|---|---|---|
| 1,000 | Evidence | 750 / 661,591 / 218.1 | 750 / 50 / 18,114 / 19.1 |
| 1,000 | ExtractionRevision | 200 / 355,123 / 218.1 | 200 / 50 / 24,726 / 30.8 |
| 1,000 | SynthesisRevision | 900 / 4,241,011 / 218.1 | 900 / 50 / 14,102 / 21.1 |
| 10,000 | Evidence | 7,500 / 6,630,843 / 4,695.1 | 7,500 / 50 / 18,138 / 98.1 |
| 10,000 | ExtractionRevision | 2,000 / 3,559,535 / 4,695.1 | 2,000 / 50 / 24,878 / 270.8 |
| 10,000 | SynthesisRevision | 9,000 / 42,513,709 / 4,695.1 | 9,000 / 50 / 14,304 / 150.2 |
| 50,000 | Evidence | failed after 12 SELECTs / 6,607.8 | 37,500 / 50 / 18,183 / 361.2 |
| 50,000 | ExtractionRevision | failed after 12 SELECTs / 6,607.8 | 10,000 / 50 / 25,030 / 645.7 |
| 50,000 | SynthesisRevision | failed after 12 SELECTs / 6,607.8 | 45,000 / 50 / 14,405 / 185.1 |

The three legacy Claim rows at 1,000 and 10,000 share the elapsed time and 13-SELECT count of the single combined `listClaimSupportOptions` call. At 50,000, that combined call failed while collecting Evidence paths through `extraction_revision_evidence`: PostgreSQL reported `MAX_PARAMETERS_EXCEEDED` at its 65,534-parameter limit. Its row/payload counts and old/new count comparison are therefore unavailable; bounded search pages still completed. No SQL text or generated IDs are included in this report. Integration tests provide the ID-set comparison where the legacy catalog can complete.

The statement-count observations are:

| Read path | Legacy SELECTs | New SELECTs | Transaction setup logged separately |
|---|---:|---:|---:|
| Retrieval queue page | 3 per legacy call | 2 | 1 `SET TRANSACTION` |
| Full-text queue page | 3 | 2 | 1 `SET TRANSACTION` |
| Claim search, each support kind | 13 for the combined catalog at 1k/10k | 2 per kind | 1 `SET TRANSACTION` per kind |
| Title/abstract history, 502 rows | 501 (history read + 500 criterion lookups) | 1 joined history SELECT | n/a |
| Full-text history, 502 rows | 501 (history read + 500 criterion lookups) | 1 joined history SELECT | n/a |
| Exact finalized SynthesisRevision lookup | n/a | 1 | n/a |

At 50,000 Papers, the history probes each returned 502 rows with one joined SELECT and 500 criterion-linked exclusions. The exact finalized SynthesisRevision lookup returned the requested ID in one SELECT (2.21 ms, 393 serialized bytes). Its plan used the existing `synthesis_revisions_project_statement_sequence_idx`; title/abstract and full-text history plans ran in 0.53 ms and 0.56 ms respectively, using the existing project/Paper/sequence and criterion indexes.

The 30 queue and Claim count/page plans all completed. Each cell below gives count execution time and root shared `hit/read` blocks, then page execution time and root shared `hit/read` blocks. The JSON output retains the complete plans, including node details.

| Papers | Retrieval all | Full-text all | Claim Evidence | Claim ExtractionRevision | Claim SynthesisRevision |
|---:|---|---|---|---|---|
| 1,000 | 5.96 ms (185/0); 7.66 ms (214/0) | 7.90 ms (185/0); 9.81 ms (214/0) | 2.41 ms (2,801/0); 2.60 ms (2,799/0) | 4.22 ms (3,326/0); 7.77 ms (4,868/0) | 4.21 ms (8,628/0); 5.76 ms (790/0) |
| 10,000 | 78.02 ms (1,639/0); 112.11 ms (2,187/0) | 83.97 ms (1,639/0); 116.26 ms (2,187/0) | 26.70 ms (28,028/0); 50.54 ms (28,026/0) | 113.82 ms (33,316/0); 199.61 ms (45,671/0) | 73.56 ms (94,010/0); 100.62 ms (94,610/0) |
| 50,000 | 407.80 ms (5,031/3,654); 424.35 ms (8,999/2,757) | 298.80 ms (5,960/2,725); 357.91 ms (9,063/2,693) | 137.20 ms (190,419/0); 165.56 ms (190,417/0) | 626.49 ms (304,381/2,661); 73.82 ms (5,655/2,629) | 182.91 ms (246,722/0); 1.13 ms (973/0) |

## Migration decision

No migration was added. The plans show sequential scans over dense project-scoped history/catalog rows for exact counts, alongside existing indexes for Paper decision histories, retrieval attempts, extraction Evidence links, synthesis revisions, and support paths. At 50,000 Papers the slowest tested count plan was the Claim ExtractionRevision count at 626 ms; all returned pages were limited to 50 rows. The exact-revision and per-Paper history lookups used existing indexes and completed below 0.6 ms. No plan spilled to temporary blocks or demonstrated an essential missing index, so no `0033` migration was created.
