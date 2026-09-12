# ADR 0021: Research Question Answer Synthesis Snapshots

- Status: Accepted
- Date: 2026-09-12

## Context

Slice 20 gives researchers an auditable planning stream that links a Research
Question (RQ) to stable Claims and Synthesis Statements. It does not capture
the researcher's authored answer to the question. That answer must remain
historical and reproducible without introducing another support or citation
graph.

The formal provenance graph remains authoritative:

`Evidence -> ExtractionRevision -> SynthesisRevision -> ClaimRevision`

An RQ Answer may consult exact analytical revisions in that graph, but the
Answer itself is not a provenance edge. SearchStrategy/SearchRun remain
project-wide protocol context, and manuscript, citation, ReviewFlow, and PRISMA
semantics remain unchanged.

## Decision

Add one append-only `research_question_answers` snapshot table and two typed
exact-context tables:

- `research_question_answer_claim_contexts`
- `research_question_answer_synthesis_contexts`

There is no stable Answer aggregate and no polymorphic context table. One
parent row is one complete historical Answer. The parent is created as a
database-only draft (`finalized_at IS NULL`) and finalization changes only
`finalized_at`; the parent and children are immutable thereafter. A draft may
exist only during the atomic construction transaction and a deferred validator
rejects any draft that reaches commit.

The Answer's meaning is researcher-authored `answer_text` (required, trimmed,
nonblank, at most 20,000 characters), with an optional trimmed, nonblank
`researcher_note` of at most 20,000 characters. No conclusion state, status,
AI generation, or automatic prefill is stored.

Each context stores an exact revision ID and its stable target ID. A new Answer
may select only a revision that is:

1. in the same Project as the RQ and Answer;
2. attached to a stable Claim/Synthesis Statement currently linked to the RQ;
3. the greatest finalized revision for that stable target;
4. `active`; and
5. formally supported according to the existing resolver semantics.

The current-link test is latest-event-first for the exact typed
`(project, RQ, target)` pair: select the row with greatest global `sequence`,
then require its `action` to be `linked`. SQL must not filter on `action` before
selecting that row. Claim support is the existing canonical ClaimRevision
support-status calculation (active plus at least one existing support row in
any of the three Claim support tables); Synthesis support requires an existing
`synthesis_revision_supports` row. Slice 21 does not modify those support
tables or reinterpret their semantics.

The construction lock order is:

`ResearchQuestion -> selected Claims ordered by UUID -> selected
SynthesisStatements ordered by UUID -> Answer -> typed context rows ->
finalization`.

The RQ lock serializes link/unlink/relink and archival. Stable analytical
parent locks serialize exact-current-revision checks against their revision
writers. No path may acquire an analytical parent and later acquire the RQ.

Database triggers independently enforce ownership, draft-only child insertion,
immutability, no deletion, per-type limits (100), duplicate prevention, and at
least one total context. Deferred finalization validation identifies the
Answer by key and re-reads the persisted parent and both child sets; it then
rechecks latest links, exact current revisions, active state, and formal
support. It never relies on stale deferred `NEW` values.

Historical Answer rows remain byte-for-byte unchanged after unlink/relink,
newer revisions, withdrawal, or RQ archive. Reads derive only the six approved
context-specific drift flags. No global `stale`, `answered`, `complete`, or
quality judgment is stored or introduced.

## Consequences

- RQ history can reconstruct exactly what the researcher wrote and which
  revisions were consulted.
- Current candidate queries and finalization must share the same current-link,
  current-revision, lifecycle, and support semantics.
- Historical contexts can become drifted without being invalidated or
  retargeted.
- Project RQ matrix rows may expose factual Answer counts, latest sequence,
  context counts, and derived drift count only; Slice 20 diagnostic flags are
  unchanged.
- No Answer is eligible to become Claim/Synthesis/Evidence support, a citation
  source, a Manuscript SectionItem, or ReviewFlow/PRISMA input.
- Migrations 0000-0020 remain byte-for-byte unchanged; this slice is additive
  and has no backfill.
