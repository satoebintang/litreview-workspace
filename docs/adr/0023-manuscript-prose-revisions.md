# ADR 0023: Immutable Manuscript Prose Revisions

- Status: Accepted
- Date: 2026-09-15
- Baseline: `v0.23.0-slice23` (`95c0cd442f09acb7550652143e0e8a18289677ce`)

## Context

Slice 23 stores the current Prose wording in `manuscript_prose_blocks`. Slice
24 gives that wording an immutable, item-level history while preserving the
stable `ManuscriptSectionItem.id == ManuscriptProseBlock.id` identity. Prose
history is manuscript content history, not research provenance, authorship,
reviewer tracking, or a manuscript-wide snapshot system.

## Decision

`manuscript_prose_blocks` is stable identity and containment only. Exact text is
stored exclusively in `manuscript_prose_revisions`, whose rows are append-only
and carry a generated global `sequence`. Current content is always the row with
the greatest sequence for the exact `(project_id, prose_block_id)` pair. No
mutable current pointer, timestamp ordering, UUID ordering, or contiguous
per-block sequence is used. UI revision numbers are derived ordinals.

The 0023 migration creates one reconstructed baseline row for every existing
ProseBlock, including removed blocks, before dropping the legacy `text` and
`updated_at` columns. Its `created_at` is the best available timestamp
associated with the content present at migration (the legacy `updated_at`). It
is not proof of original creation time, proof that the row was historically
Revision 1, or recovery of complete pre-Slice-24 edit history. Canonical history
begins with this one reconstructed baseline.

Every ProseBlock must have at least one persisted revision at transaction
commit. A deferred constraint trigger re-reads the revision table at commit;
it does not rely on stale `NEW` state. Revision INSERTs independently verify
same-project ownership, the active/nonremoved SectionItem target, valid text,
and exact difference from the current revision. Revision UPDATE and DELETE,
and ProseBlock UPDATE and DELETE, are rejected. Soft removal remains the
SectionItem lifecycle marker.

First-party edits use an exact expected-current revision ID inside the same
transaction as the append. A stale expected ID is rejected; equal text returns
unchanged without a write; whitespace is preserved exactly. Database INSERT
guards cannot model caller editing intent, so optimistic concurrency is an
application-level guarantee layered over database history integrity.

Slice 23 Prose ReviewThreads retain their immutable `opening_prose_text` and
NULL `opening_prose_revision_id`; no identity is inferred from text and no
synthetic revisions are created. New Prose ReviewThreads must bind the exact
current revision and matching text. Revision-linked drift uses exact revision
identity, while legacy NULL-ID threads use exact-text fallback and are labeled
as predating Prose revision tracking. Claim ReviewThread behavior remains
unchanged.

Prose mutation paths serialize on `Section -> ProseBlock -> SectionItem`.
Claim locking remains the released Slice 23 Claim Placement-first path.

## Consequences

- Current composition and export must load current revisions in batches; no
  historical revision metadata enters Markdown output.
- Removal and Section archival retain all Prose history; removed Prose cannot be
  revised. Future restoration is an explicit new revision containing historical
  text, never pointer retargeting.
- A migration-stable export regression is required: unchanged manuscript text
  exports byte-for-byte identically before and after 0023.
- No author, reviewer, change message, diff, rollback, branch, merge, or
  manuscript-wide version semantics are introduced.

## Rejected alternatives

- Keeping mutable `text` alongside revision rows creates permanent dual content
  authority and is rejected.
- Inferring legacy ReviewThread revision identity from equal text is rejected;
  equality cannot establish historical identity.
- A mutable `current_revision_id` is rejected because currentness is a derived
  sequence rule and pointer drift would create a second state authority.
