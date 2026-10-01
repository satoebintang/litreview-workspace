# ADR 0048: Scalable Research Question Workspace

**Status:** accepted for Slice 48

**Date:** 2026-10-01

**Baseline:** `1685a51423d8f46afbbb912f295fd95681935a6c`

## Context

The released Research Question reader assembled full Question matrices,
candidate sets, and Answer histories before returning them to interactive
pages. Reads could grow with unrelated rows inside the same Project and with
unbounded ledgers. The workspace needs stable, bounded pages while preserving
the released traceability formulas, exact Answer pins, researcher-controlled
decisions, and compatibility APIs. Traceability summaries support planning;
they do not replace formal support validation, evidence provenance, citation
requirements, manuscript review, or PRISMA reporting.

## Decision

Use dedicated read services for a Project-scoped matrix, a per-Question
workspace, typed link ledgers and pickers, exact target history, included-Paper
Field coverage, Answer candidates, Answer history, and exact Answer snapshots.
The existing `listResearchQuestions`, `getResearchQuestionMatrix`,
`getQuestionTraceability`, `getQuestionTraceabilityHistories`,
`getProjectResearchQuestionAnswerFacts`, `getResearchQuestionAnswerProjection`,
`listResearchQuestionAnswerCandidates`, and `getResearchQuestionAnswerSnapshot` APIs remain
available to their existing callers.

The matrix orders by `(sort_order, id)`, returns one page plus `hasMore`, and
aggregates diagnostics for visible Questions only. Empty Projects return a
bounded empty page with independent active and archived counts. Explicit
status filtering does not change the Project-wide counts. Diagnostic codes
are compared with the released per-target projection. `fullyCovered` depends
only on the four traceability dimensions; Answer drift remains a separate
count. Matrix cursors bind the Project, filter, page size, and `(sort_order,
id)` boundary. Sort order is mutable, so a sort-order change during traversal
can skip or repeat a Question; restart matrix traversal from page one after
changing sort order. Pages are live reads, not a cross-request snapshot.

Typed link state is reduced from each target's greatest event sequence, with
the event UUID as a deterministic tie-break. Migration 0037 adds the
transactional `traceability_epoch` counter to each Question. Historical rows
start at epoch zero, even when historical relationship events exist. A
database trigger is the sole authority for incrementing the epoch: every
valid direct insert into a typed relationship-event table advances it, while
a rejected or rolled-back insert leaves it unchanged. The trigger does not
change the Question's `updated_at`; historical event data remains untouched.

Link-ledger, picker, Answer-candidate, coverage, and exact-target history
cursors bind the relevant Question epoch and captured event high-water
sequence. An authentic traceability continuation after a committed event is
rejected with `CONCURRENT_MODIFICATION`, including when that event reserved a
lower sequence and committed late. Malformed tokens, cursor boundaries above
the captured high-water, and wrong query bindings fail with
`VALIDATION_ERROR` before read SQL. Exact target detail preserves history
after unlink and has no current-link diagnostic flags when currently
unlinked. A target that never had a relationship has no history and returns
`NOT_FOUND`.

These cursors are not cross-request MVCC snapshots. Each page reads within its
own read-only `REPEATABLE READ` transaction. Answer history is deliberately
different from traceability history: it binds a captured Answer sequence
high-water and descending Answer boundary, but no Question traceability
epoch. A lower-sequence Answer transaction reserved before page one may commit
later and appear on a continuation when its sequence is at or below the
captured high-water. This Answer-only late-commit behavior does not apply to
traceability continuation pages.

The matrix and link diagnostics retain the released formulas. A Field has
current data when an included Paper has a latest finalized value in `present`,
`not_reported`, or `not_applicable` state. Current included Papers are
recomputed from the latest Title Abstract `include` and latest Full Text
`include` decisions; new screening decisions and finalized Extraction
revisions are reflected in later coverage reads. Retrieval state is a
prerequisite to recording a Full Text decision, but does not change the
inclusion formula after that decision exists. Evidence Set emptiness and
rejected members, Synthesis support and interpretation, and Claim support and
current manuscript placement are independent diagnostic conditions.

Picker membership is distinct from eligibility. Archived Fields and Evidence
Sets, and Synthesis Statements or Claims without a current revision, remain
browseable when they are not currently linked. Search trims input, permits at
most 200 Unicode code points, and treats `%`, `_`, and backslash literally
under case-insensitive matching. Target inventory and labels are live per
page; link state is reduced through the cursor's captured event boundary, and
a later relationship event invalidates that cursor through its epoch. Answer
candidate rows preserve linked but ineligible candidates with a reason and
current state. The Answer editor retains exact Claim and Synthesis revision
selections across candidate pages and searches, allows at most 100 of each
kind, and the canonical writer rechecks current link, revision, lifecycle,
and support eligibility before finalizing.

Answer history is bounded and ordered by descending Answer sequence. Its rows
contain a short text preview; exact Answer snapshots return the complete
Answer text, researcher note, and every immutable ClaimRevision and
SynthesisRevision pin. Revision, lifecycle, and link differences are derived
drift annotations; current support status is a separate derived annotation.
Neither changes the Answer or the matrix's `fullyCovered` value. Answer text
allows up to 20,000 characters and researcher notes up to 20,000. An Answer
must pin at least one Claim or Synthesis revision and may pin at most 100 of
each kind.

## Bounded read and payload contract

