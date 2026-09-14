# Slice 23: manuscript editorial review threads

This slice adds immutable editorial `ReviewThread` and append-only
`ReviewEvent` history. It is deliberately not manuscript version history:
there is no `ProseRevision`, manuscript snapshot, rollback, approval lifecycle,
or automatic mutation of Evidence, ExtractionRevision, SynthesisRevision,
ClaimRevision, support, citation, ResearchQuestion, Answer, ReviewFlow, or
PRISMA state.

## Opening context

Every thread stores the exact persisted target context at opening. A Prose
thread stores the Prose text without trimming, whitespace/line-ending
normalization, punctuation rewriting, or sanitization. A Claim thread stores
the exact `(claim_id, claim_revision_id)` occupying the placement. These values
describe the wording or placement concern originally addressed; they are not a
complete historical manuscript revision system. PostgreSQL re-reads and locks
the subtype row on insert and rejects a caller-supplied mismatch.

## Lock-order audit

The released manuscript mutation paths were inspected before adding the
ReviewThread target guard:

| operation | released lock order |
| --- | --- |
| prose edit | direct ProseBlock update; no explicit Section lock |
| prose removal | ProseBlock + SectionItem row, then SectionItem soft removal; no Section lock |
| Claim replacement | ClaimPlacement, then Section |
| Claim removal | ClaimPlacement + SectionItem, then Section |
| Section archival | active-item check, then Section update (no inverse subtype lock) |

Review opening uses the audited per-subtype order `ClaimPlacement -> Section ->
SectionItem` and `Section -> ProseBlock -> SectionItem`. Claim replacement and
removal both acquire the ClaimPlacement row before their other target rows;
the removal read also locks its SectionItem before taking Section. Review
opening therefore shares ClaimPlacement as the mandatory first serialization
point for the Claim target, so two operations on the same placement cannot hold
the later rows in opposite transactions. Prose edit/removal do not lock
Section, while the released section writer already uses `Section -> ProseBlock`;
the Section-first Review path therefore avoids the inverse
`Section -> ProseBlock` / `ProseBlock -> Section` pair. Existing manuscript
mutation semantics remain unchanged; only the new ReviewThread path follows
these audited orders.

## State

The lifecycle reducer considers only `opened`, `resolved`, and `reopened`;
`commented` remains chronological history but is state-neutral. PostgreSQL
serializes event insertion on the thread row and a deferred trigger re-reads
the final persisted stream, requiring one and only one `opened` event first and
valid transitions before commit.