| Read | Default / maximum | SQL and payload boundary |
| --- | --- | --- |
| Matrix | 50 / 100 Questions | One Project scope, at most `pageSize + 1` ordered Questions, and four aggregates over visible Questions; Project title 240, Question identifier 100, label 280 characters |
| Typed link ledger | 25 / 50 targets | One target type and Question; compact target labels up to 240 characters |
| Target picker | 25 / 50 targets | One target type, live inventory, literal search; at most 200 Unicode code points per search |
| Answer candidate page | 25 / 50 targets | Claim or Synthesis candidates, with current eligibility and exact revision identity |
| Exact target history | 20 / 25 events | One exact Project, Question, target type, and target; ascending sequence and UUID |
| Included-Paper Field coverage | 25 / 100 Papers | One exact Field and Question; Paper title 200 and displayed value 240 characters |
| Answer history | 10 / 25 Answers | Descending Answer sequence and UUID; Answer text preview 300 characters |
| Per-Question workspace | Fixed read set | One Project and Question; compact metadata, bounded target ledgers, and 10 Answer previews |
| Exact Answer snapshot | One Answer | Full Answer and note plus complete exact pinned contexts; output-sized by design |

Serialized response targets are 256 KiB for a matrix page, 128 KiB for a
typed-link or picker page, 256 KiB for included-Paper coverage, and 128 KiB
for Answer history. Target-history output is capped at 1 MiB. Exact Answer
snapshots are exempt from a fixed byte ceiling because the complete immutable
Answer text and pins are the requested result; their measured response size is
reported by the accepted benchmark.

The Project title projection is capped at 240 characters; Question identifiers
at 100 and labels at 280. Exact target projections cap Field names at 160,
Evidence Set names at 120, Synthesis titles at 200, Claim text at 240, and
Paper titles at 200. Picker labels cap target text at 240 characters. Answer
history previews cap text at 300 characters. Exact Answer reads deliberately
return full Answer text and all pins, so their payload is bounded by the
canonical Answer/context limits rather than a preview cap.

Every keyset cursor is versioned canonical base64url JSON with strict UUID,
integer, timestamp, and query-binding validation. BIGINT cursor fields are
canonical nonnegative decimal strings from `0` through PostgreSQL's signed
BIGINT maximum `9223372036854775807`; database values above JavaScript's safe
integer range remain decimal strings end to end. Page sizes must be positive
safe integers before the service applies its configured maximum.

## Query budgets and physical index

Instrumented SELECT budgets are: matrix 6; per-Question workspace 11;
Project-layout lookup plus workspace route 12; typed link page 2; exact target
detail/history 2; included-Paper coverage 1; picker 2; Answer candidates 2;
Answer history 2; exact Answer snapshot 3. Route totals include the inherited
Project layout lookup where stated.

`research_questions_project_order_idx(project_id, sort_order, id)` was
already present in the Slice 47 baseline and is reused by the bounded Slice 48
matrix query. In a disposable counterfactual run with the existing baseline
index removed, the final bounded matrix query fell back to sequential scan plus
sort over 50k Questions, filtering 49,900 tuples on deep pages. With the
baseline index present, PostgreSQL executes a direct B-tree Index Scan
(`Index Scan using research_questions_project_order_idx`), examining exactly
the requested `pageSize + 1` rows (101 or 51 tuples) with 25 shared hit blocks
and 0 temp read/write blocks. Migration 0037 adds only the transactional
epoch/trigger machinery; no new index was needed, so no 0038 migration is
created.

## Compatibility and deferred work

Released traceability and Answer writers keep their existing validation and
immutability rules. Unrelated Protocol configuration-list paging,
ReviewReport contributor paging, dependency changes, and Slice 49 work are
explicitly deferred; this decision does not change their APIs or architecture.

## Verification and benchmark evidence

The accepted benchmark (`docs/benchmarks/slice48-research-question-read-paths.json`)
executed on PostgreSQL 16.15 and Node 22.13.0 over a 50,000-Question,
50,000-finally-included-Paper fixture with 2,000 targets/type (1,000 linked +
churn) and 1,000 Answers. All 50 benchmark cases succeeded, proving:

- Matrix reads use exactly 6 SELECTs for non-empty projects (1 for empty projects).
- All matrix page plans use the existing baseline `research_questions_project_order_idx`.
- All payload ceilings were satisfied: 100-row matrix pages peaked at 185 KiB
  (ceiling 256 KiB); 50-row link ledgers and pickers peaked at 40.6 KiB
  (ceiling 128 KiB); 100-row coverage pages peaked at 25.6 KiB (ceiling 256 KiB);
  25-row Answer history peaked at 6.9 KiB (ceiling 128 KiB); and 25-event target
  history peaked at 5.5 KiB (ceiling 1 MiB).
- The exact Answer snapshot read was measured at 6,247,214 bytes (~6.25 MB)
  for maximum-capacity 100 Claim and 100 Synthesis contexts.
- The disposable benchmark database was completely and cleanly dropped.

The focused service suite covers matrix ordering, ties and filters, empty
Projects, all nine bounded read API Project/Question boundaries, literal
search, typed picker/link/unlink transitions, released diagnostic parity,
independent support and inclusion states, cursor validation, large BIGINT
round-trips, Answer history boundaries, and exact target history. The
migration suite verifies that migration 0037 adds only the approved epoch
column and trigger machinery in fresh and forward-upgrade databases. The serial
browser suite exercises bounded pages and same-Question Field A-to-B navigation
at one unchanged epoch. Full project gates and regression suites pass cleanly
with all work uncommitted on `master`.
